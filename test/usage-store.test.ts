// usage-store.test.ts – the usage store's own discipline, beyond the basics:
// tolerant IO (corrupt vs schema-mismatch), the delta-watermark class
// (equal/replayed observations add zero, resets clamp, expired watermarks
// retire), sample-dedup boundaries (60s / 15min / surface mix / generations),
// pricing resolution + the 1h-cache-write composition in rowCost, aggregation
// windows (day/hour clipping, MTD-style mid-UTC-day edges, local modes,
// cache-hit cr+cw+in composition, usdA/usdE, blended split-less pricing),
// and the local-transcript walker's byte-offset off-by-one class plus its
// stale-rebuild self-correction. Also the `usage --rebuild` drop + refetch
// loop end to end in a subprocess. No network: fetch is always injected,
// HOME/USERPROFILE are stubbed to temp dirs, env secrets are removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { clearSecrets, type ProviderResult, registerSecret } from "../src/core.ts";
import {
  addDelta,
  aggregateUsage,
  dayKey,
  dayKeyToMs,
  glmMixFromStore,
  harvestUsage,
  hourKey,
  hourKeyToMs,
  mutateUsageStore,
  priceForModel,
  readUsageStore,
  recordSamples,
  replaceHourlyRange,
  rowCost,
  type UsageRow,
  type UsageStore,
  usageStorePath,
} from "../src/usage.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function newStore(): UsageStore {
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

// Seed the on-disk store with raw JSON (state shapes the mutators would build).
function seedStore(dir: string, partial: Partial<UsageStore>): void {
  writeFileSync(usageStorePath(dir), JSON.stringify({ ...newStore(), ...partial }));
}

function result(id: ProviderResult["id"], windows: ProviderResult["windows"], ok = true): ProviderResult {
  return { id, ok, stale: !ok, fetchedAt: new Date().toISOString(), windows };
}

// A claude transcript assistant line, the shape parseClaudeTranscriptLine eats.
function claudeMsg(id: string, inTok: number, outTok: number, ts = "2026-09-29T12:00:00Z"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: `req_${id}`,
    isApiErrorMessage: false,
    sessionId: "sess_main",
    message: {
      model: "claude-opus-5-5",
      id,
      usage: {
        input_tokens: inTok,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: outTok,
      },
    },
  })}\n`;
}

// ---------- store IO ----------

describe("usage store IO", () => {
  it("a corrupt store file resets to fresh AND is removed; a schema mismatch resets but is kept", () => {
    const corrupt = tempDir("subtrk-io-");
    const mismatched = tempDir("subtrk-io2-");
    try {
      writeFileSync(usageStorePath(corrupt), "{not json at all");
      assert.deepEqual(readUsageStore(corrupt), newStore());
      assert.throws(() => readFileSync(usageStorePath(corrupt), "utf8"), "unparseable file removed on read");
    } finally {
      rmSync(corrupt, { recursive: true, force: true });
    }
    try {
      writeFileSync(usageStorePath(mismatched), JSON.stringify({ schemaVersion: 99, hourly: {} }));
      assert.deepEqual(readUsageStore(mismatched), newStore());
      assert.ok(readFileSync(usageStorePath(mismatched), "utf8").length > 0, "version-mismatched file kept");
    } finally {
      rmSync(mismatched, { recursive: true, force: true });
    }
  });

  it("absent sections default to empty on read", () => {
    const dir = tempDir("subtrk-io3-");
    try {
      writeFileSync(usageStorePath(dir), JSON.stringify({ schemaVersion: 1 }));
      const store = readUsageStore(dir);
      assert.deepEqual(store.hourly, {});
      assert.deepEqual(store.samples, {});
      assert.deepEqual(store.pricing, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a mutator returning false skips the write entirely", () => {
    const dir = tempDir("subtrk-io4-");
    try {
      mutateUsageStore(
        dir,
        (s) => {
          replaceHourlyRange(s, "glm", 0, HOUR, { [hourKey(0)]: { m: { in: 1 } } });
          return false;
        },
        1_700_000_000_000,
      );
      assert.equal(readUsageStore(dir).updatedAt, undefined, "no write happened");
      assert.deepEqual(readUsageStore(dir).hourly, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("usageStorePath sits inside the given dir", () => {
    assert.ok(usageStorePath(join("x", "y")).endsWith(join("x", "y", "usage.json")));
  });
});

// ---------- delta watermark class ----------

describe("delta watermark class", () => {
  // Mirrors harvestZcode's in-lock pattern exactly: the delta is evaluated
  // against the STORED watermark inside the locked mutator. The clock is
  // pinned next to the fixtures – a real-clock write would prune 2023 hours.
  const AT = 1_700_000_000_000;
  const HK = hourKey(AT);
  function observe(dir: string, key: string, used: number): void {
    mutateUsageStore(
      dir,
      (store) => {
        if (!store.state.zcode) store.state.zcode = {};
        const s = store.state.zcode as { buckets?: Record<string, { used: number }> };
        s.buckets ??= {};
        const buckets = s.buckets;
        const prev = buckets[key];
        const delta = prev && used > prev.used ? used - prev.used : 0;
        buckets[key] = { used };
        if (delta > 0) addDelta(store, "zcode", HK, "glm-5-3", { tot: delta });
      },
      AT + HOUR,
    );
  }

  it("replayed equal observations add once; a counter reset adds zero and re-baselines", () => {
    const dir = tempDir("subtrk-wm-");
    try {
      observe(dir, "ent1@900", 1_000);
      observe(dir, "ent1@900", 1_500);
      observe(dir, "ent1@900", 1_500); // replay – the off-by-one class
      observe(dir, "ent1@900", 700); // bundle replaced – counter went DOWN
      const after = readUsageStore(dir).hourly.zcode[HK]["glm-5-3"].tot;
      assert.equal(after, 500, "only the genuine increase priced in");
      observe(dir, "ent1@900", 1_200); // growth from the re-baselined watermark
      assert.equal(readUsageStore(dir).hourly.zcode[HK]["glm-5-3"].tot, 1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expired bundle keys retire their watermarks; a new bundle's first read adds once", () => {
    const dir = tempDir("subtrk-wm2-");
    try {
      observe(dir, "ent1@900", 1_000);
      // the balance now only reports ent2: harvest retires ent1's watermark
      mutateUsageStore(
        dir,
        (store) => {
          const s = (store.state.zcode ?? {}) as { buckets?: Record<string, { used: number }> };
          s.buckets ??= {};
          const live = new Set(["ent2@999"]);
          for (const key of Object.keys(s.buckets)) {
            if (!live.has(key)) delete s.buckets[key];
          }
          s.buckets["ent2@999"] = { used: 300 };
          addDelta(store, "zcode", HK, "glm-5-3", { tot: 300 });
        },
        AT + HOUR,
      );
      observe(dir, "ent2@999", 300); // replay of the new bundle
      const store = readUsageStore(dir);
      assert.equal(store.hourly.zcode[HK]["glm-5-3"].tot, 300, "a first sighting is a baseline: +300 exactly once");
      assert.deepEqual(Object.keys((store.state.zcode as { buckets: Record<string, unknown> }).buckets), ["ent2@999"]);
      observe(dir, "ent2@999", 900); // genuine growth on the retired-then-rebased watermark
      assert.equal(readUsageStore(dir).hourly.zcode[HK]["glm-5-3"].tot, 900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("addDelta refuses prototype-resolving model keys (detached bucket, no pollution)", () => {
    const store = newStore();
    for (const hostile of ["__proto__", "constructor", "prototype"]) {
      addDelta(store, "zcode", hourKey(0), hostile, { tot: 5 });
    }
    const probe: { tot?: number } = {};
    assert.equal(probe.tot, undefined, "Object.prototype stays clean");
    assert.equal(Object.keys(store.hourly.zcode[hourKey(0)] ?? {}).length, 0, "no hostile keys stored");
  });
});

// ---------- sample dedup boundaries ----------

describe("recordSamples boundaries", () => {
  const T = 1_700_000_000_000;
  const resets = new Date(T + 2 * DAY).toISOString();

  function sampled(u: number, nowMs: number, ok = true, scope?: string): UsageStore {
    const store = newStore();
    recordSamples(
      store,
      [result("kimi", [{ kind: "5h", usedPercent: u, resetsAt: resets, ...(scope ? { scope } : {}) }], ok)],
      nowMs,
    );
    return store;
  }

  it("sub-minute doubles replace – even a real move –; past the minute a move appends", () => {
    const store = sampled(40, T);
    recordSamples(store, [result("kimi", [{ kind: "5h", usedPercent: 40, resetsAt: resets }])], T + 30_000);
    assert.equal(store.samples.kimi.length, 1, "same state 30s later = replace");
    assert.equal(store.samples.kimi[0].t, T + 30_000);
    recordSamples(store, [result("kimi", [{ kind: "5h", usedPercent: 45, resetsAt: resets }])], T + 45_000);
    assert.equal(store.samples.kimi.length, 1, "a 5-point move still replaces inside the minute");
    assert.equal(store.samples.kimi[0].u, 45);
    recordSamples(store, [result("kimi", [{ kind: "5h", usedPercent: 50, resetsAt: resets }])], T + 120_000);
    assert.equal(store.samples.kimi.length, 2, "past the minute the move becomes a new sample");
    assert.equal(store.samples.kimi[1].u, 50);
  });

  it("inside 15 minutes a repeat replaces; at a fresh 15-minute mark it appends", () => {
    const store = sampled(40, T);
    recordSamples(store, [result("kimi", [{ kind: "5h", usedPercent: 40.03, resetsAt: resets }])], T + 5 * 60_000);
    assert.equal(store.samples.kimi.length, 1, "noise within 15min replaces");
    const boundary = sampled(40, T);
    recordSamples(boundary, [result("kimi", [{ kind: "5h", usedPercent: 40.03, resetsAt: resets }])], T + 15 * 60_000);
    assert.equal(boundary.samples.kimi.length, 2, "a full 15 minutes later is a new sample");
  });

  it("the 60-second boundary: at exactly 60s a sub-threshold wiggle still replaces", () => {
    const store = sampled(40, T);
    recordSamples(store, [result("kimi", [{ kind: "5h", usedPercent: 40.04, resetsAt: resets }])], T + 60_000);
    assert.equal(store.samples.kimi.length, 1);
    assert.equal(store.samples.kimi[0].u, 40.04);
  });

  it("percents round to two decimals; remainingFraction converts; scoped windows key separately", () => {
    const store = newStore();
    recordSamples(
      store,
      [
        result("kimi", [
          { kind: "5h", usedPercent: 44.4449, resetsAt: resets },
          { kind: "7d", remainingFraction: 0.66, resetsAt: resets },
          { kind: "5h", usedPercent: 10, resetsAt: resets, scope: "coding" },
        ]),
      ],
      T,
    );
    assert.equal(store.samples.kimi[0].u, 44.44);
    assert.equal(store.samples.kimi[1].u, 34);
    assert.equal(store.samples.kimi[2].k, "5h·coding");
    assert.equal(store.samples.kimi[0].k, "5h");
  });

  it("stale error-fallback results are flagged, dead generations skipped", () => {
    const store = newStore();
    recordSamples(
      store,
      [
        result("kimi", [{ kind: "5h", usedPercent: 12, resetsAt: resets }], false),
        result("glm", [{ kind: "5h", usedPercent: 99, resetsAt: new Date(T - HOUR).toISOString() }]),
      ],
      T,
    );
    assert.equal(store.samples.kimi[0].stale, true);
    assert.equal(store.samples.glm?.length ?? 0, 0, "a window whose generation already reset is never plotted");
  });
});

// ---------- pricing resolution + row cost ----------

describe("priceForModel + rowCost", () => {
  const slugPrice = { in: 1.4e-6, out: 4.4e-6, cr: 0.26e-6 };

  function pricedStore(): UsageStore {
    const store = newStore();
    store.pricing = {
      fetchedAt: 1,
      usdPerTok: { "z-ai/glm-5.3": slugPrice, "moonshotai/kimi-k2": { in: 3e-6, out: 9e-6 } },
    };
    return store;
  }

  it("resolves exact slugs, vendor prefixes, and bare suffix matches from the OpenRouter list", () => {
    const store = pricedStore();
    assert.deepEqual(priceForModel(store, "z-ai/glm-5.3"), { price: slugPrice, source: "openrouter" });
    assert.deepEqual(priceForModel(store, "GLM-5.3"), { price: slugPrice, source: "openrouter" });
    const kimi = priceForModel(store, "kimi-k2");
    assert.equal(kimi?.source, "openrouter", "no prefix regex for kimi – the generic suffix loop catches it");
    assert.equal(kimi?.price.in, 3e-6);
  });

  it("falls back to the bundled table when the refreshed list misses, null when both do", () => {
    assert.equal(priceForModel(newStore(), "glm-4.6")?.source, "fallback");
    assert.equal(priceForModel(newStore(), "glm-4.6")?.price.in, 0.6e-6);
    assert.equal(priceForModel(pricedStore(), "weird-9"), null, "unknown with a table loaded – honestly unpriced");
    assert.equal(priceForModel(newStore(), "weird-9"), null);
  });

  it("rowCost: 1h-ephemeral writes price at 2x input, the 5m remainder at the cw rate", () => {
    // glm-4.6 fallback: in 0.6, cr 0.11, out 2.2 per 1M; no cw published -> cw at input
    const price = priceForModel(newStore(), "glm-4.6")?.price;
    assert.ok(price);
    const row: UsageRow = { in: 1_000_000, cr: 1_000_000, cw: 500_000, cw1h: 200_000, out: 1_000_000 };
    const cost = rowCost(row, price);
    assert.equal(cost?.kind, "estimate");
    // 1.0*0.6 + 1.0*0.11 + 0.2*(2*0.6) + 0.3*0.6 + 1.0*2.2 = 3.33
    assert.ok(Math.abs((cost?.usd ?? 0) - 3.33) < 1e-9);
  });

  it("rowCost: cw1h larger than cw clamps; absent cw rate prices at input", () => {
    const price = priceForModel(newStore(), "glm-4.6")?.price;
    const clamped = rowCost({ in: 0, cw: 100_000, cw1h: 400_000, out: 0 }, price ?? null);
    assert.ok(Math.abs((clamped?.usd ?? 0) - 0.1 * 1.2) < 1e-9, "cw1h clamped to cw; all 100k at 2x input");
  });

  it("rowCost: vendor-actual usd wins; a non-finite usd falls through to tokens; unpriced is null", () => {
    const price = priceForModel(newStore(), "glm-4.6")?.price ?? null;
    assert.deepEqual(rowCost({ tot: 10, usd: 0.25 }, price), { usd: 0.25, kind: "actual" });
    const nan = rowCost({ in: 1_000_000, usd: Number.NaN }, price);
    assert.equal(nan?.kind, "estimate", "NaN actual is not a number – token estimate instead");
    assert.ok(Math.abs((nan?.usd ?? 0) - 0.6) < 1e-9);
    assert.equal(rowCost({ in: 1_000_000 }, null), null);
  });
});

// ---------- glm mix + aggregation ----------

describe("glmMixFromStore", () => {
  it("derives the observed split from in-range rows only, null with no glm data", () => {
    const store = newStore();
    store.daily.glm = {
      [dayKey(2 * DAY)]: { "glm-5.3": { in: 300, cr: 300, out: 300 } },
      [dayKey(40 * DAY)]: { "glm-5.3": { in: 9_000, cr: 0, out: 0 } }, // out of range
    };
    store.hourly.glm = { [hourKey(2 * DAY)]: { "glm-5.3": { in: 100, cr: 200, out: 100 } } };
    const mix = glmMixFromStore(store, 0, 3 * DAY);
    assert.ok(mix);
    const total = 400 + 500 + 400; // in + cr + out over the in-range rows
    assert.ok(Math.abs(mix.in - 400 / total) < 1e-9);
    assert.ok(Math.abs(mix.cr - 500 / total) < 1e-9);
    assert.ok(Math.abs(mix.out - 400 / total) < 1e-9);
    assert.equal(glmMixFromStore(newStore(), 0, DAY), null);
  });
});

describe("aggregateUsage windows", () => {
  const T0 = Date.UTC(2026, 8, 29, 10); // 2026-09-29T10Z

  it("hour view returns exactly the hourly keys inside the inclusive range", () => {
    const store = newStore();
    store.hourly.claude = {
      [hourKey(T0 - HOUR)]: { m: { in: 1 } },
      [hourKey(T0)]: { m: { in: 10 } },
      [hourKey(T0 + HOUR)]: { m: { in: 20 } },
      [hourKey(T0 + 2 * HOUR)]: { m: { in: 200 } },
    };
    const agg = aggregateUsage(store, { granularity: "hour", fromMs: T0, toMs: T0 + 2 * HOUR });
    assert.deepEqual(
      agg.providers.claude.series.map((s) => s.t),
      [hourKey(T0), hourKey(T0 + HOUR), hourKey(T0 + 2 * HOUR)],
    );
    assert.equal(agg.providers.claude.in, 230);
  });

  it("day view builds days from hourly rows and clips edge days to the window hours", () => {
    const store = newStore();
    store.hourly.claude = {
      [hourKey(T0)]: { m: { in: 100 } }, // 10:00 on the from-day
      [hourKey(T0 + HOUR)]: { m: { in: 50 } }, // 11:00 on the from-day
    };
    // window starts 11:30 – the 10:00 hour is before the first hour key
    const agg = aggregateUsage(store, {
      granularity: "day",
      fromMs: T0 + HOUR + 30 * 60_000,
      toMs: T0 + 2 * HOUR,
    });
    assert.equal(agg.providers.claude.in, 50, "hours before the window's first hour are clipped");
    assert.deepEqual(
      agg.providers.claude.series.map((s) => s.t),
      [dayKey(T0)],
    );
  });

  it("authoritative daily rows stay whole-day even when the window starts mid-day", () => {
    const store = newStore();
    store.daily.claude = { [dayKey(T0)]: { m: { in: 777 } } };
    store.hourly.claude = { [hourKey(T0)]: { m: { in: 100 } } };
    const agg = aggregateUsage(store, { granularity: "day", fromMs: T0 + 30 * 60_000, toMs: T0 + HOUR });
    assert.equal(agg.providers.claude.in, 777, "vendor daily granularity cannot be split – no clipping");
  });

  it("local modes: exclude hides this-machine rows, include merges once, only isolates", () => {
    const store = newStore();
    store.localDaily.claude = { [dayKey(T0)]: { m: { in: 10 } } };
    store.localHourly.claude = { [hourKey(T0)]: { m: { in: 5 } } };
    const from = T0 - HOUR;
    const to = T0 + HOUR;

    const excluded = aggregateUsage(store, { provider: "claude", granularity: "day", fromMs: from, toMs: to });
    assert.equal(excluded.providers.claude, undefined, "vendor-served totals stay vendor-served");

    const included = aggregateUsage(store, {
      provider: "claude",
      granularity: "day",
      fromMs: from,
      toMs: to,
      local: "include",
    });
    const inc = included.providers.claude;
    assert.ok(inc);
    assert.equal(inc.hasLocal, true);
    assert.equal(inc.in, 15, "daily 10 + hourly 5, each counted exactly once");

    const only = aggregateUsage(store, {
      provider: "claude",
      granularity: "day",
      fromMs: from,
      toMs: to,
      local: "only",
    });
    assert.equal(only.providers.claude?.in, 10);
  });

  it("cache-hit counts writes as misses: cr / (cr + cw + in); null with no cache tokens", () => {
    const store = newStore();
    store.hourly.claude = { [hourKey(T0)]: { m: { in: 100, cr: 100, cw: 100 } } };
    const agg = aggregateUsage(store, { granularity: "hour", fromMs: T0, toMs: T0 + HOUR });
    assert.ok(Math.abs((agg.providers.claude.cacheHit ?? 0) - 100 / 300) < 1e-9);

    const writeOnly = newStore();
    writeOnly.hourly.claude = { [hourKey(T0)]: { m: { cw: 100 } } };
    const agg2 = aggregateUsage(writeOnly, { granularity: "hour", fromMs: T0, toMs: T0 + HOUR });
    assert.equal(agg2.providers.claude.cacheHit, 0, "all misses");

    const none = newStore();
    none.hourly.claude = { [hourKey(T0)]: { m: { out: 7 } } };
    const agg3 = aggregateUsage(none, { granularity: "hour", fromMs: T0, toMs: T0 + HOUR });
    assert.equal(agg3.providers.claude.cacheHit, null);
  });

  it("series buckets carry usdA/usdE that sum to the totals", () => {
    const store = newStore();
    store.pricing = { fetchedAt: 1, usdPerTok: { "x/m": { in: 1e-6, out: 2e-6 } } };
    store.hourly.openai = {
      [hourKey(T0)]: { actual: { tot: 0, usd: 0.5 } },
      [hourKey(T0 + HOUR)]: { "x/m": { in: 1_000_000 } }, // 1M * $1/M = $1
    };
    const agg = aggregateUsage(store, { granularity: "hour", fromMs: T0, toMs: T0 + 2 * HOUR });
    const u = agg.providers.openai;
    assert.equal(u.usdActual, 0.5);
    assert.ok(Math.abs(u.usdEst - 1) < 1e-9);
    assert.ok(Math.abs((u.series[0].usdA ?? 0) - 0.5) < 1e-9);
    assert.equal(u.series[0].usdE, 0);
    assert.ok(Math.abs((u.series[1].usdE ?? 0) - 1) < 1e-9);
    assert.equal(
      u.series.reduce((acc, s) => acc + s.usdA, 0),
      u.usdActual,
    );
  });

  it("split-less rows price blended with the observed glm mix; totals and series agree", () => {
    const store = newStore();
    store.daily.glm = { [dayKey(T0)]: { "glm-5.3": { in: 100, cr: 200, out: 100 } } }; // mix .25/.5/.25
    store.hourly.zcode = { [hourKey(T0)]: { "glm-5.3": { tot: 1_000 } } };
    // the mix window must cover the daily row's day start, not just the hour
    const from = dayKeyToMs(dayKey(T0));
    const agg = aggregateUsage(store, { granularity: "hour", fromMs: from, toMs: T0 + HOUR });
    const z = agg.providers.zcode;
    assert.equal(z.splitless, true);
    const blended = z.models.find((m) => m.model === "glm-5.3");
    assert.equal(blended?.usdKind, "blended");
    // 250*1.4e-6 + 500*0.26e-6 + 250*4.4e-6 (glm-5.3 fallback rates)
    assert.ok(Math.abs((blended?.usd ?? 0) - 1.58e-3) < 1e-12);
    assert.ok(Math.abs(z.usdEst - 1.58e-3) < 1e-12);
    assert.ok(Math.abs((z.series[0].usdE ?? 0) - 1.58e-3) < 1e-12);
  });

  it("unpriced models are listed, not silently priced at zero", () => {
    const store = newStore();
    store.hourly.claude = { [hourKey(T0)]: { "weird-9": { in: 10, out: 5 } } };
    const agg = aggregateUsage(store, { granularity: "hour", fromMs: T0, toMs: T0 + HOUR });
    assert.deepEqual(agg.providers.claude.unpriced, ["weird-9"]);
    assert.equal(agg.providers.claude.models[0].usd, null);
  });

  it("a %-only provider with in-range samples stays in the aggregate with zeroed tokens", () => {
    const store = newStore();
    store.samples.kimi = [
      { t: T0 + 60_000, k: "5h", u: 30, r: new Date(T0 + DAY).toISOString() },
      { t: T0 - DAY, k: "5h", u: 31, r: "old" }, // out of range
    ];
    const agg = aggregateUsage(store, { granularity: "day", fromMs: T0, toMs: T0 + DAY });
    const k = agg.providers.kimi;
    assert.ok(k, "samples alone keep the provider visible");
    assert.equal(k.samples.length, 1);
    assert.equal(k.in + k.cr + k.cw + k.out + k.tot, 0);

    const empty = aggregateUsage(store, { granularity: "day", fromMs: T0 + 2 * DAY, toMs: T0 + 3 * DAY });
    assert.equal(empty.providers.kimi, undefined, "nothing in range at all – provider omitted");
  });
});

// ---------- local transcript walker: offsets + self-correction ----------

describe("local transcript walker (claude)", () => {
  interface Env {
    home: string;
    dir: string;
    proj: string;
    transcript: string;
    restore: () => void;
  }

  function setup(): Env {
    const home = tempDir("subtrk-walk-home-");
    const dir = tempDir("subtrk-walk-dir-");
    const proj = join(home, ".claude", "projects", "p1");
    mkdirSync(proj, { recursive: true });
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    return {
      home,
      dir,
      proj,
      transcript: join(proj, "s.jsonl"),
      restore: () => {
        if (prevProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevProfile;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
        clearSecrets();
      },
    };
  }

  function harvest(env: Env, now: number): Promise<Awaited<ReturnType<typeof harvestUsage>>> {
    return harvestUsage([], {
      subtrkDir: env.dir,
      budgetMs: 20_000,
      envPath: join(env.dir, "no.env"), // hermetic – never the real ~/.subtrk/env
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      now,
    });
  }

  const rows = (dir: string): UsageRow | undefined =>
    readUsageStore(dir).localHourly.claude?.[hourKey(Date.parse("2026-09-29T12:00:00Z"))]?.["claude-opus-5-5"];

  it("a torn final line is not consumed; completing it counts it exactly once (offset off-by-one class)", async () => {
    const env = setup();
    try {
      const base = Date.now();
      // msg2 has NO trailing newline: a torn write – it must wait for its tail
      writeFileSync(env.transcript, claudeMsg("m1", 100, 10) + claudeMsg("m2", 200, 20).trimEnd());
      await harvest(env, base);
      assert.equal(rows(env.dir)?.in, 100, "only the complete line counted");
      appendFileSync(env.transcript, "\n"); // the tail lands – msg2 is now whole
      await harvest(env, base + 120_000); // past the 60s local TTL
      assert.equal(rows(env.dir)?.in, 300, "the completed line added exactly once");
      assert.equal(rows(env.dir)?.out, 30);
    } finally {
      env.restore();
    }
  });

  it("a properly newline-terminated file advances the watermark to EOF – appends count once (v4 regression)", async () => {
    const env = setup();
    try {
      const base = Date.now();
      writeFileSync(env.transcript, claudeMsg("m1", 100, 10));
      await harvest(env, base);
      appendFileSync(env.transcript, claudeMsg("m2", 200, 20));
      await harvest(env, base + 120_000);
      assert.equal(rows(env.dir)?.in, 300, "no lost first byte, no recount of m1");
    } finally {
      env.restore();
    }
  });

  it("a parser-version bump triggers a full re-read that wipes and re-adds exactly once", async () => {
    const env = setup();
    try {
      const base = Date.now();
      writeFileSync(env.transcript, claudeMsg("m1", 100, 10) + claudeMsg("m2", 200, 20));
      await harvest(env, base);
      assert.equal(rows(env.dir)?.in, 300);
      // simulate a store written by an older parser
      const stale = readUsageStore(env.dir);
      (stale.state.claude as { pv?: number }).pv = 4;
      writeFileSync(usageStorePath(env.dir), JSON.stringify(stale));
      await harvest(env, base + 120_000);
      assert.equal(rows(env.dir)?.in, 300, "wiped then re-derived once – not 600, not 0");
    } finally {
      env.restore();
    }
  });

  it("a stale rebuild that reads no usage rows keeps the previous rows for the next round", async () => {
    const env = setup();
    try {
      const base = Date.now();
      writeFileSync(env.transcript, '{"type":"user","message":"no usage here"}\n');
      seedStore(env.dir, {
        localHourly: { claude: { [hourKey(0)]: { old: { in: 42 } } } },
        state: { claude: { at: base - 120_000, pv: 4, files: { "/gone.jsonl": { off: 10, size: 10 } } } },
      });
      const summary = await harvest(env, base);
      const store = readUsageStore(env.dir);
      assert.equal(store.localHourly.claude?.[hourKey(0)]?.old.in, 42, "rows survive a no-yield rebuild");
      assert.equal((store.state.claude as { pv?: number }).pv, 4, "parser version not advanced – will retry");
      assert.ok(summary.skipped.some((s) => s.startsWith("claude/local")));
    } finally {
      env.restore();
    }
  });
});

// ---------- glm range refetch (rebuild's re-derivation path) ----------

describe("glm range refetch", () => {
  it("refetches when state cleared, replaces the hourly range (stale hours clear), and is idempotent", async () => {
    const home = tempDir("subtrk-glm-home-");
    const dir = tempDir("subtrk-glm-dir-");
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    registerSecret("glm-fixture-token");
    // fixture credential file – getSecret reads it after process.env misses
    writeFileSync(join(home, "glm.env"), "ANTHROPIC_AUTH_TOKEN=glm-fixture-token\n");
    const base = Date.now();
    const d = new Date(base);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const label = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:00:00`;
    const body = {
      data: {
        modelUsage: {
          xTime: [label],
          modelDataList: [
            {
              modelName: "GLM-5.3",
              uncachedInputTokensUsage: [100],
              cachedInputTokensUsage: [40],
              outputTokensUsage: [10],
            },
          ],
        },
      },
    };
    let fetches = 0;
    const stub = (async (url: string | URL | RequestInfo): Promise<Response> => {
      fetches++;
      const u = String(url);
      if (u.includes("usage-detail")) return new Response(JSON.stringify(body), { status: 200 });
      if (u.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const staleHour = hourKey(base - HOUR); // inside the fetch range, no longer reported
      seedStore(dir, {
        hourly: { glm: { [staleHour]: { "GLM-5.3": { in: 999 } } } },
        state: { alibaba: { at: base } }, // keep the bl subprocess out of the test
      });
      const opts = {
        subtrkDir: dir,
        budgetMs: 20_000,
        envPath: join(home, "glm.env"),
        fetchImpl: stub,
        now: base,
      };
      const summary = await harvestUsage([], opts);
      assert.ok(summary.applied.includes("glm"), `applied: ${summary.applied.join(",")}`);
      const labelHour = hourKey(Date.parse(label.replace(" ", "T")));
      let store = readUsageStore(dir);
      assert.deepEqual(
        { in: store.hourly.glm?.[labelHour]?.["GLM-5.3"]?.in, cr: store.hourly.glm?.[labelHour]?.["GLM-5.3"]?.cr },
        { in: 100, cr: 40 },
      );
      assert.equal(store.hourly.glm?.[staleHour], undefined, "hours the fetch no longer reports are zeroed");
      assert.equal(store.daily.glm?.[dayKey(Date.parse(label.replace(" ", "T")))]?.["GLM-5.3"]?.in, 100);
      assert.equal((store.state.glm as { backfilled?: boolean }).backfilled, true);

      // second round, past the GLM TTL, same vendor data: replace semantics – no double count
      const before = JSON.stringify(readUsageStore(dir).hourly.glm);
      await harvestUsage([], { ...opts, now: base + 16 * 60_000 });
      store = readUsageStore(dir);
      assert.equal(store.hourly.glm?.[labelHour]?.["GLM-5.3"]?.in, 100);
      assert.equal(JSON.stringify(store.hourly.glm), before, "refetching the same range is a no-op");
      assert.ok(fetches >= 4, "both rounds fetched their windows");
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      clearSecrets();
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- `subtrk usage` windows: MTD default, --days lookback, --hour ----------

describe("usage CLI windows", () => {
  it("month-to-date defaults to local month start; --days looks back; --hour aggregates hourly", async () => {
    const dir = tempDir("subtrk-cliwin-");
    const now = Date.now();
    try {
      seedStore(dir, {
        daily: {
          glm: {
            [dayKey(now)]: { "GLM-5.3": { in: 1_000 } },
            [dayKey(now - 40 * DAY)]: { "GLM-5.3": { in: 5_000 } }, // outside both windows
          },
        },
        hourly: { glm: { [hourKey(now)]: { "GLM-5.3": { in: 555 } } } },
        // every source pinned fresh so the CLI's own harvest is a no-op: no
        // network, no subprocesses, regardless of the machine's real creds.
        state: {
          glm: { at: now },
          openrouter: { activityAt: now, analyticsAt: now },
          zcode: { at: now },
          alibaba: { at: now },
          openai: { whamAt: now },
          claude: { at: now, pv: 5, files: {} },
        },
        pricing: { fetchedAt: now },
      });
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...parts: unknown[]): void => {
        logs.push(parts.map(String).join(" "));
      };
      try {
        assert.equal(await main(["usage", "--json", "--days", "7"], { dirs: { subtrk: dir } }), 0);
        const days = JSON.parse(logs[0]) as {
          from: string;
          granularity: string;
          providers: Record<string, { in: number }>;
        };
        assert.equal(days.granularity, "day");
        const fromMs = Date.parse(days.from);
        assert.ok(fromMs >= now - 7 * DAY && fromMs <= now - 6 * DAY + 1_000, "local midnight, 7 days back");
        assert.equal(days.providers.glm?.in, 1_000, "today in, the 40d-old row out");

        logs.length = 0;
        assert.equal(await main(["usage", "--json"], { dirs: { subtrk: dir } }), 0);
        const mtd = JSON.parse(logs[0]) as { from: string };
        const n = new Date();
        assert.equal(Date.parse(mtd.from), new Date(n.getFullYear(), n.getMonth(), 1).getTime(), "month-to-date");

        logs.length = 0;
        assert.equal(await main(["usage", "--json", "--hour"], { dirs: { subtrk: dir } }), 0);
        const hourly = JSON.parse(logs[0]) as {
          granularity: string;
          providers: Record<string, { in: number }>;
        };
        assert.equal(hourly.granularity, "hour");
        assert.equal(hourly.providers.glm?.in, 555, "hour view aggregates the hourly section only");
      } finally {
        console.log = orig;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- `subtrk usage --rebuild` end to end ----------

describe("usage --rebuild self-correction", () => {
  it("drops re-derivable sections, keeps deltas+samples, then re-derives locals from the transcripts", async () => {
    const home = tempDir("subtrk-rebuild-home-");
    const pathStub = tempDir("subtrk-rebuild-path-");
    const repo = dirname(dirname(fileURLToPath(import.meta.url)));
    // transcript the rebuild must re-derive the claude local section from
    const proj = join(home, ".claude", "projects", "C--work-x");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s1.jsonl"), claudeMsg("m1", 100, 10) + claudeMsg("m2", 200, 20));
    const now = Date.now();
    const script = `
      import assert from "node:assert/strict";
      const { pathToFileURL } = await import("node:url");
      const { join } = await import("node:path");
      const home = process.env.QUIET_HOME;
      const repo = process.env.QUIET_REPO;
      const { mutateUsageStore, readUsageStore, hourKey, replaceHourlyRange } = await import(
        pathToFileURL(join(repo, "src", "usage.ts")).href
      );
      const { main } = await import(pathToFileURL(join(repo, "src", "cli.ts")).href);
      const dir = join(home, ".subtrk");
      const now = Number(process.env.QUIET_NOW);
      mutateUsageStore(dir, (s) => {
        replaceHourlyRange(s, "glm", now - 86_400_000, now, { [hourKey(now)]: { "GLM-5.3": { in: 11 } } });
        s.daily.glm = { "2026-09-01": { "GLM-5.3": { in: 12 } } };
        replaceHourlyRange(s, "openrouter", now - 86_400_000, now, { [hourKey(now)]: { "x/y": { in: 22 } } });
        s.daily.openrouter = { "2026-09-01": { "x/y": { in: 23 } } };
        replaceHourlyRange(s, "zcode", now - 86_400_000, now, { [hourKey(now)]: { "glm-5-3": { tot: 5 } } });
        s.localHourly.claude = { [hourKey(now)]: { "claude-opus-5-5": { in: 999 } } };
        s.localDaily.openai = { "2026-01-01": { gpt: { in: 5 } } };
        s.samples.claude = [{ t: now, k: "5h", u: 12, r: new Date(now + 3_600_000).toISOString() }];
        s.pricing = { fetchedAt: now, usdPerTok: {} };
        s.state = {
          glm: { at: now, throughMs: now },
          openrouter: { activityAt: now, analyticsAt: now },
          zcode: { at: now, buckets: { "e@1": { used: 7 } } },
          claude: { at: now - 300_000, pv: 5, files: { "/old.jsonl": { off: 1, size: 1 } }, ids: ["x"] },
          openai: { at: now, whamAt: now, files: { "/old.jsonl": { off: 1, size: 1 } } },
          alibaba: { at: now },
        };
      });
      await main(["usage", "--rebuild", "--json"], { dirs: { subtrk: dir } });
      const store = readUsageStore(dir);
      assert.equal(store.hourly.glm, undefined, "glm hourly is re-derivable – dropped");
      assert.equal(store.daily.glm, undefined);
      assert.equal(store.state.glm, undefined, "glm watermark dropped so the next harvest refetches");
      assert.equal(store.hourly.openrouter, undefined);
      assert.equal(store.daily.openrouter, undefined);
      assert.equal(store.state.openrouter, undefined);
      assert.equal(store.localDaily.openai, undefined, "openai local dropped (nothing to re-derive here)");
      assert.equal(store.state.openai.files, undefined);
      assert.equal(store.hourly.zcode?.[hourKey(now)]?.["glm-5-3"]?.tot, 5, "zcode deltas are NOT re-derivable – kept");
      assert.notEqual(store.state.zcode, undefined, "zcode watermark kept");
      assert.notEqual(store.samples.claude, undefined, "probe samples kept");
      assert.notEqual(store.pricing.fetchedAt, undefined, "pricing kept");
      const tHour = hourKey(Date.parse("2026-09-29T12:00:00Z")); // the transcript's hour
      assert.equal(
        store.localHourly.claude?.[tHour]?.["claude-opus-5-5"]?.in,
        300,
        "claude local re-derived from the transcript exactly once",
      );
      console.log("REBUILD_OK");
    `;
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.OPENROUTER_MANAGEMENT_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.ZCODE_CREDENTIAL_SECRET;
    delete childEnv.SUBTRK_DEBUG_BL;
    // HOME/USERPROFILE pin every credential + store read into the temp home;
    // the stubbed PATH keeps the `bl` CLI (alibaba tier) unresolvable.
    childEnv.HOME = home;
    childEnv.USERPROFILE = home;
    childEnv.PATH = pathStub;
    childEnv.QUIET_HOME = home;
    childEnv.QUIET_REPO = repo;
    childEnv.QUIET_NOW = String(now);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: childEnv,
      timeout: 120_000,
    });
    try {
      assert.equal(child.status, 0, `stdout: ${child.stdout}\nstderr: ${child.stderr}`);
      assert.ok(child.stdout.includes("REBUILD_OK"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pathStub, { recursive: true, force: true });
    }
  });
});

// keep the key->ms round-trips covered in this partition too
describe("bucket key round-trips", () => {
  it("hour/day keys parse back to their hour/day start", () => {
    const ms = Date.UTC(2026, 9, 12, 14, 30, 15);
    assert.equal(hourKeyToMs(hourKey(ms)), Date.UTC(2026, 9, 12, 14));
    assert.equal(dayKeyToMs(dayKey(ms)), Date.UTC(2026, 9, 12));
    assert.equal(dayKey(ms), hourKey(ms).slice(0, 10));
  });
});
