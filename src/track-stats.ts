// track-stats.ts – M4b: distributions over track records (stats) and the
// agent-facing go/no-go verdict (estimate). Estimates are computed at read
// time from the usage store's pricing (house convention: a pricing refresh
// reprices history); verdicts use done, leaf, uncontested records only –
// aborted/failed tasks undercount effort and would skew "it fits" optimistic.
import { join } from "node:path";
import { readCacheEntry, SUBTRK_DIR, scrub, scrubValue } from "./core.ts";
import type { TrackRecord, TrackStore } from "./track.ts";
import { aggregateUsage, priceForModel, readUsageStore, rowCost, type UsageStore } from "./usage.ts";

// ---------- pure helpers ----------

// Nearest-rank percentile of a non-empty sample; p in [0,1]. Empty -> null.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function trackTokens(r: TrackRecord): number {
  const u = r.usage;
  if (!u) return 0;
  return u.in + u.cr + u.cw + u.out;
}

// Model key -> provider id by prefix. Model families are distinctive enough
// that this holds for every model the harvesters record; unknown -> null.
export function providerOfModel(model: string): string | null {
  const m = model.toLowerCase();
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("codex")) return "openai";
  if (m.startsWith("qwen")) return "alibaba";
  if (m.startsWith("muse")) return "opencode";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "kimi";
  return null;
}

// Dominant model = the largest token share in the record's models map.
export function dominantModel(r: TrackRecord): string | null {
  if (!r.models) return null;
  let best: string | null = null;
  let share = 0;
  for (const [model, s] of Object.entries(r.models)) {
    if (typeof s === "number" && s > share) {
      share = s;
      best = model;
    }
  }
  return best;
}

export function recordProvider(r: TrackRecord): string | null {
  if (r.providerHint) return r.providerHint;
  const model = dominantModel(r);
  return model ? providerOfModel(model) : null;
}

// Read-time estimate: the aggregate split priced at the dominant model's
// rates (records keep shares, not per-model splits). null = unpriced.
export function recordUsdE(r: TrackRecord, ustore: UsageStore): number | null {
  const model = dominantModel(r);
  if (!model || !r.usage) return null;
  const resolved = priceForModel(ustore, model);
  const cost = resolved ? rowCost(r.usage, resolved.price) : null;
  return cost ? cost.usd : null;
}

export interface EnrichedRecord extends TrackRecord {
  tokens: number;
  usdE: number | null;
  provider: string | null;
}

export function enrichRecord(r: TrackRecord, ustore: UsageStore): EnrichedRecord {
  return {
    ...r,
    tokens: trackTokens(r),
    usdE: recordUsdE(r, ustore),
    provider: recordProvider(r),
  };
}

// The estimation set: done tasks, leaves, uncontested, with numbers.
export function statableRecords(store: TrackStore, nowMs: number, days = 30): TrackRecord[] {
  const from = nowMs - days * 86_400_000;
  return store.records.filter(
    (r) => r.usage !== null && !r.pending && !r.contested && r.nested === null && r.status === "done" && r.t1 >= from,
  );
}

export interface Bucket {
  provider: string | null;
  complexity: string | null;
  n: number;
  p50Tok: number;
  p90Tok: number;
  p50Usd: number | null;
  p90Usd: number | null;
  lowN: boolean;
}

function bucketOf(records: EnrichedRecord[]): { tok: number[]; usd: number[] } {
  return {
    tok: records.map((r) => r.tokens),
    usd: records.map((r) => r.usdE).filter((v): v is number => typeof v === "number"),
  };
}

function makeBucket(provider: string | null, complexity: string | null, records: EnrichedRecord[]): Bucket {
  const { tok, usd } = bucketOf(records);
  return {
    provider,
    complexity,
    n: records.length,
    p50Tok: percentile(tok, 0.5) ?? 0,
    p90Tok: percentile(tok, 0.9) ?? 0,
    p50Usd: usd.length > 0 ? percentile(usd, 0.5) : null,
    p90Usd: usd.length > 0 ? percentile(usd, 0.9) : null,
    lowN: records.length < 3,
  };
}

export interface StatsOut {
  days: number;
  n: number;
  headline: {
    medianTok: number | null;
    minTok: number | null;
    maxTok: number | null;
    p90Tok: number | null;
    medianUsd: number | null;
    maxUsd: number | null;
    p90Usd: number | null;
  };
  buckets: Bucket[];
  excluded: { nested: number; contested: number; notDone: number; pending: number; noUsage: number };
}

export function buildStats(records: EnrichedRecord[], all: TrackStore["records"], days: number): StatsOut {
  const { tok, usd } = bucketOf(records);
  const byProviderCx = new Map<string, EnrichedRecord[]>();
  for (const r of records) {
    const key = `${r.provider ?? "?"}|${r.complexity ?? "?"}`;
    const list = byProviderCx.get(key);
    if (list) list.push(r);
    else byProviderCx.set(key, [r]);
  }
  const buckets = [...byProviderCx.entries()]
    .map(([key, list]) => {
      const [provider, complexity] = key.split("|");
      return makeBucket(provider === "?" ? null : provider, complexity === "?" ? null : complexity, list);
    })
    .sort(
      (a, b) =>
        (a.provider ?? "").localeCompare(b.provider ?? "") || (a.complexity ?? "").localeCompare(b.complexity ?? ""),
    );
  return {
    days,
    n: records.length,
    headline: {
      medianTok: percentile(tok, 0.5),
      minTok: tok.length > 0 ? Math.min(...tok) : null,
      maxTok: tok.length > 0 ? Math.max(...tok) : null,
      p90Tok: percentile(tok, 0.9),
      medianUsd: usd.length > 0 ? percentile(usd, 0.5) : null,
      maxUsd: usd.length > 0 ? Math.max(...usd) : null,
      p90Usd: usd.length > 0 ? percentile(usd, 0.9) : null,
    },
    buckets,
    excluded: {
      nested: all.filter((r) => r.nested !== null).length,
      contested: all.filter((r) => r.contested).length,
      notDone: all.filter((r) => r.status !== "done").length,
      pending: all.filter((r) => r.pending).length,
      noUsage: all.filter((r) => r.usage === null && !r.pending).length,
    },
  };
}

// ---------- estimate ----------

const KIND_MS: Record<string, number> = {
  "5h": 5 * 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface EstimateWindow {
  provider: string;
  kind: string;
  usedPercent: number | null;
  resetsAt: string;
  consumedTok: number | null;
  capacityTok: number | null;
  remainingTok: number | null;
  calibrated: boolean;
}

export interface EstimateOut {
  history: {
    n: number;
    provider: string | null;
    complexity: string | null;
    p50Tok: number;
    p90Tok: number;
    p50Usd: number | null;
    p90Usd: number | null;
    lowN: boolean;
    fellBack: boolean;
  };
  fallbacks: { label: string; n: number; p50Tok: number; lowN: boolean }[];
  window: EstimateWindow | null;
  verdict: "fits" | "median" | "insufficient" | "no-history" | "no-window";
  note: string | null;
}

const CX_ORDER = ["xs", "s", "m", "l", "xl"];

// Pick the best bucket: exact provider×complexity first, then the adjacent
// complexities of the same provider (the honest neighbors), then provider
// only, then any provider at the same complexity, then global. Prefers n>=3;
// a smaller n is only used when nothing richer exists, and is flagged lowN.
function pickBucket(
  records: EnrichedRecord[],
  provider: string | null,
  complexity: string | null,
): { list: EnrichedRecord[]; label: string; fellBack: boolean; lowN: boolean } | null {
  const cxIdx = complexity ? CX_ORDER.indexOf(complexity) : -1;
  const chain: { p: string | null; c: string | null; label: string }[] = [];
  if (provider && complexity) chain.push({ p: provider, c: complexity, label: `${provider}, ${complexity}` });
  if (provider && cxIdx > 0)
    chain.push({ p: provider, c: CX_ORDER[cxIdx - 1], label: `${provider}, ${CX_ORDER[cxIdx - 1]}` });
  if (provider && cxIdx >= 0 && cxIdx < CX_ORDER.length - 1)
    chain.push({ p: provider, c: CX_ORDER[cxIdx + 1], label: `${provider}, ${CX_ORDER[cxIdx + 1]}` });
  if (provider) chain.push({ p: provider, c: null, label: `${provider}, any complexity` });
  chain.push({ p: null, c: complexity, label: `any provider, ${complexity ?? "any complexity"}` });
  chain.push({ p: null, c: null, label: "all tracked tasks" });
  const matches = chain
    .map((step) => ({
      step,
      list: records.filter(
        (r) => (step.p === null || r.provider === step.p) && (step.c === null || r.complexity === step.c),
      ),
    }))
    .filter((m) => m.list.length > 0);
  if (matches.length === 0) return null;
  const rich = matches.find((m) => m.list.length >= 3) ?? matches[0];
  return {
    list: rich.list,
    label: rich.step.label,
    fellBack: rich.step !== matches[0].step,
    lowN: rich.list.length < 3,
  };
}

export function buildEstimate(
  records: EnrichedRecord[],
  opts: { provider: string | null; complexity: string | null; subtrkDir: string; nowMs: number },
): EstimateOut {
  const picked = pickBucket(records, opts.provider, opts.complexity);
  const fallbacks: EstimateOut["fallbacks"] = [];
  if (picked && opts.complexity) {
    for (const c of CX_ORDER) {
      if (c === opts.complexity) continue;
      const list = records.filter(
        (r) => (opts.provider === null || r.provider === opts.provider) && r.complexity === c,
      );
      if (list.length === 0) continue;
      const p50 = percentile(
        list.map((r) => r.tokens),
        0.5,
      );
      if (p50 !== null) fallbacks.push({ label: c, n: list.length, p50Tok: p50, lowN: list.length < 3 });
    }
  }
  if (!picked) {
    return {
      history: {
        n: 0,
        provider: opts.provider,
        complexity: opts.complexity,
        p50Tok: 0,
        p90Tok: 0,
        p50Usd: null,
        p90Usd: null,
        lowN: true,
        fellBack: false,
      },
      fallbacks,
      window: null,
      verdict: "no-history",
      note: "no done, uncontested leaf records yet – track a few tasks first",
    };
  }
  const { tok, usd } = bucketOf(picked.list);
  const history: EstimateOut["history"] = {
    n: picked.list.length,
    provider: opts.provider,
    complexity: opts.complexity,
    p50Tok: percentile(tok, 0.5) ?? 0,
    p90Tok: percentile(tok, 0.9) ?? 0,
    p50Usd: usd.length > 0 ? percentile(usd, 0.5) : null,
    p90Usd: usd.length > 0 ? percentile(usd, 0.9) : null,
    lowN: picked.lowN,
    fellBack: picked.fellBack,
  };

  // Window + calibration: percent-remaining becomes tokens via the operator's
  // own observed usage in the window's period (capacity ≈ consumed / used).
  let window: EstimateWindow | null = null;
  if (opts.provider) {
    const cached = readCacheEntry(join(opts.subtrkDir, "cache.json"), opts.provider);
    const win = (cached?.data.windows ?? []).find((w) => KIND_MS[w.kind] !== undefined);
    if (win && typeof win.usedPercent === "number") {
      const durationMs = KIND_MS[win.kind];
      const resetMs = Date.parse(win.resetsAt);
      const used = Math.min(100, Math.max(0, win.usedPercent)) / 100;
      let consumedTok: number | null = null;
      if (Number.isFinite(resetMs)) {
        const agg = aggregateUsage(readUsageStore(opts.subtrkDir), {
          provider: opts.provider,
          granularity: "hour",
          fromMs: resetMs - durationMs,
          toMs: opts.nowMs,
          local: "include",
        });
        const u = agg.providers[opts.provider];
        if (u) {
          const consumed = u.splitless ? u.tot : u.in + u.cr + u.cw + u.out;
          if (consumed > 0) consumedTok = consumed;
        }
      }
      const capacityTok = consumedTok !== null && used >= 0.02 ? consumedTok / used : null;
      const remainingTok = capacityTok !== null ? capacityTok * (1 - used) : null;
      window = {
        provider: opts.provider,
        kind: win.kind,
        usedPercent: win.usedPercent,
        resetsAt: win.resetsAt,
        consumedTok,
        capacityTok,
        remainingTok,
        calibrated: remainingTok !== null,
      };
    }
  }

  let verdict: EstimateOut["verdict"];
  let note: string | null = null;
  if (!window) {
    verdict = "no-window";
    note = opts.provider
      ? "no cached window for the provider (run subtrk status) or its kind has no fixed duration – history only"
      : "pass --provider to compare against a live window; showing history only";
  } else if (!window.calibrated || window.remainingTok === null) {
    verdict = "no-window";
    note = "window calibration needs token history for this provider in the current window – history only";
  } else if (history.p90Tok <= window.remainingTok) {
    verdict = "fits";
  } else if (history.p50Tok <= window.remainingTok) {
    verdict = "median";
    note = "median fits, p90 does not – split the task or switch model";
  } else {
    verdict = "insufficient";
    note = "even the median exceeds what is left – defer or split";
  }
  return { history, fallbacks, window, verdict, note };
}

// ---------- CLI rendering ----------

function fmtTok(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtUsd(n: number | null): string {
  if (n === null) return "–";
  return n > 0 && n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export function statsText(out: StatsOut): string[] {
  const lines: string[] = [];
  const h = out.headline;
  if (out.n === 0) {
    lines.push(`no done tasks in the last ${out.days}d – usage stats fill as agents adopt track start/stop`);
  } else {
    lines.push(
      `all tasks  n=${out.n} · median ${fmtTok(h.medianTok ?? 0)} tok (min ${fmtTok(h.minTok ?? 0)} · max ${fmtTok(h.maxTok ?? 0)} · p90 ${fmtTok(h.p90Tok ?? 0)}) · median ${fmtUsd(h.medianUsd)}`,
    );
    for (const b of out.buckets) {
      const label = `${b.provider ?? "?"} · ${b.complexity ?? "?"}`;
      lines.push(
        `${label.padEnd(16)} n=${String(b.n).padStart(3)}${b.lowN ? " ⚠" : "  "} p50 ${fmtTok(b.p50Tok).padStart(8)}  p90 ${fmtTok(b.p90Tok).padStart(8)}  ${fmtUsd(b.p50Usd)} / ${fmtUsd(b.p90Usd)}`,
      );
    }
  }
  const ex = out.excluded;
  const bits: string[] = [];
  if (ex.nested > 0) bits.push(`${ex.nested} nested`);
  if (ex.contested > 0) bits.push(`${ex.contested} contested`);
  if (ex.notDone > 0) bits.push(`${ex.notDone} not-done`);
  if (ex.pending > 0) bits.push(`${ex.pending} pending`);
  if (ex.noUsage > 0) bits.push(`${ex.noUsage} no-usage`);
  if (bits.length > 0) lines.push(`excluded from stats: ${bits.join(", ")}`);
  lines.push("help: subtrk track stats --json | subtrk track estimate --provider <id> --complexity <cx>");
  return lines.map((l) => scrub(l));
}

export function estimateText(out: EstimateOut): string[] {
  const lines: string[] = [];
  const h = out.history;
  const scope = [h.provider ?? "any provider", h.complexity ?? "any complexity"].join(", ");
  if (h.n === 0) {
    lines.push(`history   no records for ${scope}`);
  } else {
    const flags = [h.lowN ? "low-n" : "", h.fellBack ? "fallback bucket" : ""].filter(Boolean).join(", ");
    lines.push(`history   n=${h.n} (${scope}${flags ? ` · ${flags}` : ""}) · done · leaves`);
    lines.push(
      `  p50 ${fmtTok(h.p50Tok)} tok / ${fmtUsd(h.p50Usd)}      p90 ${fmtTok(h.p90Tok)} tok / ${fmtUsd(h.p90Usd)}`,
    );
  }
  if (out.fallbacks.length > 0) {
    lines.push(
      `fallbacks ${out.fallbacks
        .map((f) => `${f.label}: p50 ${fmtTok(f.p50Tok)} (n=${f.n}${f.lowN ? ", low-n" : ""})`)
        .join(" · ")}`,
    );
  }
  const w = out.window;
  if (w) {
    const pct = typeof w.usedPercent === "number" ? Math.round(w.usedPercent) : null;
    const left = pct === null ? "?" : String(100 - pct);
    lines.push(`window    ${w.provider} ${w.kind} · ${left}% left (reset ${w.resetsAt.slice(11, 16)}Z)`);
    if (w.calibrated && w.remainingTok !== null && w.capacityTok !== null && w.consumedTok !== null) {
      lines.push(
        `  ≈ ${fmtTok(w.remainingTok)} tok remaining  (calibrated: ${fmtTok(w.consumedTok)} consumed at ${pct}% → capacity ${fmtTok(w.capacityTok)})`,
      );
    }
  }
  const verdictLabel: Record<EstimateOut["verdict"], string> = {
    fits: "fits – p90 within the remaining window",
    median: "median fits · p90 does not — split the task or switch model",
    insufficient: "insufficient – even the median exceeds the remainder",
    "no-history": "insufficient history",
    "no-window": "no calibrated window – history only",
  };
  lines.push(`verdict   ${verdictLabel[out.verdict]}`);
  if (out.note) lines.push(`  ${out.note}`);
  lines.push("help: subtrk track estimate --json | subtrk track start --task <text>");
  return lines.map((l) => scrub(l));
}

// ---------- commands (called from cli.ts) ----------

export interface StatsArgs {
  json: boolean;
  provider?: string;
  complexity?: string;
  model?: string;
  days?: string;
}

export async function statsCommand(args: StatsArgs, deps: { subtrkDir?: string; now?: () => number }): Promise<number> {
  const dir = deps.subtrkDir ?? SUBTRK_DIR;
  const nowMs = (deps.now ?? Date.now)();
  let daysN = 30;
  if (args.days !== undefined) {
    if (!/^\d+$/.test(args.days) || Number(args.days) < 1 || Number(args.days) > 365) {
      console.error("subtrk: --days must be an integer between 1 and 365");
      return 2;
    }
    daysN = Number(args.days);
  }
  const { readTrackStore } = await import("./track.ts");
  const store = readTrackStore(dir);
  const ustore = readUsageStore(dir);
  const model = args.model?.toLowerCase();
  const enriched = statableRecords(store, nowMs, daysN)
    .map((r) => enrichRecord(r, ustore))
    .filter(
      (r) =>
        (args.provider === undefined || r.provider === args.provider) &&
        (args.complexity === undefined || r.complexity === args.complexity) &&
        (model === undefined || Object.keys(r.models ?? {}).some((m) => m.toLowerCase().includes(model))),
    );
  const out = buildStats(enriched, store.records, daysN);
  if (args.json) console.log(JSON.stringify(scrubValue({ schemaVersion: 1, ...out })));
  else for (const line of statsText(out)) console.log(line);
  return 0;
}

export interface EstimateArgs {
  json: boolean;
  provider?: string;
  complexity?: string;
  model?: string;
}

export async function estimateCommand(
  args: EstimateArgs,
  deps: { subtrkDir?: string; now?: () => number },
): Promise<number> {
  const dir = deps.subtrkDir ?? SUBTRK_DIR;
  const nowMs = (deps.now ?? Date.now)();
  const { readTrackStore } = await import("./track.ts");
  const store = readTrackStore(dir);
  const ustore = readUsageStore(dir);
  const model = args.model?.toLowerCase();
  const enriched = statableRecords(store, nowMs, 30)
    .map((r) => enrichRecord(r, ustore))
    .filter(
      (r) =>
        (args.provider === undefined || r.provider === args.provider) &&
        (args.complexity === undefined || r.complexity === args.complexity) &&
        (model === undefined || Object.keys(r.models ?? {}).some((m) => m.toLowerCase().includes(model))),
    );
  const out = buildEstimate(enriched, {
    provider: args.provider ?? null,
    complexity: args.complexity ?? null,
    subtrkDir: dir,
    nowMs,
  });
  if (args.json) console.log(JSON.stringify(scrubValue({ schemaVersion: 1, ...out })));
  else for (const line of estimateText(out)) console.log(line);
  return 0;
}
