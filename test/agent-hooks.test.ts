// agent-hooks.test.ts – the `init --agent --track` hook installer: JSON merge
// preserves the user's own hooks in both directions, codex TOML rides a
// sentinel block, removal touches only our handlers. Temp dirs everywhere.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HOOK_TAG, hookCapable, installAgentHooks, removeAgentHooks } from "../src/agent-hooks.ts";

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-hooks-"));
}

// Fixture writer: parents may not exist yet (a fresh harness home).
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// First group's handler commands for an event array we know exists.
function firstGroupCmds(event: unknown): string[] {
  const groups = event as { hooks: { command: string }[] }[];
  const first = groups[0] as { hooks: { command: string }[] };
  return first.hooks.map((h) => h.command);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("hookCapable: claude, zcode, codex only (D4)", () => {
  assert.ok(hookCapable("claude") && hookCapable("zcode") && hookCapable("codex"));
  assert.ok(!hookCapable("opencode") && !hookCapable("agy") && !hookCapable("nope"));
});

test("claude: install creates the two events; remove strips them again", () => {
  const base = tmpBase();
  try {
    const path = join(base, ".claude", "settings.json");
    const r1 = installAgentHooks("claude", base);
    assert.equal(r1.ok, true);
    const file = readJson(path);
    const hooks = file.hooks as Record<string, unknown[]>;
    assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "Stop"]);
    const cmds = firstGroupCmds(hooks.SessionStart);
    assert.ok(cmds.every((c) => c.includes(HOOK_TAG) && c.includes("--harness claude")));
    assert.ok(cmds.some((c) => c.includes("--event session-start")));
    const stopCmds = firstGroupCmds(hooks.Stop);
    assert.ok(stopCmds.some((c) => c.includes("--event stop")));

    const r2 = removeAgentHooks("claude", base);
    assert.equal(r2.ok, true);
    assert.equal(existsSync(path), true, "the settings file survives removal");
    assert.equal(readJson(path).hooks as Record<string, unknown> | undefined, undefined, "empty hooks key is dropped");
  } finally {
    cleanup(base);
  }
});

test("claude: the user's own hooks survive install AND removal (the clobber test)", () => {
  const base = tmpBase();
  try {
    const path = join(base, ".claude", "settings.json");
    put(
      path,
      JSON.stringify(
        {
          model: "opus",
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter.sh" }] }],
            SessionStart: [{ hooks: [{ type: "command", command: "my-own-start.sh" }] }],
          },
        },
        null,
        2,
      ),
    );
    installAgentHooks("claude", base);
    let file = readJson(path);
    assert.equal(file.model, "opus", "unrelated top-level keys survive");
    const hooks = file.hooks as Record<string, unknown[]>;
    assert.ok(Array.isArray(hooks.PreToolUse), "foreign event untouched");
    const sessionGroups = hooks.SessionStart as { hooks: { command: string }[] }[];
    assert.equal(sessionGroups.length, 2, "our group appended beside the user's");
    assert.ok(sessionGroups.some((g) => g.hooks.some((h) => h.command === "my-own-start.sh")));

    removeAgentHooks("claude", base);
    file = readJson(path);
    const after = file.hooks as Record<string, unknown[]> as unknown as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    assert.equal(after.SessionStart.length, 1);
    assert.equal(after.SessionStart[0]?.hooks[0]?.command, "my-own-start.sh");
    assert.ok(Array.isArray(after.PreToolUse), "still untouched after removal");
  } finally {
    cleanup(base);
  }
});

test("claude: idempotent install reports no change; invalid JSON is left alone", () => {
  const base = tmpBase();
  try {
    installAgentHooks("claude", base);
    const again = installAgentHooks("claude", base);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false, "second install is a no-op");

    const broken = tmpBase();
    try {
      const bp = join(broken, ".claude", "settings.json");
      put(bp, "{not json");
      const r = installAgentHooks("claude", broken);
      assert.equal(r.ok, false);
      assert.equal(readFileSync(bp, "utf8"), "{not json", "broken file untouched");
    } finally {
      cleanup(broken);
    }
  } finally {
    cleanup(base);
  }
});

test("claude: first modification of an existing file leaves a one-time backup", () => {
  const base = tmpBase();
  try {
    const path = join(base, ".claude", "settings.json");
    put(path, '{"model":"opus"}\n');
    installAgentHooks("claude", base);
    assert.ok(existsSync(`${path}.subtrk-bak`), "backup created");
    assert.equal(readFileSync(`${path}.subtrk-bak`, "utf8"), '{"model":"opus"}\n', "backup holds the pre-subtrk file");
    installAgentHooks("claude", base); // no-op, no rewrite
    removeAgentHooks("claude", base);
    assert.equal(readFileSync(`${path}.subtrk-bak`, "utf8"), '{"model":"opus"}\n', "backup not overwritten");
  } finally {
    cleanup(base);
  }
});

test("zcode: install sets hooks.enabled and the events; user config keys survive; removal keeps enabled", () => {
  const base = tmpBase();
  try {
    const path = join(base, ".zcode", "cli", "config.json");
    put(path, JSON.stringify({ provider: { zai: { apiKey: "k" } } }, null, 2));
    const r = installAgentHooks("zcode", base);
    assert.equal(r.ok, true);
    assert.ok(
      r.lines.some((l) => l.includes("hooks.enabled=true")),
      "the enabled flip is stated out loud",
    );
    const file = readJson(path);
    assert.deepEqual(file.provider, { zai: { apiKey: "k" } }, "user keys survive");
    const hooks = file.hooks as { enabled: boolean; events: Record<string, unknown[]> };
    assert.equal(hooks.enabled, true);
    assert.deepEqual(Object.keys(hooks.events).sort(), ["SessionStart", "Stop"]);
    const stopGroups = hooks.events.Stop as { hooks: Record<string, unknown>[] }[];
    const handler = (stopGroups[0] as { hooks: Record<string, unknown>[] }).hooks[0] as Record<string, unknown>;
    assert.equal(handler.timeoutMs, 10_000, "zcode timeout is timeoutMs (milliseconds)");

    removeAgentHooks("zcode", base);
    const after = readJson(path);
    const afterHooks = after.hooks as { enabled?: boolean; events?: unknown };
    assert.equal(afterHooks.events, undefined, "our events are gone");
    assert.equal(afterHooks.enabled, true, "enabled is left as found (stated in the docs)");
    assert.deepEqual(after.provider, { zai: { apiKey: "k" } });
  } finally {
    cleanup(base);
  }
});

test("codex: sentinel block appends, replaces, and removes; foreign TOML survives", () => {
  const base = tmpBase();
  try {
    const path = join(base, ".codex", "config.toml");
    put(path, 'model = "gpt-5.3"\n\n[[hooks.SessionStart]]\nmatcher = "^compact$"\n');
    const r = installAgentHooks("codex", base);
    assert.equal(r.ok, true);
    assert.ok(
      r.lines.some((l) => l.includes("/hooks")),
      "the trust-review note is printed",
    );
    let text = readFileSync(path, "utf8");
    assert.ok(text.startsWith('model = "gpt-5.3"'), "user TOML head intact");
    assert.ok(text.includes('matcher = "^compact$"'), "user hook table intact");
    assert.equal(text.split("# subtrk:hooks:begin").length - 1, 1, "exactly one block");

    installAgentHooks("codex", base); // replace, not duplicate
    text = readFileSync(path, "utf8");
    assert.equal(text.split("[[hooks.SessionStart.hooks]]").length - 1, 1, "idempotent");
    assert.ok(text.includes("command_windows"), "windows override present");

    const r2 = removeAgentHooks("codex", base);
    assert.equal(r2.ok, true);
    text = readFileSync(path, "utf8");
    assert.ok(!text.includes("subtrk"), "our block fully removed");
    assert.ok(text.includes('matcher = "^compact$"'), "user table still there");
  } finally {
    cleanup(base);
  }
});

test("codex: removal on a file that never had hooks is a no-op (no file created)", () => {
  const base = tmpBase();
  try {
    const r = removeAgentHooks("codex", base);
    assert.deepEqual([r.ok, r.changed], [true, false]);
    assert.equal(existsSync(join(base, ".codex", "config.toml")), false);
  } finally {
    cleanup(base);
  }
});
