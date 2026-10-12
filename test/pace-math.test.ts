// pace-math.test.ts – computeWindowPace / computeEffectiveRunway boundaries.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeEffectiveRunway, computeWindowPace, type PaceWindow } from "../src/pace.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const H = 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

// 100h cycle so 1 hour == 1 percent point of elapsed time.
function win(elapsedPct: number, usedPercent: number | undefined, extra: Partial<PaceWindow> = {}): PaceWindow {
  return { kind: "w", usedPercent, resetsAt: iso(NOW + (100 - elapsedPct) * H), windowSeconds: 100 * 3600, ...extra };
}

describe("computeWindowPace", () => {
  it("deadband: reserve exactly +/-1 is on_pace, beyond flips", () => {
    assert.equal(computeWindowPace(win(50, 49), NOW).status, "on_pace"); // reserve +1
    assert.equal(computeWindowPace(win(50, 51), NOW).status, "on_pace"); // reserve -1
    assert.equal(computeWindowPace(win(50, 48), NOW).status, "behind");
    assert.equal(computeWindowPace(win(50, 52), NOW).status, "ahead");
  });

  it("elapsed=0: no burnMultiple, no projection", () => {
    const p = computeWindowPace(win(0, 0), NOW);
    assert.equal(p.elapsedPercent, 0);
    assert.equal(p.burnMultiple, undefined);
    assert.equal(p.projectedExhaustedAt, undefined);
    assert.equal(p.cycleBasis, "window_seconds");
  });

  it("used 0% has no projection; used 100% projects exhaustion now", () => {
    const zero = computeWindowPace(win(50, 0), NOW);
    assert.equal(zero.status, "behind");
    assert.equal(zero.burnMultiple, 0);
    assert.equal(zero.projectedExhaustedAt, undefined);
    const full = computeWindowPace(win(50, 100), NOW);
    assert.equal(full.status, "ahead");
    assert.equal(full.burnMultiple, 2);
    assert.equal(full.projectedExhaustedAt, iso(NOW));
  });

  it("normalizes remainingFraction (0-1) to percent points", () => {
    const p = computeWindowPace(win(50, undefined, { remainingFraction: 0.25 }), NOW);
    assert.equal(p.reservePercentPoints, -25);
    assert.equal(p.burnMultiple, 1.5);
  });

  it("unknown reasons", () => {
    const r = (w: PaceWindow, o?: { stale?: boolean }) => computeWindowPace(w, NOW, o).reason;
    assert.equal(r(win(50, 10), { stale: true }), "stale");
    assert.equal(r(win(50, undefined)), "missing_usage");
    assert.equal(r({ kind: "w", usedPercent: 10 }), "missing_cycle"); // missing resetsAt
    assert.equal(r({ kind: "w", usedPercent: 10, resetsAt: "" }), "missing_cycle");
    assert.equal(r(win(50, 10, { windowSeconds: undefined })), "missing_cycle"); // never inferred
    assert.equal(r(win(50, 10, { startsAt: iso(NOW + 60 * H) })), "invalid_cycle"); // starts after reset
    assert.equal(r(win(50, 10, { startsAt: iso(NOW + 50 * H) })), "invalid_cycle"); // starts == reset
    assert.equal(r(win(50, 10, { windowSeconds: 0 })), "invalid_cycle");
    assert.equal(r(win(50, 10, { startsAt: iso(NOW + H) })), "future_cycle_start");
    assert.equal(r(win(50, 10, { windowSeconds: 10 * 3600 })), "future_cycle_start"); // implied start ahead
    assert.equal(r(win(100, 10)), "expired_reset");
    assert.equal(computeWindowPace(win(50, 10, { resetsAt: iso(NOW - 1) }), NOW).cycleBasis, "none");
  });

  it("projection confidence flips at 10% elapsed", () => {
    assert.equal(computeWindowPace(win(9.99, 5), NOW).projectionConfidence, "early");
    assert.equal(computeWindowPace(win(10, 5), NOW).projectionConfidence, "established");
  });

  it("invariant: reserve = percentRemaining - timeRemainingPercent (starts_at_resets_at)", () => {
    const w: PaceWindow = { kind: "w", usedPercent: 37.3, startsAt: iso(NOW - 7 * H), resetsAt: iso(NOW + 13 * H) };
    const p = computeWindowPace(w, NOW);
    assert.equal(p.cycleBasis, "starts_at_resets_at");
    assert.equal(p.cycleSeconds, 20 * 3600);
    assert.ok(Math.abs((p.reservePercentPoints ?? Number.NaN) - (100 - 37.3 - (p.timeRemainingPercent ?? 0))) < 1e-9);
    assert.ok(Math.abs((p.timeRemainingPercent ?? 0) - 65) < 1e-9);
    // linear projection: 62.7 remaining at 37.3/7h
    const expected = NOW + 62.7 / (37.3 / (7 * H));
    assert.ok(Math.abs(Date.parse(p.projectedExhaustedAt ?? "") - expected) <= 1);
  });
});

describe("computeEffectiveRunway", () => {
  it("earliest projected exhaustion wins and names the limiting window", () => {
    const r = computeEffectiveRunway([win(50, 60, { id: "a" }), win(50, 80, { id: "b" })], NOW);
    assert.equal(r.status, "projected_exhaustion");
    assert.equal(r.limitingWindowId, "b");
    assert.equal(r.usableRunwaySeconds, 12.5 * 3600); // 20 left at 1.6/h
    assert.equal(r.projectionConfidence, "established");
  });

  it("through_reset when no projection lands before its reset", () => {
    const r = computeEffectiveRunway([win(50, 30)], NOW);
    assert.deepEqual(r, { status: "through_reset", projectionConfidence: "established" });
  });

  it("exhausted_now short-circuits everything else", () => {
    const r = computeEffectiveRunway([{ kind: "x", usedPercent: 10 }, win(50, 100, { id: "dead" })], NOW);
    assert.equal(r.status, "exhausted_now");
    assert.equal(r.usableRunwaySeconds, 0);
    assert.equal(r.limitingWindowId, "dead");
    assert.equal(computeEffectiveRunway([{ kind: "g", remainingFraction: 0 }], NOW).status, "exhausted_now");
  });

  it("fails closed when no window has a resetsAt", () => {
    const r = computeEffectiveRunway(
      [
        { kind: "five_hour", usedPercent: 0 },
        { kind: "seven_day", scope: "opus", usedPercent: 0 },
      ],
      NOW,
    );
    assert.deepEqual(r, { status: "unknown", unmeasurableWindowIds: ["five_hour", "seven_day:opus"] });
    assert.deepEqual(computeEffectiveRunway([], NOW), { status: "unknown" });
  });

  it("zero-use window without resetsAt is exempt; with usage it blocks", () => {
    const ok = computeEffectiveRunway([{ kind: "five_hour", usedPercent: 0 }, win(50, 80, { id: "b" })], NOW);
    assert.equal(ok.status, "projected_exhaustion");
    assert.equal(ok.limitingWindowId, "b");
    const gap = computeEffectiveRunway([{ kind: "five_hour", usedPercent: 5 }, win(50, 80)], NOW);
    assert.deepEqual(gap, { status: "unknown", unmeasurableWindowIds: ["five_hour"] });
  });

  it("zero-use future cycle within 5 min is not yet opened; beyond is unmeasurable", () => {
    const soon = win(50, 0, { id: "m", startsAt: iso(NOW + 2 * 60 * 1000) });
    assert.equal(computeEffectiveRunway([soon, win(50, 80)], NOW).status, "projected_exhaustion");
    const late = win(50, 0, { id: "m", startsAt: iso(NOW + 10 * 60 * 1000) });
    assert.deepEqual(computeEffectiveRunway([late, win(50, 80)], NOW), {
      status: "unknown",
      unmeasurableWindowIds: ["m"],
    });
  });

  it("invalid or expired cycles are unmeasurable", () => {
    const bad = win(50, 10, { id: "bad", startsAt: iso(NOW + 60 * H) });
    const old = win(100, 10, { id: "old" });
    assert.deepEqual(computeEffectiveRunway([bad, old, win(50, 30)], NOW), {
      status: "unknown",
      unmeasurableWindowIds: ["bad", "old"],
    });
  });

  it("early confidence propagates from zero-use and early projections", () => {
    assert.equal(computeEffectiveRunway([win(5, 0), win(50, 30)], NOW).projectionConfidence, "early");
    assert.equal(computeEffectiveRunway([win(5, 1)], NOW).projectionConfidence, "early");
  });
});
