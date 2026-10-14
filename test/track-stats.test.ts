// track-stats.test.ts – M4b: percentiles, bucketing + fallback chain, the
// estimate calibration math and verdicts, stats/estimate CLI commands, and the
// serve surface (/track shell route + /api/track with live enrichment).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import type { ProviderModule } from "../src/core.ts";
import { type ServeHandle, startConsole } from "../src/serve.ts";
import { readTrackStore, type TrackRecord, type TrackStore, trackStorePath } from "../src/track.ts";
import {
  applyTreeSums,
  buildEstimate,
  buildStats,
  cleanPinnedChild,
  delegatedShare,
  dominantModel,
  enrichRecord,
  estimateCommand,
  estimateText,
  percentile,
  providerOfModel,
  statableDelegated,
  statsCommand,
  statsText,
} from "../src/track-stats.ts";
import { hourKey, readUsageStore, type UsageStore } from "../src/usage.ts";

// ---------- helpers ----------

interface Captured {
  out: string[];
  err: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rec(over: Partial<TrackRecord> & Pick<TrackRecord, "id" | "task">): TrackRecord {
  return {
    project: "C:\\work\\p",
    t0: 0,
    t1: 1_700_000_000_000,
    status: "done",
    attribution: "session-window",
    contested: false,
    nested: null,
    pending: false,
    sessions: ["s1"],
    usage: { in: 1000, cr: 5000, cw: 200, out: 400, reqs: 3 },
    models: { "glm-5.3": 1 },
    wallMs: 3_600_000,
    ...over,
  };
}

function writeStore(dir: string, store: Partial<TrackStore>): void {
  writeFileSync(trackStorePath(dir), JSON.stringify({ schemaVersion: 1, markers: [], records: [], ...store }));
}

// A usage store with `tokPerHour` glm tokens in each of the last `hours` UTC
// hours – the estimate calibration input.
function writeUsageStore(dir: string, hours: number, tokPerHour: number, nowMs: number): void {
  type Row = { in: number; cr: number; out: number; req: number };
  const hourly: Record<string, Record<string, Record<string, Row>>> = { glm: {} };
  for (let i = 0; i < hours; i++) {
    hourly.glm[hourKey(nowMs - i * 3_600_000)] = {
      "glm-5.3": {
        in: Math.round(tokPerHour * 0.1),
        cr: Math.round(tokPerHour * 0.8),
        out: Math.round(tokPerHour * 0.1),
        req: 10,
      },
    };
  }
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({ schemaVersion: 1, hourly, daily: {}, samples: {}, state: {}, pricing: {} }),
  );
}

function writeCache(dir: string, usedPercent: number, resetsAtMs: number): void {
  writeFileSync(
    join(dir, "cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      glm: {
        data: {
          id: "glm",
          ok: true,
          stale: false,
          fetchedAt: new Date(resetsAtMs - 3_600_000).toISOString(),
          windows: [{ kind: "5h", usedPercent, resetsAt: new Date(resetsAtMs).toISOString() }],
        },
        fetchedAt: resetsAtMs - 3_600_000,
        ttlMs: 60_000,
      },
    }),
  );
}

const NOW = 1_700_000_000_000;

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

// ---------- pure helpers ----------

describe("percentile + model mapping", () => {
  it("nearest-rank percentiles", () => {
    assert.equal(percentile([10], 0.5), 10);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2); // ceil(.5*4)-1 = 1
    assert.equal(percentile([1, 2, 3, 4], 0.9), 4);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2); // order-independent
    assert.equal(percentile([], 0.5), null);
  });

  it("maps model prefixes to providers and picks the dominant model", () => {
    assert.equal(providerOfModel("GLM-5.3"), "glm");
    assert.equal(providerOfModel("glm-5.3-flash"), "glm");
    assert.equal(providerOfModel("claude-opus-5-5"), "claude");
    assert.equal(providerOfModel("qwen3.8-max"), "alibaba");
    assert.equal(providerOfModel("weird-9"), null);
    assert.equal(
      dominantModel(rec({ id: "a", task: "t", models: { "glm-5.3": 0.7, "glm-5.3-flash": 0.3 } })),
      "glm-5.3",
    );
  });

  it("enriches records with tokens, est cost and derived provider", () => {
    const dir = tempDir("subtrk-stats-");
    try {
      writeUsageStore(dir, 1, 1000, NOW);
      const e = enrichRecord(rec({ id: "a", task: "t" }), readUsageStore(dir));
      assert.equal(e.tokens, 6600);
      assert.equal(e.provider, "glm");
      assert.ok(e.usdE !== null && e.usdE > 0, `priced from the fallback table (got ${e.usdE})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- stats ----------

describe("buildStats", () => {
  it("buckets by provider x complexity and counts exclusions", () => {
    const noPricing = emptyUsageStore();
    const records = [
      enrichRecord(rec({ id: "1", task: "a", complexity: "m" }), noPricing),
      enrichRecord(rec({ id: "2", task: "b", complexity: "m" }), noPricing),
      enrichRecord(
        rec({ id: "3", task: "c", complexity: "s", usage: { in: 10, cr: 0, cw: 0, out: 0, reqs: 1 } }),
        noPricing,
      ),
    ];
    const all = [
      ...records,
      rec({ id: "4", task: "nested", nested: "1" }),
      rec({ id: "5", task: "contested", contested: true }),
      rec({ id: "6", task: "aborted", status: "aborted" }),
    ];
    const out = buildStats(records, all, 30);
    assert.equal(out.n, 3);
    assert.equal(out.buckets.length, 2);
    const m = out.buckets.find((b) => b.complexity === "m");
    assert.ok(m);
    assert.equal(m.n, 2);
    assert.equal(m.p50Tok, 6600);
    assert.equal(out.excluded.nested, 1);
    assert.equal(out.excluded.contested, 1);
    assert.equal(out.excluded.notDone, 1);
  });
});

// ---------- estimate ----------

describe("delegated population + orchestrated annotation (PR C)", () => {
  const noPricing = emptyUsageStore();
  const ORCH_USAGE = { in: 2000, cr: 8000, cw: 0, out: 1000, reqs: 9 };
  const ORCH_BY_SOURCE = {
    "zcode:main": { in: 600, cr: 2400, cw: 0, out: 100, reqs: 1 },
    "zcode:subagent": { in: 1400, cr: 5600, cw: 0, out: 900, reqs: 8 },
  };

  it("delegatedShare reads the zcode subagent tiers; null when the tiers carry no split", () => {
    assert.equal(delegatedShare(rec({ id: "x", task: "t" })), null, "no bySource = unknown, never zero");
    const share = delegatedShare(rec({ id: "y", task: "t", usage: ORCH_USAGE, bySource: ORCH_BY_SOURCE }));
    assert.equal(share, 7900 / 11000);
  });

  it("statableDelegated selects done, uncontested NESTED records only", () => {
    const store: TrackStore = {
      schemaVersion: 1,
      markers: [],
      records: [
        rec({ id: "leaf", task: "solo" }),
        rec({ id: "kid", task: "child", nested: "orch1", usage: { in: 10, cr: 20, cw: 0, out: 5, reqs: 1 } }),
        rec({ id: "dead", task: "aborted child", nested: "orch1", status: "aborted" }),
      ],
    };
    const picked = statableDelegated(store, 1_700_000_000_000 + 1000, 30);
    assert.deepEqual(
      picked.map((r) => r.id),
      ["kid"],
    );
  });

  it("buildStats carries delegated buckets separately; statsText labels them upper bounds", () => {
    const leaf = enrichRecord(rec({ id: "l1", task: "solo", complexity: "m" }), noPricing);
    const nested = enrichRecord(
      rec({
        id: "n1",
        task: "child",
        complexity: "m",
        nested: "orch1",
        usage: { in: 10, cr: 20, cw: 0, out: 5, reqs: 1 },
      }),
      noPricing,
    );
    const out = buildStats([leaf], [leaf, nested], 30, [nested]);
    assert.equal(out.buckets.length, 1, "leaf buckets unchanged");
    assert.equal(out.delegated.length, 1, "nested records form their own population");
    assert.equal(out.delegated[0]?.n, 1);
    const text = statsText(out).join("\n");
    assert.match(text, /delegated glm · m/);
    assert.match(text, /upper bounds/);
  });

  it("buildEstimate annotates whole-tree burn when the picked bucket holds orchestrated records", () => {
    const dir = tempDir("subtrk-est-");
    try {
      const orch = enrichRecord(
        rec({ id: "orch1", task: "wave", complexity: "xl", usage: ORCH_USAGE, bySource: ORCH_BY_SOURCE }),
        noPricing,
      );
      const out = buildEstimate([orch], { provider: null, complexity: "xl", subtrkDir: dir, nowMs: 1_700_000_000_100 });
      assert.equal(out.history.n, 1);
      assert.ok(out.history.orchestrated, "orchestration composition present");
      assert.equal(out.history.orchestrated?.n, 1);
      assert.equal(out.history.orchestrated?.medianDelegatedPct, 72, "7900/11000 rounds to 72");
      const text = estimateText(out).join("\n");
      assert.match(text, /orchestration: 1 of 1 orchestrated · median 72% delegated – p50\/p90 are whole-tree burn/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildEstimate stays silent about orchestration for solo buckets", () => {
    const dir = tempDir("subtrk-est-");
    try {
      const solo = enrichRecord(rec({ id: "s1", task: "solo", complexity: "s" }), noPricing);
      const out = buildEstimate([solo], { provider: null, complexity: "s", subtrkDir: dir, nowMs: 1_700_000_000_100 });
      assert.equal(out.history.orchestrated, undefined);
      assert.ok(!estimateText(out).join("\n").includes("orchestration"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PR D: attribution split - clean pinned children + tree sums", () => {
  const noPricing = emptyUsageStore();

  it("cleanPinnedChild: only excluded-pin children count; unpinned or unexcluded stay window snapshots", () => {
    const parent = rec({ id: "p1", task: "parent", excludedPins: ["pin_x"] });
    const clean = rec({ id: "c1", task: "clean child", nested: "p1", sessionPin: "pin_x" });
    const unpinned = rec({ id: "c2", task: "unpinned child", nested: "p1" });
    const notExcluded = rec({ id: "c3", task: "other pin", nested: "p1", sessionPin: "pin_y" });
    const all = [parent, clean, unpinned, notExcluded];
    assert.equal(cleanPinnedChild(clean, all), true);
    assert.equal(cleanPinnedChild(unpinned, all), false);
    assert.equal(cleanPinnedChild(notExcluded, all), false);
  });

  it("applyTreeSums: a parent's sample is its whole tree; delegated clean buckets split from snapshots", () => {
    const parent = enrichRecord(
      rec({
        id: "p1",
        task: "orchestrated",
        complexity: "xl",
        usage: { in: 600, cr: 300, cw: 0, out: 100, reqs: 5 },
        excludedPins: ["pin_x"],
      }),
      noPricing,
    );
    const cleanKid = enrichRecord(
      rec({
        id: "c1",
        task: "clean child",
        complexity: "m",
        nested: "p1",
        sessionPin: "pin_x",
        usage: { in: 300, cr: 150, cw: 0, out: 50, reqs: 2 },
      }),
      noPricing,
    );
    const snapKid = enrichRecord(
      rec({
        id: "c2",
        task: "snapshot child",
        complexity: "m",
        nested: "p1",
        usage: { in: 10, cr: 5, cw: 0, out: 1, reqs: 1 },
      }),
      noPricing,
    );
    const pool = [parent, cleanKid, snapKid];
    applyTreeSums(pool);
    assert.equal(parent.tokens, 1000 + 500, "tree = own 1000 + clean child 500");
    assert.equal(snapKid.tokens, 16, "snapshot child untouched by tree sums");
    const out = buildStats([parent], [parent, cleanKid, snapKid], 30, [cleanKid, snapKid]);
    assert.equal(out.buckets[0]?.p50Tok, 1500, "the leaf calibration sample is the tree");
    const clean = out.delegated.find((b) => b.clean === true);
    const snapshot = out.delegated.find((b) => b.clean === false);
    assert.ok(clean && clean.p50Tok === 500, "clean delegated bucket carries the child's exact burn");
    assert.ok(snapshot && snapshot.p50Tok === 16, "snapshot delegated bucket stays separate");
    const text = statsText(out).join("\n");
    assert.match(text, /· clean/);
    assert.match(text, /upper bounds/);
  });
});

describe("buildEstimate", () => {
  function estDir(tokens: number[], usedPercent: number, consumedTok: number): string {
    const dir = tempDir("subtrk-est-");
    writeStore(dir, {
      records: tokens.map((tok, i) =>
        rec({
          id: `t${i}`,
          task: "x",
          complexity: "m",
          usage: { in: tok / 3, cr: tok / 3, cw: 0, out: tok / 3, reqs: 1 },
        }),
      ),
    });
    // The 5h window resets 2h from NOW, so it started at NOW-3h: three hourly
    // rows (floored hour keys at NOW, NOW-1h, NOW-2h) all fall inside it.
    writeUsageStore(dir, 3, consumedTok / 3, NOW);
    writeCache(dir, usedPercent, NOW + 2 * 3_600_000);
    return dir;
  }

  it("calibrates percent-remaining into tokens and lands the median verdict", () => {
    const dir = estDir([1.0e6, 1.2e6, 1.4e6], 82, 5.9e6); // p50 1.2M, p90 1.4M
    try {
      const store = readTrackStore(dir);
      const ustore = readUsageStore(dir);
      const enriched = store.records.map((r) => enrichRecord(r, ustore));
      const out = buildEstimate(enriched, { provider: "glm", complexity: "m", subtrkDir: dir, nowMs: NOW });
      assert.equal(out.history.n, 3);
      assert.equal(out.history.p50Tok, 1.2e6);
      assert.equal(out.history.p90Tok, 1.4e6);
      const w = out.window;
      assert.ok(w?.calibrated);
      // capacity ≈ 5.9M / 0.82, remaining ≈ capacity × 0.18
      assert.ok(Math.abs((w.capacityTok ?? 0) - 5.9e6 / 0.82) < 5_000);
      assert.ok(Math.abs((w.remainingTok ?? 0) - (5.9e6 / 0.82) * 0.18) < 5_000);
      assert.equal(out.verdict, "median"); // p50 fits, p90 does not
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fits and insufficient verdicts, plus the no-window and no-history branches", () => {
    const fits = estDir([0.5e6, 0.6e6, 0.7e6], 82, 5.9e6); // p90 0.7M < ~1.295M
    const starved = estDir([2e6, 2.5e6, 3e6], 82, 5.9e6); // p50 2.5M > remainder
    try {
      const mk = (dir: string) => {
        const store = readTrackStore(dir);
        return store.records.map((r) => enrichRecord(r, readUsageStore(dir)));
      };
      assert.equal(
        buildEstimate(mk(fits), { provider: "glm", complexity: "m", subtrkDir: fits, nowMs: NOW }).verdict,
        "fits",
      );
      assert.equal(
        buildEstimate(mk(starved), { provider: "glm", complexity: "m", subtrkDir: starved, nowMs: NOW }).verdict,
        "insufficient",
      );
      const empty = tempDir("subtrk-est2-");
      try {
        writeStore(empty, { records: [] });
        const out = buildEstimate([], { provider: "glm", complexity: "m", subtrkDir: empty, nowMs: NOW });
        assert.equal(out.verdict, "no-history");
        const out2 = buildEstimate(mk(fits), { provider: null, complexity: null, subtrkDir: fits, nowMs: NOW });
        assert.equal(out2.verdict, "no-window"); // no provider -> no window lookup
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(fits, { recursive: true, force: true });
      rmSync(starved, { recursive: true, force: true });
    }
  });
});

// ---------- CLI ----------

describe("stats + estimate commands", () => {
  it("renders text and JSON, validates --days", async () => {
    const dir = tempDir("subtrk-cmd-");
    try {
      writeStore(dir, {
        records: [
          rec({ id: "1", task: "alpha", complexity: "m" }),
          rec({ id: "2", task: "beta", complexity: "m", usage: { in: 500, cr: 500, cw: 0, out: 500, reqs: 1 } }),
        ],
      });
      writeUsageStore(dir, 3, 2000, NOW);
      const cap = captureConsole();
      try {
        assert.equal(await statsCommand({ json: false }, { subtrkDir: dir, now: () => NOW }), 0);
        assert.match(cap.out.join("\n"), /all tasks\s+n=2/);
        assert.match(cap.out.join("\n"), /glm · m\s+n= {2}2/);
        cap.out.length = 0;
        assert.equal(await statsCommand({ json: true, provider: "glm" }, { subtrkDir: dir, now: () => NOW }), 0);
        const parsed = JSON.parse(cap.out[0]) as { schemaVersion: number; n: number };
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.n, 2);
        assert.equal(await statsCommand({ json: false, days: "bad" }, { subtrkDir: dir, now: () => NOW }), 2);
        cap.out.length = 0;
        writeCache(dir, 82, NOW + 2 * 3_600_000);
        assert.equal(
          await estimateCommand({ json: false, provider: "glm", complexity: "m" }, { subtrkDir: dir, now: () => NOW }),
          0,
        );
        const text = cap.out.join("\n");
        assert.match(text, /history\s+n=2 \(glm, m/);
        assert.match(text, /calibrated:/);
        assert.match(text, /verdict\s+/);
      } finally {
        cap.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches through main with the two-positional parser", async () => {
    const dir = tempDir("subtrk-cli-");
    const cap = captureConsole();
    try {
      assert.equal(await main(["track", "stats", "--json"], { dirs: { subtrk: dir } }), 0);
      const parsed = JSON.parse(cap.out[0]) as { n: number };
      assert.equal(parsed.n, 0);
      cap.out.length = 0;
      assert.equal(await main(["track", "estimate", "--provider", "glm"], { dirs: { subtrk: dir } }), 0);
      assert.match(cap.out.join("\n"), /verdict/);
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- serve ----------

interface Resp {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string, opts: { headers?: Record<string, string> } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const okProvider: ProviderModule = {
  id: "claude",
  ttlMs: 300_000,
  probe: async () => ({
    id: "claude",
    ok: true,
    stale: false,
    fetchedAt: new Date().toISOString(),
    windows: [{ kind: "5h", usedPercent: 13, resetsAt: new Date(Date.now() + 36e5).toISOString() }],
  }),
};

describe("serve /track + /api/track", () => {
  async function withServer(
    deps: Parameters<typeof startConsole>[0],
    fn: (h: ServeHandle) => Promise<void>,
  ): Promise<void> {
    const h = await startConsole(deps);
    try {
      await fn(h);
    } finally {
      await h.close();
    }
  }

  it("serves the shell at /track and requires the token for the API", async () => {
    const dir = tempDir("subtrk-serve-trk-");
    try {
      await withServer({ providers: [okProvider], subtrkDir: dir }, async (h) => {
        const shell = await get(h.port, "/track");
        assert.equal(shell.status, 200);
        assert.match(shell.headers["content-type"] ?? "", /^text\/html/);
        const anon = await get(h.port, "/api/track");
        assert.equal(anon.status, 401);
        const authed = await get(h.port, "/api/track", { headers: { authorization: `Bearer ${h.token}` } });
        assert.equal(authed.status, 200);
        const out = JSON.parse(authed.body) as { schemaVersion: number; markers: unknown[]; records: unknown[] };
        assert.equal(out.schemaVersion, 1);
        assert.deepEqual(out.markers, []);
        assert.deepEqual(out.records, []);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enriches records and attaches live so-far usage for open markers", async () => {
    const dir = tempDir("subtrk-serve-trk-");
    try {
      writeStore(dir, {
        markers: [{ id: "trk_live", task: "running", complexity: "m", project: "C:\\p", t0: Date.now() - 600_000 }],
        records: [rec({ id: "trk_done", task: "finished", complexity: "s" })],
      });
      writeUsageStore(dir, 2, 3000, Date.now());
      const liveCalls: { project: string; t0: number }[] = [];
      await withServer(
        {
          providers: [okProvider],
          subtrkDir: dir,
          trackLive: async (w) => {
            liveCalls.push(w);
            return {
              attribution: "session-window",
              usage: { in: 100, cr: 200, cw: 0, out: 50, reqs: 2 },
              bySource: {},
              models: { "glm-5.3": 1 },
              sessions: ["s"],
            };
          },
        },
        async (h) => {
          const r = await get(h.port, "/api/track?live=1", { headers: { authorization: `Bearer ${h.token}` } });
          assert.equal(r.status, 200);
          const out = JSON.parse(r.body) as {
            live: boolean;
            markers: { id: string; live: { tokens: number; attribution: string } | null }[];
            records: { id: string; tokens: number; usdE: number | null; provider: string | null }[];
          };
          assert.equal(out.live, true);
          assert.equal(out.markers.length, 1);
          assert.deepEqual(out.markers[0].live, { tokens: 350, attribution: "session-window" });
          assert.equal(liveCalls.length, 1);
          assert.equal(out.records.length, 1);
          assert.equal(out.records[0].tokens, 6600);
          assert.equal(out.records[0].provider, "glm");
          assert.ok(out.records[0].usdE !== null && out.records[0].usdE > 0);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
