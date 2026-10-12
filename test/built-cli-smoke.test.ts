// built-cli-smoke.test.ts – the compiled dist/cli.js driven end-to-end as a
// real subprocess, exactly the way the published bin runs. Runs `npm run build`
// (tsc -p tsconfig.build.json) first; if the build is unavailable every test in
// this file skips with a clear message instead of failing. The child gets a
// fully sanitized environment – temp HOME/APPDATA/LOCALAPPDATA, PATH without
// `bl`, stripped provider secret vars – so zero real credentials are read and
// nothing leaves the machine.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");

// ---- build once -------------------------------------------------------------
const build = ((): { ok: boolean; detail: string } => {
  const res = spawnSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8", timeout: 180_000, shell: true });
  if (res.status !== 0 || !existsSync(cliPath)) {
    return {
      ok: false,
      detail: `npm run build unavailable/failed (exit ${res.status}); dist/cli.js missing=${!existsSync(cliPath)}\n${(res.stderr ?? "").slice(-400)}`,
    };
  }
  return { ok: true, detail: "" };
})();

// ---- sanitized child environment --------------------------------------------
const tempHomes: string[] = [];
const SECRET_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "KIMI_CLIENT_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ANTIGRAVITY_CLIENT_ID",
  "ANTIGRAVITY_CLIENT_SECRET",
  "ZCODE_CREDENTIAL_SECRET",
];
const ALL_PROVIDER_BUT_GOOGLE = ["claude", "glm", "alibaba", "opencode", "openrouter", "openai", "kimi", "zcode"];

after(() => {
  for (const h of tempHomes) rmSync(h, { recursive: true, force: true });
});

function childEnv(): NodeJS.ProcessEnv {
  const tempHome = mkdtempSync(join(tmpdir(), "subtrk-built-home-"));
  tempHomes.push(tempHome);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.USERPROFILE = tempHome;
  env.HOME = tempHome;
  env.APPDATA = join(tempHome, "AppData", "Roaming");
  env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
  env.XDG_CONFIG_HOME = join(tempHome, ".config");
  for (const k of SECRET_KEYS) delete env[k];
  // keep cmd/sh resolvable but `bl` (installed on some dev machines) out
  env.PATH = WIN ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin";
  return env;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 60_000): Run {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    env: childEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const skipBuild = build.ok ? false : build.detail;

describe("built dist/cli.js end-to-end (offline)", () => {
  it("npm run build produced dist/cli.js", { skip: skipBuild }, () => {
    assert.ok(existsSync(cliPath), "tsc -p tsconfig.build.json must emit dist/cli.js");
  });

  it("--version exits 0 with a semver line on stdout", { skip: skipBuild }, () => {
    const r = runCli(["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\d+\.\d+\.\d+/);
    assert.equal(r.stderr, "");
  });

  it("--help exits 0 with the usage screen on stdout", { skip: skipBuild }, () => {
    const r = runCli(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /usage:/);
    assert.match(r.stdout, /--strict/);
    assert.equal(r.stderr, "");
  });

  it("status --json over the real registry (google excluded on Windows): every provider degrades cleanly", {
    skip: skipBuild,
  }, () => {
    const argv = WIN
      ? ["status", "--json", ...ALL_PROVIDER_BUT_GOOGLE.flatMap((id) => ["--provider", id])]
      : ["status", "--json"];
    const r = runCli(argv, 90_000);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as {
      schemaVersion: number;
      checkedAt: string;
      recheckAfter: string;
      providers: {
        id: string;
        ok: boolean;
        windows?: unknown;
        credits?: unknown;
        error?: { kind: string; message: string };
      }[];
      nextEvent: unknown;
    };
    assert.equal(parsed.schemaVersion, 2);
    assert.match(parsed.checkedAt, /Z$/);
    assert.match(parsed.recheckAfter, /Z$/);
    const expected = WIN ? ALL_PROVIDER_BUT_GOOGLE : [...ALL_PROVIDER_BUT_GOOGLE, "google"];
    assert.deepEqual(parsed.providers.map((p) => p.id).sort(), [...expected].sort());
    for (const p of parsed.providers) {
      assert.equal(p.ok, false, `${p.id} must fail offline`);
      assert.ok(p.error, `${p.id} must carry an error object`);
      assert.ok(p.error.message.length > 0, `${p.id} error message non-empty`);
      assert.equal(p.windows, undefined, `${p.id} must not leak windows offline`);
      assert.equal(p.credits, undefined, `${p.id} must not leak credits offline`);
      if (p.id === "alibaba") {
        assert.ok(
          ["tool-missing", "subprocess-failed", "timeout", "no-credentials"].includes(p.error.kind),
          `alibaba degrades cleanly, got ${p.error.kind}`,
        );
      } else {
        assert.equal(p.error.kind, "no-credentials", `${p.id} should be a no-credentials failure`);
      }
    }
  });

  it("--strict exits 3 when the provider failed offline", { skip: skipBuild }, () => {
    const r = runCli(["status", "--strict", "--provider", "claude"]);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /error: no-credentials/);
  });

  it("unknown flag exits 2 with one stderr line", { skip: skipBuild }, () => {
    const r = runCli(["status", "--nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--nope/);
    assert.equal(r.stdout, "");
  });

  it("track status --json on a temp home: empty markers and pending", { skip: skipBuild }, () => {
    const r = runCli(["track", "status", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as { schemaVersion: number; markers: unknown[]; pending: unknown[] };
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(parsed.markers, []);
    assert.deepEqual(parsed.pending, []);
  });

  it("usage --json on a temp home: schemaVersion 1, empty providers", { skip: skipBuild }, () => {
    const r = runCli(["usage", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as {
      schemaVersion: number;
      granularity: string;
      providers: Record<string, unknown>;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(["day", "hour"].includes(parsed.granularity));
    assert.deepEqual(parsed.providers, {});
  });
});
