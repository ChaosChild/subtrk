// codex extras: model-scoped windows, spend_control credits, cli-rpc fallback.
// Fixtures only; the fallback runs a canned JSON-RPC node script – no network.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_ARGS, readCodexRpcUsage, resolveCodexCommand } from "../src/providers/codex-rpc.ts";
import { parseOpenaiUsage, parseSpendControl } from "../src/providers/openai.ts";

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), "utf8"));
const FAKE = new URL("./fixtures/codex/fake-app-server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NOW = Date.parse("2026-07-06T12:00:00Z");

test("code_review + additional_rate_limits -> scoped windows, base unchanged", () => {
  const r = parseOpenaiUsage(fx("usage-extras.json"), NOW);
  assert.ok(r);
  assert.equal(r.plan, "ChatGPT pro");
  assert.equal(r.credits, undefined);
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.scope, w.usedPercent]),
    [
      ["5h", undefined, 15],
      ["7d", undefined, 48],
      ["5h", "code-review", 5],
      ["7d", "code-review", 12],
      ["5h", "GPT-Preview-Spark", 33], // malformed secondary skipped, not fatal
    ],
  );
  assert.equal(r.windows[2].resetsAt, new Date(NOW + 1800_000).toISOString());
});

test("existing paid fixture parses exactly as before", () => {
  const r = parseOpenaiUsage(
    JSON.parse(readFileSync(new URL("./fixtures/codex-usage-paid.json", import.meta.url), "utf8")),
    NOW,
  );
  assert.deepEqual(r, {
    plan: "ChatGPT plus",
    windows: [
      { kind: "5h", usedPercent: 12, resetsAt: new Date(1792950847_000).toISOString() },
      { kind: "7d", usedPercent: 34, resetsAt: new Date(1792990847_000).toISOString() },
    ],
  });
});

test("spend_control -> credits; rate_limit null accepted only with credits", () => {
  const r = parseOpenaiUsage(fx("usage-spend-control.json"), NOW);
  assert.deepEqual(r, {
    plan: "ChatGPT business",
    windows: [],
    credits: {
      total: 72000,
      remaining: 71890.62,
      unit: "credits",
      source: "api",
      cycleEndsAt: new Date(1793491200_000).toISOString(),
    },
  });
  assert.equal(parseOpenaiUsage({ plan_type: "business", rate_limit: null }, NOW), null);
  assert.equal(parseSpendControl({ reached: true, individual_limit: { limit: 10, used: 3 } })?.remaining, 0);
  assert.equal(parseSpendControl({ individual_limit: { limit: 0, used: 0 } }), undefined);
  assert.equal(parseSpendControl({ individual_limit: { used_percent: 50 } }), undefined);
});

test("resolveCodexCommand: argv array, override fail-closed", () => {
  assert.deepEqual(resolveCodexCommand({}), { file: "codex", args: [...CODEX_ARGS] });
  assert.deepEqual(CODEX_ARGS, ["-s", "read-only", "-a", "never", "app-server"]);
  assert.deepEqual(resolveCodexCommand({ SUBTRK_CODEX_BINARY: FAKE }, "/node"), {
    file: "/node",
    args: [FAKE, ...CODEX_ARGS],
  });
  for (const bad of ["", "   ", "codex", "relative/codex.exe", join(tmpdir(), "no-such-codex.exe"), tmpdir()]) {
    assert.equal(resolveCodexCommand({ SUBTRK_CODEX_BINARY: bad }), null, bad);
  }
});

test("rpc fallback: canned app-server -> usage body -> windows", async () => {
  const argvOut = join(mkdtempSync(join(tmpdir(), "subtrk-codex-")), "argv.json");
  const body = await readCodexRpcUsage({ ...process.env, SUBTRK_CODEX_BINARY: FAKE, FAKE_CODEX_ARGV_OUT: argvOut });
  assert.deepEqual(JSON.parse(readFileSync(argvOut, "utf8")), CODEX_ARGS);
  const r = parseOpenaiUsage(body, NOW);
  assert.ok(r);
  assert.equal(r.plan, "ChatGPT plus");
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.scope, w.usedPercent, w.resetsAt]),
    [
      ["5h", undefined, 21, new Date(1783374300_000).toISOString()],
      ["7d", undefined, 40, "2026-07-10T00:00:00.000Z"],
      ["5h", "GPT-Spark", 9, new Date(1783374300_000).toISOString()],
    ],
  );
});

test("rpc fallback degrades to null: signed out, rpc error, missing binary, bad override", async () => {
  const env = { ...process.env, SUBTRK_CODEX_BINARY: FAKE };
  assert.equal(await readCodexRpcUsage({ ...env, FAKE_CODEX_MODE: "signed-out" }), null);
  assert.equal(await readCodexRpcUsage({ ...env, FAKE_CODEX_MODE: "rpc-error" }), null);
  assert.equal(await readCodexRpcUsage({ ...process.env, SUBTRK_CODEX_BINARY: join(tmpdir(), "nope.exe") }), null);
  // default lane with an empty PATH: spawn ENOENT -> null, never throws
  assert.equal(await readCodexRpcUsage({ PATH: "", Path: "" }), null);
  assert.equal(parseOpenaiUsage(null), null);
});

test("probe: HTTP 500 with stored login -> rpc fallback result; 429 -> no fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "subtrk-codex-home-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fake-token", account_id: "acct_fixture" } }),
  );
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, BIN: process.env.SUBTRK_CODEX_BINARY };
  const realFetch = globalThis.fetch;
  let status = 500;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SUBTRK_CODEX_BINARY = FAKE;
  globalThis.fetch = async () => new Response("{}", { status });
  try {
    const { default: openai } = await import("../src/providers/openai.ts");
    const ok = await openai.probe();
    assert.equal(ok.ok, true);
    assert.equal(ok.plan, "ChatGPT plus");
    assert.equal(ok.windows?.[0].usedPercent, 21);
    status = 429;
    const limited = await openai.probe();
    assert.equal(limited.ok, false);
    assert.equal(limited.error?.kind, "rate-limited");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [
      ["HOME", saved.HOME],
      ["USERPROFILE", saved.USERPROFILE],
      ["SUBTRK_CODEX_BINARY", saved.BIN],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
