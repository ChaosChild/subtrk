// track-estimate.test.ts – the go/no-go math: nearest-rank percentiles at the
// boundaries, record enrichment (tokens/usdE/provider), the statable set
// (done, leaf, uncontested, with numbers, inside the lookback), and
// buildEstimate's verdict ladder – exactly-at-capacity fits, median-fits/p90-
// does-not, insufficient, and every no-window shape (no cache, no provider,
// unmapped kind, missing percent, unparseable reset, no token history, sub-2%
// used). Calibration runs against a seeded usage store; everything is a temp
// dir + fixed clock.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTrackStore, type TrackRecord, type TrackStore } from "../src/track.ts";
import {
  buildEstimate,
  buildStats,
  enrichRecord,
  estimateText,
  percentile,
  providerOfModel,
  recordProvider,
  recordUsdE,
  statableRecords,
  statsText,
  trackTokens,
} from "../src/track-stats.ts";
import { hourKey, readUsageStore, type UsageStore } from "../src/usage.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rec(over: Partial<TrackRecord> & Pick<TrackRecord, "id" | "task">): TrackRecord {
  return {
    project: "C:\\work\\p",
    t0: NOW - HOUR,
    t1: NOW,
    status: "done",
    attribution: "session-window",
    contested: false,
    nested: null,
    pending: false,
    sessions: ["s1"],
    usage: { in: 1_000, cr: 5_000, cw: 200, out: 400, reqs: 3 },
    models: { "glm-5.3": 1 },
    wallMs: HOUR,
    ...over,
  };
}

function writeStore(dir: string, store: Partial<TrackStore>): void {
  writeFileSync(join(dir, "track.json"), JSON.stringify({ schemaVersion: 1, markers: [], records: [], ...store }));
}

function emptyUsageStore(): UsageStore {
  return {
    schemaVersion: 1,
    hourly: {},
    daily: {},
    localHourly: {},
    localDaily: {},
    samples: {},
    state: {},
    pricing: {},
  };
}

// `tokPerHour` glm tokens in each of the last `hours` UTC hours.
function writeUsageStore(dir: string, hours: number, tokPerHour: number, nowMs: number): void {
  const hourly: UsageStore["hourly"] = { glm: {} };
  for (let i = 0; i < hours; i++) {
    hourly.glm[hourKey(nowMs - i * HOUR)] = { "glm-5.3": { in: tokPerHour, req: 10 } };
  }
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({ schemaVersion: 1, hourly, daily: {}, samples: {}, state: {}, pricing: {} }),
  );
}

function writeCache(dir: string, windows: { kind: string; usedPercent?: number; resetsAt: string }[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      glm: {
        data: {
          id: "glm",
          ok: true,
          stale: false,
          fetchedAt: new Date(NOW - HOUR).toISOString(),
          windows,
        },
        fetchedAt: NOW - HOUR,
        ttlMs: 60_000,
      },
    }),
  );
}

// A history + window fixture; the 5h window resets 2h from NOW (started NOW-3h),
// so three hourly rows land inside it and `consumedTok` = 3 * tokPerHour.
function estDir(tokens: number[], usedPercent: number, consumedTok: number): string {
  const dir = tempDir("subtrk-est-");
  writeStore(dir, {
    records: tokens.map((tok, i) =>
      rec({ id: `t${i}`, task: "x", complexity: "m", usage: { in: tok, cr: 0, cw: 0, out: 0, reqs: 1 } }),
    ),
  });
  writeUsageStore(dir, 3, consumedTok / 3, NOW);
  writeCache(dir, [{ kind: "5h", usedPercent, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]);
  return dir;
}

function estimate(dir: string, provider: string | null = "glm", complexity: string | null = "m") {
  const store = readTrackStore(dir);
  return buildEstimate(
    store.records.map((r) => enrichRecord(r, readUsageStore(dir))),
    {
      provider,
      complexity,
      subtrkDir: dir,
      nowMs: NOW,
    },
  );
}

// ---------- pure helpers ----------

describe("percentile boundaries", () => {
  it("nearest rank: p0 is the min, p1 the max, singletons pass through, empty is null", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([7], 0.9), 7);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2, "ceil(.5*4)-1 = 1");
    assert.equal(percentile([4, 1, 3, 2], 0.9), 4, "ceil(.9*4)-1 = 3");
    assert.equal(percentile([5, 2, 9], 0), 2, "p=0 clamps to the first sorted element");
    assert.equal(percentile([5, 2, 9], 1), 9, "p=1 is the maximum");
    assert.equal(percentile([1, 2], 0.5), 1, "ceil(1)-1 = 0: lower median for even n");
  });
});

describe("record helpers", () => {
  it("trackTokens sums the split and treats a missing usage as zero", () => {
    assert.equal(trackTokens(rec({ id: "a", task: "t" })), 6_600);
    assert.equal(trackTokens(rec({ id: "a", task: "t", usage: null })), 0);
  });

  it("providerOfModel covers the families and rejects strangers", () => {
    assert.equal(providerOfModel("GLM-5.3"), "glm");
    assert.equal(providerOfModel("claude-opus-5-5"), "claude");
    assert.equal(providerOfModel("gpt-5.2"), "openai");
    assert.equal(providerOfModel("o3-mini"), "openai");
    assert.equal(providerOfModel("qwen3-max"), "alibaba");
    assert.equal(providerOfModel("gemini-3-pro"), "google");
    assert.equal(providerOfModel("kimi-k2"), "kimi");
    assert.equal(providerOfModel("moonshot-v1"), "kimi");
    assert.equal(providerOfModel("weird-9"), null);
  });

  it("recordProvider prefers the marker's providerHint; dominantModel picks the largest share", () => {
    const hinted = rec({ id: "a", task: "t", providerHint: "kimi", models: { "glm-5.3": 0.9, "gpt-5.2": 0.1 } });
    assert.equal(recordProvider(hinted), "kimi");
    const derived = rec({ id: "a", task: "t", models: { "glm-5.3": 0.4, "gpt-5.2": 0.6 } });
    assert.equal(recordProvider(derived), "openai");
    assert.equal(recordProvider(rec({ id: "a", task: "t", models: undefined })), null);
  });

  it("recordUsdE prices the aggregate split at the dominant model; unpriced models give null", () => {
    const dir = tempDir("subtrk-usde-");
    try {
      const ustore = readUsageStore(dir); // no pricing rows – the bundled fallback table prices glm
      const priced = recordUsdE(rec({ id: "a", task: "t" }), ustore);
      assert.ok(priced !== null && priced > 0, `glm-5.3 priced from the fallback table (got ${priced})`);
      const unpriced = recordUsdE(rec({ id: "a", task: "t", models: { "weird-9": 1 } }), ustore);
      assert.equal(unpriced, null);
      assert.equal(recordUsdE(rec({ id: "a", task: "t", usage: null }), ustore), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statableRecords", () => {
  it("keeps done, leaf, uncontested, numbered records inside the lookback – and the exact 30d edge", () => {
    const store: TrackStore = {
      schemaVersion: 1,
      markers: [],
      records: [
        rec({ id: "keep", task: "a" }),
        rec({ id: "edge-in", task: "b", t1: NOW - 30 * DAY }), // exactly at the cutoff
        rec({ id: "too-old", task: "c", t1: NOW - 30 * DAY - 1 }),
        rec({ id: "aborted", task: "d", status: "aborted" }),
        rec({ id: "nested", task: "e", nested: "keep" }),
        rec({ id: "contested", task: "f", contested: true }),
        rec({ id: "pending", task: "g", pending: true }),
        rec({ id: "no-usage", task: "h", usage: null }),
      ],
    };
    const kept = statableRecords(store, NOW, 30).map((r) => r.id);
    assert.deepEqual(kept.sort(), ["edge-in", "keep"]);
  });
});

describe("buildStats", () => {
  it("buckets by provider x complexity; unpriced records leave the usd percentiles null", () => {
    const noPricing = emptyUsageStore();
    const mk = (tok: number) =>
      rec({
        id: `r${tok}`,
        task: "t",
        complexity: "m",
        usage: { in: tok, cr: 0, cw: 0, out: 0, reqs: 1 },
        models: { "weird-9": 1 }, // honestly unpriced
      });
    const records = [mk(100), mk(300), mk(200)].map((r) => enrichRecord(r, noPricing));
    const out = buildStats(records, records, 30);
    assert.equal(out.n, 3);
    const m = out.buckets[0];
    assert.equal(m.p50Tok, 200);
    assert.equal(m.p90Tok, 300);
    assert.equal(m.lowN, false, "n=3 clears the low-n flag");
    assert.equal(m.p50Usd, null, "weird-9 is unpriced – no invented dollars");

    const priced = [mk(100), mk(300)].map((r) => enrichRecord({ ...r, models: { "glm-5.3": 1 } }, noPricing));
    const two = buildStats(priced, priced, 30);
    assert.equal(two.buckets[0].lowN, true, "n=2 flags low-n");
    assert.ok(two.buckets[0].p50Usd !== null, "glm models price through the fallback table");
  });
});

// ---------- estimate verdicts ----------

describe("buildEstimate verdicts", () => {
  it("exactly-at-capacity fits: p90 equal to the remaining tokens is inside", () => {
    const dir = estDir([500_000, 1_000_000, 1_000_000], 50, 1_000_000); // capacity 2M, remaining 1M, p90 1M
    try {
      const out = estimate(dir);
      assert.equal(out.verdict, "fits");
      assert.ok(Math.abs((out.window?.capacityTok ?? 0) - 2_000_000) < 1);
      assert.ok(Math.abs((out.window?.remainingTok ?? 0) - 1_000_000) < 1);
      assert.equal(out.history.p50Tok, 1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("median fits, p90 does not; even the median failing is insufficient", () => {
    const medianDir = estDir([500_000, 1_000_000, 2_000_000], 50, 1_000_000); // p50 1M, p90 2M, remaining 1M
    const starvedDir = estDir([2_000_000, 2_500_000, 3_000_000], 50, 1_000_000);
    try {
      const med = estimate(medianDir);
      assert.equal(med.verdict, "median");
      assert.equal(med.note, "median fits, p90 does not – split the task or switch model");
      const starved = estimate(starvedDir);
      assert.equal(starved.verdict, "insufficient");
      assert.equal(starved.note, "even the median exceeds what is left – defer or split");
    } finally {
      rmSync(medianDir, { recursive: true, force: true });
      rmSync(starvedDir, { recursive: true, force: true });
    }
  });

  it("zero remaining (100% used) is never 'fits' for real history; 150% clamps to the same", () => {
    const full = estDir([500_000, 600_000, 700_000], 100, 1_000_000);
    const over = estDir([500_000, 600_000, 700_000], 150, 1_000_000);
    try {
      const a = estimate(full);
      assert.equal(a.verdict, "insufficient");
      assert.equal(a.window?.remainingTok, 0);
      assert.equal(a.window?.usedPercent, 100, "the raw percent is preserved");
      const b = estimate(over);
      assert.equal(b.verdict, "insufficient");
      assert.equal(b.window?.usedPercent, 150, "out-of-range percent still reported verbatim");
      assert.equal(b.window?.remainingTok, 0, "clamped to 100% used before the math");
    } finally {
      rmSync(full, { recursive: true, force: true });
      rmSync(over, { recursive: true, force: true });
    }
  });

  it("tiny history still lands a verdict, flagged low-n", () => {
    const dir = estDir([400_000], 50, 1_000_000);
    try {
      const out = estimate(dir);
      assert.equal(out.history.n, 1);
      assert.equal(out.history.lowN, true);
      assert.equal(out.verdict, "fits", "a single small task still decides");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a richer neighbouring complexity beats a thin exact bucket and flags the fallback", () => {
    const dir = tempDir("subtrk-est-fb-");
    try {
      writeStore(dir, {
        records: [
          rec({ id: "exact", task: "thin", complexity: "m", usage: { in: 9_000_000, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "l1", task: "x", complexity: "l", usage: { in: 100_000, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "l2", task: "y", complexity: "l", usage: { in: 200_000, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "l3", task: "z", complexity: "l", usage: { in: 300_000, cr: 0, cw: 0, out: 0, reqs: 1 } }),
        ],
      });
      writeUsageStore(dir, 3, 1_000_000 / 3, NOW);
      writeCache(dir, [{ kind: "5h", usedPercent: 50, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]);
      const out = estimate(dir);
      assert.equal(out.history.n, 3, "the n>=3 neighbour bucket is preferred over n=1");
      assert.equal(out.history.fellBack, true);
      assert.equal(out.history.lowN, false);
      assert.equal(out.history.p50Tok, 200_000);
      assert.deepEqual(
        out.fallbacks.map((f) => f.label),
        ["l"],
        "the other complexities are disclosed (the queried one is the history itself)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fallbacks disclose every other complexity's median under the provider", () => {
    const dir = tempDir("subtrk-est-fb2-");
    try {
      writeStore(dir, {
        records: [
          rec({ id: "m1", task: "a", complexity: "m", usage: { in: 100, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "m2", task: "b", complexity: "m", usage: { in: 100, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "m3", task: "c", complexity: "m", usage: { in: 100, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "x1", task: "d", complexity: "xs", usage: { in: 10, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "x2", task: "e", complexity: "xs", usage: { in: 30, cr: 0, cw: 0, out: 0, reqs: 1 } }),
          rec({ id: "z1", task: "f", complexity: "xl", usage: { in: 900, cr: 0, cw: 0, out: 0, reqs: 1 } }),
        ],
      });
      const store = readTrackStore(dir);
      const out = buildEstimate(
        store.records.map((r) => enrichRecord(r, emptyUsageStore())),
        { provider: "glm", complexity: "m", subtrkDir: dir, nowMs: NOW },
      );
      assert.deepEqual(
        out.fallbacks.map((f) => f.label),
        ["xs", "xl"],
      );
      assert.equal(out.fallbacks[0].p50Tok, 10, "nearest-rank lower median of [10, 30]");
      assert.equal(out.fallbacks[0].lowN, true);
      assert.equal(out.fallbacks[1].n, 1);
      assert.equal(out.verdict, "no-window", "no cache.json here – history only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no history at all is its own verdict, and the window is not even looked up", () => {
    const dir = tempDir("subtrk-est-empty-");
    try {
      writeStore(dir, { records: [] });
      writeUsageStore(dir, 3, 100_000, NOW);
      writeCache(dir, [{ kind: "5h", usedPercent: 50, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]);
      const out = estimate(dir);
      assert.equal(out.verdict, "no-history");
      assert.equal(out.window, null);
      assert.match(out.note ?? "", /no done, uncontested leaf records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-window shapes: no cache entry, no provider, unmapped kind, missing percent", () => {
    const dir = estDir([500_000, 600_000, 700_000], 50, 1_000_000);
    const noKind = tempDir("subtrk-est-nk-");
    const noPct = tempDir("subtrk-est-np-");
    try {
      rmSync(join(dir, "cache.json"), { force: true });
      const a = estimate(dir);
      assert.equal(a.verdict, "no-window");
      assert.equal(a.window, null);
      assert.match(a.note ?? "", /no cached window/);

      const b = estimate(dir, null, null);
      assert.equal(b.verdict, "no-window");
      assert.match(b.note ?? "", /pass --provider/);

      writeStore(noKind, {
        records: [rec({ id: "t0", task: "x", complexity: "m", usage: { in: 1, cr: 0, cw: 0, out: 0, reqs: 1 } })],
      });
      writeUsageStore(noKind, 3, 100_000, NOW);
      writeCache(noKind, [{ kind: "monthly", usedPercent: 50, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]);
      const c = estimate(noKind);
      assert.equal(c.verdict, "no-window", "a window without a fixed duration cannot be calibrated");
      assert.equal(c.window, null);

      writeStore(noPct, {
        records: [rec({ id: "t0", task: "x", complexity: "m", usage: { in: 1, cr: 0, cw: 0, out: 0, reqs: 1 } })],
      });
      writeUsageStore(noPct, 3, 100_000, NOW);
      writeCache(noPct, [{ kind: "5h", resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]);
      const d = estimate(noPct);
      assert.equal(d.verdict, "no-window");
      assert.equal(d.window, null, "a percent-less window is ignored entirely");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(noKind, { recursive: true, force: true });
      rmSync(noPct, { recursive: true, force: true });
    }
  });

  it("the first mapped window wins when several are cached", () => {
    const dir = estDir([500_000, 600_000, 700_000], 50, 1_000_000);
    try {
      writeCache(dir, [
        { kind: "monthly", usedPercent: 99, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
        { kind: "7d", usedPercent: 10, resetsAt: new Date(NOW + 3 * DAY).toISOString() },
        { kind: "5h", usedPercent: 50, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
      ]);
      const out = estimate(dir);
      assert.equal(out.window?.kind, "7d", "monthly is unmapped; 7d is the first mapped entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calibration needs token history for the window's period; an unparseable reset too", () => {
    const noRows = estDir([500_000, 600_000, 700_000], 50, 0); // zero consumed
    const badReset = tempDir("subtrk-est-br-");
    try {
      const a = estimate(noRows);
      assert.equal(a.verdict, "no-window");
      assert.equal(a.window?.consumedTok, null);
      assert.equal(a.window?.calibrated, false);
      assert.match(a.note ?? "", /calibration needs token history/);

      writeStore(badReset, {
        records: [rec({ id: "t0", task: "x", complexity: "m", usage: { in: 1, cr: 0, cw: 0, out: 0, reqs: 1 } })],
      });
      writeUsageStore(badReset, 3, 100_000, NOW);
      writeCache(badReset, [{ kind: "5h", usedPercent: 50, resetsAt: "not a date" }]);
      const b = estimate(badReset);
      assert.equal(b.verdict, "no-window");
      assert.equal(b.window?.consumedTok, null, "an unparseable resetsAt blocks the calibration");
    } finally {
      rmSync(noRows, { recursive: true, force: true });
      rmSync(badReset, { recursive: true, force: true });
    }
  });

  it("the 2% gate: exactly 2% used calibrates, 1% cannot", () => {
    const atTwo = estDir([500_000, 600_000, 700_000], 2, 1_000_000); // capacity 50M, remaining 49M
    const atOne = estDir([500_000, 600_000, 700_000], 1, 1_000_000);
    try {
      const a = estimate(atTwo);
      assert.equal(a.verdict, "fits");
      assert.ok(Math.abs((a.window?.capacityTok ?? 0) - 50_000_000) < 1);
      const b = estimate(atOne);
      assert.equal(b.verdict, "no-window", "below 2% the capacity estimate is noise and is refused");
      assert.equal(b.window?.calibrated, false);
      assert.ok(b.window !== null, "the window itself is still reported");
    } finally {
      rmSync(atTwo, { recursive: true, force: true });
      rmSync(atOne, { recursive: true, force: true });
    }
  });
});

// ---------- rendering ----------

describe("estimate + stats text", () => {
  it("renders the calibrated median verdict end to end", () => {
    const dir = estDir([500_000, 1_000_000, 2_000_000], 82, 5_900_000);
    try {
      const out = estimate(dir);
      const text = estimateText(out).join("\n");
      assert.match(text, /history\s+n=3 \(glm, m\)/);
      assert.match(text, /window\s+glm 5h · 18% left/);
      assert.match(text, /calibrated: 5\.90M consumed at 82%/);
      assert.match(text, /verdict\s+median fits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stats text prints the empty-state line when nothing statable exists", () => {
    const text = statsText(buildStats([], [], 30)).join("\n");
    assert.match(text, /no done tasks in the last 30d/);
    assert.match(text, /help: subtrk track stats --json/);
  });
});
