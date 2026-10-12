// built-cli-smoke.test.ts – the compiled dist/cli.js driven end-to-end as a
// real subprocess, exactly the way the published bin runs. Runs `npm run build`
// (tsc -p tsconfig.build.json) first; if the build is unavailable every test in
// this file skips with a clear message instead of failing. The child gets a
// fully sanitized environment – temp HOME/APPDATA/LOCALAPPDATA, PATH without
// `bl`, stripped provider secret vars – so zero real credentials are read and
// nothing leaves the machine.

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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
const serveChildren: ChildProcessWithoutNullStreams[] = [];
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
  "MINIMAX_API_KEY",
  "DEEPSEEK_API_KEY",
];
const ALL_PROVIDER_BUT_GOOGLE = ["claude", "glm", "alibaba", "opencode", "openrouter", "openai", "kimi", "zcode"];

after(() => {
  for (const c of serveChildren) c.kill();
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
    const expected = WIN ? ALL_PROVIDER_BUT_GOOGLE : [...ALL_PROVIDER_BUT_GOOGLE, "google", "minimax", "deepseek"];
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

  // Regression: the published 0.1.20 tarball shipped without dist/console.html
  // (tsc doesn't copy it), so `serve` answered every request with
  // "console shell missing". The build now copies the shell; this test boots
  // the real binary so the shell can never silently vanish from the package.
  it("serve serves the console shell at / and guards the API (dist/console.html must ship)", {
    skip: skipBuild,
  }, async () => {
    assert.ok(existsSync(join(repoRoot, "dist", "console.html")), "build must copy the console shell into dist/");
    const child = spawn(process.execPath, [cliPath, "serve"], {
      env: childEnv(),
      windowsHide: true,
    });
    serveChildren.push(child);
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve printed no URL; stdout=${child.stdout ?? ""}`)), 15_000);
      child.stdout?.on("data", (chunk: string | Buffer) => {
        const m = /http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]+/.exec(String(chunk));
        if (m) {
          clearTimeout(timer);
          resolve(m[0].split("#")[0]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`serve exited early (code ${code})`));
      });
    });
    try {
      const shell = await fetch(base);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
      const body = await shell.text();
      assert.match(body, /<html/i);
      assert.match(body, /subtrk/i);
      const api = await fetch(`${base}api/status`);
      assert.equal(api.status, 401, "API without the bearer token must not leak status data");
    } finally {
      child.kill();
    }
  });

  // The class behind the 0.1.20 serve breakage: a file read relative to the
  // module (new URL("./x", import.meta.url) / join(dirname(fileURLToPath(
  // import.meta.url)), ...)) exists in src/ and even dist/, but not in the
  // tarball. Scan src/ for every such read and require its dist-relative
  // target in `npm pack`'s real file list – a new asset can't ship missing.
  it("every module-relative runtime read in src/ ships in the npm tarball", { skip: skipBuild }, () => {
    const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      shell: true,
    });
    assert.equal(pack.status, 0, pack.stderr);
    const shipped = new Set((JSON.parse(pack.stdout) as { files: { path: string }[] }[])[0].files.map((f) => f.path));
    const reads: string[] = [];
    const srcRoot = join(repoRoot, "src");
    for (const rel of readdirSync(srcRoot, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".ts")) continue;
      const text = readFileSync(join(srcRoot, rel), "utf8");
      const modDir = posix.join("dist", posix.dirname(rel.replaceAll("\\", "/")));
      for (const m of text.matchAll(/new URL\(\s*"([^"]+)",\s*import\.meta\.url\s*\)/g)) {
        reads.push(posix.normalize(posix.join(modDir, m[1])));
      }
      // Linear on purpose: the args blob is captured without nesting, then the
      // quoted strings are extracted in a second pass (a "\s*,?\s*"-loop inside
      // a + quantifier backtracks exponentially — flagged by CodeQL).
      for (const m of text.matchAll(/join\(\s*dirname\(fileURLToPath\(import\.meta\.url\)\),\s*([^)]*)\)/g)) {
        const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]);
        reads.push(posix.normalize(posix.join(modDir, ...parts)));
      }
    }
    // the scanner must keep seeing the two known reads, or it has rotted
    assert.ok(reads.includes("dist/console.html") && reads.includes("package.json"), `scanner found: ${reads}`);
    for (const r of reads) assert.ok(shipped.has(r), `${r} is read at runtime but missing from the tarball`);
  });
});
