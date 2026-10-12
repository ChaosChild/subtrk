// w1-cache-stamps.test.ts – W1.3 cache identity stamps: same inputs → reuse;
// changed credential file mtime/size or changed env value → re-probe; a
// stampless legacy entry → re-probe once, then reused with a stamp; and secret
// values never appear in the serialized cache. No network; all paths injected
// into temp dirs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fetchProvider, type ProviderModule, type ProviderResult } from "../src/core.ts";
import { fileState, traceEnv, traceInput, withInputTrace } from "../src/lib/input-trace.ts";

const ENV_NAME = "W1_STAMP_TEST_TOKEN";
const SECRET = "supersecret-w1-token-value-9f2c";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-w1-stamp-"));
}

function cleanup(dir: string): () => void {
  return () => rmSync(dir, { recursive: true, force: true });
}

function hit(id: ProviderResult["id"]): ProviderResult {
  return { id, ok: true, stale: false, fetchedAt: new Date().toISOString(), plan: "pro" };
}

interface TracingMod {
  module: ProviderModule;
  counter: { n: number };
  credFile: string;
}

// A tracesInputs provider whose probe traces a credential file and an env var
// (process env wins over ~/.subtrk/env in getSecret, so the test controls the
// value deterministically through process.env).
function tracingModule(id: ProviderResult["id"], dir: string, delayMs = 0): TracingMod {
  const counter = { n: 0 };
  const credFile = join(dir, `${id}.credentials.json`);
  writeFileSync(credFile, JSON.stringify({ token: "file-credential" }));
  const module: ProviderModule = {
    id,
    ttlMs: 60_000,
    tracesInputs: true,
    probe: async () => {
      counter.n += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      traceInput(credFile); // BEFORE the (simulated) read, like the real providers
      const v = process.env[ENV_NAME];
      traceEnv(ENV_NAME, v);
      return hit(id);
    },
  };
  return { module, counter, credFile };
}

function seedCache(cachePath: string, id: string, data: ProviderResult, ageMs: number, stamp?: unknown): void {
  mkdirSync(join(cachePath, ".."), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      schemaVersion: 1,
      [id]: { data, fetchedAt: Date.now() - ageMs, ttlMs: 60_000, ...(stamp ? { stamp } : {}) },
    }),
  );
}

describe("input-trace recorder", () => {
  it("digests are stable for unchanged inputs and change when the file does", async () => {
    const dir = tempDir();
    const file = join(dir, "cred.json");
    writeFileSync(file, "{}");
    const a = await withInputTrace(async () => {
      traceInput(file);
      traceEnv(ENV_NAME, "v1");
      return 1;
    });
    const b = await withInputTrace(async () => {
      traceInput(file);
      traceEnv(ENV_NAME, "v1");
      return 2;
    });
    assert.equal(a.inputs.digest, b.inputs.digest);
    assert.deepEqual(a.inputs.paths, [file]);
    assert.deepEqual(a.inputs.envNames, [ENV_NAME]);
    assert.equal(a.value, 1);
    assert.equal(b.value, 2);

    utimesSync(file, new Date(), new Date(Date.now() - 5_000)); // mtime backdated
    const c = await withInputTrace(async () => {
      traceInput(file);
      traceEnv(ENV_NAME, "v1");
      return 3;
    });
    assert.notEqual(c.inputs.digest, a.inputs.digest, "mtime change must change the digest");

    const d = await withInputTrace(async () => {
      traceInput(file);
      traceEnv(ENV_NAME, "v2");
      return 4;
    });
    assert.notEqual(d.inputs.digest, c.inputs.digest, "env value change must change the digest");
    const raw = JSON.stringify(d.inputs);
    assert.ok(!raw.includes("v2"), "env values never enter the traced inputs");
  });

  it("records absence as a stable state and never reads contents", () => {
    const absent = join(tempDir(), "nope.json");
    const s1 = fileState(absent);
    const s2 = fileState(absent);
    assert.equal(s1, s2);
    assert.ok(s1.endsWith(":ENOENT"), "absent files carry their errno");
  });
});

describe("cache stamps – reuse and invalidation", () => {
  it("reuses within TTL when inputs are unchanged", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module, counter } = tracingModule("glm", dir);
    const cachePath = join(dir, "cache.json");
    const first = await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1);
    const second = await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1, "same inputs must reuse the stamped entry");
    assert.equal(second.plan, "pro");
    assert.equal(second.stale, false);
    assert.equal(first.plan, "pro");
  });

  it("re-probes when the credential file mtime changes, then reuses the upgraded stamp", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module, counter, credFile } = tracingModule("claude", dir);
    const cachePath = join(dir, "cache.json");
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1);
    utimesSync(credFile, new Date(), new Date(Date.now() - 60_000));
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 2, "changed file identity must invalidate the stamp");
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 2, "the re-probe re-stamped – reuse resumes");
  });

  it("re-probes when the credential file size changes", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module, counter, credFile } = tracingModule("openai", dir);
    const cachePath = join(dir, "cache.json");
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1);
    writeFileSync(credFile, JSON.stringify({ token: "file-credential", extra: true }));
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 2, "a size change is an identity change");
  });

  it("re-probes when the traced env value changes", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const { module, counter } = tracingModule("openrouter", dir);
    const cachePath = join(dir, "cache.json");
    process.env[ENV_NAME] = SECRET;
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1);
    process.env[ENV_NAME] = `${SECRET}-rotated`;
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 2, "a rotated credential must invalidate the stamp");
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 2, "new stamp serves subsequent calls");
  });

  it("treats a stampless legacy entry as stale once, then reuses the stamped upgrade", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module, counter, credFile } = tracingModule("glm", dir);
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", hit("glm"), 1_000); // fresh but stampless (pre-W1.3 writer)
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1, "legacy entry must not be served – one re-probe");
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1, "the upgraded (stamped) entry is reused");
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as {
      glm: { stamp?: { paths: string[]; envNames: string[] } };
    };
    assert.deepEqual(stored.glm.stamp?.paths, [credFile], "upgrade wrote the file path");
    assert.deepEqual(stored.glm.stamp?.envNames, [ENV_NAME], "upgrade wrote the env name");
  });

  it("never stores the secret value in the serialized cache", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module } = tracingModule("kimi", dir);
    const cachePath = join(dir, "cache.json");
    await fetchProvider(module, { cachePath });
    const raw = readFileSync(cachePath, "utf8");
    assert.ok(!raw.includes(SECRET), "raw secret absent from the cache file");
    const parsed = JSON.parse(raw) as { kimi: { stamp: { digest: string } } };
    assert.match(parsed.kimi.stamp.digest, /^[0-9a-f]{64}$/, "only the digest is stored");
  });

  it("treats a corrupt stamp as stale (re-probe)", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    process.env[ENV_NAME] = SECRET;
    const { module, counter, credFile } = tracingModule("glm", dir);
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", hit("glm"), 1_000, { paths: [credFile], envNames: [ENV_NAME], digest: "0".repeat(64) });
    await fetchProvider(module, { cachePath });
    assert.equal(counter.n, 1, "a digest that cannot recompute is stale");
  });
});
