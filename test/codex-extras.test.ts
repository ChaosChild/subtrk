// codex extras: model-scoped windows, spend_control credits, cli-rpc fallback.
// Fixtures only; the fallback runs a canned JSON-RPC node script – no network.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // The default lane resolves the binary from the PATH entries only; an empty
  // PATH means unavailable (it used to return a bare "codex", which lets the
  // CWD intercept the spawn on Windows).
  assert.equal(resolveCodexCommand({}), null);
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

// ---- fixes (final-verification review): fallback gating, budget, PATH-only binary

// A stored login is needed for the probe to get as far as the usage read.
function withCodexHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "subtrk-codex-home-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fake-token", account_id: "acct_fixture" } }),
  );
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, BIN: process.env.SUBTRK_CODEX_BINARY };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SUBTRK_CODEX_BINARY = FAKE;
  return {
    home,
    restore: () => {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
      if (saved.BIN === undefined) delete process.env.SUBTRK_CODEX_BINARY;
      else process.env.SUBTRK_CODEX_BINARY = saved.BIN;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("probe: offline-style network failure (no HTTP status) spawns NO fallback", async (t) => {
  const ctx = withCodexHome();
  t.after(ctx.restore);
  const argvOut = join(mkdtempSync(join(tmpdir(), "subtrk-codex-off-")), "argv.json");
  // The fixture records its argv on startup – the file's absence proves no spawn.
  process.env.FAKE_CODEX_ARGV_OUT = argvOut;
  t.after(() => delete process.env.FAKE_CODEX_ARGV_OUT);
  const realFetch = globalThis.fetch;
  // DNS-style failure: fetchText maps it to http-error WITHOUT a status –
  // definitive-HTTP-only gating means the app-server must not even spawn.
  globalThis.fetch = async () => {
    throw new Error("getaddrinfo EAI_AGAIN chatgpt.com");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { default: openai } = await import("../src/providers/openai.ts");
  const r = await openai.probe();
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, "http-error");
  assert.equal(r.error?.status, undefined, "a network-level failure carries no HTTP status");
  assert.ok(!existsSync(argvOut), "the codex app-server must not spawn when merely offline");
});

test("probe: an unusable body (parse-failure) is still definitive and fires the fallback", async (t) => {
  const ctx = withCodexHome();
  t.after(ctx.restore);
  const argvOut = join(mkdtempSync(join(tmpdir(), "subtrk-codex-def-")), "argv.json");
  process.env.FAKE_CODEX_ARGV_OUT = argvOut;
  t.after(() => delete process.env.FAKE_CODEX_ARGV_OUT);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not json at all", { status: 200 });
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { default: openai } = await import("../src/providers/openai.ts");
  const parsed = await openai.probe();
  assert.equal(parsed.ok, true, "the fallback rescues an unusable body");
  assert.equal(parsed.plan, "ChatGPT plus");
  assert.ok(existsSync(argvOut), "the fallback spawned for the definitive parse failure");
});

test("resolveCodexCommand: default binary resolves from PATH directories only, never the CWD", () => {
  const base = mkdtempSync(join(tmpdir(), "subtrk-codex-path-"));
  const savedCwd = process.cwd();
  process.chdir(base); // the planted-CWD case AND a colon-free relative dir for the posix split
  try {
    const empty = join(base, "path-without-codex");
    const planted = join(base, "planted-cwd");
    mkdirSync(empty);
    mkdirSync(planted);
    // What a hostile CWD would hold: a planted codex.exe next to a .cmd shim.
    writeFileSync(join(planted, "codex.exe"), "not an executable");
    writeFileSync(join(planted, "codex.cmd"), "@echo planted");
    // A bare "codex" would let libuv find the planted binary (it searches the
    // CWD before PATH on Windows); resolution must scan PATH only.
    assert.equal(resolveCodexCommand({ PATH: empty, Path: empty }, "/node", "win32"), null);
    assert.equal(resolveCodexCommand({ PATH: empty, Path: empty }, "/node", "linux"), null);
    // A PATH directory holding codex.exe IS found, as an absolute file.
    assert.deepEqual(resolveCodexCommand({ PATH: planted, Path: planted }, "/node", "win32"), {
      file: join(planted, "codex.exe"),
      args: [...CODEX_ARGS],
    });
    // Only a .cmd shim on PATH: skipped outright (no-shell rule) -> unavailable.
    const shimOnly = join(base, "shim-only");
    mkdirSync(shimOnly);
    writeFileSync(join(shimOnly, "codex.cmd"), "@echo shim");
    assert.equal(resolveCodexCommand({ PATH: shimOnly, Path: shimOnly }, "/node", "win32"), null);
    // POSIX discipline: the extensionless `codex` file is the candidate.
    const relDir = "codex-posix";
    mkdirSync(relDir);
    writeFileSync(join(relDir, "codex"), "#!/bin/sh\necho hi\n");
    assert.deepEqual(resolveCodexCommand({ PATH: relDir }, "/node", "linux"), {
      file: join(relDir, "codex"),
      args: [...CODEX_ARGS],
    });
  } finally {
    process.chdir(savedCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("readCodexRpcUsage: the default lane with no codex on PATH degrades to null", async () => {
  const base = mkdtempSync(join(tmpdir(), "subtrk-codex-nopath-"));
  try {
    const empty = join(base, "empty");
    mkdirSync(empty);
    assert.equal(await readCodexRpcUsage({ PATH: empty, Path: empty }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readCodexRpcUsage: the deadline cuts off a hanging app-server instead of stacking 8s calls", async () => {
  const env = { ...process.env, SUBTRK_CODEX_BINARY: FAKE, FAKE_CODEX_MODE: "hang" };
  const start = Date.now();
  const r = await readCodexRpcUsage(env, { deadlineMs: start + 1_500 });
  const elapsed = Date.now() - start;
  assert.equal(r, null, "a hang past the deadline degrades to null");
  assert.ok(elapsed < 5_000, `the deadline, not the per-call 8s default, cut the hang (took ${elapsed}ms)`);
  // An already-expired deadline: immediate null, nothing spawned at all.
  const argvOut = join(mkdtempSync(join(tmpdir(), "subtrk-codex-dl-")), "argv.json");
  const t0 = Date.now();
  const expired = await readCodexRpcUsage({ ...env, FAKE_CODEX_ARGV_OUT: argvOut }, { deadlineMs: t0 - 1 });
  assert.equal(expired, null);
  assert.ok(Date.now() - t0 < 1_000, "an expired deadline returns without waiting");
  assert.ok(!existsSync(argvOut), "an expired deadline spawns nothing");
  rmSync(join(argvOut, ".."), { recursive: true, force: true });
});
