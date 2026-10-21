// alibaba-selfupdate.test.ts – the supervised bl runner. bl self-updates by
// printing a banner and running `npm install -g bailian-cli@latest` as a
// blocking child of the command subtrk spawned; killing that tree mid-install
// truncated the 2.4.0 install on 2026-10-20. These tests pin the contract:
//   - normal runs keep the absolute timeout kill;
//   - a banner-detected update is supervised and never killed – at the cap it
//     is abandoned alive, and the bl lock + serve drain hold until its exit;
//   - mapError surfaces self-update outcomes as their own error kind;
//   - runBl serialises spawns through the machine-wide bl lock;
//   - core's runProbe honours the provider's own probe budget (the v2 review's
//     blocker: a serialized probe must not die on the default 10s).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type ProviderModule, runProbe } from "../src/core.ts";
import { mapError, pendingSelfUpdates, runBl, runSupervised } from "../src/providers/alibaba.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "fake-bl-selfupdate.cjs");
// Scaled-down budgets, sized for suite load: a cold fixture process can take
// hundreds of ms to start under the full suite's parallelism, so the kill
// budget must dwarf startup while installs still outlast it.
const T = { timeoutMs: 2_000, updateCapMs: 10_000, tickMs: 25 };

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `subtrk-${prefix}-`));
  dirs.push(d);
  return d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeBl(scenario: string, workfile: string): string[] {
  return [process.execPath, FIXTURE, scenario, workfile];
}

/** A fake `bl` on PATH running the given fixture scenario (win + posix). */
function installFakeBl(binDir: string, scenario: string, workfile: string): void {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(binDir, "bl.cmd"),
      `@echo off\r\n"${process.execPath}" "${FIXTURE}" ${scenario} "${workfile}"\r\n`,
    );
  } else {
    writeFileSync(
      join(binDir, "bl"),
      `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" ${scenario} "${workfile}"\n`,
      {
        mode: 0o755,
      },
    );
  }
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("runSupervised", () => {
  it("returns output for a healthy run", async () => {
    const run = await runSupervised(fakeBl("ok", join(tmpDir("ok"), "w")), T);
    assert.equal(run.ok, true);
    assert.match(run.stdout, /per1MonthPercentage/);
    assert.equal(run.selfUpdated, false);
    assert.equal(run.timedOut, false);
  });

  it("kills a silent hang at the timeout, like the old exec() did", async () => {
    const t0 = performance.now();
    const run = await runSupervised(fakeBl("hang", join(tmpDir("hang"), "w")), T);
    assert.equal(run.ok, false);
    assert.equal(run.timedOut, true);
    assert.ok(performance.now() - t0 < 8_000, "hang must die near the 2s budget, not 30s");
  });

  it("rides out a banner-detected self-update that outlasts the kill budget", async () => {
    const work = join(tmpDir("upd"), "install.bin");
    // Install takes ~2.4s; the old 2s exec timeout killed mid-install
    // (the 2026-10-20 corruption). The supervisor must let it finish.
    const run = await runSupervised(fakeBl("update-ok", work), T);
    assert.equal(run.selfUpdated, true);
    assert.equal(run.ok, true);
    assert.match(run.stdout, /per1MonthPercentage/);
    assert.equal(readFileSync(work, "utf8").length, 8_000, "install chunks must all have landed");
  });

  it("abandons an over-cap update instead of killing it, leaving the child alive", async () => {
    const work = join(tmpDir("upd-cap"), "install.bin");
    // Cap at 2.5s while the "install" finishes at ~4s and writes a marker.
    const run = await runSupervised(fakeBl("update-cap", work), { ...T, updateCapMs: 2_500 });
    assert.equal(run.selfUpdated, true);
    assert.equal(run.updateAbandoned, true);
    assert.equal(run.ok, false);
    // The corruption guarantee, part 1: the abandoned child was NOT killed –
    // it must still be around to finish and write its marker.
    const marker = `${work}.done`;
    for (let i = 0; i < 200 && !existsSync(marker); i++) {
      await sleep(50);
    }
    assert.ok(existsSync(marker), "abandoned child must survive to finish its install");
    // Part 2: the run's `exited` lane (the bl lock and serve's shutdown drain
    // hold on it) resolves at the child's real exit, not at the cap.
    await run.exited;
  });

  it("keeps a supervised update in pendingSelfUpdates until the child exits", async () => {
    const work = join(tmpDir("drain"), "install.bin");
    const run = await runSupervised(fakeBl("update-cap", work), { ...T, updateCapMs: 2_500 });
    assert.equal(run.updateAbandoned, true);
    // Right after the abandon the child is still installing: the drain set
    // must hold its exit lane (serve waits on these before exiting).
    const pending = pendingSelfUpdates();
    assert.ok(pending.length >= 1, "abandoned run must still be pending");
    await Promise.all(pending);
    await run.exited;
  });
});

describe("mapError self-update outcomes", () => {
  const at = "2026-10-20T08:36:54.000Z";
  const base = {
    stdout: "",
    stderr: "",
    toolMissing: false,
    timedOut: false,
    exitCode: null,
    exited: Promise.resolve(),
  };

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

  it("classifies update outcomes before sniffing npm noise on stderr", () => {
    // npm install output that trips the old tool-missing sniff must not
    // misclassify a self-update run (review nit #9).
    const res = mapError(
      {
        ...base,
        ok: false,
        selfUpdated: true,
        updateAbandoned: false,
        busy: false,
        stderr: "npm WARN ... 'bl-gyp' is not recognized as an internal command",
      },
      at,
    );
    assert.equal(res?.error?.kind, "self-update");
  });
});

describe("runBl bl-lock discipline", () => {
  it("never overlaps two bl spawns from this process", async () => {
    const dir = tmpDir("lock");
    process.env.SUBTRK_DIR = dir;
    const savedPath = process.env.PATH;
    const work = join(dir, "order.txt");
    installFakeBl(join(dir, "bin"), "serial", work);
    process.env.PATH = `${join(dir, "bin")}${process.platform === "win32" ? ";" : ":"}${savedPath}`;
    const { default: alibaba } = await import("../src/providers/alibaba.ts");
    const refresh = alibaba.refresh;
    assert.ok(refresh, "provider must expose refresh");
    try {
      const results = await Promise.all([refresh(), refresh()]);
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

  it("holds the bl lock until an abandoned update's child has exited", async () => {
    const dir = tmpDir("lock-abandon");
    process.env.SUBTRK_DIR = dir;
    const savedPath = process.env.PATH;
    const work = join(dir, "install.bin");
    installFakeBl(join(dir, "bin"), "update-cap", work);
    process.env.PATH = `${join(dir, "bin")}${process.platform === "win32" ? ";" : ":"}${savedPath}`;
    try {
      // Cap at 2.5s; the fake install finishes at ~4s. The run answers at the
      // cap (stale marker) but the lock must persist until the child exits,
      // so no peer can spawn bl mid-install (review finding #3).
      const run = await runBl(["bl", "anything"], 10_000, { updateCapMs: 2_500, tickMs: 25 });
      assert.equal(run.updateAbandoned, true);
      const lockPath = join(dir, "locks", "bl.lock");
      assert.ok(existsSync(lockPath), "lock must still be held right after the abandon");
      for (let i = 0; i < 200 && existsSync(lockPath); i++) {
        await sleep(50);
      }
      assert.ok(!existsSync(lockPath), "lock must release once the abandoned child exits");
      assert.ok(existsSync(`${work}.done`), "abandoned child must finish its install");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SUBTRK_DIR;
    }
  });
});

describe("runProbe per-provider budget (core)", () => {
  const slowProbe = (ms: number): ProviderModule =>
    ({
      id: "glm",
      ttlMs: 60_000,
      probe: async () => {
        await sleep(ms);
        return { id: "glm", ok: true, stale: false, fetchedAt: new Date().toISOString() };
      },
    }) as ProviderModule;

  it("honours a provider's own probeTimeoutMs over the default 10s", async () => {
    const res = await runProbe({ ...slowProbe(600), probeTimeoutMs: 2_000 }, {});
    assert.equal(res.ok, true, "slow-but-budgeted probe must complete, not time out");
  });

  it("still times out on the opts budget when the provider sets none", async () => {
    const res = await runProbe(slowProbe(600), { probeTimeoutMs: 150 });
    assert.equal(res.ok, false);
    assert.equal(res.error?.kind, "timeout");
  });
});
