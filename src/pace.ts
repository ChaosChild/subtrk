// pace/runway semantics after quota-axi (MIT), github.com/kunchenguid/quota-axi
//
// Pure functions: no I/O, no caching, no module state; `now` is epoch ms.
// Percent scaling: Window.usedPercent is 0-100, Window.remainingFraction is
// 0-1. Both normalize to percent points (0-100) internally; when only one is
// present the other is its complement. Output percentages are percent points,
// unrounded – formatting is the caller's job.
import type { Window } from "./core.ts";

/** Reserve within this many percentage points of zero is on_pace. */
export const PACE_ON_PACE_DEADBAND_PERCENT_POINTS = 1;
/** Projections before this much of the cycle has elapsed are `early`. */
export const PACE_EARLY_ELAPSED_PERCENT = 10;
/** A zero-use window opening at most this far in the future is "not yet opened". */
export const UNOPENED_FUTURE_START_SKEW_SECONDS = 5 * 60;

// Cycle fields are optional extras: no provider fills them yet. A missing or
// empty resetsAt means "no cycle" – never synthesized, never inferred.
export interface PaceWindow extends Omit<Window, "resetsAt"> {
  id?: string;
  resetsAt?: string;
  startsAt?: string;
  windowSeconds?: number;
}

export type PaceReason =
  | "stale"
  | "missing_usage"
  | "missing_cycle"
  | "invalid_cycle"
  | "future_cycle_start"
  | "expired_reset"
  | "unsupported_period"; // ponytail: reserved for callers; nothing here emits it

export type ProjectionConfidence = "early" | "established";

export interface WindowPace {
  status: "ahead" | "on_pace" | "behind" | "unknown";
  reason?: PaceReason;
  elapsedPercent?: number;
  timeRemainingPercent?: number;
  reservePercentPoints?: number;
  burnMultiple?: number;
  projectedExhaustedAt?: string;
  projectionConfidence?: ProjectionConfidence;
  cycleBasis: "starts_at_resets_at" | "window_seconds" | "none";
  cycleSeconds?: number;
}

export interface EffectiveRunway {
  status: "exhausted_now" | "projected_exhaustion" | "through_reset" | "unknown";
  usableRunwaySeconds?: number;
  projectedExhaustedAt?: string;
  limitingWindowId?: string;
  projectionConfidence?: ProjectionConfidence;
  unmeasurableWindowIds?: string[];
}

interface Usage {
  remaining: number;
  used: number;
}

interface Cycle {
  startsAtMs: number;
  resetsAtMs: number;
  cycleSeconds: number;
  cycleBasis: "starts_at_resets_at" | "window_seconds";
}

type CycleResult = { ok: true; cycle: Cycle } | { ok: false; reason: PaceReason; startsAtMs?: number };

/** Stable id for runway output: explicit id, else kind[:scope]. */
export function windowId(w: PaceWindow): string {
  return w.id ?? (w.scope ? `${w.kind}:${w.scope}` : w.kind);
}

export function computeWindowPace(win: PaceWindow, now = Date.now(), opts: { stale?: boolean } = {}): WindowPace {
  if (opts.stale) return unknown("stale");
  if (!Number.isFinite(now)) return unknown("invalid_cycle");
  const usage = resolveUsage(win);
  if (!usage) return unknown("missing_usage");
  const c = resolveCycle(win, now);
  if (!c.ok) return unknown(c.reason);

  const { startsAtMs, resetsAtMs, cycleSeconds, cycleBasis } = c.cycle;
  const elapsedMs = now - startsAtMs;
  const timeRemainingPercent = (100 * (resetsAtMs - now)) / (cycleSeconds * 1000);
  const elapsedPercent = (100 * elapsedMs) / (cycleSeconds * 1000);
  const reservePercentPoints = usage.remaining - timeRemainingPercent;

  const pace: WindowPace = {
    status: classifyPace(reservePercentPoints),
    elapsedPercent,
    timeRemainingPercent,
    reservePercentPoints,
    cycleBasis,
    cycleSeconds,
  };
  if (elapsedPercent > 0) pace.burnMultiple = usage.used / elapsedPercent;

  if (usage.used > 0 && elapsedMs > 0 && usage.remaining >= 0) {
    const atMs = now + usage.remaining / (usage.used / elapsedMs);
    if (isRepresentable(atMs)) {
      pace.projectedExhaustedAt = new Date(atMs).toISOString();
      pace.projectionConfidence = elapsedPercent < PACE_EARLY_ELAPSED_PERCENT ? "early" : "established";
    }
  }
  return pace;
}

export function computeEffectiveRunway(windows: PaceWindow[], now = Date.now()): EffectiveRunway {
  const exhausted = windows.find((w) => resolveUsage(w)?.remaining === 0);
  if (exhausted) {
    return {
      status: "exhausted_now",
      usableRunwaySeconds: 0,
      limitingWindowId: windowId(exhausted),
      ...(isRepresentable(now) ? { projectedExhaustedAt: new Date(now).toISOString() } : {}),
    };
  }

  // No bound reports a reset: no cycle to derive any verdict from. Fail closed.
  if (windows.every((w) => !w.resetsAt) || !isRepresentable(now)) {
    return { status: "unknown", ...(windows.length ? { unmeasurableWindowIds: windows.map(windowId) } : {}) };
  }

  const unmeasurable: string[] = [];
  let limiting: { id: string; atMs: number; confidence: ProjectionConfidence } | undefined;
  let lowest: ProjectionConfidence = "established";

  for (const w of windows) {
    const usage = resolveUsage(w);
    const zeroUse = usage !== undefined && isZeroUse(usage);
    // Missing resetsAt + zero use: countdown not started (e.g. five_hour before
    // the first request). Any other usage shape without a reset is a data gap.
    if (!w.resetsAt) {
      if (!zeroUse) unmeasurable.push(windowId(w));
      continue;
    }
    const c = resolveCycle(w, now);
    if (!c.ok) {
      // Zero-use window opening within the skew tolerance: not yet opened.
      const notYetOpened =
        c.reason === "future_cycle_start" &&
        zeroUse &&
        c.startsAtMs !== undefined &&
        c.startsAtMs - now <= UNOPENED_FUTURE_START_SKEW_SECONDS * 1000;
      if (!notYetOpened) unmeasurable.push(windowId(w));
      continue;
    }
    if (!usage || usage.remaining < 0 || usage.remaining > 100) {
      unmeasurable.push(windowId(w));
      continue;
    }
    const pace = computeWindowPace(w, now);
    if (zeroUse) {
      if ((pace.elapsedPercent ?? 0) < PACE_EARLY_ELAPSED_PERCENT) lowest = "early";
      continue;
    }
    const atMs = pace.projectedExhaustedAt ? Date.parse(pace.projectedExhaustedAt) : Number.NaN;
    if (!(atMs > now) || !pace.projectionConfidence) {
      unmeasurable.push(windowId(w));
      continue;
    }
    if (pace.projectionConfidence === "early") lowest = "early";
    if (atMs < c.cycle.resetsAtMs && (!limiting || atMs < limiting.atMs)) {
      limiting = { id: windowId(w), atMs, confidence: pace.projectionConfidence };
    }
  }

  if (unmeasurable.length > 0) return { status: "unknown", unmeasurableWindowIds: unmeasurable };
  if (!limiting) return { status: "through_reset", projectionConfidence: lowest };
  return {
    status: "projected_exhaustion",
    usableRunwaySeconds: Math.max(0, Math.round((limiting.atMs - now) / 1000)),
    projectedExhaustedAt: new Date(limiting.atMs).toISOString(),
    limitingWindowId: limiting.id,
    projectionConfidence: limiting.confidence,
  };
}

// Polarity per quota-axi: positive reserve = quota left over the clock = behind.
function classifyPace(reserve: number): "ahead" | "on_pace" | "behind" {
  if (Math.abs(reserve) <= PACE_ON_PACE_DEADBAND_PERCENT_POINTS) return "on_pace";
  return reserve < 0 ? "ahead" : "behind";
}

function resolveUsage(w: PaceWindow): Usage | undefined {
  const fraction = finite(w.remainingFraction);
  const usedPct = finite(w.usedPercent);
  const remaining = fraction !== undefined ? fraction * 100 : usedPct !== undefined ? 100 - usedPct : undefined;
  if (remaining === undefined) return undefined;
  return { remaining, used: usedPct ?? 100 - remaining };
}

function isZeroUse(u: Usage): boolean {
  return u.remaining === 100 && u.used === 0;
}

function resolveCycle(w: PaceWindow, now: number): CycleResult {
  const resetsAtMs = parseMs(w.resetsAt);
  if (resetsAtMs === undefined) return { ok: false, reason: "missing_cycle" };
  if (resetsAtMs <= now) return { ok: false, reason: "expired_reset" };

  const explicitStart = parseMs(w.startsAt);
  if (explicitStart !== undefined) {
    if (explicitStart >= resetsAtMs) return { ok: false, reason: "invalid_cycle" };
    if (explicitStart > now) return { ok: false, reason: "future_cycle_start", startsAtMs: explicitStart };
    const cycleSeconds = (resetsAtMs - explicitStart) / 1000;
    return {
      ok: true,
      cycle: { startsAtMs: explicitStart, resetsAtMs, cycleSeconds, cycleBasis: "starts_at_resets_at" },
    };
  }

  const windowSeconds = finite(w.windowSeconds);
  if (windowSeconds === undefined) return { ok: false, reason: "missing_cycle" };
  const startsAtMs = resetsAtMs - windowSeconds * 1000;
  if (!(windowSeconds > 0) || !isRepresentable(startsAtMs)) return { ok: false, reason: "invalid_cycle" };
  if (startsAtMs > now) return { ok: false, reason: "future_cycle_start", startsAtMs };
  return { ok: true, cycle: { startsAtMs, resetsAtMs, cycleSeconds: windowSeconds, cycleBasis: "window_seconds" } };
}

function unknown(reason: PaceReason): WindowPace {
  return { status: "unknown", reason, cycleBasis: "none" };
}

function parseMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function finite(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRepresentable(ms: number): boolean {
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
}
