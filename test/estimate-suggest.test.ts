// estimate-suggest.test.ts – W4.2: `track estimate --suggest` ranks enabled
// provider × model positions by calibrated fit (model as output). Offline,
// deterministic fixtures: ranking, p50-only placement, every disclosure
// reason, the 2% calibration gate, the additive JSON field, and the
// byte-identical default output.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { readTrackStore, type TrackRecord, trackStorePath } from "../src/track.ts";
import { buildSuggest, enrichRecord, estimateCommand, type SuggestOut, statableRecords } from "../src/track-stats.ts";
import { hourKey, readUsageStore } from "../src/usage.ts";

const NOW = 1_700_000_000_000;
const H = 3_600_000;

function rec(id: string, model: string, tok: number): TrackRecord {
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
    models: { [model]: 1 },
    wallMs: H,
  };
}

// Three hourly rows per provider inside a 5h window resetting at NOW+2h.
function hourly(models: Record<string, number>): Record<string, Record<string, object>> {
  const out: Record<string, Record<string, object>> = {};
  for (let i = 0; i < 3; i++) {
    const rows: Record<string, object> = {};
    for (const [m, total] of Object.entries(models)) {
      const t = total / 3;
      rows[m] = { in: Math.round(t * 0.1), cr: Math.round(t * 0.8), out: Math.round(t * 0.1), req: 1 };
    }
    out[hourKey(NOW - i * H)] = rows;
  }
  return out;
}

function cacheEntry(id: string, usedPercent: number, resetsAtMs: number, stale = false): object {
  return {
    data: {
      id,
      ok: true,
      stale,
      fetchedAt: new Date(NOW - H).toISOString(),
      windows: [{ kind: "5h", usedPercent, resetsAt: new Date(resetsAtMs).toISOString() }],
    },
    fetchedAt: NOW - H,
    ttlMs: 60_000,
  };
}

// claude: fits p90 with ~53% headroom (cap 10M, left 6M, p90 0.7M)
// alibaba: fits p90 with ~12.5% headroom (cap 4M, left 2M, p90 1.5M)
// glm: median fits, p90 does not (left ~1.295M, p50 1.2M, p90 1.4M)
// openai: stale (window already reset) · kimi: 1% used (2% gate)
// google: no cached window · claude-mystery-9: no pricing
function fixture(dir: string): void {
  const records = [
    rec("c1", "claude-opus-5.5", 0.5e6),
    rec("c2", "claude-opus-5.5", 0.6e6),
    rec("c3", "claude-opus-5.5", 0.7e6),
    rec("a1", "qwen3-max", 1.0e6),
    rec("a2", "qwen3-max", 1.2e6),
    rec("a3", "qwen3-max", 1.5e6),
    rec("g1", "glm-5.3", 1.0e6),
    rec("g2", "glm-5.3", 1.2e6),
    rec("g3", "glm-5.3", 1.4e6),
  ];
  writeFileSync(trackStorePath(dir), JSON.stringify({ schemaVersion: 1, markers: [], records }));
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({
      schemaVersion: 1,
      hourly: {
        claude: hourly({ "claude-opus-5.5": 3e6, "claude-mystery-9": 1e6 }),
        alibaba: hourly({ "qwen3-max": 2e6 }),
        glm: hourly({ "glm-5.3": 5.9e6 }),
        kimi: hourly({ "kimi-k2": 1e6 }),
      },
      daily: {},
      samples: {},
      state: {},
      pricing: {
        fetchedAt: NOW,
        usdPerTok: {
          "anthropic/claude-opus-5.5": { in: 5e-6, out: 25e-6, cr: 0.5e-6, cw: 6.25e-6 },
          "moonshotai/kimi-k2": { in: 0.6e-6, out: 2.5e-6 },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      claude: cacheEntry("claude", 40, NOW + 2 * H),
      alibaba: cacheEntry("alibaba", 50, NOW + 2 * H),
      glm: cacheEntry("glm", 82, NOW + 2 * H),
      openai: cacheEntry("openai", 30, NOW - H),
      kimi: cacheEntry("kimi", 1, NOW + 2 * H),
    }),
  );
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ enabled: ["claude", "alibaba", "glm", "openai", "kimi", "google"] }),
  );
}

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  return { out, restore: () => (console.log = orig) };
}

async function run(args: Parameters<typeof estimateCommand>[0], dir: string): Promise<string[]> {
  const cap = capture();
  try {
    assert.equal(await estimateCommand(args, { subtrkDir: dir, now: () => NOW }), 0);
    return cap.out;
  } finally {
    cap.restore();
  }
}

describe("track estimate --suggest", () => {
  let dir: string;
  let sg: SuggestOut;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "subtrk-suggest-"));
    fixture(dir);
    const ustore = readUsageStore(dir);
    const pool = statableRecords(readTrackStore(dir), NOW).map((r) => enrichRecord(r, ustore));
    sg = buildSuggest(pool, {
      providers: ["claude", "alibaba", "glm", "openai", "kimi", "google"],
      complexity: "m",
      subtrkDir: dir,
      nowMs: NOW,
    });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("ranks fits-p90 by headroom, then median-only", () => {
    assert.deepEqual(
      sg.candidates.map((c) => [`${c.provider}/${c.model}`, c.fits]),
      [
        ["claude/claude-opus-5.5", "p50+p90"],
        ["alibaba/qwen3-max", "p50+p90"],
        ["glm/glm-5.3", "p50"],
      ],
    );
    const [claude, alibaba] = sg.candidates;
    assert.ok(Math.abs(claude.headroomPct - 53) < 0.5, `claude headroom ${claude.headroomPct}`);
    assert.ok(Math.abs(alibaba.headroomPct - 12.5) < 0.5, `alibaba headroom ${alibaba.headroomPct}`);
    assert.ok(sg.candidates[2].headroomPct < 0, "p90 overruns the glm window");
    // each provider calibrates from its own bucket and prices at the candidate model
    assert.equal(claude.p90Tok, 0.7e6);
    assert.ok(claude.p50Usd !== null && claude.p90Usd !== null && claude.p50Usd < claude.p90Usd);
  });

  it("discloses every position it cannot evaluate", () => {
    const reasons = Object.fromEntries(sg.excluded.map((x) => [`${x.provider}/${x.model ?? "*"}`, x.reason]));
    assert.match(reasons["claude/claude-mystery-9"], /no pricing/);
    assert.match(reasons["openai/*"], /stale/);
    assert.match(reasons["kimi/*"], /under 2% used/);
    assert.match(reasons["google/*"], /no cached window/);
    assert.equal(sg.excluded.length, 4);
  });

  it("JSON adds `suggest` and leaves every existing field unchanged", async () => {
    const base = { json: true, provider: "glm", complexity: "m" };
    const plain = JSON.parse((await run(base, dir))[0]) as Record<string, unknown>;
    const withSg = JSON.parse((await run({ ...base, suggest: true }, dir))[0]) as Record<string, unknown>;
    assert.equal("suggest" in plain, false);
    const { suggest, ...rest } = withSg;
    assert.deepEqual(rest, plain);
    assert.deepEqual(
      (suggest as SuggestOut).candidates.map((c) => c.model),
      ["claude-opus-5.5", "qwen3-max", "glm-5.3"],
    );
  });

  it("default text is byte-identical; --suggest only inserts its block before help", async () => {
    const base = { json: false, provider: "glm", complexity: "m" };
    const plain = await run(base, dir);
    assert.deepEqual(plain, [
      "history   n=3 (glm, m) · done · leaves",
      "  p50 1.20M tok / $2.42      p90 1.40M tok / $2.83",
      "window    glm 5h · 18% left (reset 00:13Z)",
      "  ≈ 1.30M tok remaining  (calibrated: 5.90M consumed at 82% → capacity 7.20M)",
      "verdict   median fits · p90 does not — split the task or switch model",
      "  median fits, p90 does not – split the task or switch model",
      "help: subtrk track estimate --json | subtrk track start --task <text>",
    ]);
    const withSg = await run({ ...base, suggest: true }, dir);
    assert.deepEqual(withSg.slice(0, plain.length - 1), plain.slice(0, -1));
    assert.equal(withSg.at(-1), plain.at(-1));
    const block = withSg.slice(plain.length - 1, -1);
    assert.match(block[0], /^suggest\s+advisory/);
    assert.match(block[1], /claude\/claude-opus-5\.5\s+fits p90 · headroom 53%/);
    assert.match(block[3], /glm\/glm-5\.3\s+median fits · p90 does not/);
    assert.ok(block.some((l) => /skipped kimi: window under 2% used/.test(l)));
  });

  it("is reachable through main", async () => {
    const cap = capture();
    try {
      assert.equal(
        await main(["track", "estimate", "--complexity", "m", "--suggest", "--json"], { dirs: { subtrk: dir } }),
        0,
      );
      const parsed = JSON.parse(cap.out[0]) as { suggest?: SuggestOut };
      // real clock: the fixture's windows have long reset, so all are stale – disclosed, not hidden
      assert.ok(parsed.suggest);
      assert.ok(parsed.suggest.excluded.some((x) => /stale/.test(x.reason)));
    } finally {
      cap.restore();
    }
  });
});
