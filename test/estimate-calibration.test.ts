// estimate-calibration.test.ts – vk-11 SPEC (expected to fail until implemented):
// the calibration ladder for `track estimate` / `--suggest`. A freshly reset
// window (<2% used) is exactly when an agent asks "can I run this?", so
// capacity must come from the provider's own prior windows when the current
// one is too young to calibrate itself.
//
// Ladder (first rung that holds wins):
//   1. calibrated:current-window   used >= 10% and in-window tokens > 0
//   2. calibrated:history          >= 3 prior generations of the same window key, each
//                                  ending at >= 10% used with tokens > 0 → median capacity
//   3. calibrated:current-window   used 2–10% (today's 2% gate) when rung 2 is unavailable
//   4. estimated:history-sparse    1–2 such generations → Σtokens / Σ(final used%)
//   5. unknown                     skipped; the reason names what is missing
// A prior generation = usage-store samples with the same key (kind, or
// "kind·scope"), resetsAt rounded to the minute (vendors jitter it by ms),
// reset <= now, not the current generation, non-stale samples only; its final
// used% is its max sample, its tokens are the provider's usage over
// [reset − kind duration, reset). Remaining = capacity × (1 − used_now).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TrackRecord } from "../src/track.ts";
import { readTrackStore, trackStorePath } from "../src/track.ts";
import {
  buildEstimate,
  buildSuggest,
  type EstimateWindow,
  enrichRecord,
  estimateCommand,
  type SuggestCandidate,
  statableRecords,
} from "../src/track-stats.ts";
import { hourKey, readUsageStore } from "../src/usage.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 13, 0, 0, 0); // hour-aligned so 5h windows map onto whole hourly rows
const CUR_RESET = NOW + 4 * H; // current 5h window: [NOW-1h, NOW+4h)
const iso = (ms: number) => new Date(ms).toISOString();

// Spec-only shape: the additive fields the implementation must add.
type Confidence = "calibrated:current-window" | "calibrated:history" | "estimated:history-sparse" | "unknown";
type Win = EstimateWindow & { confidence?: Confidence; historyN?: number };
type Cand = SuggestCandidate & { confidence?: Confidence };

function rec(id: string, tok: number): TrackRecord {
  return {
    id,
    task: "x",
    project: "C:\\work\\p",
    t0: 0,
    t1: NOW,
    status: "done",
    attribution: "session-window",
    contested: false,
    nested: null,
    pending: false,
    sessions: ["s1"],
    complexity: "m",
    usage: { in: tok / 3, cr: tok / 3, cw: 0, out: tok / 3, reqs: 1 },
    models: { "glm-5.3": 1 },
    wallMs: H,
  };
}

interface Gen {
  endsAgoH: number; // reset = NOW - 1h - endsAgoH hours (0 = ends where the current window starts)
  tok: number; // tokens spread evenly over the generation's 5 hours
  u: number; // final used%
  stale?: boolean;
  jitter?: boolean; // report resetsAt with ms jitter across samples (real glm/claude behaviour)
}

interface Fx {
  usedNow: number;
  curTok?: number; // tokens inside the current window
  gens?: Gen[];
}

// glm, 5h window. Prior generations end back to back before the current one.
function fixture({ usedNow, curTok = 0, gens = [] }: Fx): string {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-calib-"));
  writeFileSync(
    trackStorePath(dir),
    JSON.stringify({
      schemaVersion: 1,
      markers: [],
      records: [rec("g1", 1.0e6), rec("g2", 1.2e6), rec("g3", 1.4e6)],
    }),
  );
  const hourly: Record<string, Record<string, object>> = {};
  const add = (hourMs: number, tok: number) => {
    hourly[hourKey(hourMs)] = { "glm-5.3": { in: tok, req: 1 } };
  };
  if (curTok > 0) add(NOW - H, curTok);
  const samples: object[] = [];
  for (const g of gens) {
    const reset = NOW - H - g.endsAgoH * H;
    for (let i = 1; i <= 5; i++) add(reset - i * H, g.tok / 5);
    for (const [j, frac] of [0.5, 1].entries()) {
      const r = g.jitter ? iso(reset + j * 7) : iso(reset); // same generation, ms-jittered resetsAt
      samples.push({ t: reset - 10 * 60_000 + j, k: "5h", u: g.u * frac, r, ...(g.stale ? { stale: true } : {}) });
    }
  }
  // the current generation's own samples never count as history
  samples.push({ t: NOW - 30 * 60_000, k: "5h", u: usedNow, r: iso(CUR_RESET) });
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({
      schemaVersion: 1,
      hourly: { glm: hourly },
      daily: {},
      samples: { glm: samples },
      state: {},
      pricing: {},
    }),
  );
  writeFileSync(
    join(dir, "cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      glm: {
        data: {
          id: "glm",
          ok: true,
          stale: false,
          fetchedAt: iso(NOW - 60_000),
          windows: [{ kind: "5h", usedPercent: usedNow, resetsAt: iso(CUR_RESET) }],
        },
        fetchedAt: NOW - 60_000,
        ttlMs: 60_000,
      },
    }),
  );
  writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["glm"] }));
  return dir;
}

const dirs: string[] = [];
function fx(f: Fx): string {
  const d = fixture(f);
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function pool(dir: string) {
  const ustore = readUsageStore(dir);
  return statableRecords(readTrackStore(dir), NOW).map((r) => enrichRecord(r, ustore));
}
const estimate = (dir: string) =>
  buildEstimate(pool(dir), { provider: "glm", complexity: "m", subtrkDir: dir, nowMs: NOW });
const suggest = (dir: string) =>
  buildSuggest(pool(dir), { providers: ["glm"], complexity: "m", subtrkDir: dir, nowMs: NOW });

// Four prior windows, 10M tokens each at 50% → capacity 20M per window.
const RICH: Gen[] = [0, 5, 10, 15].map((endsAgoH) => ({ endsAgoH, tok: 10e6, u: 50 }));

function near(actual: number | null | undefined, expected: number, label: string): void {
  assert.ok(actual != null && Math.abs(actual - expected) < 1, `${label}: ${actual} != ${expected}`);
}

describe("vk-11 calibration ladder (SPEC – expected to fail until implemented)", () => {
  it("operator case: fresh window (1% used) + rich history → SUGGESTED, calibrated:history", () => {
    const dir = fx({ usedNow: 1, curTok: 0.1e6, gens: RICH });
    const sg = suggest(dir);
    assert.equal(sg.excluded.length, 0, `must not be skipped: ${JSON.stringify(sg.excluded)}`);
    const c = sg.candidates[0] as Cand;
    assert.equal(c.provider, "glm");
    assert.equal(c.confidence, "calibrated:history");
    near(c.remainingTok, 20e6 * 0.99, "remaining = median capacity × (1 − 1%)");
    assert.equal(c.fits, "p50+p90");

    const e = estimate(dir);
    const w = e.window as Win;
    assert.equal(e.verdict, "fits");
    assert.equal(w.calibrated, true);
    assert.equal(w.confidence, "calibrated:history");
    assert.equal(w.historyN, 4);
    near(w.capacityTok, 20e6, "capacity");
  });

  it("0% used (just reset, no in-window tokens) still calibrates from history", () => {
    const e = estimate(fx({ usedNow: 0, gens: RICH }));
    assert.equal((e.window as Win).confidence, "calibrated:history");
    near(e.window?.remainingTok, 20e6, "a fully fresh window has the whole capacity left");
  });

  it("fresh window + zero history → skipped with the honest reason, confidence unknown", () => {
    const dir = fx({ usedNow: 1, curTok: 0.1e6 });
    const sg = suggest(dir);
    assert.equal(sg.candidates.length, 0);
    assert.equal(sg.excluded.length, 1);
    assert.match(sg.excluded[0].reason, /under 2% used/, "keeps today's wording (existing assertions)");
    assert.match(sg.excluded[0].reason, /no prior 5h window/, "and names the missing history");
    const e = estimate(dir);
    assert.equal(e.verdict, "no-window");
    assert.equal((e.window as Win).confidence, "unknown");
    assert.equal(e.window?.calibrated, false);
  });

  it("partial history (2 qualifying windows) → estimated:history-sparse, pooled Σtok/Σused", () => {
    const e = estimate(
      fx({
        usedNow: 1,
        gens: [
          { endsAgoH: 0, tok: 10e6, u: 50 },
          { endsAgoH: 5, tok: 15e6, u: 50 },
        ],
      }),
    );
    const w = e.window as Win;
    assert.equal(w.confidence, "estimated:history-sparse");
    assert.equal(w.historyN, 2);
    near(w.capacityTok, 25e6, "(10M + 15M) / (0.5 + 0.5)");
  });

  it("precedence: a calibratable current window beats history", () => {
    const e = estimate(fx({ usedNow: 40, curTok: 8e6, gens: RICH.map((g) => ({ ...g, tok: 25e6 })) }));
    const w = e.window as Win;
    assert.equal(w.confidence, "calibrated:current-window");
    near(w.capacityTok, 20e6, "8M / 40% – history's 50M is ignored");
  });

  it("precedence: rich history beats a barely-used (2–10%) current window", () => {
    // Real store, 2026-10-13: glm 5h at exactly 2% calibrated itself to 2.15G capacity,
    // 11x its 190M history median – a 2% current window is the noise the gate exists for.
    const e = estimate(fx({ usedNow: 2, curTok: 1e6, gens: RICH }));
    const w = e.window as Win;
    assert.equal(w.confidence, "calibrated:history");
    near(w.capacityTok, 20e6, "history median, not 1M / 2% = 50M");
  });

  it("with no history, the 2–10% current window still calibrates (today's 2% gate holds)", () => {
    const e = estimate(fx({ usedNow: 2, curTok: 1e6 }));
    assert.equal((e.window as Win).confidence, "calibrated:current-window");
    near(e.window?.capacityTok, 50e6, "1M / 2%");
  });

  it("history capacity is the median – one outlier generation cannot swing it", () => {
    const e = estimate(
      fx({
        usedNow: 1,
        gens: [
          { endsAgoH: 0, tok: 5e6, u: 50 }, // 10M
          { endsAgoH: 5, tok: 10e6, u: 50 }, // 20M
          { endsAgoH: 10, tok: 500e6, u: 50 }, // 1000M outlier
        ],
      }),
    );
    near(e.window?.capacityTok, 20e6, "median of 10M/20M/1000M");
  });

  it("generations below 10% final usage, stale-sampled ones, and token-less ones do not qualify", () => {
    const e = estimate(
      fx({
        usedNow: 1,
        gens: [
          { endsAgoH: 0, tok: 10e6, u: 50 }, // qualifies
          { endsAgoH: 5, tok: 10e6, u: 8 }, // final 8% – too little to calibrate
          { endsAgoH: 10, tok: 10e6, u: 50, stale: true }, // error-fallback samples
          { endsAgoH: 15, tok: 0, u: 50 }, // no token history
        ],
      }),
    );
    const w = e.window as Win;
    assert.equal(w.confidence, "estimated:history-sparse");
    assert.equal(w.historyN, 1);
    near(w.capacityTok, 20e6, "only the qualifying generation");
  });

  it("ms-jittered resetsAt is ONE generation (minute-rounded key)", () => {
    // Real store: claude shows 702 raw 5h resetsAt values in 35 days, 23 after rounding.
    const e = estimate(fx({ usedNow: 1, gens: RICH.slice(0, 2).map((g) => ({ ...g, jitter: true })) }));
    const w = e.window as Win;
    assert.equal(w.historyN, 2, "two generations, not four");
    assert.equal(w.confidence, "estimated:history-sparse");
  });

  it("JSON carries window.confidence / historyN and suggest candidates[].confidence", async () => {
    const dir = fx({ usedNow: 1, curTok: 0.1e6, gens: RICH });
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      assert.equal(
        await estimateCommand(
          { json: true, provider: "glm", complexity: "m", suggest: true },
          { subtrkDir: dir, now: () => NOW },
        ),
        0,
      );
    } finally {
      console.log = orig;
    }
    const j = JSON.parse(out[0]) as { window: Win; suggest: { candidates: Cand[] } };
    assert.equal(j.window.confidence, "calibrated:history");
    assert.equal(j.window.historyN, 4);
    assert.equal(j.suggest.candidates[0].confidence, "calibrated:history");
  });

  it("text names the rung: history line on the window, confidence label on each suggestion", async () => {
    const dir = fx({ usedNow: 1, curTok: 0.1e6, gens: RICH });
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      await estimateCommand(
        { json: false, provider: "glm", complexity: "m", suggest: true },
        { subtrkDir: dir, now: () => NOW },
      );
    } finally {
      console.log = orig;
    }
    assert.ok(
      out.some((l) =>
        /≈ 19\.80M tok remaining {2}\(calibrated:history – median capacity 20\.00M over 4 prior 5h windows\)/.test(l),
      ),
      out.join("\n"),
    );
    assert.ok(
      out.some((l) => /glm\/glm-5\.3\s+fits p90 · headroom \d+% .*· calibrated:history$/.test(l)),
      out.join("\n"),
    );
  });
});
