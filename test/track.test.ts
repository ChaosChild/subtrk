// track.test.ts – M4a verbs, store discipline, contested/nested detection,
// prune, pending-harvest retry, and the window harvesters (zcode sqlite
// fixture db, claude + codex transcript trees). No network, no real user files.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import {
  type HarvestFn,
  type HarvestResult,
  parseDurationMs,
  readTrackStore,
  trackCommand,
  trackStorePath,
} from "../src/track.ts";
import { harvestWindow } from "../src/track-harvest.ts";

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

function usage(in_: number, cr: number, cw: number, out: number): HarvestResult {
  return {
    attribution: "session-window",
    usage: { in: in_, cr, cw, out, reqs: 3 },
    bySource: { "zcode:main": { in: in_, cr, cw, out, reqs: 3 } },
    models: { "glm-5.3": 1 },
    sessions: ["sess_a"],
  };
}

interface Fixture {
  dir: string;
  cwd: string;
  now: { ms: number };
  calls: { windows: { project: string; t0: number; t1: number }[] };
  harvest: HarvestFn;
  restore: () => void;
}

// A track CLI fixture: temp store, pinned clock, pinned cwd, injected harvest.
function fixture(harvestImpl?: HarvestFn): Fixture {
  const dir = tempDir("subtrk-track-");
  const cwd = tempDir("subtrk-proj-");
  const now = { ms: 1_700_000_000_000 };
  const calls: { windows: { project: string; t0: number; t1: number }[] } = { windows: [] };
  const harvest: HarvestFn =
    harvestImpl ??
    (async (w) => {
      calls.windows.push(w);
      return usage(1000, 5000, 200, 400);
    });
  return {
    dir,
    cwd,
    now,
    calls,
    harvest,
    restore: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Parse a mini flag argv (--task=x pairs, bare --all) into TrackArgs fields.
function run(fx: Fixture, args: string[]): Promise<number> {
  const flags: Record<string, string | boolean> = {};
  for (const a of args.slice(2)) {
    const eq = a.indexOf("=");
    if (eq === -1) flags[a.replace(/^--/, "")] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const { provider, ...rest } = flags as Record<string, string | boolean>;
  return trackCommand(
    {
      sub: args[1],
      json: false,
      ...rest,
      providerHint: typeof provider === "string" ? provider : undefined,
    },
    { subtrkDir: fx.dir, cwd: () => fx.cwd, now: () => fx.now.ms, harvest: fx.harvest },
  );
}

// ---------- verbs ----------

describe("track start", () => {
  it("opens a marker and prints the stop hint", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      const code = await run(fx, ["track", "start", "--task=write tests"]);
      assert.equal(code, 0);
      assert.match(cap.out[0], /^trk_[0-9a-f]{8}\s+marker open/);
      assert.match(cap.out[1], /subtrk track stop --id trk_/);
      const store = readTrackStore(fx.dir);
      assert.equal(store.markers.length, 1);
      assert.equal(store.markers[0].task, "write tests");
      assert.equal(store.markers[0].project, fx.cwd);
      assert.equal(store.markers[0].t0, fx.now.ms);
    } finally {
      cap.restore();
      fx.restore();
    }
  });

  it("rejects a missing task, bad complexity, unknown provider", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      assert.equal(await run(fx, ["track", "start"]), 2);
      assert.equal(await run(fx, ["track", "start", "--task=x", "--complexity=huge"]), 2);
      assert.equal(await run(fx, ["track", "start", "--task=x", "--provider=nope"]), 2);
      assert.equal(readTrackStore(fx.dir).markers.length, 0);
    } finally {
      cap.restore();
      fx.restore();
    }
  });

  it("warns when a marker is already open in the same project", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=first"]);
      fx.now.ms += 60_000;
      const code = await run(fx, ["track", "start", "--task=second"]);
      assert.equal(code, 0);
      assert.ok(cap.out.some((l) => l.includes("is still open here")));
      assert.equal(readTrackStore(fx.dir).markers.length, 2);
    } finally {
      cap.restore();
      fx.restore();
    }
  });
});

describe("track stop", () => {
  it("closes the newest open marker for the cwd and records harvested usage", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=a", "--complexity=m"]);
      fx.now.ms += 3_600_000;
      const code = await run(fx, ["track", "stop"]);
      assert.equal(code, 0);
      const store = readTrackStore(fx.dir);
      assert.equal(store.markers.length, 0);
      assert.equal(store.records.length, 1);
      const rec = store.records[0];
      assert.equal(rec.status, "done");
      assert.equal(rec.complexity, "m");
      assert.equal(rec.wallMs, 3_600_000);
      assert.deepEqual(rec.usage, { in: 1000, cr: 5000, cw: 200, out: 400, reqs: 3 });
      assert.equal(rec.attribution, "session-window");
      assert.deepEqual(rec.sessions, ["sess_a"]);
      // the harvest saw the marker window, not the stop instant
      assert.equal(fx.calls.windows[0].t0 < fx.calls.windows[0].t1, true);
      assert.match(cap.out.join("\n"), /tot 6.6k/);
    } finally {
      cap.restore();
      fx.restore();
    }
  });

  it("stops by id, honors --status and --note, fails cleanly on unknown id", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=a"]);
      const store = readTrackStore(fx.dir);
      const id = store.markers[0].id;
      fx.now.ms += 1_000;
      assert.equal(await run(fx, ["track", "stop", `--id=${id}`, "--status=aborted", "--note=gave up"]), 0);
      const rec = readTrackStore(fx.dir).records[0];
      assert.equal(rec.status, "aborted");
      assert.equal(rec.note, "gave up");
      assert.equal(await run(fx, ["track", "stop", "--id=trk_deadbeef"]), 1);
      assert.equal(await run(fx, ["track", "stop", "--status=stale"]), 2);
    } finally {
      cap.restore();
      fx.restore();
    }
  });

  it("degrades to a pending record when the harvest throws, then recovers on status", async () => {
    const fx = fixture();
    let broken = true;
    fx.harvest = async () => {
      if (broken) throw new Error("db locked");
      return usage(10, 20, 0, 5);
    };
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=a"]);
      fx.now.ms += 5_000;
      await run(fx, ["track", "stop"]);
      let rec = readTrackStore(fx.dir).records[0];
      assert.equal(rec.pending, true);
      assert.equal(rec.usage, null);
      assert.equal(rec.attribution, "none");
      broken = false;
      fx.now.ms += 5_000;
      await run(fx, ["track", "status"]);
      rec = readTrackStore(fx.dir).records[0];
      assert.equal(rec.pending, false);
      assert.deepEqual(rec.usage, { in: 10, cr: 20, cw: 0, out: 5, reqs: 3 });
    } finally {
      cap.restore();
      fx.restore();
    }
  });
});

describe("contested + nested detection", () => {
  // Overlap without containment needs an --id stop of the OLDER marker while
  // the newer is still open (stop-by-newest always yields containment).
  async function overlappingPair(fx: Fixture, sessions: string[]): Promise<void> {
    let n = 0;
    fx.harvest = async () => {
      n += 1;
      return {
        attribution: "session-window",
        usage: { in: 1, cr: 1, cw: 0, out: 1, reqs: 1 },
        bySource: {},
        models: {},
        sessions: [sessions[n - 1]],
      };
    };
    await run(fx, ["track", "start", "--task=a"]);
    const idA = readTrackStore(fx.dir).markers[0].id;
    fx.now.ms += 10;
    await run(fx, ["track", "start", "--task=b"]);
    fx.now.ms += 20; // a: 0..30, b: 10..40 -> overlap 10..30, no containment
    await run(fx, ["track", "stop", `--id=${idA}`]);
    fx.now.ms += 10;
    await run(fx, ["track", "stop"]);
  }

  it("marks overlapping same-project records with shared sessions contested", async () => {
    const fx = fixture();
    try {
      await overlappingPair(fx, ["sess_same", "sess_same"]);
      const records = readTrackStore(fx.dir).records;
      assert.equal(records.length, 2);
      assert.ok(records.every((r) => r.contested));
      assert.ok(records.every((r) => r.nested === null));
    } finally {
      fx.restore();
    }
  });

  it("session-window records sharing no sessions are not contested even when overlapping", async () => {
    const fx = fixture();
    try {
      await overlappingPair(fx, ["sess_a", "sess_b"]);
      const records = readTrackStore(fx.dir).records;
      assert.equal(
        records.some((r) => r.contested),
        false,
      );
    } finally {
      fx.restore();
    }
  });

  it("nested: a contained record points at its container; disjoint windows stay clean", async () => {
    const fx = fixture();
    try {
      // outer: t0=0..t1=100 (contains inner)
      await run(fx, ["track", "start", "--task=outer"]);
      fx.now.ms += 10;
      await run(fx, ["track", "start", "--task=inner"]);
      fx.now.ms += 10;
      await run(fx, ["track", "stop"]); // inner: 10..20
      fx.now.ms += 80;
      await run(fx, ["track", "stop"]); // outer: 0..100
      const records = readTrackStore(fx.dir).records;
      const inner = records.find((r) => r.task === "inner");
      const outer = records.find((r) => r.task === "outer");
      assert.ok(inner && outer);
      assert.equal(inner.nested, outer.id);
      assert.equal(outer.nested, null);
      assert.equal(inner.contested, false);
      assert.equal(outer.contested, false);
    } finally {
      fx.restore();
    }
  });

  it("disjoint windows in the same project are never contested", async () => {
    const fx = fixture();
    try {
      await run(fx, ["track", "start", "--task=a"]);
      fx.now.ms += 100;
      await run(fx, ["track", "stop"]);
      await run(fx, ["track", "start", "--task=b"]);
      fx.now.ms += 100;
      await run(fx, ["track", "stop"]);
      for (const r of readTrackStore(fx.dir).records) {
        assert.equal(r.contested, false);
        assert.equal(r.nested, null);
      }
    } finally {
      fx.restore();
    }
  });
});

describe("track prune", () => {
  it("closes markers past the cutoff as stale, with durations", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=old"]);
      fx.now.ms += 4 * 86_400_000;
      await run(fx, ["track", "start", "--task=fresh"]);
      assert.equal(await run(fx, ["track", "prune"]), 0); // default 3d: only "old"
      const store = readTrackStore(fx.dir);
      assert.equal(store.markers.length, 1);
      assert.equal(store.markers[0].task, "fresh");
      assert.equal(store.records.length, 1);
      assert.equal(store.records[0].status, "stale");
      assert.match(store.records[0].note ?? "", /pruned after 4d/);
      assert.match(cap.out.join("\n"), /pruned/);
    } finally {
      cap.restore();
      fx.restore();
    }
  });

  it("honors --before durations and --all, rejects bad ones", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=1h"]);
      fx.now.ms += 2 * 3_600_000;
      await run(fx, ["track", "prune", "--before=24h"]); // 2h old: survives
      assert.equal(readTrackStore(fx.dir).markers.length, 1);
      await run(fx, ["track", "prune", "--before=60m"]); // 2h old: closed
      assert.equal(readTrackStore(fx.dir).markers.length, 0);
      await run(fx, ["track", "start", "--task=x"]);
      assert.equal(await run(fx, ["track", "prune", "--all"]), 0);
      assert.equal(readTrackStore(fx.dir).markers.length, 0);
      assert.equal(await run(fx, ["track", "prune", "--before=2w"]), 2);
      assert.equal(await run(fx, ["track", "prune", "--all", "--before=1h"]), 2);
    } finally {
      cap.restore();
      fx.restore();
    }
  });
});

describe("track list + status", () => {
  it("filters by days and reports pending records", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      await run(fx, ["track", "start", "--task=ten-days-old"]);
      await run(fx, ["track", "stop"]); // t1 = now (0)
      fx.now.ms += 10 * 86_400_000;
      await run(fx, ["track", "start", "--task=just-now"]);
      await run(fx, ["track", "stop"]); // t1 = now (+10d)
      const listCap = captureConsole();
      let listCode = -1;
      try {
        listCode = await run(fx, ["track", "list", "--days=5"]);
      } finally {
        listCap.restore();
      }
      assert.equal(listCode, 0);
      const listed = listCap.out.filter((l) => l.includes("trk_"));
      assert.equal(listed.length, 1);
      assert.match(listed[0], /just-now/);
      assert.equal(await run(fx, ["track", "list", "--days=bad"]), 2);
    } finally {
      cap.restore();
      fx.restore();
    }
  });
});

describe("cli dispatch", () => {
  it("routes track <sub>, rejects unknown subs and stray positionals", async () => {
    const fx = fixture();
    const cap = captureConsole();
    try {
      const code = await main(["track", "start", "--task=via cli", "--json"], { dirs: { subtrk: fx.dir } });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]) as { marker: { id: string; task: string } };
      assert.equal(parsed.marker.task, "via cli");
      assert.match(parsed.marker.id, /^trk_/);
      assert.equal(await main(["track", "bogus"], { dirs: { subtrk: fx.dir } }), 2);
      assert.equal(await main(["track", "start", "extra"], { dirs: { subtrk: fx.dir } }), 2);
    } finally {
      cap.restore();
      fx.restore();
    }
  });
});

// ---------- durations ----------

describe("parseDurationMs", () => {
  it("accepts d/h/m and rejects everything else", () => {
    assert.equal(parseDurationMs("24h"), 24 * 3_600_000);
    assert.equal(parseDurationMs("60m"), 60 * 60_000);
    assert.equal(parseDurationMs("3d"), 3 * 86_400_000);
    assert.equal(parseDurationMs("2w"), null);
    assert.equal(parseDurationMs("h"), null);
    assert.equal(parseDurationMs("-1h"), null);
    assert.equal(parseDurationMs("0h"), null);
  });
});

// ---------- harvesters ----------

function claudeLine(ts: number, id: string, inTok: number, cr: number, out: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: inTok, cache_read_input_tokens: cr, cache_creation_input_tokens: 0, output_tokens: out },
    },
  });
}

function codexTokenLine(ts: number, ordinal: number, totalIn: number, cached: number, out: number): string {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totalIn,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: out,
        },
      },
    },
  });
}

describe("harvestWindow (local stores)", () => {
  const T0 = 1_700_000_000_000;
  const T1 = T0 + 3_600_000;

  it("sums claude transcript usage in the window with dedupe", async () => {
    const home = tempDir("subtrk-home-");
    const project = "C:\\work\\my-proj";
    const dir = join(home, ".claude", "projects", "C--work-my-proj");
    mkdirSync(dir, { recursive: true });
    try {
      const dup = claudeLine(T0 + 60_000, "a", 100, 400, 50);
      writeFileSync(
        join(dir, "sess1.jsonl"),
        [
          claudeLine(T0 - 10_000, "out", 999, 999, 999), // before the window
          dup,
          claudeLine(T0 + 120_000, "b", 10, 20, 5),
          "", // tolerate a blank line
          dup, // streaming replay – deduped
        ].join("\n"),
      );
      const res = await harvestWindow({ project, t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.equal(res.attribution, "window");
      assert.deepEqual(res.usage, { in: 110, cr: 420, cw: 0, out: 55, reqs: 2 });
      assert.equal(res.models["claude-opus-5-5"], 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sums codex rollout deltas for the matching cwd only", async () => {
    const home = tempDir("subtrk-home-");
    const project = "C:\\work\\my-proj";
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string) =>
      JSON.stringify({ timestamp: new Date(T0).toISOString(), ordinal: 0, type: "session_meta", payload: { cwd } });
    try {
      writeFileSync(
        join(day, "rollout-a.jsonl"),
        [
          meta("C:\\work\\my-proj"),
          codexTokenLine(T0 + 60_000, 1, 1000, 800, 100), // delta: in 200 cr 800 out 100
          codexTokenLine(T0 + 120_000, 2, 1500, 1200, 150), // delta: in 300 cr 400 out 50
          codexTokenLine(T0 + 9_000_000, 3, 9999, 0, 0), // after the window
        ].join("\n"),
      );
      writeFileSync(
        join(day, "rollout-other.jsonl"),
        [meta("C:\\other"), codexTokenLine(T0 + 60_000, 1, 500, 0, 10)].join("\n"),
      );
      const res = await harvestWindow({ project, t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      // snapshot deltas are inclusive of cache: dIn 500 - dCached 400 -> in 100 on the second event
      assert.deepEqual(res.usage, { in: 300, cr: 1200, cw: 0, out: 150, reqs: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("harvests zcode model_usage rows, normalizing inclusive input and skipping session_title", async () => {
    const home = tempDir("subtrk-home-");
    const dbDir = join(home, ".zcode", "cli", "db");
    mkdirSync(dbDir, { recursive: true });
    process.removeAllListeners("warning"); // node:sqlite experimental warning noise in test output
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dbDir, "db.sqlite"));
    try {
      db.exec(`create table session (id text primary key, directory text, time_created integer)`);
      db.exec(
        `create table model_usage (id text primary key, session_id text, query_source text, model_id text,
          provider_id text, started_at integer, input_tokens integer, output_tokens integer,
          cache_creation_input_tokens integer, cache_read_input_tokens integer)`,
      );
      const ins = db.prepare(
        `insert into model_usage (id, session_id, query_source, model_id, provider_id, started_at,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
         values (?, ?, ?, ?, 'p', ?, ?, ?, ?, ?)`,
      );
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run(
        "sess_main",
        "C:\\Work\\My-Proj\\", // trailing slash + case must normalize away
        T0 - 86_400_000,
      );
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run(
        "sess_subagent_agent_x",
        "C:\\work\\my-proj",
        T0,
      );
      // inclusive: input 1000 contains cr 800 -> uncached 200
      ins.run("r1", "sess_main", "main_turn", "GLM-5.3", T0 + 60_000, 1000, 100, 0, 800);
      ins.run("r2", "sess_subagent_agent_x", "subagent", "GLM-5.3-Flash", T0 + 120_000, 500, 50, 20, 300);
      ins.run("r3", "sess_main", "session_title", "GLM-5.3", T0 + 130_000, 900, 0, 0, 0); // excluded
      ins.run("r4", "sess_main", "compact", "GLM-5.3", T0 + 140_000, 200, 0, 0, 0); // included
      ins.run("r5", "sess_main", "main_turn", "GLM-5.3", T0 + 9_000_000, 10, 10, 0, 0); // outside window
      const res = await harvestWindow({ project: "C:/work/my-proj", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.equal(res.attribution, "session-window");
      // inclusive inputs normalized: r1 1000-800, r2 500-300-20, r4 200-0-0
      assert.deepEqual(res.usage, { in: 580, cr: 1100, cw: 20, out: 150, reqs: 3 });
      assert.deepEqual([...res.sessions].sort(), ["sess_main", "sess_subagent_agent_x"]);
      assert.ok(res.bySource["zcode:main"] && res.bySource["zcode:subagent"] && res.bySource["zcode:compact"]);
      assert.ok(res.bySource["zcode:main"].in === 200);
      assert.ok((res.models["GLM-5.3"] ?? 0) > (res.models["GLM-5.3-Flash"] ?? 0));
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null when no store has data", async () => {
    const home = tempDir("subtrk-home-");
    try {
      const res = await harvestWindow({ project: "C:\\nowhere", t0: T0, t1: T1 }, { homeDir: home });
      assert.equal(res, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- store discipline ----------

describe("track store", () => {
  it("parks a version-mismatched file as .bak instead of discarding it", () => {
    const dir = tempDir("subtrk-track-");
    try {
      writeFileSync(trackStorePath(dir), JSON.stringify({ schemaVersion: 99, records: [{ id: "trk_old" }] }));
      const store = readTrackStore(dir);
      assert.equal(store.markers.length, 0);
      const bak = readFileSync(`${trackStorePath(dir)}.bak`, "utf8");
      assert.match(bak, /trk_old/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
