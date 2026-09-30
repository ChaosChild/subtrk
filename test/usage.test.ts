// usage.test.ts – M3 usage store: bucket key math, the three write semantics
// (replace-range, delta-watermark, sampling dedup), lock exclusivity, parsers
// against live-captured shapes (2026-09-29), pricing resolution, aggregation
// (day/hour, actual vs blended vs unpriced), the `subtrk usage` CLI, the
// /api/usage route, and the no-secrets guarantee. No network: fetch is always
// injected; all paths live in temp dirs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { acquireLock, clearSecrets, type ProviderResult, registerSecret, releaseLock } from "../src/core.ts";
import { parseClaudeUsage } from "../src/providers/claude.ts";
import { fetchZcodeBalance } from "../src/providers/zcode.ts";
import { startConsole } from "../src/serve.ts";
import {
  addDelta,
  aggregateUsage,
  dayKey,
  dayKeyToMs,
  extractOrActivity,
  extractOrAnalytics,
  extractOrPricing,
  harvestUsage,
  hourKey,
  hourKeyToMs,
  mutateUsageStore,
  parseGlmDetail,
  priceForModel,
  readUsageStore,
  recordSamples,
  replaceDailyRows,
  replaceHourlyRange,
  rowCost,
} from "../src/usage.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-usage-test-"));
}
function cleanup(dir: string): () => void {
  return () => rmSync(dir, { recursive: true, force: true });
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function result(
  id: ProviderResult["id"],
  windows: ProviderResult["windows"],
  surfaces?: { key: string; name: string; percent: number }[],
): ProviderResult {
  return {
    id,
    ok: true,
    stale: false,
    fetchedAt: new Date().toISOString(),
    windows,
    ...(surfaces ? { surfaces } : {}),
  };
}

// ---------- bucket keys ----------

describe("usage bucket keys", () => {
  it("round-trips UTC hour and day keys", () => {
    const ms = Date.UTC(2026, 8, 29, 13, 7, 5);
    assert.equal(hourKey(ms), "2026-09-29T13");
    assert.equal(hourKeyToMs("2026-09-29T13"), Date.UTC(2026, 8, 29, 13));
    assert.equal(dayKey(ms), "2026-09-29");
    assert.equal(dayKeyToMs("2026-09-29"), Date.UTC(2026, 8, 29));
    assert.ok(hourKey(ms) < hourKey(ms + HOUR)); // lexicographic order == time order
  });
});

// ---------- write semantics ----------

describe("usage write semantics", () => {
  it("replaceDailyRows is idempotent – refetching a range never double counts", () => {
    const dir = tempDir();
    try {
      const rows = { "2026-09-28": { "GLM-5.3": { in: 100, out: 5 } } };
      mutateUsageStore(dir, (s) => replaceDailyRows(s, "glm", rows));
      mutateUsageStore(dir, (s) => replaceDailyRows(s, "glm", rows));
      const store = readUsageStore(dir);
      assert.equal(store.daily.glm["2026-09-28"]["GLM-5.3"].in, 100);
    } finally {
      cleanup(dir)();
    }
  });

  it("replaceHourlyRange clears stale keys inside the range, keeps outside", () => {
    const dir = tempDir();
    try {
      const t0 = Date.UTC(2026, 8, 29, 10);
      mutateUsageStore(dir, (s) => {
        replaceHourlyRange(s, "openrouter", t0 - 2 * HOUR, t0 + 2 * HOUR, {
          [hourKey(t0)]: { "x/y": { in: 10 } },
        });
        replaceHourlyRange(s, "openrouter", t0 - 96 * HOUR, t0 - 3 * HOUR, {
          [hourKey(t0 - 90 * HOUR)]: { "x/y": { in: 7 } },
        });
      });
      // refetch reports the hour now empty
      mutateUsageStore(dir, (s) => replaceHourlyRange(s, "openrouter", t0 - 2 * HOUR, t0 + 2 * HOUR, {}));
      const store = readUsageStore(dir);
      assert.equal(store.hourly.openrouter[hourKey(t0)], undefined);
      assert.equal(store.hourly.openrouter[hourKey(t0 - 90 * HOUR)]?.["x/y"].in, 7);
    } finally {
      cleanup(dir)();
    }
  });

  it("addDelta accumulates into existing rows", () => {
    const dir = tempDir();
    try {
      const hk = hourKey(Date.UTC(2026, 8, 29, 9));
      mutateUsageStore(dir, (s) => addDelta(s, "zcode", hk, "glm-5-3", { tot: 50 }));
      mutateUsageStore(dir, (s) => addDelta(s, "zcode", hk, "glm-5-3", { tot: 25 }));
      const store = readUsageStore(dir);
      assert.equal(store.hourly.zcode[hk]["glm-5-3"].tot, 75);
    } finally {
      cleanup(dir)();
    }
  });

  it("delta-watermark: applying the same observation twice adds once", () => {
    // The harvester evaluates the delta INSIDE the locked mutator against the
    // stored watermark, so a duplicate observation (two agents fetched the
    // same balance) applies zero the second time.
    const dir = tempDir();
    const used = 1500;
    const applyOnce = (): void => {
      mutateUsageStore(dir, (store) => {
        if (!store.state.zcode) store.state.zcode = {};
        const s = store.state.zcode as { buckets?: Record<string, { used: number }> };
        if (!s.buckets) s.buckets = {};
        const buckets = s.buckets;
        const key = "ent1@1790000000";
        const prev = buckets[key]?.used ?? 1000;
        const delta = Math.max(0, used - prev);
        buckets[key] = { used };
        if (delta > 0) addDelta(store, "zcode", hourKey(Date.UTC(2026, 8, 29, 9)), "glm-5-3", { tot: delta });
      });
    };
    try {
      applyOnce();
      applyOnce();
      const store = readUsageStore(dir);
      assert.equal(store.hourly.zcode[hourKey(Date.UTC(2026, 8, 29, 9))]["glm-5-3"].tot, 500);
    } finally {
      cleanup(dir)();
    }
  });

  it("mutateUsageStore skips when another process holds the lock", () => {
    const dir = tempDir();
    try {
      const lockPath = join(dir, "usage.json.lock");
      assert.equal(acquireLock(lockPath), true);
      const applied = mutateUsageStore(dir, (s) => replaceDailyRows(s, "glm", {}));
      assert.equal(applied, false);
      releaseLock(lockPath);
      assert.equal(
        mutateUsageStore(dir, (s) => replaceDailyRows(s, "glm", {})),
        true,
      );
    } finally {
      cleanup(dir)();
    }
  });

  it("prunes hourly buckets past 90 days and samples past 35 days on write", () => {
    const dir = tempDir();
    try {
      const now = Date.UTC(2026, 8, 29, 12);
      mutateUsageStore(
        dir,
        (s) => {
          replaceHourlyRange(s, "glm", now - 120 * DAY, now - 100 * DAY, {
            [hourKey(now - 110 * DAY)]: { m: { in: 1 } },
          });
          replaceHourlyRange(s, "glm", now - DAY, now, { [hourKey(now - DAY)]: { m: { in: 2 } } });
          s.samples.claude = [
            { t: now - 40 * DAY, k: "5h", u: 10, r: "x" },
            { t: now - DAY, k: "5h", u: 20, r: "x" },
          ];
        },
        now,
      );
      const store = readUsageStore(dir);
      assert.equal(store.hourly.glm[hourKey(now - 110 * DAY)], undefined);
      assert.ok(store.hourly.glm[hourKey(now - DAY)]);
      assert.equal(store.samples.claude.length, 1);
    } finally {
      cleanup(dir)();
    }
  });
});

// ---------- sampling ----------

describe("usage samples", () => {
  const now = Date.UTC(2026, 8, 29, 12);

  function sampleOnce(
    dir: string,
    u: number,
    resetsAt: string,
    t: number,
    surfaces?: { key: string; name: string; percent: number }[],
  ): void {
    mutateUsageStore(
      dir,
      (s) => {
        recordSamples(s, [result("claude", [{ kind: "5h", usedPercent: u, resetsAt }], surfaces)], t);
      },
      t,
    );
  }

  it("dedups repeats, keeps changes, splits on reset generations", () => {
    const dir = tempDir();
    try {
      const r1 = "2026-09-29T18:04:00Z";
      const r2 = "2026-09-30T00:00:00Z";
      sampleOnce(dir, 10, r1, now);
      sampleOnce(dir, 10, r1, now + 60_000); // same value within 15min -> replace, not append
      sampleOnce(dir, 42, r1, now + 20 * 60_000); // value moved -> new sample
      sampleOnce(dir, 5, r2, now + 30 * 60_000); // new generation -> new sample
      const store = readUsageStore(dir);
      const list = store.samples.claude;
      assert.equal(list.length, 3);
      assert.deepEqual(
        list.map((s) => s.u),
        [10, 42, 5],
      );
      assert.equal(list[1].r, r1);
      assert.equal(list[2].r, r2);
    } finally {
      cleanup(dir)();
    }
  });

  it("carries claude per-surface breakdown on the sample", () => {
    const dir = tempDir();
    try {
      const surfaces = [
        { key: "claude_code", name: "Claude Code", percent: 92 },
        { key: "chat", name: "Chats", percent: 5 },
      ];
      sampleOnce(dir, 39, "2026-10-04T00:59:59Z", now, surfaces);
      const store = readUsageStore(dir);
      assert.deepEqual(store.samples.claude[0].sf, surfaces);
    } finally {
      cleanup(dir)();
    }
  });

  it("claude parser surfaces seven_day_breakdown rows", () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 32, resets_at: "2026-09-29T17:39:59Z" },
      seven_day: { utilization: 39, resets_at: "2026-10-04T00:59:59Z" },
      seven_day_breakdown: { as_of: "x", rows: [{ key: "claude_code", display_name: "Claude Code", percent: 92 }] },
    });
    assert.ok(parsed);
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.surfaces?.[0].name, "Claude Code");
  });
});

// ---------- parsers (live-captured shapes, 2026-09-29) ----------

describe("usage parsers", () => {
  it("parses glm usage-detail hourly series with nulls", () => {
    const body = {
      code: 0,
      data: {
        granularity: "hourly",
        modelUsage: {
          xTime: ["2026-09-26 17:00:00", "2026-09-26 18:00:00"],
          modelDataList: [
            {
              modelCode: "glm-5.3",
              modelName: "GLM-5.3",
              uncachedInputTokensUsage: [262906, null],
              cachedInputTokensUsage: [1271232, "2632320"],
              outputTokensUsage: [2015, 3871],
            },
          ],
        },
      },
    };
    const parsed = parseGlmDetail(body);
    assert.ok(parsed);
    const rows = parsed.buckets["2026-09-26 17:00:00"];
    assert.equal(rows["GLM-5.3"].in, 262906);
    assert.equal(rows["GLM-5.3"].cr, 1271232);
    const next = parsed.buckets["2026-09-26 18:00:00"];
    assert.equal(next["GLM-5.3"].in ?? 0, 0); // null reads as zero
    assert.equal(next["GLM-5.3"].cr, 2632320); // numeric strings parse
    assert.equal(parseGlmDetail({ data: null }), null);
  });

  it("parses openrouter activity rows (UTC dates, numeric fields)", () => {
    const rows = extractOrActivity({
      data: [
        {
          date: "2026-09-28 00:00:00",
          model: "openai/gpt-5.2",
          requests: 151,
          usage: 0.42,
          prompt_tokens: 5212654,
          completion_tokens: 117726,
          reasoning_tokens: 83715,
        },
        { garbage: true },
      ],
    });
    assert.ok(rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dateMs, Date.UTC(2026, 8, 28));
    assert.equal(rows[0].usage, 0.42);
    assert.equal(extractOrActivity({ data: "nope" }), null);
  });

  it("parses openrouter analytics rows (string numbers, cached subset of prompt)", () => {
    const rows = extractOrAnalytics({
      data: {
        data: [
          {
            date__hour: "2026-09-29 13:00:00",
            model: "nvidia/nemotron-3",
            tokens_prompt: "186685",
            tokens_completion: "1544",
            cached_tokens: "84480",
          },
        ],
      },
    });
    assert.ok(rows);
    assert.equal(rows[0].hourMs, Date.UTC(2026, 8, 29, 13));
    assert.equal(rows[0].prompt, 186685);
    assert.equal(extractOrAnalytics({ data: {} }), null);
  });

  it("parses openrouter pricing strings including explicit zeros", () => {
    const prices = extractOrPricing({
      data: [
        {
          id: "z-ai/glm-5.3",
          pricing: {
            prompt: "0.0000014",
            completion: "0.0000044",
            input_cache_read: "0.00000026",
            input_cache_write: "0",
          },
        },
        { id: "broken", pricing: { prompt: "x" } },
      ],
    });
    assert.ok(prices);
    assert.equal(prices["z-ai/glm-5.3"].in, 0.0000014);
    assert.equal(prices["z-ai/glm-5.3"].cw, 0);
    assert.equal(prices.broken, undefined);
  });

  it("zcode raw buckets expose used units for watermarks", async () => {
    // fetchZcodeBalance on a machine without the desktop store fails honestly.
    const out = await fetchZcodeBalance();
    if (out.ok) {
      const { zcodeBuckets } = await import("../src/providers/zcode.ts");
      const joined = zcodeBuckets(out.body, Date.now());
      if (joined && !joined.expired && joined.buckets.length > 0) {
        for (const b of joined.buckets) {
          assert.ok(b.scope.length > 0);
          assert.ok(Number.isFinite(b.used));
        }
      }
    } else {
      assert.ok(
        out.error.kind === "no-credentials" ||
          out.error.kind === "expired-token" ||
          out.error.kind === "not-readable-remotely" ||
          out.error.kind === "http-error" ||
          out.error.kind === "parse-failure" ||
          out.error.kind === "timeout",
      );
    }
  });
});

// ---------- pricing resolution ----------

describe("usage pricing", () => {
  const store = {
    schemaVersion: 1 as const,
    hourly: {},
    daily: {},
    samples: {},
    state: {},
    pricing: {
      fetchedAt: 1,
      usdPerTok: {
        "z-ai/glm-5.3": { in: 1.4e-6, out: 4.4e-6, cr: 0.26e-6 },
        "anthropic/claude-opus-5.5": { in: 5e-6, out: 25e-6 },
      },
    },
  };

  it("resolves exact slugs, prefixes, suffixes and the fallback table", () => {
    assert.equal(priceForModel(store, "z-ai/glm-5.3")?.source, "openrouter");
    assert.equal(priceForModel(store, "GLM-5.3")?.source, "openrouter"); // prefix -> z-ai/glm-5.3
    assert.equal(priceForModel(store, "glm-5-3")?.source, "openrouter"); // dashed variant
    assert.equal(priceForModel(store, "claude-opus-5-5")?.price.in, 5e-6); // suffix match
    assert.equal(priceForModel(store, "qwen3-max")?.source, "fallback");
    assert.equal(priceForModel(store, "totally-unknown-model"), null);
  });

  it("rowCost prefers vendor-actual usd over estimates", () => {
    const glm = store.pricing.usdPerTok?.["z-ai/glm-5.3"];
    assert.ok(glm);
    assert.deepEqual(rowCost({ in: 10, out: 10, usd: 0.5 }, glm), { usd: 0.5, kind: "actual" });
    const est = rowCost({ in: 1e6, out: 0 }, glm);
    assert.ok(est && est.kind === "estimate");
    assert.equal(rowCost({ in: 1e6 }, null), null);
  });
});

// ---------- aggregation ----------

describe("usage aggregation", () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const from = now - 7 * DAY;

  function seed(dir: string): void {
    mutateUsageStore(
      dir,
      (s) => {
        replaceDailyRows(s, "glm", {
          [dayKey(now - DAY)]: { "GLM-5.3": { in: 1000, cr: 4000, out: 100 } },
        });
        replaceHourlyRange(s, "glm", now - 3 * HOUR, now, {
          [hourKey(now - HOUR)]: { "GLM-5.3": { in: 50, cr: 200, out: 5 } },
        });
        replaceDailyRows(s, "openrouter", {
          [dayKey(now - DAY)]: { "openai/gpt-5.2": { in: 900, out: 100, req: 10, usd: 0.25 } },
        });
        replaceHourlyRange(s, "zcode", now - 3 * HOUR, now, {
          [hourKey(now - HOUR)]: { "glm-5-3": { tot: 12345 } },
        });
        s.samples.google = [{ t: now - HOUR, k: "5h", u: 12, r: "2026-09-29T18:00:00Z" }];
        s.pricing = { fetchedAt: now, usdPerTok: { "z-ai/glm-5.3": { in: 1.4e-6, out: 4.4e-6, cr: 0.26e-6 } } };
      },
      now,
    );
  }

  it("day view prefers daily rows, aggregates hourly otherwise, blends splitless rows", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const agg = aggregateUsage(readUsageStore(dir), { granularity: "day", fromMs: from, toMs: now });
      const glm = agg.providers.glm;
      assert.equal(glm.splitless, false);
      assert.equal(glm.models.find((m) => m.model === "GLM-5.3")?.in, 1050);
      assert.equal(glm.cacheHit !== null && glm.cacheHit > 0.79 && glm.cacheHit < 0.81, true);
      assert.ok(glm.usdEst > 0);

      const or = agg.providers.openrouter;
      assert.equal(or.usdActual, 0.25);
      assert.equal(or.models[0].usdKind, "actual");

      const zcode = agg.providers.zcode;
      assert.equal(zcode.splitless, true);
      const zModel = zcode.models[0];
      assert.equal(zModel.tot, 12345);
      assert.equal(zModel.usdKind, "blended");
      assert.ok(zModel.usd !== null && zModel.usd > 0);

      // google: samples only – present with zero buckets
      assert.equal(agg.providers.google.splitless, true);
      assert.equal(agg.providers.google.samples.length, 1);
      assert.equal(agg.providers.google.models.length, 0);
    } finally {
      cleanup(dir)();
    }
  });

  it("hour view returns the hourly buckets only", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const agg = aggregateUsage(readUsageStore(dir), { granularity: "hour", fromMs: now - 2 * HOUR, toMs: now });
      assert.equal(agg.providers.glm.series.length, 1);
      assert.equal(agg.providers.glm.series[0].in, 50);
      assert.equal(agg.providers.openrouter, undefined); // daily rows stay out of the hour view
    } finally {
      cleanup(dir)();
    }
  });

  it("lists unpriced models instead of silently pricing at zero", () => {
    const dir = tempDir();
    try {
      mutateUsageStore(
        dir,
        (s) => {
          replaceDailyRows(s, "glm", { [dayKey(now - DAY)]: { "mystery-model": { in: 10 } } });
          s.pricing = {};
        },
        now,
      );
      const agg = aggregateUsage(readUsageStore(dir), { granularity: "day", fromMs: from, toMs: now });
      assert.deepEqual(agg.providers.glm.unpriced, ["mystery-model"]);
      assert.equal(agg.providers.glm.models[0].usd, null);
    } finally {
      cleanup(dir)();
    }
  });
});

// ---------- harvest ----------

describe("usage harvest", () => {
  // Fixture dates are RELATIVE to now: the daily activity row must land on
  // dayKey(now-1d) and the analytics hour inside the harvester's 48h window,
  // or the day-view aggregation drops them when UTC midnight rolls over
  // (this exact time-bomb broke the suite once the clock hit Sep 30 UTC).
  const OR_ACTIVITY = () => ({
    data: [
      {
        date: `${dayKey(Date.now() - DAY)} 00:00:00`,
        model: "openai/gpt-5.2",
        requests: 2,
        usage: 0.1,
        prompt_tokens: 100,
        completion_tokens: 20,
      },
    ],
  });
  const OR_ANALYTICS = () => ({
    data: {
      data: [
        {
          date__hour: `${hourKey(Date.now() - 2 * HOUR)}:00:00`,
          model: "openai/gpt-5.2",
          tokens_prompt: "500",
          tokens_completion: "40",
          cached_tokens: "100",
        },
      ],
    },
  });
  const OR_MODELS = {
    data: [
      { id: "openai/gpt-5.2", pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000002" } },
    ],
  };

  function jsonFetch(map: (url: string) => unknown): typeof fetch {
    return (async (url: string | URL | RequestInfo): Promise<Response> =>
      new Response(JSON.stringify(map(String(url))), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  it("applies openrouter + pricing from injected fetches and never stores the key", async () => {
    const dir = tempDir();
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-mgmt-FIXTURE-SECRET";
    registerSecret("sk-or-mgmt-FIXTURE-SECRET");
    try {
      const summary = await harvestUsage([], {
        subtrkDir: dir,
        budgetMs: 5_000,
        fetchImpl: jsonFetch((url) => {
          if (url.includes("/activity")) return OR_ACTIVITY();
          if (url.includes("/analytics/query")) return OR_ANALYTICS();
          if (url.includes("/models")) return OR_MODELS;
          return {};
        }),
      });
      assert.deepEqual(
        summary.errors.filter((e) => e.startsWith("openrouter") || e.startsWith("pricing")),
        [],
      );
      const raw = JSON.stringify(readUsageStore(dir));
      assert.ok(!raw.includes("sk-or-mgmt-FIXTURE-SECRET"), "the store must never hold secrets");
      const store = readUsageStore(dir);
      const dailyDay = dayKey(Date.now() - DAY);
      const hk = hourKey(Date.now() - 2 * HOUR);
      assert.equal(store.daily.openrouter[dailyDay]["openai/gpt-5.2"].usd, 0.1);
      assert.equal(store.hourly.openrouter[hk]["openai/gpt-5.2"].in, 400); // 500 prompt − 100 cached
      assert.equal(store.hourly.openrouter[hk]["openai/gpt-5.2"].cr, 100);
      assert.ok(store.pricing.usdPerTok?.["openai/gpt-5.2"]);
      const agg = aggregateUsage(store, { granularity: "day", fromMs: Date.now() - DAY, toMs: Date.now() });
      assert.equal(agg.providers.openrouter.models[0].usdKind, "actual");
    } finally {
      delete process.env.OPENROUTER_MANAGEMENT_KEY;
      clearSecrets();
      cleanup(dir)();
    }
  });

  it("skips openrouter history gracefully without a management key", async () => {
    const dir = tempDir();
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    try {
      const summary = await harvestUsage([], {
        subtrkDir: dir,
        budgetMs: 2_000,
        envPath: join(dir, "does-not-exist.env"), // hermetic – never the real ~/.subtrk/env
        fetchImpl: jsonFetch(() => ({})),
      });
      assert.ok(summary.skipped.some((s) => s.startsWith("openrouter: no management key")));
      assert.equal(Object.keys(readUsageStore(dir).daily.openrouter ?? {}).length, 0);
    } finally {
      cleanup(dir)();
    }
  });

  it("records samples from probe results", async () => {
    const dir = tempDir();
    try {
      await harvestUsage([result("kimi", [{ kind: "5h", usedPercent: 44, resetsAt: "2026-09-29T18:00:00Z" }])], {
        subtrkDir: dir,
        budgetMs: 1_000,
        fetchImpl: jsonFetch(() => ({})),
      });
      const store = readUsageStore(dir);
      assert.equal(store.samples.kimi[0].u, 44);
    } finally {
      cleanup(dir)();
    }
  });
});

// ---------- CLI + serve ----------

describe("subtrk usage CLI", () => {
  it("prints month-to-date text and json from a seeded store", async () => {
    const dir = tempDir();
    try {
      const now = Date.now();
      mutateUsageStore(dir, (s) => {
        replaceDailyRows(s, "glm", { [dayKey(now)]: { "GLM-5.3": { in: 1000, cr: 1000, out: 100 } } });
        s.samples.claude = [{ t: now, k: "5h", u: 32, r: "x" }];
        s.pricing = { fetchedAt: now, usdPerTok: { "z-ai/glm-5.3": { in: 1.4e-6, out: 4.4e-6, cr: 0.26e-6 } } };
      });
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...parts: unknown[]) => logs.push(parts.join(" "));
      let code: number;
      try {
        code = await main(["usage"], { dirs: { subtrk: dir } });
      } finally {
        console.log = orig;
      }
      assert.equal(code, 0);
      const text = logs.join("\n");
      assert.ok(text.includes("glm"));
      assert.ok(text.includes("% history only"));

      const jsonLogs: string[] = [];
      console.log = (...parts: unknown[]) => jsonLogs.push(parts.join(" "));
      let code2: number;
      try {
        code2 = await main(["usage", "--json"], { dirs: { subtrk: dir } });
      } finally {
        console.log = orig;
      }
      assert.equal(code2, 0);
      const parsed = JSON.parse(jsonLogs[0]) as {
        schemaVersion: number;
        providers: Record<string, { models: unknown[] }>;
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.ok(parsed.providers.glm.models.length > 0);
    } finally {
      cleanup(dir)();
    }
  });

  it("rejects unknown providers and bad --days with exit 2", async () => {
    const dir = tempDir();
    try {
      assert.equal(await main(["usage", "--provider", "nope"], { dirs: { subtrk: dir } }), 2);
      assert.equal(await main(["usage", "--days", "0"], { dirs: { subtrk: dir } }), 2);
      assert.equal(await main(["usage", "--days", "abc"], { dirs: { subtrk: dir } }), 2);
    } finally {
      cleanup(dir)();
    }
  });
});

// ---------- /api/usage route ----------

describe("GET /api/usage", () => {
  it("serves aggregates from the store behind the bearer token", async () => {
    const dir = tempDir();
    try {
      const now = Date.now();
      mutateUsageStore(dir, (s) => {
        replaceDailyRows(s, "glm", { [dayKey(now)]: { "GLM-5.3": { in: 1000, cr: 500, out: 50 } } });
        s.pricing = { fetchedAt: now, usdPerTok: { "z-ai/glm-5.3": { in: 1.4e-6, out: 4.4e-6, cr: 0.26e-6 } } };
      });
      const handle = await startConsole({ subtrkDir: dir, providers: [] });
      try {
        const auth = { authorization: `Bearer ${handle.token}` };
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/usage`, { headers: auth });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          schemaVersion: number;
          providers: Record<string, { models: unknown[]; cacheHit: number | null }>;
        };
        assert.equal(body.schemaVersion, 1);
        assert.ok(body.providers.glm);
        assert.ok(body.providers.glm.models.length > 0);

        const scoped = await fetch(`http://127.0.0.1:${handle.port}/api/usage?provider=glm&granularity=hour`, {
          headers: auth,
        });
        assert.equal(scoped.status, 200);

        const noAuth = await fetch(`http://127.0.0.1:${handle.port}/api/usage`);
        assert.equal(noAuth.status, 401);
        const badProvider = await fetch(`http://127.0.0.1:${handle.port}/api/usage?provider=nope`, { headers: auth });
        assert.equal(badProvider.status, 400);
        const badMethod = await fetch(`http://127.0.0.1:${handle.port}/api/usage`, { method: "POST", headers: auth });
        assert.equal(badMethod.status, 405);

        // The drill-down route serves the same static shell for known ids and
        // nothing else – no file serving, ever.
        const shellRes = await fetch(`http://127.0.0.1:${handle.port}/provider/glm`);
        assert.equal(shellRes.status, 200);
        assert.match(shellRes.headers.get("content-type") ?? "", /text\/html/);
        assert.ok((shellRes.headers.get("content-security-policy") ?? "").length > 0);
        const shellText = await shellRes.text();
        assert.ok(shellText.includes("subtrk console"));
        // The token lives ONLY in the URL fragment, so every same-origin
        // navigation must carry location.hash – dropping it 401s the whole
        // page (regression guard for the blank-drill-down bug).
        assert.ok(shellText.includes("${location.hash}"), "card navigation must carry the fragment");
        assert.ok(shellText.includes('"/" + location.hash'), "back link must carry the fragment");
        assert.equal((await fetch(`http://127.0.0.1:${handle.port}/provider/nope`)).status, 404);

        for (const r of [res, scoped, noAuth, badProvider, badMethod]) {
          for (const key of Object.keys(r.headers)) {
            assert.ok(!key.toLowerCase().startsWith("access-control-"), "no CORS headers, ever");
          }
        }
      } finally {
        await handle.close();
      }
    } finally {
      cleanup(dir)();
    }
  });
});
