// w1-cache-e2e.test.ts – end-to-end: two concurrent fetchProvider calls for the
// same provider with a slow probe must produce exactly one underlying probe
// invocation (the leader writes the cache, the waiter is served by it), and a
// second provider keeps its own independent single-flight. The probe-fn seam is
// the ProviderModule registry shape (src/providers/index.ts) – fetchProvider
// takes one module, so the counting wrapper sits exactly where the real
// provider modules sit. No network; temp dirs only.
//
// Deliberately timing-free: nothing here sleeps a fixed duration and hopes.
// Every wait polls an observable condition every ~15ms up to a generous
// deadline and fails with a message naming what never happened, so a loaded
// machine only makes the test slower, never wrong.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fetchProvider, type ProviderModule, type ProviderResult } from "../src/core.ts";
import { fetchLockPath } from "../src/lib/fetch-lock.ts";
import { traceInput } from "../src/lib/input-trace.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-w1-e2e-"));
}

function cleanup(dir: string): () => void {
  return () => rmSync(dir, { recursive: true, force: true });
}

// Poll `cond` every ~15ms until it holds or `timeoutMs` elapses. A timeout is a
// hard failure naming the condition, never a silent pass – the generous budget
// absorbs full-suite load instead of letting a short sleep decide the outcome.
async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000, intervalMs = 15): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Waiter budget: must exceed any plausible leader runtime under load, so the
// waiter is always served by the leader's write (a broken single-flight still
// fails fast via the exactly-once assertion once the budget lapses).
const WAITER_MS = 20_000;

// A counting probe that traces a credential file – exactly what a real tracing
// provider does, minus the vendor call. With a gate, the probe blocks INSIDE
// the vendor call until the test opens the gate: the leader is provably
// mid-probe (not merely scheduled) before the waiter joins, so the two
// fetchProvider calls are truly concurrent regardless of scheduler timing.
function tracingModule(
  id: ProviderResult["id"],
  dir: string,
  counter: { n: number },
  opts: { gate?: { open: boolean }; delayMs?: number } = {},
): ProviderModule {
  const credFile = join(dir, `${id}.credential`);
  writeFileSync(credFile, "credential");
  return {
    id,
    ttlMs: 60_000,
    tracesInputs: true,
    probe: async () => {
      counter.n += 1;
      if (opts.gate) {
        await waitFor(`the ${id} probe gate to open`, () => opts.gate?.open === true, 10_000);
      } else if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      traceInput(credFile);
      return { id, ok: true, stale: false, fetchedAt: new Date().toISOString(), plan: "pro" };
    },
  };
}

describe("end-to-end single-flight", () => {
  it("two concurrent probes for one provider hit the vendor exactly once", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const counter = { n: 0 };
    const gate = { open: false };
    const mod = tracingModule("glm", dir, counter, { gate });
    const lock = fetchLockPath(dir, "glm");

    // Leader goes first and hangs inside its probe until the gate opens.
    const a = fetchProvider(mod, { cachePath, fetchWaitMs: WAITER_MS });
    await waitFor("the glm single-flight lock to appear (leader mid-probe)", () => existsSync(lock));
    // The lock is held and the cache empty, so this caller can only be a waiter.
    const b = fetchProvider(mod, { cachePath, fetchWaitMs: WAITER_MS });
    // The waiter has already attempted the lock synchronously by the time the
    // call above returned; release the leader and let its write serve the wait.
    gate.open = true;
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(counter.n, 1, `leader probes once, waiter is served (got ${counter.n})`);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(ra.stale, false);
    assert.equal(rb.stale, false);
    // The leader's write landed and carries the stamp for both callers.
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as { glm: { stamp?: unknown } };
    assert.ok(stored.glm.stamp, "the single probe's result was cached with a stamp");
  });

  it("the waiter's result is identical to the leader's cache write", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const counter = { n: 0 };
    const gate = { open: false };
    const mod = tracingModule("claude", dir, counter, { gate });
    const lock = fetchLockPath(dir, "claude");
    const a = fetchProvider(mod, { cachePath, fetchWaitMs: WAITER_MS });
    await waitFor("the claude single-flight lock to appear (leader mid-probe)", () => existsSync(lock));
    const b = fetchProvider(mod, { cachePath, fetchWaitMs: WAITER_MS });
    gate.open = true;
    const results = await Promise.all([a, b]);
    assert.equal(counter.n, 1);
    assert.equal(results[0].windows, undefined);
    assert.equal(results[1].plan, results[0].plan);
    const stored = (JSON.parse(readFileSync(cachePath, "utf8")) as { claude: { data: ProviderResult } }).claude.data;
    assert.equal(results[0].fetchedAt, stored.fetchedAt, "both callers serve the same probe's data");
  });

  it("different providers do not block each other (per-provider keys)", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const a = { n: 0 };
    const b = { n: 0 };
    const modA = tracingModule("glm", dir, a, { delayMs: 80 });
    const modB = tracingModule("kimi", dir, b, { delayMs: 80 });
    const [ra, rb] = await Promise.all([
      fetchProvider(modA, { cachePath, fetchWaitMs: WAITER_MS }),
      fetchProvider(modB, { cachePath, fetchWaitMs: WAITER_MS }),
    ]);
    assert.equal(a.n, 1);
    assert.equal(b.n, 1);
    assert.equal(ra.ok && rb.ok, true);
    // Deterministic: the leader releases in a finally clause before its
    // fetchProvider promise resolves, so both locks are gone by now.
    assert.ok(!existsSync(fetchLockPath(dir, "glm")), "glm lock released after completion");
    assert.ok(!existsSync(fetchLockPath(dir, "kimi")), "kimi lock released after completion");
  });
});
