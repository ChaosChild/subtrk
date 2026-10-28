// track-harvest.test.ts – window harvest over synthetic harness stores in a
// fake HOME: partial/corrupt transcript records are skipped without losing
// their valid neighbours, claude session attribution (line sessionId over file
// stem, subagent files under the parent session), codex cumulative-delta
// parsing with turn_context model attribution, and the zcode sqlite tier
// (inclusive-input normalization, source buckets, pin filter, hostile model
// keys, unreadable db). No network, no real stores: everything lives in temp
// dirs and is removed again.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { harvestWindow } from "../src/track-harvest.ts";

const T0 = 1_700_000_000_000;
const T1 = T0 + 3_600_000;
const DAY = 86_400_000;

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-harv-home-"));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function claudeLine(
  ts: number,
  id: string,
  inTok: number,
  cr: number,
  out: number,
  opts: { cw?: number; e1h?: number; sessionId?: string; model?: string } = {},
): string {
  const cw = opts.cw ?? 0;
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(ts),
    requestId: `req_${id}`,
    isApiErrorMessage: false,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    message: {
      model: opts.model ?? "claude-opus-5-5",
      id,
      usage: {
        input_tokens: inTok,
        cache_read_input_tokens: cr,
        cache_creation_input_tokens: cw,
        ...(opts.e1h
          ? { cache_creation: { ephemeral_1h_input_tokens: opts.e1h, ephemeral_5m_input_tokens: cw - opts.e1h } }
          : {}),
        output_tokens: out,
      },
    },
  });
}

function codexMeta(cwd: string, id?: string): string {
  const payload = id ? { cwd, id } : { cwd };
  return JSON.stringify({ timestamp: iso(T0), ordinal: 0, type: "session_meta", payload });
}

function codexCtx(model: string, ts: number): string {
  return JSON.stringify({ timestamp: iso(ts), type: "turn_context", payload: { model } });
}

function codexToken(ts: number, totalIn: number, cached: number, cw: number, out: number): string {
  return JSON.stringify({
    timestamp: iso(ts),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totalIn,
          cached_input_tokens: cached,
          cache_write_input_tokens: cw,
          output_tokens: out,
        },
      },
    },
  });
}

// ---------- claude transcript scan ----------

describe("harvestWindow: claude transcript robustness", () => {
  it("skips corrupt and partial lines, harvesting the valid neighbours", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-my-proj");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "s1.jsonl"),
        [
          "not json at all",
          '{"type":"assistant","timestamp":"', // torn write
          claudeLine(T0 + 60_000, "ok1", 100, 400, 50),
          "[]", // valid JSON, wrong shape
          JSON.stringify({
            type: "assistant",
            timestamp: iso(T0 + 90_000),
            isApiErrorMessage: true,
            message: { model: "claude-opus-5-5", id: "err", usage: { input_tokens: 9_999 } },
          }),
          claudeLine(T0 + 120_000, "ok2", 10, 20, 5),
          "",
        ].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\my-proj", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.equal(res.attribution, "session-scan");
      assert.deepEqual(res.usage, { in: 110, cr: 420, cw: 0, out: 55, reqs: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("window edges are inclusive; a file untouched since before the window is skipped by mtime", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-edge");
    mkdirSync(dir, { recursive: true });
    try {
      const stale = join(dir, "stale.jsonl");
      writeFileSync(stale, claudeLine(T0 + 60_000, "s", 500, 0, 500));
      utimesSync(stale, new Date(T0 - DAY), new Date(T0 - DAY)); // untouched during the window
      writeFileSync(
        join(dir, "fresh.jsonl"),
        [
          claudeLine(T0, "at-start", 1, 2, 3),
          claudeLine(T1, "at-end", 4, 5, 6),
          claudeLine(T1 + 1, "late", 100, 0, 100),
        ].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\edge", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 5, cr: 7, cw: 0, out: 9, reqs: 2 }, "t0 and t1 inclusive, t1+1 out");
      assert.deepEqual(res.sessions, ["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a subagent sidechain line attributes to the sessionId it carries, not the file stem", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-side");
    const sub = join(dir, "sessX", "subagents");
    mkdirSync(sub, { recursive: true });
    try {
      // a top-level session file keeps the project dir "usable" (fresh mtime)
      writeFileSync(join(dir, "sessX.jsonl"), claudeLine(T0 + 30_000, "par", 1, 0, 1, { sessionId: "sessX" }));
      writeFileSync(join(sub, "agent-1.jsonl"), claudeLine(T0 + 60_000, "a1", 100, 0, 10, { sessionId: "parent-1" }));
      const res = await harvestWindow({ project: "C:\\work\\side", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual([...res.sessions].sort(), ["parent-1", "sessX"], "the line's sessionId wins over the file stem");
      assert.equal(res.attribution, "session-scan");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a dir holding ONLY a session's subagents/ transcript is usable – no silent null (regression: the *.jsonl guard skipped session dirs)", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-subonly");
    const sub = join(dir, "sess1", "subagents");
    mkdirSync(sub, { recursive: true });
    try {
      // no top-level *.jsonl at all – the only in-window activity is the sidechain
      writeFileSync(join(sub, "agent-1.jsonl"), claudeLine(T0 + 60_000, "a1", 100, 0, 10));
      const res = await harvestWindow({ project: "C:\\work\\subonly", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res, "subagent-only activity must harvest, never return null");
      assert.equal(res.attribution, "session-scan");
      assert.deepEqual(res.usage, { in: 100, cr: 0, cw: 0, out: 10, reqs: 1 });
      assert.deepEqual(res.sessions, ["sess1"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a subagents/ transcript untouched during the window still keeps the dir unusable", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-substale");
    const sub = join(dir, "sess1", "subagents");
    mkdirSync(sub, { recursive: true });
    try {
      const stale = join(sub, "agent-1.jsonl");
      writeFileSync(stale, claudeLine(T0 + 60_000, "a1", 100, 0, 10));
      utimesSync(stale, new Date(T0 - DAY), new Date(T0 - DAY)); // untouched during the window
      const res = await harvestWindow({ project: "C:\\work\\substale", t0: T0, t1: T1 }, { homeDir: home });
      assert.equal(res, null, "descending into session dirs must not drop the mtime gate");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an agent-<id> pin harvests exactly that subagent file; a parent-sid pin keeps main + all subagents", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-agentpin");
    const sub = join(dir, "sessP", "subagents");
    mkdirSync(sub, { recursive: true });
    try {
      writeFileSync(join(dir, "sessP.jsonl"), claudeLine(T0 + 30_000, "m", 1, 0, 1, { sessionId: "sessP" }));
      writeFileSync(join(sub, "agent-aaa.jsonl"), claudeLine(T0 + 60_000, "a", 100, 0, 10, { sessionId: "sessP" }));
      writeFileSync(join(sub, "agent-bbb.jsonl"), claudeLine(T0 + 70_000, "b", 1_000, 0, 100, { sessionId: "sessP" }));
      const w = { project: "C:\\work\\agentpin", t0: T0, t1: T1 };

      const agent = await harvestWindow({ ...w, session: "agent-aaa" }, { homeDir: home });
      assert.ok(agent, "an agent pin must not harvest null");
      assert.equal(agent.attribution, "session-scan");
      assert.deepEqual(agent.usage, { in: 100, cr: 0, cw: 0, out: 10, reqs: 1 });
      assert.deepEqual(agent.sessions, ["agent-aaa"], "the pin, not the parent sessionId the lines carry");

      const parent = await harvestWindow({ ...w, session: "sessP" }, { homeDir: home });
      assert.ok(parent);
      assert.deepEqual(parent.usage, { in: 1_101, cr: 0, cw: 0, out: 111, reqs: 3 });
      assert.deepEqual(parent.sessions, ["sessP"]);

      const unpinned = await harvestWindow(w, { homeDir: home });
      assert.ok(unpinned);
      assert.deepEqual(unpinned.usage, parent.usage);

      assert.equal(await harvestWindow({ ...w, session: "agent-nope" }, { homeDir: home }), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the 1h cache-write split on bySource and the aggregate", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-split");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "s1.jsonl"), claudeLine(T0 + 60_000, "c1", 100, 50, 20, { cw: 300, e1h: 120 }));
      const res = await harvestWindow({ project: "C:\\work\\split", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 100, cr: 50, cw: 300, cw1h: 120, out: 20, reqs: 1 });
      assert.equal(res.bySource.claude?.cw1h, 120);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- codex rollout scan ----------

describe("harvestWindow: codex rollout robustness", () => {
  it("sums cumulative deltas, attributes via turn_context (default 'codex' before it), skips zero-delta replays and garbage lines", async () => {
    const home = tempHome();
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    try {
      writeFileSync(
        join(day, "rollout.jsonl"),
        [
          codexMeta("C:\\work\\my-proj"),
          codexToken(T0 + 60_000, 1_000, 800, 0, 100), // delta: in 200 cr 800 out 100 – model 'codex'
          "garbage { not json",
          codexCtx("gpt-5.2", T0 + 70_000),
          codexToken(T0 + 80_000, 1_500, 1_200, 100, 150), // deltas: in 500-400=100, cr 400, cw 100, out 50
          codexToken(T0 + 90_000, 1_500, 1_200, 100, 150), // identical snapshot – zero delta, no req
          codexCtx("gpt-5.3-flash", T0 + 100_000),
          codexToken(T0 + 110_000, 1_700, 1_200, 100, 250), // attributed to the new model
        ].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\my-proj", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.equal(res.attribution, "window");
      assert.deepEqual(res.usage, { in: 500, cr: 1_200, cw: 100, out: 250, reqs: 3 });
      assert.deepEqual(res.sessions, [], "transcript scans carry no session ids on the codex tier");
      // model attribution: codex 200+800+0+100; gpt-5.2 100+400+100+50; gpt-5.3-flash 200+0+0+100
      assert.ok(Math.abs(res.models.codex - 1_100 / 2_050) < 1e-9);
      assert.ok(Math.abs(res.models["gpt-5.2"] - 650 / 2_050) < 1e-9);
      assert.ok(Math.abs(res.models["gpt-5.3-flash"] - 300 / 2_050) < 1e-9);
      assert.ok(Math.abs(Object.values(res.models).reduce((a, b) => a + b, 0) - 1) < 1e-9, "shares sum to one");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a rollout for another cwd contributes nothing; window edges inclusive", async () => {
    const home = tempHome();
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    try {
      writeFileSync(
        join(day, "mine.jsonl"),
        [
          codexMeta("C:\\work\\mine"),
          codexToken(T0, 100, 0, 0, 10), // exactly at t0
          codexToken(T1, 200, 0, 0, 20), // exactly at t1
          codexToken(T1 + 1, 300, 0, 0, 30), // out
        ].join("\n"),
      );
      writeFileSync(
        join(day, "theirs.jsonl"),
        [codexMeta("C:\\other"), codexToken(T0 + 60_000, 5_000, 0, 0, 5)].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\mine", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 200, cr: 0, cw: 0, out: 20, reqs: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("harvestWindow: codex session pin", () => {
  it("a pin keeps only the rollout whose session_meta id matches and records it; unpinned sums all", async () => {
    const home = tempHome();
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    try {
      writeFileSync(
        join(day, "parent.jsonl"),
        [codexMeta("C:\\work\\cx", "thr-parent"), codexToken(T0 + 60_000, 100, 0, 0, 10)].join("\n"),
      );
      writeFileSync(
        join(day, "child.jsonl"),
        [codexMeta("C:\\work\\cx", "thr-child"), codexToken(T0 + 70_000, 1_000, 0, 0, 100)].join("\n"),
      );
      const w = { project: "C:\\work\\cx", t0: T0, t1: T1 };

      const pinned = await harvestWindow({ ...w, session: "thr-child" }, { homeDir: home });
      assert.ok(pinned);
      assert.equal(pinned.attribution, "window");
      assert.deepEqual(pinned.usage, { in: 1_000, cr: 0, cw: 0, out: 100, reqs: 1 });
      assert.deepEqual(pinned.sessions, ["thr-child"]);

      const unpinned = await harvestWindow(w, { homeDir: home });
      assert.ok(unpinned);
      assert.deepEqual(unpinned.usage, { in: 1_100, cr: 0, cw: 0, out: 110, reqs: 2 });
      assert.deepEqual(unpinned.sessions, []);

      assert.equal(await harvestWindow({ ...w, session: "thr-nope" }, { homeDir: home }), null);

      // PR D (release blocker B1): an excluded child pin leaves the child's
      // rollout out of the parent's window - codex children count once.
      const parentOnly = await harvestWindow({ ...w, excludeSessions: ["thr-child"] }, { homeDir: home });
      assert.ok(parentOnly);
      assert.deepEqual(parentOnly.usage, { in: 100, cr: 0, cw: 0, out: 10, reqs: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- zcode sqlite window ----------

interface ZcodeDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...v: unknown[]) => void };
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => ZcodeDb;
}

async function makeDb(home: string): Promise<ZcodeDb> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as SqliteModule;
  const dbDir = join(home, ".zcode", "cli", "db");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, "db.sqlite"));
  db.exec(`create table session (id text primary key, directory text, time_created integer)`);
  db.exec(
    `create table model_usage (id text primary key, session_id text, query_source text, model_id text,
      provider_id text, started_at integer, input_tokens integer, output_tokens integer,
      cache_creation_input_tokens integer, cache_read_input_tokens integer)`,
  );
  return db;
}

function insert(
  db: ZcodeDb,
  id: string,
  row: {
    sid: string;
    src: string;
    model: string;
    at: number;
    inTok: number | null;
    out: number | null;
    cw?: number | null;
    cr?: number | null;
  },
): void {
  db.prepare(
    `insert into model_usage (id, session_id, query_source, model_id, provider_id, started_at,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     values (?, ?, ?, ?, 'zai', ?, ?, ?, ?, ?)`,
  ).run(id, row.sid, row.src, row.model, row.at, row.inTok, row.out, row.cw ?? 0, row.cr ?? 0);
}

describe("harvestWindow: zcode sqlite tier", () => {
  it("normalizes inclusive input, buckets by source, keeps sessions, and filters the window + pin", async () => {
    const home = tempHome();
    const db = await makeDb(home);
    try {
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run(
        "sess_a",
        "c:\\work\\pin",
        T0,
      );
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run(
        "sess_b",
        "C:\\Work\\Pin",
        T0,
      );
      insert(db, "r1", {
        sid: "sess_a",
        src: "main_turn",
        model: "glm-5.3",
        at: T0 + 1,
        inTok: 1_000,
        out: 50,
        cw: 100,
        cr: 800,
      });
      insert(db, "r2", { sid: "sess_b", src: "subagent", model: "glm-5.3-flash", at: T0 + 2, inTok: 100, out: 10 });
      insert(db, "r3", { sid: "sess_a", src: "session_title", model: "glm-5.3", at: T0 + 3, inTok: 9_999, out: 9_999 });
      insert(db, "r4", { sid: "sess_a", src: "main_turn", model: "glm-5.3", at: T0 - 1, inTok: 9_999, out: 0 });
      insert(db, "r5", { sid: "sess_a", src: "main_turn", model: "glm-5.3", at: T1 + 1, inTok: 9_999, out: 0 });
      insert(db, "r6", { sid: "sess_a", src: "tool_call", model: "other-model", at: T0 + 6, inTok: null, out: 5 });
      insert(db, "r7", {
        sid: "sess_a",
        src: "compact",
        model: "glm-5.3",
        at: T0 + 7,
        inTok: 50,
        out: 0,
        cw: 100,
        cr: 800,
      });
      insert(db, "r8", {
        sid: "sess_a",
        src: "main_turn",
        model: "glm-5.3",
        at: T0 + 8,
        inTok: 0,
        out: 0,
        cw: 0,
        cr: 0,
      });

      const res = await harvestWindow({ project: "C:\\Work\\PIN", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.equal(res.attribution, "session-window");
      // r1: uncached 1000-100-800=100; r2: 100; r6: NULLs read 0, out 5 (zcode:other);
      // r7: clamp max(0, 50-100-800)=0, its cr/cw still count; r8: all-zero skipped
      assert.deepEqual(res.usage, { in: 200, cr: 1_600, cw: 200, out: 65, reqs: 4 });
      assert.deepEqual([...res.sessions].sort(), ["sess_a", "sess_b"]);
      assert.ok(res.bySource["zcode:main"], "main bucket present");
      assert.equal(res.bySource["zcode:subagent"]?.reqs, 1);
      assert.equal(res.bySource["zcode:other"]?.out, 5, "unknown query_source lands in zcode:other");
      assert.equal(res.bySource["zcode:compact"]?.cr, 800);
      assert.ok(Math.abs(res.models["glm-5.3"] - 1_950 / 2_065) < 1e-9, "token shares over the summed total");

      // pinned session restricts the tier to exactly that session's rows
      const pinned = await harvestWindow(
        { project: "C:\\Work\\PIN", t0: T0, t1: T1, session: "sess_b" },
        { homeDir: home },
      );
      assert.ok(pinned);
      assert.deepEqual(pinned.usage, { in: 100, cr: 0, cw: 0, out: 10, reqs: 1 });
      assert.deepEqual(pinned.sessions, ["sess_b"]);
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a hostile model id cannot become a store key; NULL tokens read as zero", async () => {
    const home = tempHome();
    const db = await makeDb(home);
    try {
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run("s", "C:\\x", T0);
      insert(db, "r1", { sid: "s", src: "main_turn", model: "__proto__", at: T0 + 1, inTok: 10, out: 5 });
      const res = await harvestWindow({ project: "C:\\x", t0: T0, t1: T1 }, { homeDir: home });
      assert.ok(res);
      assert.ok((res.models["?"] ?? 0) > 0, "the row is kept under the '?' model");
      assert.equal(Object.hasOwn(res.models, "__proto__"), false, "no own hostile key – never a store key");
      const probe: Record<string, number> = {};
      assert.equal((probe as { pollution?: number }).pollution, undefined, "Object.prototype unpolluted");
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an unreadable db (or none) yields null rather than an error", async () => {
    const home = tempHome();
    const dbDir = join(home, ".zcode", "cli", "db");
    mkdirSync(dbDir, { recursive: true });
    try {
      writeFileSync(join(dbDir, "db.sqlite"), "this is not a sqlite database");
      const res = await harvestWindow({ project: "C:\\x", t0: T0, t1: T1 }, { homeDir: home });
      assert.equal(res, null, "a broken store degrades to 'no data', never a throw");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("harvestWindow: pause gaps", () => {
  // A closed pause gap [from, to): burn stamped inside it belongs to whoever
  // worked while the task was paused. Gap below spans T0+10m..T0+40m.
  const PAUSE = { from: T0 + 600_000, to: T0 + 2_400_000 };
  const window = { t0: T0, t1: T1, pauses: [PAUSE] };

  it("zcode: rows stamped inside the gap are skipped, active rows count", async () => {
    const home = tempHome();
    const db = await makeDb(home);
    try {
      db.prepare(`insert into session (id, directory, time_created) values (?, ?, ?)`).run(
        "sess_p",
        "c:\\work\\pause",
        T0,
      );
      insert(db, "keep", { sid: "sess_p", src: "main_turn", model: "glm-5.3", at: T0 + 60_000, inTok: 100, out: 10 });
      insert(db, "drop", {
        sid: "sess_p",
        src: "main_turn",
        model: "glm-5.3",
        at: PAUSE.from + 1,
        inTok: 9_999,
        out: 9_999,
      });
      insert(db, "edge", {
        sid: "sess_p",
        src: "main_turn",
        model: "glm-5.3",
        at: PAUSE.to, // half-open gap: resuming at `to` is the task's again
        inTok: 50,
        out: 5,
      });
      const res = await harvestWindow({ project: "C:\\work\\pause", ...window }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 150, cr: 0, cw: 0, out: 15, reqs: 2 });
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("claude: messages stamped inside the gap are skipped", async () => {
    const home = tempHome();
    const dir = join(home, ".claude", "projects", "C--work-pause");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "s1.jsonl"),
        [
          claudeLine(T0 + 60_000, "active", 100, 0, 10),
          claudeLine(PAUSE.from + 1, "paused", 9_999, 0, 9_999),
          claudeLine(PAUSE.to, "resumed", 50, 0, 5),
        ].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\pause", ...window }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 150, cr: 0, cw: 0, out: 15, reqs: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("codex: the snapshot delta inside the gap is skipped, later deltas still compute", async () => {
    const home = tempHome();
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    try {
      writeFileSync(
        join(day, "rollout.jsonl"),
        [
          codexMeta("C:\\work\\pause"),
          codexToken(T0 + 60_000, 100, 0, 0, 10), // delta 100/10 – active
          codexToken(PAUSE.from + 300_000, 150, 0, 0, 15), // delta 50/5 inside the gap – skipped
          codexToken(PAUSE.to + 60_000, 200, 0, 0, 20), // delta 50/5 since the paused snapshot – active
        ].join("\n"),
      );
      const res = await harvestWindow({ project: "C:\\work\\pause", ...window }, { homeDir: home });
      assert.ok(res);
      assert.deepEqual(res.usage, { in: 150, cr: 0, cw: 0, out: 15, reqs: 2 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
