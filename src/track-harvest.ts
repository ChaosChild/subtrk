// track-harvest.ts – window harvest over harness-local usage stores (spec
// §Track attribution ladder, minus the rejected provider-delta tier). All
// stores are read read-only; the zcode sqlite open is verified safe while the
// harness is writing. Every store's accounting convention is normalized here
// to TrackUsage (in = UNCACHED input): zcode input_tokens is inclusive of
// cache reads, claude/codex report the exclusive split already.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import type { HarvestResult, HarvestWindow, TrackUsage } from "./track.ts";
import { type CodexParserState, parseClaudeTranscriptLine, parseCodexRolloutLine } from "./usage.ts";

// Store keys derived from (untrusted) harness store content – usage.ts discipline.
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function emptyUsage(): TrackUsage {
  return { in: 0, cr: 0, cw: 0, out: 0, reqs: 0 };
}

function usageTotal(u: TrackUsage): number {
  return u.in + u.cr + u.cw + u.out;
}

function bucket(rec: Record<string, TrackUsage>, key: string): TrackUsage {
  if (PROTO_KEYS.has(key)) key = "?";
  if (!rec[key]) rec[key] = emptyUsage();
  return rec[key];
}

interface Accumulator {
  bySource: Record<string, TrackUsage>;
  models: Record<string, number>; // model -> total tokens (shares computed once at the end)
  sessions: Set<string>;
}

// ---------- zcode: per-request rows in ~/.zcode/cli/db/db.sqlite ----------

// node:sqlite is experimental on the Node versions we support and prints an
// ExperimentalWarning on load. Removing 'warning' listeners does NOT
// suppress it – Node prints to stderr whenever the event fires with zero
// listeners, so the event must never fire: patch process.emitWarning across
// the import (restore one immediate later, in case a deferred call site),
// memoized so concurrent callers can't double-patch. Unavailable → no data.
let sqlitePromise: Promise<typeof import("node:sqlite") | null> | null = null;
function importSqlite(): Promise<typeof import("node:sqlite") | null> {
  sqlitePromise ??= (async () => {
    const origEmitWarning = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      const mod = await import("node:sqlite");
      setImmediate(() => {
        process.emitWarning = origEmitWarning;
      });
      return mod;
    } catch {
      process.emitWarning = origEmitWarning;
      return null;
    }
  })();
  return sqlitePromise;
}

async function harvestZcode(acc: Accumulator, w: HarvestWindow, homeDir: string): Promise<boolean> {
  const dbPath = join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  try {
    await stat(dbPath);
  } catch {
    return false;
  }
  const mod = await importSqlite();
  if (!mod) return false;
  let rows: unknown[];
  try {
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      // Requests, not sessions, carry the time filter: long-lived mains would
      // be missed by a session.time_created window. session_title rows are
      // harness bookkeeping, not task burn (compact IS task burn). A manual
      // --session pin restricts this tier to that session only.
      const pin = typeof w.session === "string" && w.session.trim() !== "" ? w.session.trim() : null;
      const stmt = db.prepare(
        `select mu.session_id as sid, mu.query_source as src, mu.model_id as model,
                mu.input_tokens as inTok, mu.output_tokens as outTok,
                mu.cache_creation_input_tokens as cw, mu.cache_read_input_tokens as cr
         from model_usage mu join session s on s.id = mu.session_id
         where mu.started_at >= ? and mu.started_at <= ? and mu.query_source <> 'session_title'
           and rtrim(lower(replace(s.directory, char(92), '/')), '/') = ?
           and (? is null or mu.session_id = ?)`,
      );
      rows = stmt.all(w.t0, w.t1, normalizeDir(w.project), pin, pin) as unknown[];
    } finally {
      db.close();
    }
  } catch {
    return false; // busy/locked/foreign schema – the record goes pending
  }
  const srcKey: Record<string, string> = {
    main_turn: "zcode:main",
    subagent: "zcode:subagent",
    compact: "zcode:compact",
  };
  let any = false;
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const inTok = Number(r.inTok) || 0;
    const cr = Number(r.cr) || 0;
    const cw = Number(r.cw) || 0;
    const out = Number(r.outTok) || 0;
    // inclusive input: subtract cache read+write for the uncached remainder
    const uncached = Math.max(0, inTok - cr - cw);
    if (uncached + cr + cw + out <= 0) continue;
    any = true;
    const key = srcKey[String(r.src)] ?? "zcode:other";
    const u = bucket(acc.bySource, key);
    u.in += uncached;
    u.cr += cr;
    u.cw += cw;
    u.out += out;
    u.reqs += 1;
    const model = typeof r.model === "string" && r.model !== "" && !PROTO_KEYS.has(r.model) ? r.model : "?";
    acc.models[model] = (acc.models[model] ?? 0) + uncached + cr + cw + out;
    if (typeof r.sid === "string" && r.sid !== "") acc.sessions.add(r.sid);
  }
  return any;
}

// ---------- claude code: per-message usage in ~/.claude/projects/<enc>/*.jsonl ----------

// Claude encodes the project path by replacing every non-alphanumeric char
// with '-' (C:\Development\x → C--Development-x) – verified against live dirs.
function encodeClaudePath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

async function harvestClaude(acc: Accumulator, w: HarvestWindow, homeDir: string): Promise<boolean> {
  let files: string[];
  try {
    const dir = join(homeDir, ".claude", "projects", encodeClaudePath(w.project));
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(dir, e.name));
  } catch {
    return false;
  }
  let any = false;
  const seen = new Set<string>(); // streaming replays duplicate message ids – first wins (ccusage rule)
  for (const file of files) {
    try {
      const st = await stat(file);
      if (st.mtimeMs < w.t0) continue; // untouched during the window
    } catch {
      continue;
    }
    const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const r = parseClaudeTranscriptLine(line, null);
      if (!r || r.ts < w.t0 || r.ts > w.t1) continue;
      if (r.dedupeKey) {
        if (seen.has(r.dedupeKey)) continue;
        seen.add(r.dedupeKey);
      }
      const tot = (r.row.in ?? 0) + (r.row.cr ?? 0) + (r.row.cw ?? 0) + (r.row.out ?? 0);
      if (tot <= 0) continue;
      any = true;
      const u = bucket(acc.bySource, "claude");
      u.in += r.row.in ?? 0;
      u.cr += r.row.cr ?? 0;
      u.cw += r.row.cw ?? 0;
      u.out += r.row.out ?? 0;
      u.reqs += r.row.req ?? 0;
      acc.models[r.model] = (acc.models[r.model] ?? 0) + tot;
    }
  }
  return any;
}

// ---------- codex: rollout JSONL under ~/.codex/sessions/YYYY/MM/DD ----------

async function codexFiles(sessionsRoot: string): Promise<string[]> {
  const out: string[] = [];
  let years: string[] = [];
  try {
    years = (await readdir(sessionsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const year of years) {
    const months = await readdir(join(sessionsRoot, year), { withFileTypes: true }).catch(() => []);
    for (const month of months.filter((e) => e.isDirectory())) {
      const days = await readdir(join(sessionsRoot, year, month.name), { withFileTypes: true }).catch(() => []);
      for (const day of days.filter((e) => e.isDirectory())) {
        const files = await readdir(join(sessionsRoot, year, month.name, day.name), { withFileTypes: true }).catch(
          () => [],
        );
        for (const f of files.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))) {
          out.push(join(sessionsRoot, year, month.name, day.name, f.name));
        }
      }
    }
  }
  return out;
}

async function harvestCodex(acc: Accumulator, w: HarvestWindow, homeDir: string): Promise<boolean> {
  const files = await codexFiles(join(homeDir, ".codex", "sessions"));
  const wantDir = normalizeDir(w.project);
  let any = false;
  for (const file of files) {
    try {
      const st = await stat(file);
      if (st.mtimeMs < w.t0) continue;
    } catch {
      continue;
    }
    let cwd: string | null = null;
    let model: string | null = null;
    let prev: CodexParserState | null = null;
    const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (cwd === null && line.includes('"session_meta"')) {
        try {
          const meta = JSON.parse(line) as { payload?: { cwd?: unknown } };
          if (typeof meta.payload?.cwd === "string") cwd = meta.payload.cwd;
        } catch {
          /* keep scanning */
        }
        if (cwd !== null && normalizeDir(cwd) !== wantDir) break; // a different project's rollout
        continue;
      }
      const r = parseCodexRolloutLine(line, model, prev);
      if (!r) continue;
      if (r.modelUpdate !== null) model = r.modelUpdate;
      prev = r.nextState;
      if (r.ts === 0 || r.ts < w.t0 || r.ts > w.t1) continue;
      const tot = (r.row.in ?? 0) + (r.row.cr ?? 0) + (r.row.cw ?? 0) + (r.row.out ?? 0);
      if (tot <= 0) continue;
      any = true;
      const u = bucket(acc.bySource, "codex");
      u.in += r.row.in ?? 0;
      u.cr += r.row.cr ?? 0;
      u.cw += r.row.cw ?? 0;
      u.out += r.row.out ?? 0;
      u.reqs += r.row.req ?? 0;
      const key = PROTO_KEYS.has(r.model) ? "?" : r.model;
      acc.models[key] = (acc.models[key] ?? 0) + tot;
    }
  }
  return any;
}

// ---------- entry point ----------

export interface HarvestOpts {
  homeDir?: string; // override homedir() (tests)
}

// Sum every readable local store's usage for [t0, t1] in the project. The
// result's attribution names the best tier that produced numbers:
// "session-window" (zcode per-request rows), "window" (transcript scans),
// "none" (nothing readable – the record keeps its task facts only).
export async function harvestWindow(w: HarvestWindow, opts: HarvestOpts = {}): Promise<HarvestResult | null> {
  const homeDir = opts.homeDir ?? homedir();
  const acc: Accumulator = { bySource: {}, models: {}, sessions: new Set() };
  const [zcode, claude, codex] = await Promise.all([
    harvestZcode(acc, w, homeDir).catch(() => false),
    harvestClaude(acc, w, homeDir).catch(() => false),
    harvestCodex(acc, w, homeDir).catch(() => false),
  ]);
  const usage = emptyUsage();
  for (const u of Object.values(acc.bySource)) {
    usage.in += u.in;
    usage.cr += u.cr;
    usage.cw += u.cw;
    usage.out += u.out;
    usage.reqs += u.reqs;
  }
  const total = usageTotal(usage);
  if (total <= 0) return null;
  const shares: Record<string, number> = {};
  for (const [model, tok] of Object.entries(acc.models)) shares[model] = tok / total;
  const attribution = zcode ? "session-window" : claude || codex ? "window" : "none";
  return { attribution, usage, bySource: acc.bySource, models: shares, sessions: [...acc.sessions] };
}
