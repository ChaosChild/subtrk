// usage.ts – M3 usage store (docs/spec.md §Usage store): ~/.subtrk/usage.json
// holds immutable token history per provider/model in UTC hour and day buckets,
// per-window % samples from every probe, and a weekly pricing cache. Three
// write semantics keep concurrent agents from double counting:
//   replace-range  – range/time-series APIs (glm, openrouter) overwrite the
//                    bucket keys they fetched, so refetching the same range is
//                    a no-op;
//   delta-watermark – cumulative counters (zcode used_units) add only the
//                    increase over the stored watermark, evaluated INSIDE the
//                    locked read-modify-write;
//   file-offset    – local transcripts (claude overlay, later PR) use byte
//                    offsets; re-derivable buckets have `subtrk usage --rebuild`.
// Applies are serialized through the same existence-only lockfile discipline as
// cache.json. Harvest rides collectStatus callers (every CLI status call and
// every dashboard refresh), is best-effort, and never fails or blocks them:
// failures land in the summary, watermarks only advance together with the
// buckets they produced. The store never holds secrets.

import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, errorMessage, getSecret, type ProviderResult, releaseLock, SUBTRK_DIR } from "./core.ts";
import { extractJson } from "./providers/alibaba.ts";
import { glmAuth } from "./providers/glm.ts";
import { fetchZcodeBalance, zcodeBuckets } from "./providers/zcode.ts";
import { fallbackPriceFor, normalizeModelKey, perToken } from "./usage-pricing.ts";

// ---------- types ----------

// One bucket cell per model. `in` is UNCACHED input; `cr` cache-read input;
// `cw` cache-write input; `tot` is a split-less total (zcode). `usd` is a
// vendor-ACTUAL cost (openrouter activity, openai wham) – estimates are always
// computed at read time so a pricing refresh reprices history.
export interface UsageRow {
  in?: number;
  cw?: number;
  cr?: number;
  out?: number;
  tot?: number;
  req?: number;
  usd?: number;
  pct?: number; // plan-usage percent for a day/model (openai wham) – informational, never summed
}

export interface UsageSample {
  t: number; // epoch ms
  k: string; // window key: kind, or "kind·scope" for scoped windows
  u: number; // used percent 0–100
  r: string; // resetsAt ISO – distinguishes generations of the same window
  sf?: { key: string; name: string; percent: number }[]; // claude per-surface mix
  stale?: boolean; // observed via error-fallback (the vendor's last-known value)
}

export interface ModelPrice {
  in: number;
  out: number;
  cr?: number;
  cw?: number;
}

export interface UsageStore {
  schemaVersion: 1;
  hourly: Record<string, Record<string, Record<string, UsageRow>>>; // provider -> hourKey -> model -> row (vendor-served)
  daily: Record<string, Record<string, Record<string, UsageRow>>>; // provider -> dayKey -> model -> row (vendor-served)
  // This-machine token harvests (claude transcripts, codex rollouts) live in
  // their own sections: they are real tokens but cover only this machine, so
  // month-to-date totals exclude them and the drill-downs show them labeled.
  localHourly: Record<string, Record<string, Record<string, UsageRow>>>;
  localDaily: Record<string, Record<string, Record<string, UsageRow>>>;
  samples: Record<string, UsageSample[]>;
  state: Record<string, Record<string, unknown>>; // per-source watermarks (never secrets)
  pricing: { fetchedAt?: number; usdPerTok?: Record<string, ModelPrice> };
  updatedAt?: number;
}

const USAGE_SCHEMA_VERSION = 1;
const HOURLY_RETENTION_MS = 90 * 86_400_000;
const SAMPLE_RETENTION_MS = 35 * 86_400_000;
const PRICING_TTL_MS = 7 * 86_400_000;
const GLM_TTL_MS = 15 * 60_000;
const OR_ACTIVITY_TTL_MS = 6 * 3_600_000;
const OR_ANALYTICS_TTL_MS = 15 * 60_000;
const OR_ACTIVITY_RANGE_MS = 30 * 86_400_000; // vendor retention: last 30 completed UTC days
const OR_ANALYTICS_WINDOW_MS = 48 * 3_600_000;
const GLM_HOURLY_WINDOW_MS = 2 * 86_400_000; // chunks stay < the vendor's hourly/daily switch (~7d)
const GLM_BACKFILL_MS = 30 * 86_400_000;
const ZCODE_TTL_MS = 10 * 60_000;
const WRITE_RETRIES = [25, 50, 75, 100];

// ---------- bucket keys (UTC) ----------

export function hourKey(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}`.padStart(4, "0") +
    "-" +
    `${d.getUTCMonth() + 1}`.padStart(2, "0") +
    "-" +
    `${d.getUTCDate()}`.padStart(2, "0") +
    "T" +
    `${d.getUTCHours()}`.padStart(2, "0")
  );
}

export function dayKey(ms: number): string {
  return hourKey(ms).slice(0, 10);
}

export function hourKeyToMs(key: string): number {
  return Date.parse(`${key}:00:00Z`);
}

export function dayKeyToMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

// GLM label frames: the monitor endpoints bucket in the frame of the request's
// startTime/endTime (live-verified 2026-09-29), and we send local-machine time,
// so Node's local-frame Date.parse of "YYYY-MM-DD HH:00:00" is the right instant.
function localLabelToMs(label: string): number {
  return Date.parse(label.includes("T") ? label : label.replace(" ", "T"));
}

// OpenRouter labels are UTC ("2026-09-28 00:00:00").
function utcLabelToMs(label: string): number {
  return Date.parse(`${label.replace(" ", "T")}Z`);
}

// ---------- store IO ----------

function emptyStore(): UsageStore {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    hourly: {},
    daily: {},
    localHourly: {},
    localDaily: {},
    samples: {},
    state: {},
    pricing: {},
  };
}

export function usageStorePath(subtrkDir: string = SUBTRK_DIR): string {
  return join(subtrkDir, "usage.json");
}

// Tolerant read: absent, corrupt, or schema-mismatched files come back as a
// fresh store (the quota-cache discipline). Reads need no lock – writers land
// atomically via temp+rename.
export function readUsageStore(subtrkDir: string = SUBTRK_DIR): UsageStore {
  let text: string;
  try {
    text = readFileSync(usageStorePath(subtrkDir), "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(text) as UsageStore | null;
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== USAGE_SCHEMA_VERSION) return emptyStore();
    return {
      schemaVersion: USAGE_SCHEMA_VERSION,
      hourly: parsed.hourly ?? {},
      daily: parsed.daily ?? {},
      localHourly: parsed.localHourly ?? {},
      localDaily: parsed.localDaily ?? {},
      samples: parsed.samples ?? {},
      state: parsed.state ?? {},
      pricing: parsed.pricing ?? {},
      updatedAt: parsed.updatedAt,
    };
  } catch {
    try {
      rmSync(usageStorePath(subtrkDir), { force: true });
    } catch {
      /* best effort */
    }
    return emptyStore();
  }
}

// Get-or-create for the string-keyed maps the store is built from – kept as a
// helper because `x[k] ??= {}` inside an expression trips the linter.
function ensure<T>(rec: Record<string, T>, key: string): T {
  if (!rec[key]) rec[key] = {} as T;
  return rec[key];
}

// Locked read-modify-write: the ONLY writer. The mutator both applies buckets
// and advances watermarks so a lost lock (another process holds it) skips both
// and the next harvest redoes the work. Returns false when the lock was busy.
export function mutateUsageStore(
  subtrkDir: string,
  // biome-ignore lint/suspicious/noConfusingVoidType: mutators usually return nothing; an explicit `false` means "nothing changed, skip the write"
  mutator: (store: UsageStore) => boolean | void,
  nowMs: number = Date.now(),
): boolean {
  const path = usageStorePath(subtrkDir);
  const lockPath = `${path}.lock`;
  if (!acquireLock(lockPath)) return false;
  try {
    const store = readUsageStore(subtrkDir);
    if (mutator(store) === false) return true;
    pruneStore(store, nowMs);
    store.updatedAt = nowMs;
    writeStoreAtomic(path, store);
    return true;
  } finally {
    releaseLock(lockPath);
  }
}

// Temp file + rename, 4 retries with short sleeps, then silent give-up – a
// lost write costs one future re-apply, never an error (writeCacheEntry
// discipline). Atomics.wait sleeps the thread without burning CPU.
function writeStoreAtomic(path: string, store: UsageStore): void {
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

function pruneStore(store: UsageStore, nowMs: number): void {
  const hourlyCutoff = hourKey(nowMs - HOURLY_RETENTION_MS);
  for (const provider of Object.keys(store.hourly)) {
    for (const key of Object.keys(store.hourly[provider])) {
      if (key < hourlyCutoff) delete store.hourly[provider][key];
    }
    if (Object.keys(store.hourly[provider]).length === 0) delete store.hourly[provider];
  }
  for (const provider of Object.keys(store.samples)) {
    const kept = store.samples[provider].filter((s) => nowMs - s.t <= SAMPLE_RETENTION_MS);
    if (kept.length > 0) store.samples[provider] = kept;
    else delete store.samples[provider];
  }
}

// ---------- pure bucket ops (exported for tests) ----------

// Replace whole day keys for one provider: a fetched range carries the FULL
// model set per day, so overwriting the key is idempotent under refetch.
export function replaceDailyRows(
  store: UsageStore,
  provider: string,
  days: Record<string, Record<string, UsageRow>>,
): void {
  const cur = ensure(store.daily, provider);
  for (const key of Object.keys(days)) cur[key] = days[key];
}

// Replace a closed hourly range for one provider: keys inside [fromMs,toMs]
// that the fetch did not report are ZERO usage and get deleted, present ones
// are overwritten.
export function replaceHourlyRange(
  store: UsageStore,
  provider: string,
  fromMs: number,
  toMs: number,
  hours: Record<string, Record<string, UsageRow>>,
): void {
  const cur = ensure(store.hourly, provider);
  const fromKey = hourKey(fromMs);
  const toKey = hourKey(toMs);
  for (const key of Object.keys(cur)) {
    if (key >= fromKey && key <= toKey) delete cur[key];
  }
  for (const key of Object.keys(hours)) {
    if (key >= fromKey && key <= toKey) cur[key] = hours[key];
  }
}

// Delta-watermark consumer: adds to whatever the bucket already holds.
export function addDelta(store: UsageStore, provider: string, hKey: string, model: string, delta: UsageRow): void {
  const hours = ensure(store.hourly, provider);
  const bucket = ensure(hours, hKey);
  const row = ensure(bucket, model);
  for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
    const v = delta[field];
    if (v === undefined) continue;
    row[field] = (row[field] ?? 0) + v;
  }
}

// Sample one probe round: append when a window's usage moved (or >15 min
// passed), replace sub-minute doubles, ignore repeats. Window generations are
// distinguished by resetsAt so post-reset usage starts a fresh series. Stale
// error-fallback results ARE sampled (their windows are the vendor's
// last-known values) and flagged `stale`; windows whose generation has already
// reset are skipped in both cases – replaying them at "now" would plot a dead
// window's usage on today's timeline (the phantom-row bug).
export function recordSamples(store: UsageStore, results: ProviderResult[], nowMs: number): boolean {
  let changed = false;
  for (const result of results) {
    if (!Array.isArray(result.windows)) continue;
    const stale = result.ok !== true;
    if (!store.samples[result.id]) store.samples[result.id] = []; // arrays, not objects
    const list = store.samples[result.id];
    for (const w of result.windows) {
      const resetMs = Date.parse(w.resetsAt);
      if (Number.isFinite(resetMs) && resetMs <= nowMs) continue; // dead generation
      const u = w.usedPercent ?? (w.remainingFraction !== undefined ? (1 - w.remainingFraction) * 100 : undefined);
      if (u === undefined || !Number.isFinite(u)) continue;
      const k = w.scope ? `${w.kind}·${w.scope}` : w.kind;
      const sample: UsageSample = { t: nowMs, k, u: Math.round(u * 100) / 100, r: w.resetsAt };
      if (stale) sample.stale = true;
      const surfaces = result.surfaces;
      if (surfaces && surfaces.length > 0) sample.sf = surfaces;
      let lastIdx = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].k === k && list[i].r === w.resetsAt) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) {
        const last = list[lastIdx];
        const sameSurfaceMix = JSON.stringify(last.sf ?? null) === JSON.stringify(sample.sf ?? null);
        if (
          nowMs - last.t < 60_000 ||
          (Math.abs(last.u - sample.u) < 0.05 && sameSurfaceMix && nowMs - last.t < 15 * 60_000)
        ) {
          list[lastIdx] = sample;
          changed = true;
          continue;
        }
      }
      list.push(sample);
      changed = true;
    }
  }
  return changed;
}

// ---------- pricing ----------

// OpenRouter slug prefixes for vendor model keys, longest first.
const OR_PREFIXES: [RegExp, string][] = [
  [/^moonshot/, "moonshotai"],
  [/^deepseek/, "deepseek"],
  [/^claude/, "anthropic"],
  [/^(gpt|o[134]|chatgpt)/, "openai"],
  [/^(gemini|gemma)/, "google"],
  [/^glm/, "z-ai"],
  [/^qwen/, "qwen"],
  [/^grok/, "x-ai"],
  [/^(llama|meta)/, "meta-llama"],
  [/^(mistral|mixtral)/, "mistralai"],
];

export interface ResolvedPrice {
  price: ModelPrice;
  source: "openrouter" | "fallback";
}

// Resolve a vendor model key ("GLM-5.3", "glm-5-3", "anthropic/claude-opus-5.5")
// to a per-token price: the refreshed OpenRouter list first, the bundled vendor
// table second, null when honestly unpriced.
export function priceForModel(store: UsageStore, model: string): ResolvedPrice | null {
  const p = store.pricing.usdPerTok ?? {};
  if (Object.keys(p).length > 0) {
    const raw = model.toLowerCase().trim();
    if (p[raw]) return { price: p[raw], source: "openrouter" };
    // Dots, dashes and vendor prefixes all normalize away: "GLM-5.3" and the
    // slugified scope "glm-5-3" both resolve to the "z-ai/glm-5.3" slug.
    const key = normalizeModelKey(model);
    for (const [re, prefix] of OR_PREFIXES) {
      if (!re.test(key)) continue;
      for (const slug of Object.keys(p)) {
        if (!slug.startsWith(`${prefix}/`)) continue;
        if (normalizeModelKey(slug.slice(prefix.length + 1)) === key) return { price: p[slug], source: "openrouter" };
      }
    }
    for (const slug of Object.keys(p)) {
      const slash = slug.indexOf("/");
      const slugModel = slash >= 0 ? slug.slice(slash + 1) : slug;
      if (normalizeModelKey(slugModel) === key) return { price: p[slug], source: "openrouter" };
    }
  }
  const fb = fallbackPriceFor(model);
  return fb ? { price: perToken(fb), source: "fallback" } : null;
}

// Row cost: vendor-actual `usd` wins; else tokens × price; null = unpriced.
export function rowCost(row: UsageRow, price: ModelPrice | null): { usd: number; kind: "actual" | "estimate" } | null {
  if (row.usd !== undefined && Number.isFinite(row.usd)) return { usd: row.usd, kind: "actual" };
  if (!price) return null;
  const uncachedIn = row.in ?? 0;
  const cr = row.cr ?? 0;
  const cw = row.cw ?? 0;
  const out = row.out ?? 0;
  return {
    usd: uncachedIn * price.in + cr * (price.cr ?? 0) + cw * (price.cw ?? price.in) + out * price.out,
    kind: "estimate",
  };
}

// The observed z.ai in/cache/out mix (Q2 decision): zcode bundles are total-
// token only, and the operator's zcode traffic rides the same models on the
// same projects as the GLM plan, so the GLM plan's own split prices it –
// always labeled an estimate.
export function glmMixFromStore(
  store: UsageStore,
  fromMs: number,
  toMs: number,
): { in: number; cr: number; out: number } | null {
  let inSum = 0;
  let crSum = 0;
  let outSum = 0;
  const accumulate = (levels: Record<string, Record<string, UsageRow>>) => {
    const prov = levels.glm;
    if (!prov) return;
    for (const key of Object.keys(prov)) {
      const ms = key.includes("T") ? hourKeyToMs(key) : dayKeyToMs(key);
      if (ms < fromMs || ms > toMs) continue;
      for (const row of Object.values(prov[key])) {
        inSum += row.in ?? 0;
        crSum += row.cr ?? 0;
        outSum += row.out ?? 0;
      }
    }
  };
  accumulate(store.daily);
  accumulate(store.hourly);
  const total = inSum + crSum + outSum;
  if (total <= 0) return null;
  return { in: inSum / total, cr: crSum / total, out: outSum / total };
}

// ---------- aggregation (read side) ----------

export interface UsageTotals {
  in: number;
  cr: number;
  cw: number;
  out: number;
  tot: number;
  req: number;
  usdActual: number;
  usdEst: number;
  cacheHit: number | null;
}

export interface ModelUsage {
  model: string;
  in: number;
  cr: number;
  cw: number;
  out: number;
  tot: number;
  req: number;
  usd: number | null;
  usdKind: "actual" | "estimate" | "blended" | null;
  pct?: number; // vendor-reported plan-usage percent (openai wham daily rows)
}

export interface ProviderUsage extends UsageTotals {
  models: ModelUsage[];
  unpriced: string[];
  series: { t: string; in: number; cr: number; cw: number; out: number; tot: number; req: number }[];
  splitless: boolean; // rows carry only `tot` (zcode) – the UI renders table-only
  hasLocal: boolean; // this-machine rows are merged in (claude transcripts, codex rollouts)
  samples: UsageSample[]; // window-% history in range (the chart for %-only providers)
}

export interface UsageAggregate {
  fromMs: number;
  toMs: number;
  granularity: "day" | "hour";
  providers: Record<string, ProviderUsage>;
}

function emptyTotals(): UsageTotals {
  return { in: 0, cr: 0, cw: 0, out: 0, tot: 0, req: 0, usdActual: 0, usdEst: 0, cacheHit: null };
}

function addRow(totals: UsageTotals, row: UsageRow): void {
  totals.in += row.in ?? 0;
  totals.cr += row.cr ?? 0;
  totals.cw += row.cw ?? 0;
  totals.out += row.out ?? 0;
  totals.tot += row.tot ?? 0;
  totals.req += row.req ?? 0;
}

function finalizeCacheHit(totals: UsageTotals): void {
  const denom = totals.cr + totals.in;
  totals.cacheHit = denom > 0 ? totals.cr / denom : null;
}

// Merge one day/hour of model rows (openai: vendor rows carry the plan-%
// while local rows carry tokens – one model row ends up holding both). Token
// fields sum; pct is informational.
function mergedDayRows(
  a: Record<string, UsageRow> | undefined,
  b: Record<string, UsageRow> | undefined,
): Record<string, UsageRow> {
  if (!a || Object.keys(a).length === 0) return b ?? {};
  if (!b || Object.keys(b).length === 0) return a;
  const out: Record<string, UsageRow> = {};
  for (const [model, row] of Object.entries(a)) out[model] = { ...row };
  for (const [model, row] of Object.entries(b)) {
    const t = ensure(out, model);
    for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
      const v = row[field];
      if (v !== undefined) t[field] = (t[field] ?? 0) + v;
    }
    if (row.pct !== undefined) t.pct = Math.max(t.pct ?? 0, row.pct);
  }
  return out;
}

// Merge a vendor-served section with its local counterpart.
function mergedSection(
  a: Record<string, Record<string, UsageRow>> | undefined,
  b: Record<string, Record<string, UsageRow>> | undefined,
): Record<string, Record<string, UsageRow>> {
  if (!a || Object.keys(a).length === 0) return b ?? {};
  if (!b || Object.keys(b).length === 0) return a;
  const out: Record<string, Record<string, UsageRow>> = {};
  for (const [key, rows] of Object.entries(a)) out[key] = { ...rows };
  for (const [key, rows] of Object.entries(b)) {
    out[key] = mergedDayRows(out[key], rows);
  }
  return out;
}

// Aggregate stored buckets over [fromMs,toMs]. Day view prefers daily rows
// (they carry the vendor's authoritative split; glm backfills them beyond the
// hourly window) and falls back to aggregating that day's hourly rows.
// `local` controls the this-machine sections (claude transcripts, codex
// rollouts): "exclude" keeps month-to-date totals vendor-served only,
// "include" merges them into a provider view (labeled hasLocal), "only"
// returns just the local rows for a drill-down's local block.
export function aggregateUsage(
  store: UsageStore,
  opts: {
    provider?: string;
    granularity: "day" | "hour";
    fromMs: number;
    toMs: number;
    local?: "exclude" | "include" | "only";
  },
): UsageAggregate {
  const mode = opts.local ?? "exclude";
  const localKeys = [...Object.keys(store.localDaily), ...Object.keys(store.localHourly)];
  const providers = opts.provider
    ? [opts.provider]
    : mode === "only"
      ? [...new Set(localKeys)]
      : [
          ...new Set([
            ...Object.keys(store.daily),
            ...Object.keys(store.hourly),
            ...(mode === "include" ? localKeys : []),
            ...Object.keys(store.samples),
          ]),
        ];
  const out: Record<string, ProviderUsage> = {};
  const seen = new Set<string>();
  for (const id of providers) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hasLocal = mode !== "exclude" && !!(store.localDaily[id] || store.localHourly[id]);
    const daily =
      mode === "only"
        ? (store.localDaily[id] ?? {})
        : mergedSection(store.daily[id], mode === "include" ? store.localDaily[id] : undefined);
    // Day view aggregates VENDOR hourly only – the local hourly rows are
    // combined once, further down (merging them here AND there double counts).
    const hourlyVendor = store.hourly[id] ?? {};
    const hourly =
      mode === "only"
        ? (store.localHourly[id] ?? {})
        : mode === "include"
          ? mergedSection(store.hourly[id], store.localHourly[id])
          : hourlyVendor;
    const series: ProviderUsage["series"] = [];
    const byModel = new Map<
      string,
      { row: UsageRow; actual: number | null; priced: number | null; kind: ModelUsage["usdKind"]; pct: number | null }
    >();
    const totals = emptyTotals();
    let splitless = true;
    let anyRow = false;

    const consume = (key: string, rows: Record<string, UsageRow>) => {
      anyRow = true;
      const bucketTotals = emptyTotals();
      for (const [model, row] of Object.entries(rows)) {
        if (row.in || row.out || row.cr || row.cw) splitless = false;
        addRow(totals, row);
        addRow(bucketTotals, row);
        const acc = byModel.get(model) ?? {
          row: {},
          actual: null as number | null,
          priced: null as number | null,
          kind: null as ModelUsage["usdKind"],
          pct: null as number | null,
        };
        for (const field of ["in", "cw", "cr", "out", "tot", "req"] as const) {
          const v = row[field];
          if (v !== undefined) acc.row[field] = (acc.row[field] ?? 0) + v;
        }
        if (row.pct !== undefined) acc.pct = Math.max(acc.pct ?? 0, row.pct);
        const resolved = priceForModel(store, model);
        if (row.usd !== undefined) {
          acc.actual = (acc.actual ?? 0) + row.usd;
          acc.kind = "actual";
          totals.usdActual += row.usd;
        } else if (resolved && (row.in || row.cr || row.cw || row.out)) {
          // Split rows price token-by-token; tot-only rows (zcode) fall through
          // to the blended mix below – a $0 estimate would block it.
          const est = rowCost(row, resolved.price);
          if (est && est.kind === "estimate") {
            acc.priced = (acc.priced ?? 0) + est.usd;
            acc.kind = acc.kind === "actual" ? "actual" : "estimate";
            totals.usdEst += est.usd;
          }
        }
        byModel.set(model, acc);
      }
      series.push({
        t: key,
        in: bucketTotals.in,
        cr: bucketTotals.cr,
        cw: bucketTotals.cw,
        out: bucketTotals.out,
        tot: bucketTotals.tot,
        req: bucketTotals.req,
      });
    };

    if (opts.granularity === "day") {
      const fromKey = dayKey(opts.fromMs);
      const toKey = dayKey(opts.toMs);
      // Window edges are instants and can fall mid-UTC-day: the MTD default
      // starts at LOCAL midnight, which is the previous UTC day for any
      // longitude east of UTC. Days built from hourly rows clip to the exact
      // in-window hours; authoritative daily rows stay whole-day (vendor
      // daily granularity cannot be split).
      const firstHour = hourKey(opts.fromMs);
      const lastHour = hourKey(opts.toMs);
      const hourInWindow = (hk: string, dk: string): boolean =>
        (dk !== fromKey || hk >= firstHour) && (dk !== toKey || hk <= lastHour);
      const dayKeys = new Set([...Object.keys(daily), ...Object.keys(hourly).map((k) => k.slice(0, 10))]);
      const sorted = [...dayKeys].filter((k) => k >= fromKey && k <= toKey).sort();
      // include-mode: this-machine hourly rows combine with the vendor rows
      // for the day (openai: pct daily + local tokens; claude: local only).
      // They are NOT pre-merged into `hourly` here – that would double count.
      const localHourly = mode === "include" ? (store.localHourly[id] ?? {}) : {};
      const localAggForDay = (dk: string): Record<string, UsageRow> => {
        const agg: Record<string, UsageRow> = {};
        for (const hk of Object.keys(localHourly)) {
          if (!hk.startsWith(dk) || !hourInWindow(hk, dk)) continue;
          for (const [model, row] of Object.entries(localHourly[hk])) {
            const target = ensure(agg, model);
            for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
              const v = row[field];
              if (v !== undefined) target[field] = (target[field] ?? 0) + v;
            }
          }
        }
        return agg;
      };
      for (const dk of sorted) {
        const vendor = daily[dk]
          ? daily[dk]
          : (() => {
              const agg: Record<string, UsageRow> = {};
              for (const hk of Object.keys(hourlyVendor)) {
                if (!hk.startsWith(dk) || !hourInWindow(hk, dk)) continue;
                for (const [model, row] of Object.entries(hourly[hk])) {
                  const target = ensure(agg, model);
                  for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd", "pct"] as const) {
                    const v = row[field];
                    if (v !== undefined) {
                      if (field === "pct") target.pct = Math.max(target.pct ?? 0, v);
                      else target[field] = (target[field] ?? 0) + v;
                    }
                  }
                }
              }
              return agg;
            })();
        const combined = mode === "include" ? mergedDayRows(vendor, localAggForDay(dk)) : vendor;
        if (Object.keys(combined).length > 0) consume(dk, combined);
      }
    } else {
      const fromKey = hourKey(opts.fromMs);
      const toKey = hourKey(opts.toMs);
      const keys = Object.keys(hourly)
        .filter((k) => k >= fromKey && k <= toKey)
        .sort();
      for (const hk of keys) consume(hk, hourly[hk]);
    }

    const rangeSamples = (store.samples[id] ?? []).filter((s) => s.t >= opts.fromMs && s.t <= opts.toMs);
    if (!anyRow && (mode === "only" || rangeSamples.every((s) => s.t < opts.fromMs || s.t > opts.toMs))) continue;
    finalizeCacheHit(totals);

    // Split-less providers (zcode): price totals with the observed z.ai mix.
    const mix = splitless ? glmMixFromStore(store, opts.fromMs, opts.toMs) : null;
    const models: ModelUsage[] = [];
    const unpriced: string[] = [];
    for (const [model, acc] of byModel) {
      let usd: number | null = null;
      let kind: ModelUsage["usdKind"] = null;
      if (acc.actual !== null) {
        usd = acc.actual;
        kind = "actual";
      } else if (acc.priced !== null) {
        usd = acc.priced;
        kind = "estimate";
      } else if (splitless && mix) {
        const resolved = priceForModel(store, model);
        if (resolved) {
          const t = acc.row.tot ?? 0;
          usd =
            t * mix.in * resolved.price.in + t * mix.cr * (resolved.price.cr ?? 0) + t * mix.out * resolved.price.out;
          kind = "blended";
        }
      }
      if (usd === null && acc.pct === null) unpriced.push(model);
      if (kind === "blended" && usd !== null) totals.usdEst += usd;
      models.push({
        model,
        in: acc.row.in ?? 0,
        cr: acc.row.cr ?? 0,
        cw: acc.row.cw ?? 0,
        out: acc.row.out ?? 0,
        tot: acc.row.tot ?? 0,
        req: acc.row.req ?? 0,
        usd,
        usdKind: kind,
        ...(acc.pct !== null ? { pct: acc.pct } : {}),
      });
    }
    models.sort((a, b) => b.tot + b.in + b.cr + b.out - (a.tot + a.in + a.cr + a.out));
    out[id] = {
      ...totals,
      models,
      unpriced,
      series,
      splitless,
      hasLocal,
      samples: rangeSamples,
    };
  }
  return { fromMs: opts.fromMs, toMs: opts.toMs, granularity: opts.granularity, providers: out };
}

// ---------- harvest ----------

export interface HarvestOpts {
  subtrkDir?: string;
  budgetMs?: number; // overall cap – fetches abort past it, applies already made persist
  envPath?: string; // override ~/.subtrk/env for secret reads (tests)
  now?: number; // injectable clock
  fetchImpl?: typeof fetch; // injectable for tests
}

export interface HarvestSummary {
  applied: string[];
  skipped: string[];
  errors: string[];
  aborted: boolean;
}

interface JobCtx {
  store: () => UsageStore;
  dir: string;
  now: number;
  deadline: number;
  fetchImpl: typeof fetch;
  envPath?: string;
  summary: HarvestSummary;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function timeLeft(ctx: JobCtx): number {
  return ctx.deadline - Date.now();
}

// --- glm: credit-usage/usage-detail (hourly split near now, daily backfill) ---

async function harvestGlm(ctx: JobCtx): Promise<void> {
  const state = ctx.store().state.glm as { at?: number; throughMs?: number; backfilled?: boolean } | undefined;
  if (state?.at && ctx.now - state.at < GLM_TTL_MS) {
    ctx.summary.skipped.push("glm: fresh");
    return;
  }
  const configObj = (() => {
    try {
      return JSON.parse(readFileSync(join(homedir(), ".zcode", "cli", "config.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const envToken = getSecret("ANTHROPIC_AUTH_TOKEN", ctx.envPath);
  const auth = glmAuth(configObj, envToken);
  if (!auth) {
    ctx.summary.skipped.push("glm: no credentials");
    return;
  }
  const dayMs = 86_400_000;
  const fetchWindows: { fromMs: number; toMs: number; daily: boolean }[] = [];
  const backfilled = state?.backfilled === true;
  if (!backfilled) {
    fetchWindows.push({ fromMs: ctx.now - GLM_BACKFILL_MS, toMs: ctx.now - 2 * dayMs, daily: true });
  }
  const hourlyFrom = Math.max(
    ctx.now - GLM_HOURLY_WINDOW_MS,
    state?.throughMs ? state.throughMs - 3 * 3_600_000 : ctx.now - GLM_HOURLY_WINDOW_MS,
  );
  fetchWindows.push({ fromMs: hourlyFrom, toMs: ctx.now, daily: false });

  const dailyOut: Record<string, Record<string, UsageRow>> = {};
  const hourlyOut: Record<string, Record<string, UsageRow>> = {};
  let hourlyTo = ctx.now;
  for (const win of fetchWindows) {
    if (timeLeft(ctx) < 1_500) {
      ctx.summary.aborted = true;
      break;
    }
    const url =
      `${auth.host}/api/monitor/credit-usage/usage-detail?type=1&usageType=MODEL` +
      `&startTime=${encodeURIComponent(localStamp(win.fromMs))}&endTime=${encodeURIComponent(localStamp(win.toMs))}`;
    let body: unknown;
    try {
      const res = await ctx.fetchImpl(url, { headers: { Authorization: auth.apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as unknown;
    } catch (err) {
      ctx.summary.errors.push(`glm: ${errorMessage(err)}`);
      return;
    }
    const parsed = parseGlmDetail(body);
    if (!parsed) {
      ctx.summary.errors.push("glm: usage-detail shape unrecognized");
      return;
    }
    for (const label of Object.keys(parsed.buckets)) {
      const ms = localLabelToMs(label);
      if (win.daily) {
        const dk = dayKey(ms);
        dailyOut[dk] = mergeRows(dailyOut[dk], parsed.buckets[label]);
      } else {
        const hk = hourKey(ms);
        hourlyOut[hk] = mergeRows(hourlyOut[hk], parsed.buckets[label]);
        hourlyTo = Math.max(hourlyTo, ms + 3_600_000);
      }
    }
  }
  const applied = mutateUsageStore(
    ctx.dir,
    (store) => {
      if (Object.keys(dailyOut).length > 0) replaceDailyRows(store, "glm", dailyOut);
      // Always replace the hourly range – hours the fetch did not report are
      // zero usage, so stale keys inside it must clear.
      replaceHourlyRange(store, "glm", hourlyFrom, hourlyTo, hourlyOut);
      const s = ensure(store.state, "glm") as { at?: number; throughMs?: number; backfilled?: boolean };
      s.at = ctx.now;
      s.throughMs = hourlyTo;
      if (!backfilled && !ctx.summary.aborted) s.backfilled = true;
    },
    ctx.now,
  );
  if (applied) ctx.summary.applied.push("glm");
  else ctx.summary.skipped.push("glm: store busy");
}

interface ParsedGlmDetail {
  buckets: Record<string, Record<string, UsageRow>>; // label -> model -> row
}

// Pure: data.modelUsage.{xTime[], modelDataList[]} -> bucket rows. Series are
// parallel arrays aligned with xTime; null/absent entries read as zero
// (live-verified 2026-09-29: hourly labels for short ranges, daily beyond ~7d).
export function parseGlmDetail(body: unknown): ParsedGlmDetail | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const mu = (data as { modelUsage?: unknown }).modelUsage;
  if (typeof mu !== "object" || mu === null) return null;
  const m = mu as { xTime?: unknown; modelDataList?: unknown };
  if (!Array.isArray(m.xTime) || !Array.isArray(m.modelDataList)) return null;
  const labels = m.xTime.filter((l): l is string => typeof l === "string");
  const buckets: Record<string, Record<string, UsageRow>> = {};
  for (const raw of m.modelDataList) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const model =
      typeof row.modelName === "string" && row.modelName !== ""
        ? row.modelName
        : typeof row.modelCode === "string"
          ? row.modelCode
          : null;
    if (!model) continue;
    const series = {
      in: Array.isArray(row.uncachedInputTokensUsage) ? row.uncachedInputTokensUsage : [],
      cr: Array.isArray(row.cachedInputTokensUsage) ? row.cachedInputTokensUsage : [],
      out: Array.isArray(row.outputTokensUsage) ? row.outputTokensUsage : [],
    };
    labels.forEach((label, i) => {
      const inV = num(series.in[i]);
      const crV = num(series.cr[i]);
      const outV = num(series.out[i]);
      if (inV === null && crV === null && outV === null) return;
      const bucket = ensure(buckets, label);
      const target = ensure(bucket, model);
      if (inV !== null) target.in = (target.in ?? 0) + inV;
      if (crV !== null) target.cr = (target.cr ?? 0) + crV;
      if (outV !== null) target.out = (target.out ?? 0) + outV;
    });
  }
  return { buckets };
}

function mergeRows(
  base: Record<string, UsageRow> | undefined,
  add: Record<string, UsageRow>,
): Record<string, UsageRow> {
  const out: Record<string, UsageRow> = { ...(base ?? {}) };
  for (const [model, row] of Object.entries(add)) {
    const target = ensure(out, model);
    for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
      const v = row[field];
      if (v !== undefined) target[field] = (target[field] ?? 0) + v;
    }
  }
  return out;
}

// --- openrouter: /activity (daily tokens + actual USD) + analytics (hourly) ---

async function harvestOpenrouter(ctx: JobCtx): Promise<void> {
  const mgmt = getSecret("OPENROUTER_MANAGEMENT_KEY", ctx.envPath);
  if (!mgmt) {
    ctx.summary.skipped.push("openrouter: no management key (history unavailable – optional)");
    return;
  }
  const state = ctx.store().state.openrouter as { activityAt?: number; analyticsAt?: number } | undefined;
  const auth = { Authorization: `Bearer ${mgmt}` };
  let didSomething = false;
  if (!state?.activityAt || ctx.now - state.activityAt >= OR_ACTIVITY_TTL_MS) {
    if (timeLeft(ctx) < 1_500) {
      ctx.summary.aborted = true;
    } else {
      const fromMs = ctx.now - OR_ACTIVITY_RANGE_MS;
      try {
        const res = await ctx.fetchImpl("https://openrouter.ai/api/v1/activity", { headers: auth });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        const rows = extractOrActivity(body);
        if (rows === null) {
          ctx.summary.errors.push("openrouter: activity shape unrecognized");
        } else {
          const days: Record<string, Record<string, UsageRow>> = {};
          for (const r of rows) {
            const dk = dayKey(r.dateMs);
            const bucket = ensure(days, dk);
            const target = ensure(bucket, r.model);
            target.in = (target.in ?? 0) + r.prompt;
            target.out = (target.out ?? 0) + r.completion;
            target.req = (target.req ?? 0) + r.requests;
            target.usd = (target.usd ?? 0) + r.usage;
          }
          const applied = mutateUsageStore(
            ctx.dir,
            (store) => {
              // Replace the vendor's whole retention window: days the API no
              // longer returns are gone server-side, so stale local copies of
              // them must not linger either.
              const cur = ensure(store.daily, "openrouter");
              const fromKey = dayKey(fromMs);
              for (const key of Object.keys(cur)) {
                if (key >= fromKey) delete cur[key];
              }
              replaceDailyRows(store, "openrouter", days);
              const s = ensure(store.state, "openrouter") as { activityAt?: number };
              s.activityAt = ctx.now;
            },
            ctx.now,
          );
          if (applied) {
            ctx.summary.applied.push("openrouter/activity");
            didSomething = true;
          } else ctx.summary.skipped.push("openrouter/activity: store busy");
        }
      } catch (err) {
        ctx.summary.errors.push(`openrouter/activity: ${errorMessage(err)}`);
      }
    }
  } else ctx.summary.skipped.push("openrouter/activity: fresh");
  if (!state?.analyticsAt || ctx.now - state.analyticsAt >= OR_ANALYTICS_TTL_MS) {
    if (timeLeft(ctx) < 1_500) {
      ctx.summary.aborted = true;
    } else {
      const fromMs = ctx.now - OR_ANALYTICS_WINDOW_MS;
      const toMs = ctx.now;
      try {
        const res = await ctx.fetchImpl("https://openrouter.ai/api/v1/analytics/query", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            metrics: ["tokens_prompt", "tokens_completion", "cached_tokens"],
            dimensions: ["model"],
            granularity: "hour",
            time_range: { start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() },
            limit: 2000,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        const rows = extractOrAnalytics(body);
        if (rows === null) {
          ctx.summary.errors.push("openrouter: analytics shape unrecognized");
        } else {
          const hours: Record<string, Record<string, UsageRow>> = {};
          for (const r of rows) {
            const hk = hourKey(r.hourMs);
            const bucket = ensure(hours, hk);
            const target = ensure(bucket, r.model);
            const cached = r.cached;
            target.in = (target.in ?? 0) + Math.max(0, r.prompt - cached);
            target.cr = (target.cr ?? 0) + cached;
            target.out = (target.out ?? 0) + r.completion;
          }
          const applied = mutateUsageStore(
            ctx.dir,
            (store) => {
              replaceHourlyRange(store, "openrouter", fromMs, toMs, hours);
              const s = ensure(store.state, "openrouter") as { analyticsAt?: number };
              s.analyticsAt = ctx.now;
            },
            ctx.now,
          );
          if (applied) {
            ctx.summary.applied.push("openrouter/analytics");
            didSomething = true;
          } else ctx.summary.skipped.push("openrouter/analytics: store busy");
        }
      } catch (err) {
        ctx.summary.errors.push(`openrouter/analytics: ${errorMessage(err)}`);
      }
    }
  } else ctx.summary.skipped.push("openrouter/analytics: fresh");
  if (didSomething) ctx.summary.applied.push("openrouter");
}

interface OrActivityRow {
  dateMs: number;
  model: string;
  requests: number;
  usage: number;
  prompt: number;
  completion: number;
}

// Pure: {data:[{date, model, requests, usage, prompt_tokens, completion_tokens,
// reasoning_tokens, ...}]} (live-verified 2026-09-29). Dates are UTC.
export function extractOrActivity(body: unknown): OrActivityRow[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: OrActivityRow[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const date = typeof r.date === "string" ? r.date : null;
    const model =
      typeof r.model === "string" && r.model !== ""
        ? r.model
        : typeof r.model_permaslug === "string"
          ? r.model_permaslug
          : null;
    const requests = num(r.requests);
    const usage = num(r.usage);
    const prompt = num(r.prompt_tokens);
    const completion = num(r.completion_tokens);
    if (!date || !model || requests === null || usage === null || prompt === null || completion === null) continue;
    const dateMs = utcLabelToMs(date);
    if (!Number.isFinite(dateMs)) continue;
    out.push({ dateMs, model, requests, usage, prompt, completion });
  }
  return out;
}

interface OrAnalyticsRow {
  hourMs: number;
  model: string;
  prompt: number;
  completion: number;
  cached: number;
}

// Pure: {data:{data:[{date__hour, model, tokens_prompt, tokens_completion,
// cached_tokens}]}} (live-verified 2026-09-29 – string numbers). cached is a
// subset of prompt, so uncached input = prompt − cached.
export function extractOrAnalytics(body: unknown): OrAnalyticsRow[] | null {
  if (typeof body !== "object" || body === null) return null;
  const outer = (body as { data?: unknown }).data;
  if (typeof outer !== "object" || outer === null) return null;
  const data = (outer as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: OrAnalyticsRow[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const hour = typeof r.date__hour === "string" ? r.date__hour : null;
    const model = typeof r.model === "string" && r.model !== "" ? r.model : null;
    const prompt = num(r.tokens_prompt);
    const completion = num(r.tokens_completion);
    const cached = num(r.cached_tokens) ?? 0;
    if (!hour || !model || prompt === null || completion === null) continue;
    const hourMs = utcLabelToMs(hour);
    if (!Number.isFinite(hourMs)) continue;
    out.push({ hourMs, model, prompt, completion, cached });
  }
  return out;
}

// --- zcode: cumulative used_units per model bucket, delta against watermarks ---

async function harvestZcode(ctx: JobCtx): Promise<void> {
  const state = ctx.store().state.zcode as { at?: number; buckets?: Record<string, { used: number }> } | undefined;
  if (state?.at && ctx.now - state.at < ZCODE_TTL_MS) {
    ctx.summary.skipped.push("zcode: fresh");
    return;
  }
  const bal = await fetchZcodeBalance();
  if (!bal.ok) {
    ctx.summary.skipped.push(`zcode: ${bal.error.kind}`);
    return;
  }
  const joined = zcodeBuckets(bal.body, ctx.now);
  if (joined === null) {
    ctx.summary.errors.push("zcode: balance shape unrecognized");
    return;
  }
  if (joined.expired || joined.buckets.length === 0) {
    mutateUsageStore(
      ctx.dir,
      (store) => {
        delete store.state.zcode; // no active buckets – watermarks would be stale
      },
      ctx.now,
    );
    ctx.summary.skipped.push("zcode: no active bundles");
    return;
  }
  let deltaTotal = 0;
  const applied = mutateUsageStore(
    ctx.dir,
    (store) => {
      const s = ensure(store.state, "zcode") as { at?: number; buckets?: Record<string, { used: number }> };
      if (!s.buckets) s.buckets = {};
      const buckets = s.buckets;
      const live = new Set<string>();
      for (const b of joined.buckets) {
        const key = `${b.entitlementId}@${b.expiresSec}`;
        live.add(key);
        const prev = buckets[key];
        const delta = prev && b.used > prev.used ? b.used - prev.used : 0;
        buckets[key] = { used: b.used };
        if (delta > 0) {
          addDelta(store, "zcode", hourKey(ctx.now), b.scope, { tot: delta });
          deltaTotal += delta;
        }
      }
      for (const key of Object.keys(buckets)) {
        if (!live.has(key)) delete buckets[key]; // expired bundle – watermark retired
      }
      s.at = ctx.now;
    },
    ctx.now,
  );
  if (applied) {
    ctx.summary.applied.push(deltaTotal > 0 ? `zcode (+${deltaTotal} tok)` : "zcode");
  } else ctx.summary.skipped.push("zcode: store busy");
}

// --- pricing: OpenRouter's public models list, weekly ---

async function harvestPricing(ctx: JobCtx): Promise<void> {
  const store = ctx.store();
  if (store.pricing.fetchedAt && ctx.now - store.pricing.fetchedAt < PRICING_TTL_MS) {
    ctx.summary.skipped.push("pricing: fresh");
    return;
  }
  if (timeLeft(ctx) < 1_500) {
    ctx.summary.aborted = true;
    return;
  }
  try {
    const res = await ctx.fetchImpl("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const prices = extractOrPricing(body);
    if (prices === null) {
      ctx.summary.errors.push("pricing: models shape unrecognized");
      return;
    }
    const applied = mutateUsageStore(
      ctx.dir,
      (store) => {
        store.pricing = { fetchedAt: ctx.now, usdPerTok: prices };
      },
      ctx.now,
    );
    if (applied) ctx.summary.applied.push("pricing");
    else ctx.summary.skipped.push("pricing: store busy");
  } catch (err) {
    ctx.summary.errors.push(`pricing: ${errorMessage(err)}`);
  }
}

// Pure: {data:[{id, pricing:{prompt, completion, input_cache_read,
// input_cache_write}}]} – USD-per-token STRINGS. Entries that fail to parse
// are skipped; free models (0/0) are kept at zero.
export function extractOrPricing(body: unknown): Record<string, ModelPrice> | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: Record<string, ModelPrice> = {};
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as { id?: unknown; pricing?: unknown };
    if (typeof r.id !== "string" || r.id === "" || typeof r.pricing !== "object" || r.pricing === null) continue;
    const p = r.pricing as Record<string, unknown>;
    const inP = num(p.prompt);
    const outP = num(p.completion);
    if (inP === null || outP === null) continue;
    const cr = num(p.input_cache_read);
    const cw = num(p.input_cache_write);
    out[r.id.toLowerCase()] = {
      in: inP,
      out: outP,
      // A parsed 0 is meaningful (free cache reads/writes) – only absent or
      // unparseable fields are omitted.
      ...(cr !== null ? { cr } : {}),
      ...(cw !== null ? { cw } : {}),
    };
  }
  return out;
}

// --- alibaba: token-plan model telemetry via the bl passthrough ---
// The qwencloud analytics page reads this exact API (verified live 2026-09-30):
// getModelMonitorDataWithOss with productMode "TokenPlanPersonal" returns
// model_usage series per usage_type (input_tokens incl. cached, cached_tokens,
// output_tokens, total_tokens) as daily points, plus a cumsum range-total
// companion series that we skip. Model slugs come from listRecentlyModels;
// per-model numbers need one request per slug (the server aggregates across
// the models filter). Needs the bl console session (expires ~5h) – on expiry
// this degrades to skipped, and the stale % sampler keeps history flowing.

const BL_TIMEOUT_MS = 12_000;
const ALIBABA_TTL_MS = 6 * 3_600_000;
// Pseudo-model key for aggregate (not per-model) rows – unpriceable, shown as-is.
const ALIBABA_ALL_MODELS = "(all models)";
const OPENAI_LOCAL_TTL_MS = 60_000;
// Bump when local-parser semantics change: stores harvested by an older
// parser are wiped and re-read once (self-healing, no operator rebuild).
// v4: incremental offsets over-counted the trailing newline byte (first
// appended line per round was lost) and stale rounds double-added their rows –
// stores from older parsers are wiped and re-derived once, exactly.
const LOCAL_PARSER_VERSION = 4;
const OPENAI_WHAM_TTL_MS = 6 * 3_600_000;
const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage/daily-token-usage-breakdown";

interface BlRun {
  ok: boolean;
  stdout: string;
  toolMissing: boolean;
  timedOut: boolean;
}

function runBl(literal: string, args: readonly string[], timeoutMs: number = BL_TIMEOUT_MS): Promise<BlRun> {
  return new Promise((resolve) => {
    const finish = (
      err: (Error & { code?: string | number; killed?: boolean }) | null,
      stdout: string | Buffer,
    ): void => {
      if (err) {
        const toolMissing = err.code === "ENOENT" || (process.platform === "win32" && err.code === 9009);
        resolve({ ok: false, stdout: String(stdout ?? ""), toolMissing, timedOut: err.killed === true });
      } else {
        resolve({ ok: true, stdout: String(stdout ?? ""), toolMissing: false, timedOut: false });
      }
    };
    if (process.platform === "win32") {
      // .cmd shim requires the shell; only vendor-sourced validated values are
      // interpolated (slugs are checked against a strict charset first).
      exec(literal, { timeout: timeoutMs, windowsHide: true }, finish);
    } else {
      execFile(args[0], args.slice(1), { timeout: timeoutMs }, finish);
    }
  });
}

async function blCall(
  api: string,
  reqDTO: unknown,
  site: string,
  region: string,
  deadline: number,
): Promise<unknown | null> {
  if (Date.now() + 2_000 > deadline) return null;
  const data = JSON.stringify({ reqDTO });
  const literal = `bl console call --api ${api} --data "${data.replace(/"/g, '\\"')}" --console-site ${site} --console-region ${region} --output json`;
  if (process.env.SUBTRK_DEBUG_BL) console.error(`[bl] ${literal.slice(0, 240)}`);
  const args = [
    "bl",
    "console",
    "call",
    "--api",
    api,
    "--data",
    data,
    "--console-site",
    site,
    "--console-region",
    region,
    "--output",
    "json",
  ];
  const run = await runBl(literal, args);
  if (!run.ok) return null;
  return extractJson(run.stdout);
}

function blSiteRegion(): { site: string; region: string } {
  let site = "international";
  let region = "ap-southeast-1";
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".bailian", "config.json"), "utf8")) as Record<string, unknown>;
    if (typeof cfg.console_site === "string" && /^[a-z-]+$/.test(cfg.console_site)) site = cfg.console_site;
    if (typeof cfg.console_region === "string" && /^[a-z0-9-]+$/.test(cfg.console_region)) region = cfg.console_region;
  } catch {
    /* defaults stand */
  }
  return { site, region };
}

export interface AlibabaSeries {
  usageType: string;
  unit: string;
  aggMethod: string;
  points: { t: number; value: number }[];
}

// Pure: unwrap the bl envelope to originData series. null = shape failure;
// {login: true} marks an expired console session (both the top-level bl error
// envelope and the nested zelda error shape).
export function parseAlibabaMonitor(body: unknown): { series: AlibabaSeries[] } | { login: true } | null {
  if (typeof body !== "object" || body === null) return null;
  const topErr = (body as { error?: { message?: unknown; code?: unknown } }).error;
  if (topErr && typeof topErr === "object") {
    const msg = String(topErr.message ?? "");
    if (/log ?in|session/i.test(msg)) return { login: true };
    return null; // a different top-level bl error is still not a monitor body
  }
  let d: unknown = (body as { data?: unknown }).data;
  const v2 = (d as { DataV2?: { data?: unknown } } | null | undefined)?.DataV2;
  if (v2 && typeof v2.data === "object" && v2.data !== null) d = v2.data;
  const inner = (d as { data?: unknown } | null | undefined)?.data;
  if (typeof inner === "object" && inner !== null) {
    const code = (inner as { code?: unknown }).code;
    const message = String((inner as { message?: unknown }).message ?? "");
    if (typeof code === "string" && code !== "200" && /log ?in|session/i.test(message)) return { login: true };
  }
  let dd: unknown = inner;
  if (typeof dd === "object" && dd !== null) {
    const nested = (dd as { data?: unknown }).data;
    if (nested !== undefined) dd = nested;
  }
  const origin = (dd as { originData?: unknown } | null | undefined)?.originData;
  if (!Array.isArray(origin)) return null;
  const series: AlibabaSeries[] = [];
  for (const raw of origin) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const labels = (s.labels ?? {}) as Record<string, unknown>;
    const usageType = typeof labels.usage_type === "string" ? labels.usage_type : "";
    if (!usageType) continue;
    const aggMethod = typeof s.aggMethod === "string" ? s.aggMethod : "sum";
    const points: { t: number; value: number }[] = [];
    if (Array.isArray(s.points)) {
      for (const p of s.points) {
        if (typeof p !== "object" || p === null) continue;
        const t = (p as { timestamp?: unknown }).timestamp;
        const value = num((p as { value?: unknown }).value);
        if (typeof t === "number" && Number.isFinite(t) && value !== null) points.push({ t, value });
      }
    }
    series.push({ usageType, unit: typeof labels.unit === "string" ? labels.unit : "", aggMethod, points });
  }
  return { series };
}

// Pure: sum-series per usage_type -> daily model rows. cached_tokens is a
// subset of input_tokens, so uncached input = input − cached (clamped).
export function alibabaRowsFromSeries(
  series: AlibabaSeries[],
): { days: Record<string, Record<string, UsageRow>> } | null {
  const pick = (ut: string): Map<number, number> => {
    const s = series.find((x) => x.usageType === ut && x.aggMethod === "sum"); // cumsum companions skipped
    return new Map((s?.points ?? []).map((p) => [p.t, p.value]));
  };
  const input = pick("input_tokens");
  const cached = pick("cached_tokens");
  const output = pick("output_tokens");
  const total = pick("total_tokens");
  if (input.size === 0 && total.size === 0) return null;
  const stamps = new Set<number>([...input.keys(), ...total.keys()]);
  const days: Record<string, Record<string, UsageRow>> = {};
  const MODEL = ALIBABA_ALL_MODELS;
  for (const ts of stamps) {
    const inTot = input.get(ts) ?? 0;
    const cachedV = cached.get(ts) ?? 0;
    const outV = output.get(ts) ?? 0;
    const totV = total.get(ts);
    const row: UsageRow = {};
    if (input.size > 0) row.in = Math.max(0, inTot - cachedV);
    if (cached.size > 0) row.cr = cachedV;
    if (output.size > 0) row.out = outV;
    if (totV !== undefined) row.tot = totV;
    const dk = dayKey(ts);
    days[dk] ??= {};
    const bucket = days[dk];
    bucket[MODEL] ??= {};
    const target = bucket[MODEL];
    for (const field of ["in", "cw", "cr", "out", "tot"] as const) {
      const v = row[field];
      if (v !== undefined) target[field] = (target[field] ?? 0) + v;
    }
  }
  return { days };
}

// Per-model: the same monitor call restricted to one slug.
export function alibabaPerModelRows(series: AlibabaSeries[], model: string): Record<string, Record<string, UsageRow>> {
  const base = alibabaRowsFromSeries(series);
  const days: Record<string, Record<string, UsageRow>> = {};
  if (!base) return days;
  for (const [dk, rows] of Object.entries(base.days)) {
    days[dk] = { [model]: rows[ALIBABA_ALL_MODELS] ?? {} };
  }
  return days;
}

// Pure: combine a fresh aggregate fetch, fresh per-model fetches and the
// store's existing days into the replace payload. A COMPLETE per-model round
// (every slug fetched) replaces its days wholesale – vendor truth. A degraded
// round (some or all slug fetches failed, or the model list was unavailable)
// overlays fresh slugs on the existing attributed rows instead – a slow bl
// round must never wipe good history back to the unlabeled aggregate. Only a
// day with neither fresh nor existing per-model rows gets the aggregate row,
// which is never mixed with per-model rows on one day (same traffic).
export function mergeAlibabaDays(
  totalDays: Record<string, Record<string, UsageRow>>,
  perModelDays: Record<string, Record<string, UsageRow>>,
  existingDays: Record<string, Record<string, UsageRow>>,
  perModelComplete = false,
): Record<string, Record<string, UsageRow>> {
  const merged: Record<string, Record<string, UsageRow>> = {};
  for (const [dk, rows] of Object.entries(totalDays)) {
    const fresh = perModelDays[dk];
    const day: Record<string, UsageRow> = {};
    if (!(perModelComplete && fresh)) {
      const ex = existingDays[dk];
      if (ex) {
        for (const [m, r] of Object.entries(ex)) {
          if (m !== ALIBABA_ALL_MODELS) day[m] = r;
        }
      }
    }
    if (fresh) {
      for (const [m, r] of Object.entries(fresh)) day[m] = r;
    }
    merged[dk] = Object.keys(day).length > 0 ? day : rows;
  }
  return merged;
}

async function harvestAlibaba(ctx: JobCtx): Promise<void> {
  const state = ctx.store().state.alibaba as { at?: number } | undefined;
  if (state?.at && ctx.now - state.at < ALIBABA_TTL_MS) {
    ctx.summary.skipped.push("alibaba: fresh");
    return;
  }
  const { site, region } = blSiteRegion();
  const fromMs = ctx.now - 30 * 86_400_000;
  const toMs = ctx.now;
  const reqBase = { startTime: fromMs, endTime: toMs, productMode: "TokenPlanPersonal", step: 86_400 };
  const metricFilters = [{ metricName: "model_usage", aggMethod: "sum" }];
  const totalBody = await blCall(
    "zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss",
    { ...reqBase, metricFilters },
    site,
    region,
    ctx.deadline,
  );
  if (totalBody === null) {
    ctx.summary.skipped.push("alibaba: bl unavailable or budget spent");
    return;
  }
  const parsedTotal = parseAlibabaMonitor(totalBody);
  if (parsedTotal === null) {
    ctx.summary.errors.push(`alibaba: monitor shape unrecognized – ${JSON.stringify(totalBody).slice(0, 400)}`);
    return;
  }
  if ("login" in parsedTotal) {
    ctx.summary.skipped.push("alibaba: console session expired – run subtrk auth refresh --provider alibaba");
    return;
  }
  const totalDays = alibabaRowsFromSeries(parsedTotal.series);
  if (!totalDays) {
    ctx.summary.errors.push("alibaba: monitor series empty");
    return;
  }
  // Per-model rows: one request per slug (the server aggregates across a
  // multi-model filter). Failure here degrades to the aggregate row.
  const perModelDays: Record<string, Record<string, UsageRow>> = {};
  let modelsOk = 0;
  const listBody = await blCall(
    "zeldaEasy.bailian-telemetry.platform-model.listRecentlyModels",
    { startTime: fromMs, endTime: toMs, productMode: "TokenPlanPersonal" },
    site,
    region,
    ctx.deadline,
  );
  const slugs = (() => {
    let d: unknown = (listBody as { data?: unknown } | null)?.data;
    const v2 = (d as { DataV2?: { data?: unknown } } | null | undefined)?.DataV2;
    if (v2 && typeof v2.data === "object" && v2.data !== null) d = v2.data;
    const arr = (d as { data?: unknown } | null | undefined)?.data;
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string" && /^[a-zA-Z0-9._-]+$/.test(s)).slice(0, 8)
      : [];
  })();
  for (const slug of slugs) {
    const body = await blCall(
      "zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss",
      { ...reqBase, metricFilters, models: [slug] },
      site,
      region,
      ctx.deadline,
    );
    const parsed = body === null ? null : parseAlibabaMonitor(body);
    if (!parsed || "login" in parsed) continue;
    const rows = alibabaPerModelRows(parsed.series, slug);
    for (const [dk, models] of Object.entries(rows)) {
      perModelDays[dk] ??= {};
      const bucket = perModelDays[dk];
      for (const [model, row] of Object.entries(models)) bucket[model] = { ...row };
    }
    modelsOk++;
  }
  if (slugs.length === 0) {
    ctx.summary.skipped.push("alibaba: model list unavailable – aggregate rows only");
  } else if (modelsOk < slugs.length) {
    ctx.summary.skipped.push(
      `alibaba: ${slugs.length - modelsOk}/${slugs.length} model fetches failed – prior rows kept`,
    );
  }
  const fromDayKey = dayKey(fromMs);
  const applied = mutateUsageStore(
    ctx.dir,
    (store) => {
      const cur = ensure(store.daily, "alibaba");
      const existing: Record<string, Record<string, UsageRow>> = {};
      for (const key of Object.keys(cur)) existing[key] = cur[key];
      for (const key of Object.keys(cur)) {
        if (key >= fromDayKey) delete cur[key];
      }
      replaceDailyRows(
        store,
        "alibaba",
        mergeAlibabaDays(totalDays.days, perModelDays, existing, slugs.length > 0 && modelsOk === slugs.length),
      );
      const s = ensure(store.state, "alibaba") as { at?: number };
      s.at = ctx.now;
    },
    ctx.now,
  );
  if (applied) {
    ctx.summary.applied.push(modelsOk > 0 ? `alibaba (${modelsOk}/${slugs.length} models)` : "alibaba");
  } else ctx.summary.skipped.push("alibaba: store busy");
}

// --- openai: local codex rollouts (tokens) + wham daily plan-% (server) ---

// Pure: the wham daily breakdown -> {dayKey -> model -> pct} rows (credits is
// a plan-usage percent, not dollars – informational, never summed or priced).
export function extractOpenaiWham(body: unknown): Record<string, Record<string, UsageRow>> | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const days: Record<string, Record<string, UsageRow>> = {};
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as { date?: unknown; models?: unknown };
    if (typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Array.isArray(d.models)) continue;
    days[d.date] ??= {};
    const bucket = days[d.date];
    for (const m of d.models) {
      if (typeof m !== "object" || m === null) continue;
      const model = (m as { model?: unknown }).model;
      const credits = num((m as { credits?: unknown }).credits);
      if (typeof model !== "string" || model === "" || credits === null) continue;
      bucket[model] ??= {};
      const target = bucket[model];
      target.pct = Math.max(target.pct ?? 0, credits);
    }
  }
  return days;
}

// Pure: one codex rollout line -> a token DELTA row. Codex re-emits
// token_count events with a CUMULATIVE total_token_usage (last_token_usage
// repeats the same response on every status update, so summing it triple
// counts) – the delta is this snapshot minus the previous one, carried across
// harvests in the file watermark. Model attribution rides the nearest
// preceding turn_context line.
export interface CodexParserState {
  input: number;
  cached: number;
  cw: number;
  out: number;
}

export function parseCodexRolloutLine(
  line: string,
  currentModel: string | null,
  prev: CodexParserState | null,
): { ts: number; model: string; row: UsageRow; modelUpdate: string | null; nextState: CodexParserState | null } | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const rec = o as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> | null };
  if (rec.type === "turn_context" && rec.payload && typeof rec.payload.model === "string" && rec.payload.model) {
    return { ts: 0, model: "", row: {}, modelUpdate: rec.payload.model, nextState: prev };
  }
  if (rec.type !== "event_msg" || !rec.payload || rec.payload.type !== "token_count") return null;
  const info = rec.payload.info as { total_token_usage?: Record<string, unknown> } | undefined;
  const u = info?.total_token_usage;
  if (!u || typeof u !== "object") return null;
  const inTot = num(u.input_tokens);
  const cached = num(u.cached_input_tokens) ?? 0;
  const cw = num(u.cache_write_input_tokens) ?? 0;
  const out = num(u.output_tokens);
  if (inTot === null || out === null) return null;
  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const next: CodexParserState = { input: inTot, cached, cw, out };
  const dIn = Math.max(0, inTot - (prev?.input ?? 0));
  const dCached = Math.max(0, cached - (prev?.cached ?? 0));
  const dCw = Math.max(0, cw - (prev?.cw ?? 0));
  const dOut = Math.max(0, out - (prev?.out ?? 0));
  if (dIn + dCached + dCw + dOut <= 0)
    return { ts, model: currentModel ?? "codex", row: {}, modelUpdate: null, nextState: next };
  const row: UsageRow = { in: Math.max(0, dIn - dCached), req: 1 };
  if (dCached > 0) row.cr = dCached;
  if (dCw > 0) row.cw = dCw;
  if (dOut > 0) row.out = dOut;
  return { ts, model: currentModel ?? "codex", row, modelUpdate: null, nextState: next };
}

// Pure: one claude transcript line -> a token row (ccusage rules: skip
// synthetic/error lines; input/cache/cache-read/output from message.usage).
// Streaming partial writes duplicate the same message.id+requestId with
// growing usage – the caller dedupes on `dedupeKey`, keeping the FIRST
// occurrence (the ccusage convention).
export function parseClaudeTranscriptLine(
  line: string,
  _currentModel: string | null,
): { ts: number; model: string; row: UsageRow; dedupeKey: string | null } | null {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null; // cheap prefilter
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const rec = o as Record<string, unknown>;
  if (rec.type !== "assistant" || rec.isApiErrorMessage === true) return null;
  const message = rec.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const model = message.model;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (typeof model !== "string" || model === "" || model === "<synthetic>" || !usage || typeof usage !== "object")
    return null;
  const inTot = num(usage.input_tokens) ?? 0;
  const cr = num(usage.cache_read_input_tokens) ?? 0;
  const cw = num(usage.cache_creation_input_tokens) ?? 0;
  const out = num(usage.output_tokens) ?? 0;
  if (inTot + cr + cw + out <= 0) return null;
  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const row: UsageRow = { in: inTot, req: 1 };
  if (cr > 0) row.cr = cr;
  if (cw > 0) row.cw = cw;
  if (out > 0) row.out = out;
  const mid = typeof message.id === "string" ? message.id : "";
  const rid = typeof rec.requestId === "string" ? rec.requestId : "";
  const dedupeKey = mid || rid ? createHash("sha256").update(`${mid}|${rid}`).digest("hex").slice(0, 12) : null;
  return { ts, model, row, dedupeKey };
}

// Shared incremental JSONL walker: per-file byte offsets + parser state in
// state[provider].files; truncated files restart from zero (rare, documented
// double-count risk – subtrk usage --rebuild is the repair). Processes files
// newest-first until the budget runs out; offsets advance only for files that
// were fully processed through their last complete line.
interface LocalFileWatermark {
  off: number;
  size: number;
  last?: unknown; // parser state carried across harvests (codex cumulative totals)
  model?: string | null; // last turn_context model, so resumed files attribute correctly
  pv?: number; // parser version that produced this watermark
}

async function harvestLocalJsonl(
  ctx: JobCtx,
  provider: "claude" | "openai",
  root: string,
  parseLine: (
    line: string,
    currentModel: string | null,
    parserState: unknown,
  ) => { ts?: number; model?: string; row?: UsageRow; modelUpdate?: string | null; nextState?: unknown } | null,
  label: string,
): Promise<boolean> {
  const state = ctx.store().state[provider] as
    | { at?: number; pv?: number; files?: Record<string, LocalFileWatermark> }
    | undefined;
  // Absent pv = pre-versioning store: treat as stale so rows written by an
  // older parser are REPLACED, not added to. Also self-heal data loss: if
  // files are watermarked as processed but the local section is EMPTY, a
  // past wipe outran its rebuild - force a full re-read.
  const sectionEmpty =
    Object.keys(ctx.store().localHourly[provider] ?? {}).length === 0 &&
    Object.keys(ctx.store().localDaily[provider] ?? {}).length === 0;
  const staleParser =
    state?.pv !== LOCAL_PARSER_VERSION ||
    (state?.files !== undefined && Object.keys(state.files).length > 0 && sectionEmpty);
  if (state?.at && !staleParser && ctx.now - state.at < OPENAI_LOCAL_TTL_MS) {
    ctx.summary.skipped.push(`${label}: fresh`);
    return true;
  }
  const files: { path: string; mtime: number; size: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of entries) {
      const fp = join(dir, f);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(fp, depth + 1);
      else if (f.endsWith(".jsonl")) files.push({ path: fp, mtime: st.mtimeMs, size: st.size });
    }
  };
  try {
    walk(root, 0);
  } catch {
    ctx.summary.skipped.push(`${label}: unreadable dir`);
    return false;
  }
  if (files.length === 0) {
    ctx.summary.skipped.push(`${label}: no transcripts`);
    return false;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const watermarks = staleParser ? {} : (state?.files ?? {});
  const rowsByHour = new Map<string, Map<string, UsageRow>>();
  const offsets: Record<string, LocalFileWatermark> = {};
  let processed = 0;
  for (const file of files) {
    if (Date.now() + 1_500 > ctx.deadline) {
      ctx.summary.aborted = true;
      break;
    }
    const wm = watermarks[file.path];
    let start = 0;
    if (wm && file.size >= wm.off) {
      if (wm.off >= file.size) continue; // fully processed
      start = wm.off;
    } // truncated or new -> restart at 0 (rare double-count, --rebuild repairs)
    let text = "";
    try {
      const fd = openSync(file.path, "r");
      try {
        const len = file.size - start;
        if (len <= 0) continue;
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, start);
        text = buf.toString("utf8", 0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue; // file vanished mid-harvest
    }
    let currentModel: string | null = wm?.model ?? null; // resumes mid-file attribution
    let parserState: unknown = wm?.last ?? null; // codex: cumulative totals across runs
    let consumed = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (isLast) {
        if (line !== "") break; // partial line – re-read next round
        continue; // trailing "" after the final \n: no byte to count (counting it pushed offsets 1 past EOF, and the next incremental read then lost the first appended line)
      }
      consumed += Buffer.byteLength(line, "utf8") + 1;
      if (line === "") continue;
      const parsed = parseLine(line, currentModel, parserState);
      if (parsed?.modelUpdate) {
        currentModel = parsed.modelUpdate;
        if (parsed.nextState !== undefined) parserState = parsed.nextState;
        continue;
      }
      if (!parsed) continue;
      if (parsed.nextState !== undefined) parserState = parsed.nextState;
      if (!parsed.row || parsed.ts === undefined || !parsed.model) continue;
      const hk = hourKey(parsed.ts);
      const models = rowsByHour.get(hk) ?? new Map<string, UsageRow>();
      const target = models.get(parsed.model) ?? {};
      for (const field of ["in", "cw", "cr", "out", "req"] as const) {
        const v = parsed.row[field];
        if (v !== undefined) target[field] = (target[field] ?? 0) + v;
      }
      models.set(parsed.model, target);
      rowsByHour.set(hk, models);
    }
    offsets[file.path] = {
      off: start + consumed,
      size: file.size,
      last: parserState,
      model: currentModel,
      pv: LOCAL_PARSER_VERSION,
    };
    processed++;
  }
  if (processed === 0 && rowsByHour.size === 0) {
    ctx.summary.skipped.push(`${label}: nothing new`);
    return true; // nothing to do counts as success – watermarks stay valid
  }
  if (staleParser && rowsByHour.size === 0) {
    // A stale rebuild that read NO usage rows must not wipe the section and
    // walk away (budget aborted mid-file) - keep the old rows and watermarks
    // so the next harvest retries the full read.
    ctx.summary.skipped.push(`${label}: rebuild read nothing - kept previous rows`);
    return false;
  }
  const applied = mutateUsageStore(
    ctx.dir,
    (store) => {
      // A stale rebuild REPLACES the section: wipe first, then add once. (The
      // add must never run before the wipe – that double-counts on normal
      // incremental rounds, where the rows survive untouched.)
      if (staleParser) {
        delete store.localHourly[provider];
        delete store.localDaily[provider];
      }
      for (const [hk, models] of rowsByHour) {
        for (const [model, row] of models) addDeltaLocal(store, provider, hk, model, row);
      }
      const s = ensure(store.state, provider) as {
        at?: number;
        pv?: number;
        files?: Record<string, LocalFileWatermark>;
      };
      s.files ??= {};
      const f = s.files;
      if (staleParser) {
        // Files not reprocessed this round (aborted budget) keep no old-parser
        // watermark - the next harvest re-reads them fully.
        for (const path of Object.keys(f)) {
          if (!offsets[path]) delete f[path];
        }
      }
      for (const [path, wm] of Object.entries(offsets)) f[path] = wm;
      s.pv = LOCAL_PARSER_VERSION;
      s.at = ctx.now;
    },
    ctx.now,
  );
  if (applied) ctx.summary.applied.push(label);
  else {
    ctx.summary.skipped.push(`${label}: store busy`);
    return false;
  }
  return true;
}

// addDelta into the LOCAL section – this-machine rows must never mix with the
// vendor-served buckets (month-to-date totals exclude them by design).
function addDeltaLocal(store: UsageStore, provider: string, hKey: string, model: string, delta: UsageRow): void {
  const hours = ensure(store.localHourly, provider);
  const bucket = ensure(hours, hKey);
  const row = ensure(bucket, model);
  for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
    const v = delta[field];
    if (v === undefined) continue;
    row[field] = (row[field] ?? 0) + v;
  }
}

async function harvestOpenai(ctx: JobCtx): Promise<void> {
  // 1. local rollouts – real tokens, this machine
  await harvestLocalJsonl(
    ctx,
    "openai",
    join(homedir(), ".codex", "sessions"),
    (line, currentModel, parserState) =>
      parseCodexRolloutLine(line, currentModel, parserState as CodexParserState | null),
    "openai/local",
  );
  // 2. wham daily plan-% – server-side, cross-machine
  const state = ctx.store().state.openai as { whamAt?: number } | undefined;
  if (state?.whamAt && ctx.now - state.whamAt < OPENAI_WHAM_TTL_MS) {
    ctx.summary.skipped.push("openai/wham: fresh");
    return;
  }
  if (Date.now() + 2_000 > ctx.deadline) {
    ctx.summary.aborted = true;
    return;
  }
  let token: string | undefined;
  let account: string | undefined;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown };
    };
    if (typeof auth.tokens?.access_token === "string" && auth.tokens.access_token) token = auth.tokens.access_token;
    if (typeof auth.tokens?.account_id === "string" && auth.tokens.account_id) account = auth.tokens.account_id;
    else if (typeof auth.tokens?.id_token === "string") {
      const parts = auth.tokens.id_token.split(".");
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
          if (typeof payload.chatgpt_account_id === "string") account = payload.chatgpt_account_id;
        } catch {
          /* account id stays absent */
        }
      }
    }
  } catch {
    ctx.summary.skipped.push("openai/wham: no codex credentials");
    return;
  }
  if (!token) {
    ctx.summary.skipped.push("openai/wham: no codex credentials");
    return;
  }
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const url = `${WHAM_URL}?start_date=${iso(ctx.now - 30 * 86_400_000)}&end_date=${iso(ctx.now)}`;
  try {
    const res = await ctx.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "codex-cli",
        ...(account ? { "chatgpt-account-id": account } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const days = extractOpenaiWham(body);
    if (days === null) {
      ctx.summary.errors.push("openai/wham: shape unrecognized");
      return;
    }
    const fromDayKey = dayKey(ctx.now - 30 * 86_400_000);
    const applied = mutateUsageStore(
      ctx.dir,
      (store) => {
        const cur = ensure(store.daily, "openai");
        for (const key of Object.keys(cur)) {
          if (key >= fromDayKey) delete cur[key];
        }
        replaceDailyRows(store, "openai", days);
        const s = ensure(store.state, "openai") as { whamAt?: number };
        s.whamAt = ctx.now;
      },
      ctx.now,
    );
    if (applied) ctx.summary.applied.push("openai/wham");
    else ctx.summary.skipped.push("openai/wham: store busy");
  } catch (err) {
    ctx.summary.errors.push(`openai/wham: ${errorMessage(err)}`);
  }
}

async function harvestClaudeLocal(ctx: JobCtx): Promise<void> {
  // Streaming partial writes duplicate message.id+requestId across lines and
  // resumed sessions replay them across files – dedupe on a bounded recent-id
  // set (first occurrence wins, the ccusage convention) persisted in state.
  const state = ctx.store().state.claude as
    | { ids?: string[]; pv?: number; files?: Record<string, unknown> }
    | undefined;
  // Mirror the walker's staleness (parser bump OR watermarked-but-empty
  // section): a full re-read must start with an EMPTY dedupe set, or the
  // persisted "already seen" ids swallow every historical line.
  const sectionEmpty =
    Object.keys(ctx.store().localHourly.claude ?? {}).length === 0 &&
    Object.keys(ctx.store().localDaily.claude ?? {}).length === 0;
  const fullReread =
    state?.pv !== LOCAL_PARSER_VERSION ||
    (state?.files !== undefined && Object.keys(state.files).length > 0 && sectionEmpty);
  const seen = new Set(fullReread ? [] : (state?.ids ?? []).slice(-4000));
  const newIds: string[] = [];
  const applied = await harvestLocalJsonl(
    ctx,
    "claude",
    join(homedir(), ".claude", "projects"),
    (line, currentModel, parserState) => {
      const r = parseClaudeTranscriptLine(line, currentModel);
      if (!r) return null;
      if (r.dedupeKey) {
        if (seen.has(r.dedupeKey)) return null;
        seen.add(r.dedupeKey);
        newIds.push(r.dedupeKey);
      }
      return { ts: r.ts, model: r.model, row: r.row, modelUpdate: null, nextState: parserState };
    },
    "claude/local",
  );
  if (applied) {
    mutateUsageStore(
      ctx.dir,
      (store) => {
        const s = ensure(store.state, "claude") as { ids?: string[]; pv?: number };
        if (newIds.length > 0) s.ids = [...newIds, ...(s.ids ?? [])].slice(0, 4000);
        s.pv = LOCAL_PARSER_VERSION;
      },
      ctx.now,
    );
  } else {
    // The walker's apply was lock-skipped: leave pv/at untouched so the NEXT
    // harvest still treats the section as stale and re-reads it fully.
    const ids = (ctx.store().state.claude as { ids?: string[] } | undefined)?.ids;
    if (ids) {
      mutateUsageStore(
        ctx.dir,
        (store) => {
          (ensure(store.state, "claude") as { ids?: string[] }).ids = ids;
        },
        ctx.now,
      );
    }
  }
}

// --- entry point ---

// Harvest every due source. Called after collectStatus from both the CLI and
// the console: `subtrk status` awaits it under a short budget (typical call:
// everything fresh, so it returns immediately), `subtrk serve` runs it
// fire-and-forget. Failures land in the summary – status output is untouched.
export async function harvestUsage(results: ProviderResult[] = [], opts: HarvestOpts = {}): Promise<HarvestSummary> {
  const dir = opts.subtrkDir ?? SUBTRK_DIR;
  const now = opts.now ?? Date.now();
  const summary: HarvestSummary = { applied: [], skipped: [], errors: [], aborted: false };
  const ctx: JobCtx = {
    store: () => readUsageStore(dir),
    dir,
    now,
    deadline: now + (opts.budgetMs ?? 8_000),
    fetchImpl: opts.fetchImpl ?? fetch,
    envPath: opts.envPath,
    summary,
  };
  const jobs: Promise<void>[] = [
    (async () => {
      if (results.length === 0) return;
      const applied = mutateUsageStore(
        dir,
        (store) => {
          recordSamples(store, results, now);
        },
        now,
      );
      if (applied) summary.applied.push("samples");
      else summary.skipped.push("samples: store busy");
    })(),
    harvestGlm(ctx),
    harvestOpenrouter(ctx),
    harvestZcode(ctx),
    harvestPricing(ctx),
    harvestAlibaba(ctx),
    harvestOpenai(ctx),
    harvestClaudeLocal(ctx),
  ];
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "rejected") summary.errors.push(`harvest: ${errorMessage(s.reason)}`);
  }
  return summary;
}
