// Regression: askHidden must leave stdin usable by later prompts. A for-await
// loop over stdin destroys the stream on break, so the question right after
// a hidden prompt resolved immediately and init exited.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  askHidden,
  askProviderSelection,
  blHasPlanKey,
  parseProviderSelection,
  saveProviderSelection,
} from "../src/init.ts";

function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

test("askHidden leaves stdin usable for the next prompt", async () => {
  const stdin = fakeTty();
  const hidden = askHidden("key: ", stdin);
  stdin.write("sk-sp-test\r");
  assert.equal(await hidden, "sk-sp-test");

  const rl = createInterface({ input: stdin as never, output: new PassThrough() });
  const q = rl.question("site? ");
  stdin.write("1\n");
  assert.equal((await q).trim(), "1");
  rl.close();
});

test("askHidden handles backspace and ctrl-d", async () => {
  const stdin = fakeTty();
  const hidden = askHidden("key: ", stdin);
  stdin.write("abc\u007f\r");
  assert.equal(await hidden, "ab");
  const again = askHidden("key2: ", stdin);
  stdin.write("xy\u0004");
  assert.equal(await again, "xy");
});

// init skips the alibaba api-key prompt when bl's own config already stores the
// plan key – blHasPlanKey is that skip condition.
test("blHasPlanKey: prepared bl config with token-plan.api_key means the prompt is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-init-"));
  try {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ "token-plan": { api_key: "sk-sp-stored" } }));
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(blHasPlanKey(parsed), true, "stored key -> prompt skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(blHasPlanKey({ "token-plan": { api_key: "" } }), false, "empty key still prompts");
  assert.equal(blHasPlanKey({ "token-plan": {} }), false);
  assert.equal(blHasPlanKey({}), false);
  assert.equal(blHasPlanKey(null), false);
  assert.equal(blHasPlanKey({ "token-plan": { api_key: 123 } }), false);
});

// init's first step asks which providers to track. Full runInit cannot run
// in-process (it reads real HOME state and prompts), so the pure parse/save
// seam carries the assertions; the prompt itself must skip like every other
// hidden prompt when stdin is not a TTY.
function captureConsoleLog(logs: string[]): () => void {
  const orig = console.log;
  console.log = (line?: unknown) => {
    logs.push(String(line));
  };
  return () => {
    console.log = orig;
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
}

test("parseProviderSelection: numbers, ids, keep-current, canonical order, invalid", () => {
  assert.deepEqual(parseProviderSelection("1 3 5", []), ["claude", "alibaba", "opencode"]);
  assert.deepEqual(parseProviderSelection("claude, google", []), ["claude", "google"]);
  assert.deepEqual(parseProviderSelection("2, openrouter", []), ["glm", "openrouter"]);
  assert.deepEqual(parseProviderSelection("5 3 1", []), ["claude", "alibaba", "opencode"], "canonical order");
  assert.deepEqual(parseProviderSelection("1 1 3", []), ["claude", "alibaba"], "duplicates collapse");
  assert.deepEqual(parseProviderSelection("", ["glm"]), ["glm"], "empty keeps the current selection");
  assert.deepEqual(parseProviderSelection("   ", ["claude", "glm"]), ["claude", "glm"]);
  assert.equal(parseProviderSelection("0", []), null, "0 is not a provider number");
  assert.deepEqual(parseProviderSelection("7", []), ["openai"], "openai is the seventh listing entry");
  assert.deepEqual(parseProviderSelection("8", []), ["kimi"], "kimi is the eighth listing entry");
  assert.deepEqual(parseProviderSelection("9", []), ["zcode"], "zcode is the ninth listing entry");
  assert.equal(parseProviderSelection("10", []), null, "past the end of the listing");
  assert.equal(parseProviderSelection("-1", []), null);
  assert.equal(parseProviderSelection("claude bogus", []), null, "invalid token -> re-prompt signal");
});

test("saveProviderSelection writes { enabled: [...] } with a trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-init-"));
  try {
    assert.equal(saveProviderSelection(dir, ["claude", "google", "openrouter"]), true);
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    assert.ok(raw.endsWith("\n"), "newline-terminated");
    assert.deepEqual(JSON.parse(raw), { enabled: ["claude", "google", "openrouter"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askProviderSelection: valid answer returns ids, invalid re-prompts with the same listing", async () => {
  const stdin = fakeTty();
  const logs: string[] = [];
  const restore = captureConsoleLog(logs);
  let picked: readonly string[] | null = null;
  try {
    const pending = askProviderSelection(["claude", "glm", "alibaba"], stdin);
    stdin.write("10\r"); // past the end of the nine-entry listing
    await until(() => logs.some((line) => line.includes("invalid entry")));
    stdin.write("1 3\r");
    picked = await pending;
  } finally {
    restore();
  }
  assert.deepEqual(picked, ["claude", "alibaba"]);
  const listings = logs.filter((line) => line === "Which providers does subtrk track?");
  assert.equal(listings.length, 2, `listing shown once per attempt, got: ${logs.join(" | ")}`);
});

test("askProviderSelection on non-TTY stdin keeps the selection and prints the skip note", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean };
  stdin.isTTY = false;
  const logs: string[] = [];
  const restore = captureConsoleLog(logs);
  let picked: readonly string[] | null = null;
  try {
    picked = await askProviderSelection(["claude", "glm"], stdin);
  } finally {
    restore();
  }
  assert.deepEqual(picked, ["claude", "glm"], "skip keeps the current selection");
  assert.ok(
    logs.some((line) => line.includes("stdin is not a TTY")),
    `skip note printed, got: ${logs.join(" | ")}`,
  );
});
