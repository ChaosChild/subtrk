// core.ts – types, config, env secrets, redaction, TTL cache, fetch helpers,
// and scheduling math for subtrk. Pure logic; every path is a parameter
// (defaulting to SUBTRK_DIR) so tests can inject temp dirs.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------- shared contract (docs/spec.md §ProviderResult) ----------

export type ProviderId = "claude" | "glm" | "alibaba" | "google" | "opencode" | "openrouter" | "openai" | "kimi";

export type ErrorKind =
  | "no-credentials"
  | "expired-token"
  | "tool-missing"
  | "rate-limited"
  | "forbidden"
  | "not-readable-remotely"
  | "parse-failure"
  | "subprocess-failed"
  | "timeout"
  | "http-error";

export interface ProviderError {
  kind: ErrorKind;
  message: string;
  hint?: string;
  remedy?: string; // exact CLI line an agent/operator can run (fixed literal)
  retryAfterMs?: number;
  status?: number;
}

export interface Window {
  kind: string;
  scope?: string;
  usedPercent?: number;
  remainingFraction?: number;
  resetsAt: string;
}

export interface Credits {
  total?: number;
  remaining: number;
  unit: "credits" | "usd";
  cycleEndsAt?: string;
  source: "api" | "derived";
}

export interface ProviderResult {
  id: ProviderId;
  ok: boolean;
  stale: boolean;
  fetchedAt: string;
  plan?: string;
  windows?: Window[];
  credits?: Credits;
  note?: string;
  refreshable?: true; // module supports interactive refresh (subtrk auth refresh / POST /api/refresh)
  error?: ProviderError;
}

// Fixed-literal outcome of an interactive refresh – never subprocess output.
export interface RefreshResult {
  ok: boolean;
  message: string;
}

export interface ProviderModule {
  id: ProviderId;
  ttlMs: number;
  probe(): Promise<ProviderResult>; // NEVER throws
  refresh?: () => Promise<RefreshResult>; // interactive re-auth (browser/login flow)
}

export interface StatusOutput {
  schemaVersion: 1;
  checkedAt: string;
  recheckAfter: string;
  providers: ProviderResult[];
  nextEvent: {
    providerId: string;
    type: "window-reset";
    at: string;
    atMs: number;
  } | null;
}

// ---------- constants ----------

export const SUBTRK_DIR = join(homedir(), ".subtrk");
// One-time migration from the pre-rename dir so stored keys/cache survive.
try {
  const legacy = join(homedir(), ".subt");
  if (existsSync(legacy) && !existsSync(SUBTRK_DIR)) renameSync(legacy, SUBTRK_DIR);
} catch {
  /* best effort – a failure just means re-running `subtrk init` */
}
export const ALL_PROVIDER_IDS: readonly ProviderId[] = [
  "claude",
  "glm",
  "alibaba",
  "google",
  "opencode",
  "openrouter",
  "openai",
  "kimi",
];
export const PROBE_TIMEOUT_MS = 10_000;
// --fresh never bypasses these providers' TTL floors (claude's usage endpoint
// has UA-keyed 429 buckets – spec §Cache TTL table).
export const FRESH_FLOOR_IDS: readonly ProviderId[] = ["claude"];

const SCHEMA_VERSION = 1;
const LOCK_MAX_AGE_MS = 60_000;
const STALE_ERROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONTENDER_WAIT_MS = 750;

export interface FetchOpts {
  cachePath?: string;
  fresh?: boolean; // bypass cache TTL reads once
  contenderWaitMs?: number; // injectable for tests; default 750
  probeTimeoutMs?: number; // injectable for tests; default PROBE_TIMEOUT_MS
  now?: number; // injectable clock for cache age math
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class HttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, retryAfterMs?: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends Error {
  constructor(message = "timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- config ----------

export interface SubtrkConfig {
  enabled: ProviderId[];
  order?: ProviderId[]; // display order – listed ids first, rest keeps registry order
}

// Known ids only, duplicates dropped; a non-array of strings yields undefined
// (order is an optional hint, never a hard failure like enabled).
function parseOrder(value: unknown): ProviderId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) return undefined;
  return [...new Set(value.filter((id): id is ProviderId => (ALL_PROVIDER_IDS as readonly string[]).includes(id)))];
}

export function loadConfig(subtrkDir: string = SUBTRK_DIR): SubtrkConfig {
  const path = join(subtrkDir, "config.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: [...ALL_PROVIDER_IDS] };
    throw new ConfigError(`config unreadable: ${errorMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config is not valid JSON: ${path}`);
  }
  const file = raw as { enabled?: unknown; order?: unknown } | null;
  const enabled = file?.enabled;
  if (enabled === undefined) return { enabled: [...ALL_PROVIDER_IDS], order: parseOrder(file?.order) };
  if (!Array.isArray(enabled) || enabled.some((e) => typeof e !== "string")) {
    throw new ConfigError(`config.enabled must be an array of provider ids: ${path}`);
  }
  return {
    enabled: enabled.filter((id): id is ProviderId => (ALL_PROVIDER_IDS as readonly string[]).includes(id)),
    order: parseOrder(file?.order),
  };
}

// Read-modify-write of the whole config file: unknown pre-existing keys are
// preserved, only the patch keys are overwritten. Temp file + rename (the
// writeCacheEntry discipline). Throws on write failure – callers decide.
export function saveConfig(subtrkDir: string, patch: { enabled?: ProviderId[]; order?: ProviderId[] }): void {
  const path = join(subtrkDir, "config.json");
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      file = parsed as Record<string, unknown>;
    }
  } catch {
    /* absent or unparseable – start a fresh file */
  }
  if (patch.enabled !== undefined) file.enabled = [...patch.enabled];
  if (patch.order !== undefined) file.order = [...patch.order];
  mkdirSync(subtrkDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------- env secrets + redaction ----------

const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function scrub(s: string): string {
  let out = s;
  for (const secret of secrets) out = out.split(secret).join("***");
  return out;
}

export function scrubValue<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
    return out as T;
  }
  return value;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// Process env wins, then ~/.subtrk/env (KEY=VALUE lines, # comments).
export function getSecret(name: string, envPath: string = join(SUBTRK_DIR, "env")): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) {
    registerSecret(fromEnv);
    return fromEnv;
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    return undefined;
  }
  const value = parsed[name];
  if (value) registerSecret(value);
  return value;
}

// ---------- cache (spec §Cache) ----------

interface CacheHit {
  data: ProviderResult;
  fetchedAt: number; // epoch ms
}

interface LockInfo {
  pid: number;
  startedAt: number;
}

export function readCacheEntry(cachePath: string, id: string): CacheHit | null {
  let text: string;
  try {
    text = readFileSync(cachePath, "utf8");
  } catch {
    return null; // absent – a plain miss
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      rmSync(cachePath, { force: true });
    } catch {
      /* best effort */
    }
    return null; // corrupt – miss and delete
  }
  const file = parsed as { schemaVersion?: unknown } & Record<string, unknown>;
  if (!file || typeof file !== "object" || file.schemaVersion !== SCHEMA_VERSION) {
    try {
      rmSync(cachePath, { force: true });
    } catch {
      /* best effort */
    }
    return null; // schema mismatch – discard the file
  }
  const entry = file[id] as { data?: unknown; fetchedAt?: unknown } | undefined;
  if (
    !entry ||
    typeof entry !== "object" ||
    !entry.data ||
    typeof entry.data !== "object" ||
    typeof entry.fetchedAt !== "number"
  ) {
    return null;
  }
  return { data: entry.data as ProviderResult, fetchedAt: entry.fetchedAt };
}

// Temp file + rename, up to 4 retries with 25–100ms backoff, then silent
// give-up – a lost write costs one future re-probe, it is never an error.
export async function writeCacheEntry(
  cachePath: string,
  id: string,
  data: ProviderResult,
  ttlMs: number,
): Promise<void> {
  const backoffs = [25, 50, 75, 100];
  try {
    let file: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && parsed.schemaVersion === SCHEMA_VERSION) file = parsed;
    } catch {
      /* absent or corrupt – start a fresh file */
    }
    file[id] = { data, fetchedAt: Date.parse(data.fetchedAt) || Date.now(), ttlMs };
    const payload = JSON.stringify({ ...file, schemaVersion: SCHEMA_VERSION });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(tmp, payload);
        renameSync(tmp, cachePath);
        return;
      } catch {
        if (attempt >= backoffs.length) return;
        await sleep(backoffs[attempt]);
      }
    }
  } catch {
    /* silent */
  }
}

// Best-effort removal of one provider's cache entry (after an interactive
// refresh): same temp+rename discipline and silent give-up as writeCacheEntry –
// a lost delete costs one stale read, never an error.
export function removeCachedProvider(subtrkDir: string, id: string): void {
  const cachePath = join(subtrkDir, "cache.json");
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) return;
    if (!(id in parsed)) return;
    delete parsed[id];
    const payload = JSON.stringify({ ...parsed, schemaVersion: SCHEMA_VERSION });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, payload);
      renameSync(tmp, cachePath);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* absent or corrupt – nothing to remove */
  }
}

function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function tryCreateLock(lockPath: string): boolean {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* best effort */
  }
  try {
    closeSync(openSync(lockPath, "wx")); // exclusive create IS the lock
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
    /* unreadable */
  }
  return null;
}

function acquireLock(lockPath: string): boolean {
  if (tryCreateLock(lockPath)) return true;
  const info = readLock(lockPath);
  if (!info) return false; // no stealing: cannot prove the holder is dead
  const dead = isPidDead(info.pid);
  const tooOld = Date.now() - info.startedAt > LOCK_MAX_AGE_MS;
  if (!dead && !tooOld) return false;
  try {
    unlinkSync(lockPath); // GC: holder provably dead or lock too old
  } catch {
    /* ignore EPERM/ENOENT during GC */
  }
  return tryCreateLock(lockPath);
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

async function runProbe(p: ProviderModule, opts: FetchOpts): Promise<ProviderResult> {
  const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    return await withTimeout(p.probe(), timeoutMs);
  } catch (err) {
    const fetchedAt = new Date().toISOString();
    if (err instanceof TimeoutError) {
      return {
        id: p.id,
        ok: false,
        stale: false,
        fetchedAt,
        error: { kind: "timeout", message: `probe exceeded ${timeoutMs}ms budget` },
      };
    }
    return {
      id: p.id,
      ok: false,
      stale: false,
      fetchedAt,
      error: { kind: "parse-failure", message: `probe crashed: ${errorMessage(err)}` },
    };
  }
}

async function finishProbe(
  p: ProviderModule,
  result: ProviderResult,
  entry: CacheHit | null,
  cachePath: string,
  now: number,
): Promise<ProviderResult> {
  if (result.ok) {
    await writeCacheEntry(cachePath, p.id, result, p.ttlMs);
    return result;
  }
  // Stale-on-error: serve cached data < 24h old with stale:true AND the error.
  if (entry && now - entry.fetchedAt < STALE_ERROR_MAX_AGE_MS) {
    return { ...entry.data, ok: false, stale: true, error: result.error };
  }
  return result;
}

// Cache-or-probe per spec §Cache. ttlMs <= 0 bypasses the cache entirely.
export async function fetchProvider(p: ProviderModule, opts: FetchOpts = {}): Promise<ProviderResult> {
  if (p.ttlMs <= 0) return runProbe(p, opts);
  const cachePath = opts.cachePath ?? join(SUBTRK_DIR, "cache.json");
  const lockPath = `${cachePath}.lock`;
  const now = opts.now ?? Date.now();
  const entry = readCacheEntry(cachePath, p.id);
  let held = false;
  if (entry && !opts.fresh) {
    const age = now - entry.fetchedAt;
    if (age < p.ttlMs) return { ...entry.data, stale: false };
    if (age < 2 * p.ttlMs) {
      // Stale-while-revalidate: a live peer is already refreshing.
      if (!acquireLock(lockPath)) return { ...entry.data, stale: true };
      held = true;
    }
  }
  if (!held) held = acquireLock(lockPath);
  try {
    if (!held) {
      // Contender: lock held by a live process. Wait ~750ms, re-check the
      // cache once, then probe anyway – one bounded duplicate probe.
      await sleep(opts.contenderWaitMs ?? CONTENDER_WAIT_MS);
      const again = readCacheEntry(cachePath, p.id);
      if (again && !opts.fresh && Date.now() - again.fetchedAt < p.ttlMs) {
        return { ...again.data, stale: false };
      }
      const probed = await runProbe(p, opts);
      return await finishProbe(p, probed, entry, cachePath, now);
    }
    const probed = await runProbe(p, opts);
    return await finishProbe(p, probed, entry, cachePath, now);
  } finally {
    if (held) releaseLock(lockPath);
  }
}

// ---------- HTTP helpers ----------

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

const BODY_CAP_BYTES = 1_000_000;

// JSON GET/POST with AbortController timeout and a 1MB body cap.
// Non-2xx throws HttpError (with retryAfterMs when the header is present);
// abort throws TimeoutError; JSON.parse errors propagate to the caller.
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      try {
        void res.body?.cancel();
      } catch {
        /* best effort */
      }
      throw new HttpError(res.status, retryAfterMs);
    }
    let body: Uint8Array;
    if (res.body) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > BODY_CAP_BYTES) {
          ac.abort();
          throw new Error(`response body exceeds ${BODY_CAP_BYTES} byte cap`);
        }
        chunks.push(chunk);
      }
      body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      body = new TextEncoder().encode(await res.text());
    }
    return JSON.parse(new TextDecoder().decode(body));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (ac.signal.aborted && err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------- scheduling math ----------

// Earliest time new information can exist for an ok provider with windows:
// max(resetsAt, fetchedAt + ttl) per window, earliest overall, clamped >= now+1s.
export function computeNextEvent(
  entries: { result: ProviderResult; ttlMs: number }[],
  nowMs: number = Date.now(),
): StatusOutput["nextEvent"] {
  let best: { providerId: string; atMs: number } | null = null;
  for (const { result, ttlMs } of entries) {
    if (!result.ok || !result.windows) continue;
    const fetchedMs = Date.parse(result.fetchedAt);
    for (const w of result.windows) {
      const resetMs = Date.parse(w.resetsAt);
      if (!Number.isFinite(resetMs)) continue;
      const effective = Number.isFinite(fetchedMs) ? Math.max(resetMs, fetchedMs + ttlMs) : resetMs;
      if (!best || effective < best.atMs) best = { providerId: result.id, atMs: effective };
    }
  }
  if (!best) return null;
  const atMs = Math.max(best.atMs, nowMs + 1000);
  return {
    providerId: best.providerId,
    type: "window-reset",
    at: new Date(atMs).toISOString(),
    atMs,
  };
}

// now + clamp(min ttl of ok providers, 60s, 300s) – the scheduler heartbeat.
export function computeRecheckAfter(okTtlsMs: number[], nowMs: number = Date.now()): string {
  const min = okTtlsMs.length > 0 ? Math.min(...okTtlsMs) : 300_000;
  const clamped = Math.min(300_000, Math.max(60_000, min));
  return new Date(nowMs + clamped).toISOString();
}

// ---------- status collection (shared by `subtrk status` and `subtrk serve`) ----------

export interface CollectStatusOpts {
  subtrkDir?: string; // override ~/.subtrk (tests)
  providers?: ProviderModule[]; // stub registry (tests); default: real registry, lazily imported
  requested?: readonly string[]; // pre-validated --provider ids
  fresh?: boolean; // bypass cache TTLs once (floors respected)
}

export async function collectStatus(
  opts: CollectStatusOpts = {},
): Promise<{ out: StatusOutput; ttlById: Map<string, number> }> {
  const cfg = loadConfig(opts.subtrkDir);
  const registry = opts.providers ?? (await import("./providers/index.ts")).allProviders;
  const requested = opts.requested !== undefined && opts.requested.length > 0 ? new Set<string>(opts.requested) : null;
  const selected = registry.filter((m) => cfg.enabled.includes(m.id) && (!requested || requested.has(m.id)));
  // Configured display order: listed ids first by index, unlisted keep registry
  // order after them (stable sort). Applied to filtered lists too – harmless.
  if (cfg.order && cfg.order.length > 0) {
    const rank = new Map(cfg.order.map((id, i) => [id, i] as const));
    const last = cfg.order.length;
    selected.sort((a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last));
  }
  if (selected.length === 0) {
    throw new Error("no providers selected – check ~/.subtrk/config.json or --provider");
  }
  const fresh = opts.fresh === true;
  if (fresh && selected.some((m) => (FRESH_FLOOR_IDS as readonly string[]).includes(m.id))) {
    console.error("claude keeps its 300s floor");
  }
  const cachePath = join(opts.subtrkDir ?? SUBTRK_DIR, "cache.json");
  const nowMs = Date.now();
  const settled = await Promise.allSettled(
    selected.map((m) =>
      fetchProvider(m, {
        cachePath,
        fresh: fresh && !(FRESH_FLOOR_IDS as readonly string[]).includes(m.id),
      }),
    ),
  );
  const results: ProviderResult[] = settled.map((s, i) => {
    const base: ProviderResult =
      s.status === "fulfilled"
        ? s.value
        : {
            id: selected[i].id,
            ok: false,
            stale: false,
            fetchedAt: new Date().toISOString(),
            error: { kind: "parse-failure", message: `internal error: ${errorMessage(s.reason)}` },
          };
    // Annotate from the module (not the cached blob) so cache hits carry it too.
    return typeof selected[i].refresh === "function" ? { ...base, refreshable: true } : base;
  });
  const ttlById = new Map(selected.map((m) => [m.id, m.ttlMs] as const));
  const okTtls = selected.filter((_, i) => results[i].ok).map((m) => m.ttlMs);
  return {
    out: {
      schemaVersion: 1,
      checkedAt: new Date(nowMs).toISOString(),
      recheckAfter: computeRecheckAfter(okTtls, nowMs),
      providers: results,
      nextEvent: computeNextEvent(
        results.map((r) => ({ result: r, ttlMs: ttlById.get(r.id) ?? 0 })),
        nowMs,
      ),
    },
    ttlById,
  };
}
