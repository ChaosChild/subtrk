// track-hook-events.test.ts – the remaining hook contract beyond the basics:
// malformed stdin shapes of every kind, the D5 state machine across a marker's
// life (nudge -> silence -> change), anonymous sessions re-arming at the hour
// boundary, the state file's GC and corruption tolerance, and the guarantee
// that a hook never mutates the track store. Valid events "session-start"/
// "stop" only ever READ markers and emit nudges; everything exits 0.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TrackMarker } from "../src/track.ts";
import {
  HOOK_DIALECTS,
  HOOK_EVENTS,
  markersInScope,
  parseHookInput,
  type TrackHookOutcome,
  trackHookCommand,
} from "../src/track-hook.ts";

const T0 = Date.parse("2026-10-12T09:30:00Z");

function marker(over: Partial<TrackMarker> = {}): TrackMarker {
  return {
    id: "trk_hook01",
    task: "hook coverage task",
    project: join(tmpdir(), "subtrk-hookx-proj"),
    t0: T0,
    ...over,
  };
}

interface Fixture {
  base: string;
  proj: string;
  restore: () => void;
}

function setupStore(markers: TrackMarker[]): Fixture {
  const base = mkdtempSync(join(tmpdir(), "subtrk-hookx-"));
  const proj = join(base, "proj");
  writeFileSync(
    join(base, "track.json"),
    JSON.stringify({ schemaVersion: 1, markers: markers.map((m) => ({ ...m, project: proj })), records: [] }),
  );
  return {
    base,
    proj,
    restore: () => rmSync(base, { recursive: true, force: true }),
  };
}

function fire(
  fx: Fixture,
  event: string,
  harness: string,
  stdin: string,
  now = Date.parse("2026-10-12T10:00:00Z"),
): TrackHookOutcome {
  return trackHookCommand(
    { event, harness },
    {
      subtrkDir: fx.base,
      stdin,
      cwd: () => fx.proj,
      now: () => now,
    },
  );
}

test("hook event and dialect constants are the registered set", () => {
  assert.deepEqual([...HOOK_EVENTS], ["session-start", "stop"]);
  assert.deepEqual([...HOOK_DIALECTS], ["claude", "zcode", "codex"]);
});

test("parseHookInput: every malformed shape degrades to {}", () => {
  assert.deepEqual(parseHookInput("null"), {});
  assert.deepEqual(parseHookInput("[1,2,3]"), {});
  assert.deepEqual(parseHookInput("42"), {});
  assert.deepEqual(parseHookInput('"a string"'), {});
  assert.deepEqual(parseHookInput('{"session_id":42}'), {}, "non-string session ids dropped");
  assert.deepEqual(parseHookInput('{"session_id":"s","cwd":123}'), { sessionId: "s" }, "non-string cwd dropped");
  assert.deepEqual(parseHookInput('{"workspacePaths":[]}'), {});
  assert.deepEqual(parseHookInput('{"workspacePaths":[42,"C:/repo"]}'), {});
  assert.deepEqual(parseHookInput('{"workspacePaths":"not-an-array"}'), {});
  assert.deepEqual(parseHookInput('{"conversationId":"c9","workspacePaths":["C:/w"]}'), {
    sessionId: "c9",
    cwd: "C:/w",
  });
  assert.deepEqual(
    parseHookInput('{"session_id":"  "}'),
    { sessionId: "  " },
    "the parser only rejects empty ids – odd-but-nonempty strings pass through untouched",
  );
});

test("markersInScope matches case-insensitively on win32 and never a sibling prefix", () => {
  const proj = join(tmpdir(), "subtrk-hookx-scope");
  const m = marker({ project: proj });
  assert.equal(markersInScope([m], proj).length, 1, "exact dir");
  assert.equal(markersInScope([m], join(proj, "sub", "dir")).length, 1, "cwd under the marker dir");
  assert.equal(markersInScope([m], `${proj}X`).length, 0, "a sibling sharing the prefix is not an ancestor");
  assert.equal(markersInScope([m], join(tmpdir(), "elsewhere")).length, 0);
  if (process.platform === "win32") {
    const upper = marker({ project: proj.toUpperCase() });
    assert.equal(markersInScope([upper], proj.toLowerCase()).length, 1, "win32 compares case-insensitively");
  }
});

test("a marker's life: session-start nudges once, stop repeats stay silent, closing re-arms the next state", () => {
  const fx = setupStore([marker({ id: "trk_life01" })]);
  const trackPath = join(fx.base, "track.json");
  try {
    const first = fire(fx, "session-start", "claude", '{"session_id":"S"}');
    assert.equal(first.code, 0);
    const parsed = JSON.parse(first.output) as { hookSpecificOutput: { additionalContext: string } };
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("trk_life01"));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("track stop --id trk_life01"));

    assert.equal(fire(fx, "stop", "claude", '{"session_id":"S"}').output, "", "unchanged open set = silence");
    assert.equal(fire(fx, "session-start", "claude", '{"session_id":"S"}').output, "");

    // the marker closes (another process wrote the store) – the set changed
    writeFileSync(trackPath, JSON.stringify({ schemaVersion: 1, markers: [], records: [] }));
    const closed = fire(fx, "session-start", "claude", '{"session_id":"S"}');
    assert.ok(closed.output.includes("no open track marker"), "the empty set is itself a state change");

    assert.equal(
      readFileSync(trackPath, "utf8"),
      JSON.stringify({ schemaVersion: 1, markers: [], records: [] }),
      "the hook never writes the track store",
    );
  } finally {
    fx.restore();
  }
});

test("anonymous sessions key on cwd+hour: the nudge re-arms at the hour boundary", () => {
  const fx = setupStore([marker({ id: "trk_anon01" })]);
  const t1059 = Date.parse("2026-10-12T10:59:00Z");
  const t1101 = Date.parse("2026-10-12T11:01:00Z");
  try {
    const stdin = "{}"; // no session id at all
    assert.notEqual(fire(fx, "session-start", "zcode", stdin, t1059).output, "");
    assert.equal(fire(fx, "session-start", "zcode", stdin, t1059 + 30_000).output, "", "same hour = throttled");
    assert.notEqual(fire(fx, "session-start", "zcode", stdin, t1101).output, "", "a new hour is a new bounded key");
  } finally {
    fx.restore();
  }
});

test("state file GC drops week-old entries and keeps fresh ones; a corrupt file recovers silently", () => {
  const fx = setupStore([]);
  const statePath = join(fx.base, "hooks-state.json");
  const now = Date.parse("2026-10-12T10:00:00Z");
  try {
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          ancient: { s: "open:trk_old", at: now - 8 * 86_400_000 },
          fresh: { s: "none", at: now - 3_600_000 },
        },
      }),
    );
    fire(fx, "session-start", "claude", '{"session_id":"S"}', now);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      sessions: Record<string, { s: string; at: number }>;
    };
    assert.equal(state.sessions.ancient, undefined, "week-old entries GC'd on write");
    assert.notEqual(state.sessions.fresh, undefined, "fresh entries survive");
    assert.notEqual(state.sessions.S, undefined, "the fired session is recorded");

    writeFileSync(statePath, "}}}corrupt{{{");
    const after = fire(fx, "session-start", "claude", '{"session_id":"S"}', now);
    assert.equal(after.code, 0, "corrupt state never breaks the hook");
    assert.notEqual(after.output, "", "it reads as fresh, so the nudge re-fires");
  } finally {
    fx.restore();
  }
});

test("stop with an open marker nudges exactly once per session; unknown event/harness stay silent", () => {
  const fx = setupStore([marker({ id: "trk_stop01", task: "the stop task" })]);
  try {
    const codex = fire(fx, "stop", "codex", '{"session_id":"C"}');
    assert.deepEqual(
      Object.keys(JSON.parse(codex.output) as Record<string, unknown>),
      ["systemMessage"],
      "codex Stop speaks through systemMessage",
    );
    assert.ok(codex.output.includes("trk_stop01"));
    assert.equal(fire(fx, "stop", "codex", '{"session_id":"C"}').output, "");

    for (const bad of [
      ["turn-end", "claude"],
      ["session-start", "cursor"],
      ["", ""],
      ["SESSION-START", "claude"],
    ]) {
      const res = fire(fx, bad[0], bad[1], '{"session_id":"X"}');
      assert.deepEqual(res, { code: 0, output: "" }, `${bad.join("/")} is silently ignored`);
    }
  } finally {
    fx.restore();
  }
});
