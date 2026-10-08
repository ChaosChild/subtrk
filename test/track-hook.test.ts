// track-hook.test.ts – the harness-side verb: stdin parsing, marker scoping,
// the D5 state-change throttle, per-harness output shapes (zcode's stdout
// schema is strict, so the emitted keys are pinned exactly), and the
// never-blocks discipline. Temp stores everywhere; no real ~/.subtrk touched.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearSecrets, registerSecret } from "../src/core.ts";
import type { TrackMarker } from "../src/track.ts";
import {
  hookOutput,
  markersInScope,
  nudgeText,
  openStateKey,
  parseHookInput,
  type TrackHookOutcome,
  trackHookCommand,
} from "../src/track-hook.ts";

function marker(over: Partial<TrackMarker> = {}): TrackMarker {
  return {
    id: "trk_test01",
    task: "a task",
    project: join(tmpdir(), "subtrk-hook-proj"),
    t0: Date.parse("2026-10-08T14:02:00Z"),
    ...over,
  };
}

test("parseHookInput: harness shapes and garbage all parse", () => {
  assert.deepEqual(parseHookInput('{"session_id":"s1","cwd":"/repo"}'), { sessionId: "s1", cwd: "/repo" });
  assert.deepEqual(parseHookInput('{"conversationId":"c1","workspacePaths":["C:/repo"]}'), {
    sessionId: "c1",
    cwd: "C:/repo",
  });
  assert.deepEqual(parseHookInput("not json at all"), {});
  assert.deepEqual(parseHookInput('{"session_id":""}'), {}, "empty session id is dropped");
});

test("markersInScope: exact dir, subdirectories, and only those", () => {
  const proj = marker().project;
  const m = marker();
  assert.ok(markersInScope([m], proj).length === 1, "exact dir matches");
  assert.ok(markersInScope([m], join(proj, "sub", "dir")).length === 1, "cwd under the marker dir matches");
  assert.ok(markersInScope([m], join(proj.replace("hook", "other"), "sub")).length === 0, "unrelated dir ignored");
  assert.ok(markersInScope([m], proj.slice(0, -2)).length === 0, "a SIBLING prefix is not an ancestor");
});

test("nudgeText: session-start nudges both states; stop nudges only open markers", () => {
  const none = nudgeText("session-start", []);
  assert.ok(none?.includes("no open track marker") && none?.includes("track start --task"));
  assert.equal(nudgeText("stop", []), null, "a turn ending markerless is normal – silence");
  const m = marker({ id: "trk_abc123", task: "fix the widget parser" });
  const open = nudgeText("stop", [m]);
  assert.ok(
    open?.includes("trk_abc123") &&
      open?.includes("fix the widget parser") &&
      open.includes("track stop --id trk_abc123"),
  );
  const two = nudgeText("session-start", [m, marker({ id: "trk_def456" })]);
  assert.ok(two?.includes("+1 more open"));
});

test("nudgeText: long task descriptions truncate; secrets scrub out", () => {
  const long = nudgeText("stop", [marker({ task: "x".repeat(80) })]);
  assert.ok((long ?? "").length < 400, "truncated");
  registerSecret("sk-super-secret-value");
  try {
    const leaked = nudgeText("stop", [marker({ task: "rotate sk-super-secret-value now" })]);
    assert.ok(leaked?.includes("***"), "registered secrets never ride the nudge");
    assert.ok(!leaked?.includes("sk-super-secret-value"));
  } finally {
    clearSecrets();
  }
});

test("hookOutput: exact key sets per dialect (zcode's stdout schema is strict)", () => {
  const ss = JSON.parse(hookOutput("claude", "session-start", "T")) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.deepEqual(Object.keys(ss), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(ss.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(ss.hookSpecificOutput.hookEventName, "SessionStart");

  const stop = JSON.parse(hookOutput("zcode", "stop", "T")) as typeof ss;
  assert.equal(stop.hookSpecificOutput.hookEventName, "Stop");
  assert.deepEqual(Object.keys(stop), ["hookSpecificOutput"], "no extra keys ever");

  const codexSs = JSON.parse(hookOutput("codex", "session-start", "T")) as typeof ss;
  assert.equal(codexSs.hookSpecificOutput.hookEventName, "SessionStart");
  const codexStop = JSON.parse(hookOutput("codex", "stop", "T")) as { systemMessage: string };
  assert.deepEqual(Object.keys(codexStop), ["systemMessage"]);
});

// ---------- the verb, against a temp store ----------

interface Fixture {
  base: string; // temp subtrk dir
  proj: string; // marker project dir
}

function setupStore(withMarkers: TrackMarker[]): Fixture {
  const base = mkdtempSync(join(tmpdir(), "subtrk-hookdir-"));
  const proj = join(base, "proj");
  writeFileSync(
    join(base, "track.json"),
    JSON.stringify({ schemaVersion: 1, markers: withMarkers.map((m) => ({ ...m, project: proj })), records: [] }),
  );
  return { base, proj };
}

function fire(fx: Fixture, args: { event: string; harness: string }, stdin: string): TrackHookOutcome {
  return trackHookCommand(args, {
    subtrkDir: fx.base,
    stdin,
    cwd: () => fx.proj,
    now: () => Date.parse("2026-10-08T15:00:00Z"),
  });
}

test("track hook: nudges once per state change (D5), silences on repeats", () => {
  const fx = setupStore([]);
  try {
    // No cwd in the stdin payload – the verb then falls back to deps.cwd(),
    // exactly like a real hook whose JSON carried only the session id.
    const stdin = '{"session_id":"s1"}';
    const first = fire(fx, { event: "session-start", harness: "claude" }, stdin);
    assert.notEqual(first.output, "", "first fire nudges");
    const parsed = JSON.parse(first.output) as { hookSpecificOutput: { additionalContext: string } };
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("no open track marker"));

    assert.equal(fire(fx, { event: "session-start", harness: "claude" }, stdin).output, "", "same state = silence");
    assert.equal(fire(fx, { event: "stop", harness: "claude" }, stdin).output, "", "still nothing open on stop");

    // A marker opens (another agent/process wrote it) – the set changed.
    writeFileSync(
      join(fx.base, "track.json"),
      JSON.stringify({
        schemaVersion: 1,
        markers: [{ ...marker({ id: "trk_nowopen" }), project: fx.proj }],
        records: [],
      }),
    );
    const opened = fire(fx, { event: "stop", harness: "claude" }, stdin);
    assert.ok(opened.output.includes("trk_nowopen"), "a newly open marker nudges on turn end");
    assert.equal(fire(fx, { event: "stop", harness: "claude" }, stdin).output, "", "and then stays quiet");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("track hook: separate sessions each get their one nudge; markers in other folders never match", () => {
  const m = marker({ id: "trk_mine" });
  const fx = setupStore([m]);
  try {
    const a = fire(fx, { event: "session-start", harness: "zcode" }, '{"session_id":"A"}');
    const b = fire(fx, { event: "session-start", harness: "zcode" }, '{"session_id":"B"}');
    assert.notEqual(a.output, "", "session A gets its nudge");
    assert.notEqual(b.output, "", "session B's state is independent");

    const other = trackHookCommand(
      { event: "session-start", harness: "zcode" },
      { subtrkDir: fx.base, stdin: '{"session_id":"C"}', cwd: () => join(fx.base, "elsewhere"), now: () => Date.now() },
    );
    assert.match(other.output, /no open track marker/, "marker scoped to its own folder");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("track hook: never blocks, never errors – garbage input and unknown names exit 0 silently", () => {
  const fx = setupStore([]);
  try {
    assert.deepEqual(fire(fx, { event: "session-start", harness: "claude" }, "%%%").code, 0);
    assert.deepEqual(fire(fx, { event: "bogus", harness: "claude" }, "{}").output, "");
    assert.deepEqual(fire(fx, { event: "session-start", harness: "agy" }, "{}").output, "");
    assert.deepEqual(fire(fx, { event: "session-start", harness: "claude" }, "{}").code, 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("track hook: state file GC keeps bounded and JSON-shaped", () => {
  const fx = setupStore([marker()]);
  try {
    fire(fx, { event: "session-start", harness: "codex" }, '{"session_id":"s"}');
    const state = JSON.parse(readFileSync(join(fx.base, "hooks-state.json"), "utf8")) as {
      schemaVersion: number;
      sessions: Record<string, { s: string; at: number }>;
    };
    assert.equal(state.schemaVersion, 1);
    assert.ok(state.sessions.s?.s.startsWith("open:"));
    assert.ok(Object.keys(state.sessions).length <= 500);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("openStateKey: sorted, comparable", () => {
  assert.equal(openStateKey([]), "none");
  const a = marker({ id: "trk_b" });
  const b = marker({ id: "trk_a" });
  assert.equal(openStateKey([a, b]), "open:trk_a,trk_b");
});
