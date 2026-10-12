// w1-cache-e2e.test.ts – end-to-end: two concurrent fetchProvider calls for the
// same provider with a slow probe must produce exactly one underlying probe
// invocation (the leader writes the cache, the waiter is served by it), and a
// second provider keeps its own independent single-flight. The probe-fn seam is
// the ProviderModule registry shape (src/providers/index.ts) – fetchProvider
// takes one module, so the counting wrapper sits exactly where the real
// provider modules sit. No network; temp dirs only.
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

// A slow, counting probe that traces a credential file – exactly what a real
// tracing provider does, minus the vendor call.
function slowTracingModule(
  id: ProviderResult["id"],
  dir: string,
  counter: { n: number },
  delayMs: number,
): ProviderModule {
  const credFile = join(dir, `${id}.credential`);
  writeFileSync(credFile, "credential");
  return {
    id,
    ttlMs: 60_000,
    tracesInputs: true,
    probe: async () => {
      counter.n += 1;
      await new Promise((r) => setTimeout(r, delayMs));
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
    const mod = slowTracingModule("glm", dir, counter, 150);
    const [a, b] = await Promise.all([
      fetchProvider(mod, { cachePath, fetchWaitMs: 5_000 }),
      fetchProvider(mod, { cachePath, fetchWaitMs: 5_000 }),
    ]);
    assert.equal(counter.n, 1, `leader probes once, waiter is served (got ${counter.n})`);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.stale, false);
    assert.equal(b.stale, false);
    // The leader's write landed and carries the stamp for both callers.
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as { glm: { stamp?: unknown } };
    assert.ok(stored.glm.stamp, "the single probe's result was cached with a stamp");
  });

  it("the waiter's result is identical to the leader's cache write", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const counter = { n: 0 };
    const mod = slowTracingModule("claude", dir, counter, 120);
    const results = await Promise.all([
      fetchProvider(mod, { cachePath, fetchWaitMs: 5_000 }),
      fetchProvider(mod, { cachePath, fetchWaitMs: 5_000 }),
    ]);
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
    const modA = slowTracingModule("glm", dir, a, 80);
    const modB = slowTracingModule("kimi", dir, b, 80);
    const [ra, rb] = await Promise.all([
      fetchProvider(modA, { cachePath, fetchWaitMs: 5_000 }),
      fetchProvider(modB, { cachePath, fetchWaitMs: 5_000 }),
    ]);
    assert.equal(a.n, 1);
    assert.equal(b.n, 1);
    assert.equal(ra.ok && rb.ok, true);
    assert.ok(!existsSync(fetchLockPath(dir, "glm")), "glm lock released after completion");
    assert.ok(!existsSync(fetchLockPath(dir, "kimi")), "kimi lock released after completion");
  });
});
