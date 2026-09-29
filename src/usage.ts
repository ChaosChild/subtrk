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

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, errorMessage, getSecret, type ProviderResult, releaseLock, SUBTRK_DIR } from "./core.ts";
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
}

export interface UsageSample {
  t: number; // epoch ms
  k: string; // window key: kind, or "kind·scope" for scoped windows
  u: number; // used percent 0–100
  r: string; // resetsAt ISO – distinguishes generations of the same window
  sf?: { key: string; name: string; percent: number }[]; // claude per-surface mix
}

export interface ModelPrice {
  in: number;
  out: number;
  cr?: number;
  cw?: number;
}

export interface UsageStore {
  schemaVersion: 1;
  hourly: Record<string, Record<string, Record<string, UsageRow>>>; // provider -> hourKey -> model -> row
  daily: Record<string, Record<string, Record<string, UsageRow>>>; // provider -> dayKey -> model -> row
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
// distinguished by resetsAt so post-reset usage starts a fresh series.
export function recordSamples(store: UsageStore, results: ProviderResult[], nowMs: number): boolean {
  let changed = false;
  for (const result of results) {
    if (!result.ok || !Array.isArray(result.windows)) continue;
    if (!store.samples[result.id]) store.samples[result.id] = []; // arrays, not objects
    const list = store.samples[result.id];
    for (const w of result.windows) {
      const u = w.usedPercent ?? (w.remainingFraction !== undefined ? (1 - w.remainingFraction) * 100 : undefined);
      if (u === undefined || !Number.isFinite(u)) continue;
      const k = w.scope ? `${w.kind}·${w.scope}` : w.kind;
      const sample: UsageSample = { t: nowMs, k, u: Math.round(u * 100) / 100, r: w.resetsAt };
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
}

export interface ProviderUsage extends UsageTotals {
  models: ModelUsage[];
  unpriced: string[];
  series: { t: string; in: number; cr: number; cw: number; out: number; tot: number; req: number }[];
  splitless: boolean; // rows carry only `tot` (zcode) – the UI renders table-only
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

// Aggregate stored buckets over [fromMs,toMs]. Day view prefers daily rows
// (they carry the vendor's authoritative split; glm backfills them beyond the
// hourly window) and falls back to aggregating that day's hourly rows.
export function aggregateUsage(
  store: UsageStore,
  opts: { provider?: string; granularity: "day" | "hour"; fromMs: number; toMs: number },
): UsageAggregate {
  const providers = opts.provider
    ? [opts.provider]
    : [...new Set([...Object.keys(store.daily), ...Object.keys(store.hourly), ...Object.keys(store.samples)])];
  const out: Record<string, ProviderUsage> = {};
  const seen = new Set<string>();
  for (const id of providers) {
    if (seen.has(id)) continue;
    seen.add(id);
    const series: ProviderUsage["series"] = [];
    const byModel = new Map<
      string,
      { row: UsageRow; actual: number | null; priced: number | null; kind: ModelUsage["usdKind"] }
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
        };
        for (const field of ["in", "cw", "cr", "out", "tot", "req"] as const) {
          const v = row[field];
          if (v !== undefined) acc.row[field] = (acc.row[field] ?? 0) + v;
        }
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
      const daily = store.daily[id] ?? {};
      const hourly = store.hourly[id] ?? {};
      const dayKeys = new Set([...Object.keys(daily), ...Object.keys(hourly).map((k) => k.slice(0, 10))]);
      const sorted = [...dayKeys].filter((k) => k >= fromKey && k <= toKey).sort();
      for (const dk of sorted) {
        const rows = daily[dk];
        if (rows) {
          consume(dk, rows);
          continue;
        }
        const agg: Record<string, UsageRow> = {};
        for (const hk of Object.keys(hourly)) {
          if (!hk.startsWith(dk)) continue;
          for (const [model, row] of Object.entries(hourly[hk])) {
            const target = ensure(agg, model);
            for (const field of ["in", "cw", "cr", "out", "tot", "req", "usd"] as const) {
              const v = row[field];
              if (v !== undefined) target[field] = (target[field] ?? 0) + v;
            }
          }
        }
        consume(dk, agg);
      }
    } else {
      const fromKey = hourKey(opts.fromMs);
      const toKey = hourKey(opts.toMs);
      const hourly = store.hourly[id] ?? {};
      const keys = Object.keys(hourly)
        .filter((k) => k >= fromKey && k <= toKey)
        .sort();
      for (const hk of keys) consume(hk, hourly[hk]);
    }

    if (!anyRow && (store.samples[id] ?? []).every((s) => s.t < opts.fromMs || s.t > opts.toMs)) continue;
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
      if (usd === null) unpriced.push(model);
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
      });
    }
    models.sort((a, b) => b.tot + b.in + b.cr + b.out - (a.tot + a.in + a.cr + a.out));
    const rangeSamples = (store.samples[id] ?? []).filter((s) => s.t >= opts.fromMs && s.t <= opts.toMs);
    out[id] = {
      ...totals,
      models,
      unpriced,
      series,
      splitless,
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
  ];
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "rejected") summary.errors.push(`harvest: ${errorMessage(s.reason)}`);
  }
  return summary;
}
