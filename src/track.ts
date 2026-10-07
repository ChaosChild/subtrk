// track.ts – M4a task-level usage accounting (spec §Track).
// Agents mark task boundaries (`track start` / `track stop`); subtrk harvests
// the real token usage for that window from harness-local stores (see
// track-harvest.ts) and records it. Markers are passive – nothing schedules
// around them, and a failed harvest degrades to a `pending` record that the
// next track invocation retries, never an error for the agent.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ALL_PROVIDER_IDS, acquireLock, releaseLock, SUBTRK_DIR, scrub, scrubValue } from "./core.ts";

// ---------- types ----------

export type Attribution = "session-window" | "window" | "none";

export type TrackStatus = "done" | "aborted" | "failed" | "stale";

export interface TrackUsage {
  in: number; // UNCACHED input (inclusive stores normalized at harvest)
  cr: number;
  cw: number;
  out: number;
  reqs: number;
}

export interface TrackMarker {
  id: string;
  task: string;
  complexity?: string; // xs|s|m|l|xl (declared by the starting agent)
  tags?: string[];
  project: string; // absolute dir resolved at start
  t0: number; // epoch ms
  session?: string; // optional harness session pin (manual)
  providerHint?: string;
}

export interface TrackRecord {
  id: string;
  task: string;
  complexity?: string;
  tags?: string[];
  project: string;
  t0: number;
  t1: number;
  status: TrackStatus;
  attribution: Attribution;
  contested: boolean; // usage window provably overlaps a sibling record
  nested: string | null; // id of the record whose window contains this one
  pending: boolean; // harvest failed – retried on later invocations
  sessions: string[]; // exact session ids summed (zcode), or transcript stems
  usage: TrackUsage | null; // null = no readable local store (attribution "none")
  bySource?: Record<string, TrackUsage>; // zcode:main / zcode:subagent / zcode:compact / claude / codex
  models?: Record<string, number>; // model -> token share 0..1
  wallMs: number;
  note?: string;
}

export interface TrackStore {
  schemaVersion: 1;
  markers: TrackMarker[];
  records: TrackRecord[];
  updatedAt?: number;
}

// What a window harvest returns (track-harvest.ts). `usage` is null when no
// local store was readable – an honest gap, never a machine-wide guess.
export interface HarvestResult {
  attribution: Attribution;
  usage: TrackUsage | null;
  bySource: Record<string, TrackUsage>;
  models: Record<string, number>;
  sessions: string[];
}

export interface HarvestWindow {
  project: string;
  t0: number;
  t1: number;
}

export type HarvestFn = (w: HarvestWindow) => Promise<HarvestResult | null>;

export interface TrackDeps {
  subtrkDir?: string; // override ~/.subtrk (tests)
  homeDir?: string; // harness-store root override (tests)
  cwd?: () => string; // default process.cwd()
  now?: () => number;
  harvest?: HarvestFn; // default: the real local-store harvest, lazily imported
}

const TRACK_SCHEMA_VERSION = 1;
const WRITE_RETRIES = [25, 50, 75, 100];
const PRUNE_DEFAULT_MS = 3 * 86_400_000;
const STALE_AFTER_MS = 6 * 3_600_000;
const COMPLEXITIES = new Set(["xs", "s", "m", "l", "xl"]);
const STATUSES = new Set(["done", "aborted", "failed", "stale"]);
const DURATION_RE = /^(\d{1,3})([dhm])$/;

// Store keys derived from (untrusted) harness store content must not resolve
// to Object.prototype – same discipline as usage.ts's PROTO_KEYS (enforced in
// track-harvest.ts, where store data becomes keys).

// ---------- store IO ----------

function emptyStore(): TrackStore {
  return { schemaVersion: TRACK_SCHEMA_VERSION, markers: [], records: [] };
}

export function trackStorePath(subtrkDir: string = SUBTRK_DIR): string {
  return join(subtrkDir, "track.json");
}

// Tolerant read (quota-cache discipline), with one difference: records are
// NOT re-derivable, so a version-mismatched file is parked as track.json.bak
// instead of silently discarded.
export function readTrackStore(subtrkDir: string = SUBTRK_DIR): TrackStore {
  const path = trackStorePath(subtrkDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(text) as TrackStore | null;
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== TRACK_SCHEMA_VERSION) {
      parkBackup(path, text);
      return emptyStore();
    }
    return {
      schemaVersion: TRACK_SCHEMA_VERSION,
      markers: Array.isArray(parsed.markers) ? parsed.markers : [],
      records: Array.isArray(parsed.records) ? parsed.records : [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    parkBackup(path, text);
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
    return emptyStore();
  }
}

function parkBackup(path: string, text: string): void {
  try {
    writeFileSync(`${path}.bak`, text);
  } catch {
    /* best effort – a lost backup must not block the fresh store */
  }
}

// Temp file + rename, 4 retries with short sleeps, then silent give-up (the
// writeStoreAtomic discipline: a lost write costs one future re-apply).
function writeStoreAtomic(path: string, store: TrackStore): void {
  const payload = JSON.stringify(store);
  const tmp = `${path}.${process.pid}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, path);
      return;
    } catch {
      if (attempt >= WRITE_RETRIES.length) return;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRIES[attempt]);
      } catch {
        /* not allowed on this thread – retry immediately */
      }
    }
  }
}

// Locked read-modify-write, the ONLY writer (mutateUsageStore discipline).
export function mutateTrackStore(
  subtrkDir: string,
  // biome-ignore lint/suspicious/noConfusingVoidType: mutators usually return nothing; an explicit `false` means "nothing changed, skip the write"
  mutator: (store: TrackStore) => boolean | void,
  nowMs: number = Date.now(),
): boolean {
  const path = trackStorePath(subtrkDir);
  const lockPath = `${path}.lock`;
  if (!acquireLock(lockPath)) return false;
  try {
    const store = readTrackStore(subtrkDir);
    if (mutator(store) === false) return true;
    store.updatedAt = nowMs;
    writeStoreAtomic(path, store);
    return true;
  } finally {
    releaseLock(lockPath);
  }
}

// ---------- helpers ----------

function newTrackId(): string {
  return `trk_${randomBytes(4).toString("hex")}`;
}

function normalizeDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function usageTotal(u: TrackUsage): number {
  return u.in + u.cr + u.cw + u.out;
}

function usageTot(r: HarvestResult | null): TrackUsage | null {
  if (!r?.usage || usageTotal(r.usage) <= 0) return null;
  return r.usage;
}

function fmtTok(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtDur(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// `24h` / `60m` / `3d` -> ms (prune --before convention).
export function parseDurationMs(value: string): number | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitMs = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
  return n * unitMs;
}

// Full deterministic pass over the record set: containment marks the inner
// record `nested` (stats read leaves only); provable overlap between records
// that both carry usage marks BOTH `contested`. A nested pair is not also
// contested – nesting is the more specific truth.
function recomputeFlags(records: TrackRecord[]): void {
  for (const r of records) {
    r.contested = false;
    r.nested = null;
  }
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      if (normalizeDir(a.project) !== normalizeDir(b.project)) continue;
      const aContainsB = a.t0 <= b.t0 && b.t1 <= a.t1;
      const bContainsA = b.t0 <= a.t0 && a.t1 <= b.t1;
      if (aContainsB || bContainsA) {
        const inner = aContainsB ? b : a;
        const outer = aContainsB ? a : b;
        if (inner.nested === null) inner.nested = outer.id;
        continue;
      }
      if (a.usage === null || b.usage === null) continue; // overlap without numbers cannot be contested usage
      if (a.t0 >= b.t1 || b.t0 >= a.t1) continue; // no overlap
      // Both session-attributed: contested only when they summed shared sessions.
      if (a.attribution === "session-window" && b.attribution === "session-window") {
        const shared = a.sessions.some((s) => b.sessions.includes(s));
        if (!shared) continue;
      }
      a.contested = true;
      b.contested = true;
    }
  }
}

async function defaultHarvest(w: HarvestWindow, homeDir?: string): Promise<HarvestResult | null> {
  const mod = await import("./track-harvest.ts");
  return mod.harvestWindow(w, { homeDir });
}

function depsHarvest(deps: TrackDeps): HarvestFn {
  if (deps.harvest) return deps.harvest;
  return (w) => defaultHarvest(w, deps.homeDir);
}

// ---------- verbs ----------

export interface TrackArgs {
  sub: string;
  json: boolean;
  task?: string;
  complexity?: string;
  tags?: string;
  project?: string;
  session?: string;
  providerHint?: string;
  status?: string;
  note?: string;
  id?: string;
  before?: string;
  all?: boolean;
  days?: string;
}

const USAGE_HINT = "help: subtrk track start|stop|status|list|prune --help";

export async function trackCommand(args: TrackArgs, deps: TrackDeps = {}): Promise<number> {
  const dir = deps.subtrkDir ?? SUBTRK_DIR;
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? (() => process.cwd());
  const harvest = depsHarvest(deps);
  switch (args.sub) {
    case "start":
      return startTrack(args, { dir, now, cwd });
    case "stop":
      return stopTrack(args, { dir, now, harvest, cwd });
    case "status":
      return statusTrack(args, { dir, now, harvest });
    case "list":
      return listTrack(args, { dir, now, harvest });
    case "prune":
      return pruneTrack(args, { dir, now, harvest });
    default:
      console.error(`subtrk: unknown track command '${args.sub}' – try subtrk --help`);
      return 2;
  }
}

interface VerbCtx {
  dir: string;
  now: () => number;
  harvest?: HarvestFn;
  cwd?: () => string;
}

function startTrack(args: TrackArgs, ctx: VerbCtx): number {
  const task = args.task?.trim() ?? "";
  if (task === "") {
    console.error("subtrk: track start needs --task <short description>");
    return 2;
  }
  if (args.complexity !== undefined && !COMPLEXITIES.has(args.complexity)) {
    console.error(`subtrk: --complexity must be one of xs, s, m, l, xl (got '${args.complexity}')`);
    return 2;
  }
  if (args.providerHint !== undefined && !(ALL_PROVIDER_IDS as readonly string[]).includes(args.providerHint)) {
    console.error(`subtrk: unknown provider '${args.providerHint}'`);
    return 2;
  }
  const nowMs = ctx.now();
  const project = resolve(args.project ?? (ctx.cwd ?? (() => process.cwd()))());
  const marker: TrackMarker = {
    id: newTrackId(),
    task,
    complexity: args.complexity,
    tags: args.tags
      ? args.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8)
      : undefined,
    project,
    t0: nowMs,
    session: args.session?.trim() || undefined,
    providerHint: args.providerHint,
  };
  let existingOpen: TrackMarker[] = [];
  const applied = mutateTrackStore(
    ctx.dir,
    (store) => {
      existingOpen = store.markers.filter(
        (m) => normalizeDir(m.project) === normalizeDir(project) && m.id !== marker.id,
      );
      store.markers.push(marker);
    },
    nowMs,
  );
  if (!applied) {
    console.error("subtrk: track store busy – marker not written, re-run track start");
    return 1;
  }
  if (args.json) {
    console.log(JSON.stringify(scrubValue({ schemaVersion: 1, marker, existingOpen: existingOpen.map((m) => m.id) })));
  } else {
    console.log(scrub(`${marker.id}  marker open · ${marker.project}`));
    console.log(scrub(`stop with: subtrk track stop --id ${marker.id}`));
    for (const m of existingOpen) {
      console.log(scrub(`note: ${m.id} is still open here (${m.task}) – stop or prune it first`));
    }
  }
  return 0;
}

// Build the record for a closed marker. Harvest failures degrade to a pending
// record (usage null, retried later) – never an error for the caller.
async function closeMarker(
  marker: TrackMarker,
  status: TrackStatus,
  note: string | undefined,
  ctx: Required<Pick<VerbCtx, "dir" | "now">> & { harvest: HarvestFn },
): Promise<TrackRecord> {
  const t1 = ctx.now();
  let result: HarvestResult | null = null;
  let pending = false;
  try {
    result = await ctx.harvest({ project: marker.project, t0: marker.t0, t1 });
  } catch {
    pending = true;
  }
  const usage = pending ? null : usageTot(result);
  const record: TrackRecord = {
    id: marker.id,
    task: marker.task,
    complexity: marker.complexity,
    tags: marker.tags,
    project: marker.project,
    t0: marker.t0,
    t1,
    status,
    attribution: usage === null ? "none" : (result?.attribution ?? "none"),
    contested: false,
    nested: null,
    pending: pending || usage === null,
    sessions: usage === null ? [] : (result?.sessions ?? []),
    usage,
    bySource: usage === null ? undefined : result?.bySource,
    models: usage === null ? undefined : result?.models,
    wallMs: t1 - marker.t0,
    note: note?.trim() || undefined,
  };
  mutateTrackStore(
    ctx.dir,
    (store) => {
      store.markers = store.markers.filter((m) => m.id !== marker.id);
      store.records.push(record);
      recomputeFlags(store.records);
    },
    t1,
  );
  return record;
}

function recordLines(r: TrackRecord): string[] {
  const task = r.task.length > 48 ? `${r.task.slice(0, 47)}…` : r.task;
  const bits: string[] = [`${r.id}  ${r.status}  ${task}`];
  if (r.complexity) bits.push(r.complexity);
  bits.push(fmtDur(r.wallMs));
  if (r.usage) {
    const u = r.usage;
    bits.push(`in ${fmtTok(u.in)} · cr ${fmtTok(u.cr)} · cw ${fmtTok(u.cw)} · out ${fmtTok(u.out)}`);
    bits.push(`(tot ${fmtTok(usageTotal(u))})`);
    bits.push(r.attribution);
    bits.push(`${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"}`);
  } else if (r.pending) {
    bits.push("pending harvest");
  } else {
    bits.push("no local usage data");
  }
  const flags: string[] = [];
  if (r.contested) flags.push("contested");
  if (r.nested !== null) flags.push(`nested in ${r.nested}`);
  if (flags.length > 0) bits.push(`[${flags.join(", ")}]`);
  return [scrub(bits.join("  "))];
}

async function stopTrack(args: TrackArgs, ctx: VerbCtx & { harvest: HarvestFn; cwd: () => string }): Promise<number> {
  const status = args.status ?? "done";
  if (!STATUSES.has(status) || status === "stale") {
    console.error("subtrk: --status must be done, aborted or failed (stale is set by track prune)");
    return 2;
  }
  const store = readTrackStore(ctx.dir);
  let marker: TrackMarker | undefined;
  if (args.id !== undefined) {
    marker = store.markers.find((m) => m.id === args.id);
    if (!marker) {
      console.error(`subtrk: no open track '${args.id}'`);
      return 1;
    }
  } else {
    const project = normalizeDir(resolve(ctx.cwd()));
    const candidates = store.markers.filter((m) => normalizeDir(m.project) === project);
    marker = candidates.at(-1);
    if (!marker) {
      console.error(`subtrk: no open track for ${project}`);
      return 1;
    }
  }
  const record = await closeMarker(marker, status as TrackStatus, args.note, {
    dir: ctx.dir,
    now: ctx.now,
    harvest: ctx.harvest,
  });
  if (args.json) {
    console.log(JSON.stringify(scrubValue({ schemaVersion: 1, record })));
  } else {
    for (const line of recordLines(record)) console.log(line);
    console.log(USAGE_HINT);
  }
  return 0;
}

// Retry pending harvests (bounded) – the recovery path for a store that was
// busy or unreadable at stop time. Newest first, at most three per call.
async function retryPending(dir: string, now: () => number, harvest: HarvestFn): Promise<number> {
  const store = readTrackStore(dir);
  const pending = store.records
    .filter((r) => r.pending && r.usage === null)
    .sort((a, b) => b.t1 - a.t1)
    .slice(0, 3);
  let recovered = 0;
  for (const rec of pending) {
    let result: HarvestResult | null = null;
    try {
      result = await harvest({ project: rec.project, t0: rec.t0, t1: rec.t1 });
    } catch {
      continue;
    }
    const usage = usageTot(result);
    if (usage === null) continue;
    const ok = mutateTrackStore(
      dir,
      (s) => {
        const target = s.records.find((r) => r.id === rec.id);
        if (!target?.pending) return false;
        target.pending = false;
        target.usage = usage;
        target.attribution = result?.attribution ?? "none";
        target.sessions = result?.sessions ?? [];
        target.bySource = result?.bySource;
        target.models = result?.models;
        recomputeFlags(s.records);
      },
      now(),
    );
    if (ok) recovered++;
  }
  return recovered;
}

async function statusTrack(args: TrackArgs, ctx: VerbCtx & { harvest: HarvestFn }): Promise<number> {
  const nowMs = ctx.now();
  await retryPending(ctx.dir, ctx.now, ctx.harvest);
  const store = readTrackStore(ctx.dir);
  if (args.json) {
    console.log(
      JSON.stringify(
        scrubValue({ schemaVersion: 1, markers: store.markers, pending: store.records.filter((r) => r.pending) }),
      ),
    );
    return 0;
  }
  if (store.markers.length === 0 && !store.records.some((r) => r.pending)) {
    console.log("no open tracks");
    console.log(USAGE_HINT);
    return 0;
  }
  for (const m of [...store.markers].sort((a, b) => a.t0 - b.t0)) {
    const age = nowMs - m.t0;
    const stale = age > STALE_AFTER_MS ? "  [stale?]" : "";
    const cx = m.complexity ? ` ${m.complexity}` : "";
    console.log(scrub(`${m.id}  ${fmtDur(age)} open${cx}${stale}  ${m.task}  ·  ${m.project}`));
  }
  for (const r of store.records.filter((r) => r.pending)) {
    console.log(scrub(`${r.id}  pending harvest (${r.status})  ·  ${r.task}`));
  }
  console.log(USAGE_HINT);
  return 0;
}

async function listTrack(args: TrackArgs, ctx: VerbCtx & { harvest: HarvestFn }): Promise<number> {
  let daysN = 30;
  if (args.days !== undefined) {
    if (!/^\d+$/.test(args.days) || Number(args.days) < 1 || Number(args.days) > 365) {
      console.error("subtrk: --days must be an integer between 1 and 365");
      return 2;
    }
    daysN = Number(args.days);
  }
  const nowMs = ctx.now();
  await retryPending(ctx.dir, ctx.now, ctx.harvest);
  const store = readTrackStore(ctx.dir);
  const fromMs = nowMs - daysN * 86_400_000;
  const records = store.records.filter((r) => r.t1 >= fromMs).sort((a, b) => b.t1 - a.t1);
  if (args.json) {
    console.log(JSON.stringify(scrubValue({ schemaVersion: 1, days: daysN, records })));
    return 0;
  }
  if (records.length === 0) {
    console.log(`no tracked tasks in the last ${daysN}d`);
    console.log(USAGE_HINT);
    return 0;
  }
  for (const r of records) {
    for (const line of recordLines(r))
      console.log(`${new Date(r.t1).toISOString().slice(0, 16).replace("T", " ")}  ${line}`);
  }
  console.log(USAGE_HINT);
  return 0;
}

async function pruneTrack(args: TrackArgs, ctx: VerbCtx & { harvest: HarvestFn }): Promise<number> {
  if (args.all && args.before !== undefined) {
    console.error("subtrk: --all and --before are mutually exclusive");
    return 2;
  }
  let cutoffMs = PRUNE_DEFAULT_MS;
  if (args.all) {
    cutoffMs = 0; // every open marker is at least 0ms old
  } else if (args.before !== undefined) {
    const parsed = parseDurationMs(args.before);
    if (parsed === null) {
      console.error("subtrk: --before must look like 24h, 60m or 3d");
      return 2;
    }
    cutoffMs = parsed;
  }
  const nowMs = ctx.now();
  const store = readTrackStore(ctx.dir);
  const doomed = store.markers.filter((m) => nowMs - m.t0 >= cutoffMs);
  if (doomed.length === 0) {
    console.log(args.json ? JSON.stringify({ schemaVersion: 1, pruned: [] }) : "nothing to prune");
    return 0;
  }
  const closed: TrackRecord[] = [];
  for (const m of doomed) {
    closed.push(
      await closeMarker(m, "stale", `pruned after ${fmtDur(nowMs - m.t0)}`, {
        dir: ctx.dir,
        now: ctx.now,
        harvest: ctx.harvest,
      }),
    );
  }
  if (args.json) {
    console.log(JSON.stringify(scrubValue({ schemaVersion: 1, pruned: closed.map((r) => r.id) })));
  } else {
    for (const r of closed) {
      for (const line of recordLines(r)) console.log(`pruned  ${line}`);
    }
  }
  return 0;
}
