// alibaba-selfupdate.test.ts – the supervised bl runner. bl self-updates by
// printing a banner and running `npm install -g bailian-cli@latest` as a
// blocking child of the command subtrk spawned; killing that tree mid-install
// truncated the 2.4.0 install on 2026-10-20. These tests pin the contract:
//   - normal runs keep the absolute timeout kill;
//   - a detected update (banner on stderr, or bl's update-state file
//     changing) is supervised and never killed – at the cap it is abandoned;
//   - an abandoned child is left alive to finish its install;
//   - mapError surfaces self-update outcomes as their own error kind;
//   - runBl serialises spawns through the machine-wide bl lock.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { mapError, runSupervised } from "../src/providers/alibaba.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "fake-bl-selfupdate.cjs");
// Scaled-down budgets, sized for suite load: a cold fixture process can take
// hundreds of ms to start under the full suite's parallelism, so the kill
// budget must dwarf startup while installs still outlast it.
// statePath: null keeps the real ~/.bailian/update-state.json out of play –
// a live bl on this dev machine rewriting it mid-test would flip runs into
// update mode (the fallback the one dedicated test pins with its own file).
const T = { timeoutMs: 2_000, updateCapMs: 10_000, tickMs: 25, statePath: null };

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `subtrk-${prefix}-`));
  dirs.push(d);
  return d;
}

function fakeBl(scenario: string, workfile: string, statefile?: string): { literal: string; args: string[] } {
  const parts = [FIXTURE, scenario, workfile, ...(statefile ? [statefile] : [])];
  return {
    // The literal is only used on Windows (shell); quote every path.
    literal: `"${process.execPath}" ${parts.map((p) => `"${p}"`).join(" ")}`,
    args: [process.execPath, ...parts],
  };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("runSupervised", () => {
  it("returns output for a healthy run", async () => {
    const dir = tmpDir("ok");
    const { literal, args } = fakeBl("ok", join(dir, "w"));
    const run = await runSupervised(literal, args, T);
    assert.equal(run.ok, true);
    assert.match(run.stdout, /per1MonthPercentage/);
    assert.equal(run.selfUpdated, false);
    assert.equal(run.timedOut, false);
  });

  it("kills a silent hang at the timeout, like the old exec() did", async () => {
    const dir = tmpDir("hang");
    const { literal, args } = fakeBl("hang", join(dir, "w"));
    const t0 = performance.now();
    const run = await runSupervised(literal, args, T);
    assert.equal(run.ok, false);
    assert.equal(run.timedOut, true);
    assert.ok(performance.now() - t0 < 8_000, "hang must die near the 2s budget, not 30s");
  });

  it("rides out a banner-detected self-update that outlasts the kill budget", async () => {
    const dir = tmpDir("upd");
    const work = join(dir, "install.bin");
    // Install takes ~480ms; the old 250ms exec timeout killed mid-install
    // (the 2026-10-20 corruption). The supervisor must let it finish.
    const { literal, args } = fakeBl("update-ok", work);
    const run = await runSupervised(literal, args, T);
    assert.equal(run.selfUpdated, true);
    assert.equal(run.ok, true);
    assert.match(run.stdout, /per1MonthPercentage/);
    assert.equal(readFileSync(work, "utf8").length, 8_000, "install chunks must all have landed");
  });

  it("detects a banner-less update via the update-state file changing", async () => {
    const dir = tmpDir("upd-silent");
    const work = join(dir, "install.bin");
    const state = join(dir, "update-state.json");
    writeFileSync(state, JSON.stringify({ lastChecked: 1, latestVersion: "2.3.3" }));
    const { literal, args } = fakeBl("update-silent", work, state);
    const run = await runSupervised(literal, args, { ...T, statePath: state });
    assert.equal(run.selfUpdated, true, "state-file change alone must avert the kill");
    assert.equal(run.ok, true);
    assert.equal(readFileSync(work, "utf8").length, 8_000);
  });

  it("abandons an over-cap update instead of killing it, leaving the child alive", async () => {
    const dir = tmpDir("upd-cap");
    const work = join(dir, "install.bin");
    // Cap at 2.5s while the "install" finishes at ~4s and writes a marker.
    const { literal, args } = fakeBl("update-cap", work);
    const run = await runSupervised(literal, args, { ...T, updateCapMs: 2_500 });
    assert.equal(run.selfUpdated, true);
    assert.equal(run.updateAbandoned, true);
    assert.equal(run.ok, false);
    // The corruption guarantee: the abandoned child was NOT killed – it must
    // still be around to finish and write its marker.
    const marker = `${work}.done`;
    for (let i = 0; i < 200 && !existsSync(marker); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(marker), "abandoned child must survive to finish its install");
  });
});

describe("mapError self-update outcomes", () => {
  const at = "2026-10-20T08:36:54.000Z";
  const base = { stdout: "", stderr: "", toolMissing: false, timedOut: false };

  it("maps a completed-but-failed update run to kind self-update", () => {
    const res = mapError({ ...base, ok: false, selfUpdated: true, updateAbandoned: false, busy: false }, at);
    assert.equal(res?.error?.kind, "self-update");
    assert.match(res?.error?.message ?? "", /next refresh/);
  });

  it("maps an abandoned update to kind self-update with the cap in the message", () => {
    const res = mapError({ ...base, ok: false, selfUpdated: true, updateAbandoned: true, busy: false }, at);
    assert.equal(res?.error?.kind, "self-update");
    assert.match(res?.error?.message ?? "", /left it running/);
  });

  it("maps a lock timeout to an honest busy error", () => {
    const res = mapError({ ...base, ok: false, selfUpdated: false, updateAbandoned: false, busy: true }, at);
    assert.equal(res?.error?.kind, "subprocess-failed");
    assert.match(res?.error?.message ?? "", /busy/);
  });
});

describe("runBl bl-lock serialisation", () => {
  it("never overlaps two bl spawns from this process", async () => {
    // runBl routes every spawn through the machine-wide lock. Point
    // SUBTRK_DIR at a temp dir, put a fake `bl` (the serial fixture) on PATH,
    // then race two refresh() calls through the real runBl and demand strict
    // S…E S…E ordering in the shared workfile – the 2026-10-20 incident was
    // three parallel spawns each starting its own npm install.
    const dir = tmpDir("lock");
    process.env.SUBTRK_DIR = dir;
    const savedPath = process.env.PATH;
    const work = join(dir, "order.txt");
    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir);
    if (process.platform === "win32") {
      writeFileSync(join(binDir, "bl.cmd"), `@echo off\r\n"${process.execPath}" "${FIXTURE}" serial "${work}"\r\n`);
    } else {
      writeFileSync(join(binDir, "bl"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" serial "${work}"\n`, {
        mode: 0o755,
      });
    }
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${savedPath}`;
    const { default: alibaba } = await import("../src/providers/alibaba.ts");
    try {
      const results = await Promise.all([alibaba.refresh(), alibaba.refresh()]);
      assert.ok(
        results.every((r) => r.ok),
        "both serialised spawns must succeed",
      );
      assert.equal(readFileSync(work, "utf8"), "SESE", "lock must serialise the two spawns");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SUBTRK_DIR;
    }
  });
});
