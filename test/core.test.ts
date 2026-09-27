// core.test.ts – cache TTL/lock/stale math, env parser precedence, redaction,
// nextEvent/recheckAfter math. No network; all paths injected into temp dirs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ALL_PROVIDER_IDS,
  clearSecrets,
  collectStatus,
  computeNextEvent,
  computeRecheckAfter,
  fetchProvider,
  getSecret,
  loadConfig,
  type ProviderModule,
  type ProviderResult,
  parseEnvText,
  registerSecret,
  removeCachedProvider,
  saveConfig,
  scrub,
  scrubValue,
} from "../src/core.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-core-test-"));
}

function cleanup(dir: string): () => void {
  return () => rmSync(dir, { recursive: true, force: true });
}

function seedCache(cachePath: string, id: string, data: ProviderResult, ageMs: number, ttlMs = 60_000): void {
  mkdirSync(join(cachePath, ".."), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      schemaVersion: 1,
      [id]: { data, fetchedAt: Date.now() - ageMs, ttlMs },
    }),
  );
}

function seedLock(lockPath: string, pid: number): void {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: Date.now() }));
}

function hit(id: ProviderResult["id"], windows = false): ProviderResult {
  return {
    id,
    ok: true,
    stale: false,
    fetchedAt: new Date().toISOString(),
    ...(windows
      ? { windows: [{ kind: "5h", usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }
      : {}),
  };
}

function countingModule(id: ProviderResult["id"], result: ProviderResult, counter: { n: number }): ProviderModule {
  return {
    id,
    ttlMs: 60_000,
    probe: async () => {
      counter.n += 1;
      return result;
    },
  };
}

describe("env parser + getSecret precedence", () => {
  it("parses KEY=VALUE lines, comments, and quotes", () => {
    const parsed = parseEnvText("# comment\n\nFOO=bar\nBAZ=\"quoted val\"\nQUX='single'\nbroken-line\n\n");
    assert.deepEqual(parsed, { FOO: "bar", BAZ: "quoted val", QUX: "single" });
  });

  it("prefers process env over the file and registers values for scrubbing", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    clearSecrets();
    const envPath = join(dir, "env");
    writeFileSync(envPath, 'SUBTRK_TEST_KEY=from-file\nSUBTRK_TEST_QUOTED="from-quotes"\n');
    delete process.env.SUBTRK_TEST_KEY;
    t.after(() => {
      delete process.env.SUBTRK_TEST_KEY;
      clearSecrets();
    });
    assert.equal(getSecret("SUBTRK_TEST_KEY", envPath), "from-file");
    assert.equal(scrub("x from-file y"), "x *** y");
    process.env.SUBTRK_TEST_KEY = "from-env";
    assert.equal(getSecret("SUBTRK_TEST_KEY", envPath), "from-env");
    assert.equal(scrub("x from-env y"), "x *** y");
    assert.equal(getSecret("SUBTRK_TEST_QUOTED", envPath), "from-quotes");
    assert.equal(getSecret("SUBTRK_TEST_ABSENT", envPath), undefined);
  });
});

describe("redaction", () => {
  it("scrub replaces every registered secret occurrence; empty values are ignored", () => {
    clearSecrets();
    registerSecret("sek-fixture-123");
    registerSecret("");
    assert.equal(scrub("token=sek-fixture-123 token=sek-fixture-123 end"), "token=*** token=*** end");
    assert.equal(scrub("no secrets here"), "no secrets here");
    const deep = scrubValue({ a: "sek-fixture-123", b: ["plain", { c: "sek-fixture-123" }], d: 5 });
    assert.deepEqual(deep, { a: "***", b: ["plain", { c: "***" }], d: 5 });
    clearSecrets();
  });
});

describe("config", () => {
  it("absent file means all providers enabled", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    assert.deepEqual(loadConfig(dir).enabled, [...ALL_PROVIDER_IDS]);
  });

  it("reads enabled list and drops unknown ids", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["claude", "nope"] }));
    assert.deepEqual(loadConfig(dir).enabled, ["claude"]);
  });

  it("throws ConfigError on invalid JSON and on a non-array enabled field", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    writeFileSync(join(dir, "config.json"), "{not json");
    assert.throws(() => loadConfig(dir));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: "claude" }));
    assert.throws(() => loadConfig(dir));
  });

  it("reads an optional order list: unknown ids and duplicates dropped, invalid -> undefined", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ enabled: ["claude"], order: ["kimi", "nope", "kimi", "claude"] }),
    );
    assert.deepEqual(loadConfig(dir).order, ["kimi", "claude"]);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["claude"], order: "claude" }));
    assert.equal(loadConfig(dir).order, undefined, "non-array order is not a hard failure");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["claude"] }));
    assert.equal(loadConfig(dir).order, undefined);
  });

  it("saveConfig patches keys and preserves unknown pre-existing keys", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["claude"], custom: { keep: true } }));
    saveConfig(dir, { order: ["kimi"] });
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    assert.ok(raw.endsWith("\n"), "newline-terminated");
    assert.deepEqual(JSON.parse(raw), { enabled: ["claude"], order: ["kimi"], custom: { keep: true } });
    saveConfig(dir, { enabled: ["glm"], order: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), {
      enabled: ["glm"],
      order: [],
      custom: { keep: true },
    });
    rmSync(join(dir, "config.json"));
    saveConfig(dir, { enabled: ["claude"] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { enabled: ["claude"] });
  });

  it("collectStatus orders providers by config order, unlisted last in registry order", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ order: ["google", "claude"] }));
    const mod = (id: ProviderModule["id"]): ProviderModule => ({
      id,
      ttlMs: 0,
      probe: async () => ({ id, ok: true, stale: false, fetchedAt: new Date().toISOString() }),
    });
    const out = await collectStatus({
      subtrkDir: dir,
      providers: [mod("claude"), mod("glm"), mod("google")],
    });
    assert.deepEqual(
      out.out.providers.map((p) => p.id),
      ["google", "claude", "glm"],
    );
  });
});

describe("cache: fresh / stale / probe math", () => {
  it("writes on first probe, then serves fresh cache without probing", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const counter = { n: 0 };
    const mod = countingModule("glm", hit("glm"), counter);
    const first = await fetchProvider(mod, { cachePath });
    assert.equal(first.stale, false);
    assert.equal(counter.n, 1);
    const stored = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.glm.ttlMs, 60_000);
    const second = await fetchProvider(mod, { cachePath });
    assert.equal(counter.n, 1, "second call within TTL must hit the cache");
    assert.equal(second.stale, false);
  });

  it("serves stale-while-revalidate when expired < 2x ttl and a live peer holds the lock", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const lockPath = `${cachePath}.lock`;
    seedCache(cachePath, "glm", hit("glm", true), 90_000); // 1.5x ttl
    seedLock(lockPath, process.pid); // live process
    const counter = { n: 0 };
    const result = await fetchProvider(countingModule("glm", hit("glm"), counter), { cachePath });
    assert.equal(counter.n, 0, "must not probe while a live peer holds the lock");
    assert.equal(result.stale, true);
    assert.ok(existsSync(lockPath), "peer's lock must not be removed");
  });

  it("probes again once age >= 2x ttl", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", hit("glm"), 150_000); // 2.5x ttl
    const counter = { n: 0 };
    const fresh = hit("glm");
    const result = await fetchProvider(countingModule("glm", fresh, counter), { cachePath });
    assert.equal(counter.n, 1);
    assert.equal(result.stale, false);
  });

  it("contender waits, re-checks, then probes anyway when the lock stays held", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const lockPath = `${cachePath}.lock`;
    seedCache(cachePath, "glm", hit("glm"), 150_000);
    seedLock(lockPath, process.pid); // live lock that never goes away
    const counter = { n: 0 };
    await fetchProvider(countingModule("glm", hit("glm"), counter), {
      cachePath,
      contenderWaitMs: 10,
    });
    assert.equal(counter.n, 1, "bounded duplicate probe after wait + re-check");
  });

  it("treats corrupt JSON as a miss, deletes it, and rewrites it", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    writeFileSync(cachePath, "{definitely not json");
    const counter = { n: 0 };
    await fetchProvider(countingModule("glm", hit("glm"), counter), { cachePath });
    assert.equal(counter.n, 1);
    const stored = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(stored.schemaVersion, 1);
    assert.ok(stored.glm);
  });

  it("discards the file on schemaVersion mismatch", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({ schemaVersion: 2, glm: { data: hit("glm"), fetchedAt: Date.now(), ttlMs: 60_000 } }),
    );
    const counter = { n: 0 };
    await fetchProvider(countingModule("glm", hit("glm"), counter), { cachePath });
    assert.equal(counter.n, 1, "mismatched schema must be a miss");
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).schemaVersion, 1);
  });

  it("falls back to cached data < 24h with stale:true and the error on probe failure", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", hit("glm", true), 3_600_000); // 1h old, well past ttl
    const counter = { n: 0 };
    const failing: ProviderModule = {
      id: "glm",
      ttlMs: 60_000,
      probe: async () => {
        counter.n += 1;
        return {
          id: "glm",
          ok: false,
          stale: false,
          fetchedAt: new Date().toISOString(),
          error: { kind: "rate-limited", message: "429", retryAfterMs: 30_000 },
        };
      },
    };
    const result = await fetchProvider(failing, { cachePath });
    assert.equal(counter.n, 1);
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.ok(result.windows?.length === 1, "cached windows served alongside the error");
    assert.equal(result.error?.kind, "rate-limited");
  });

  it("never throws when the cache write fails (silent give-up)", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    mkdirSync(cachePath); // cachePath is a directory: every write fails
    const counter = { n: 0 };
    const result = await fetchProvider(countingModule("glm", hit("glm"), counter), {
      cachePath,
      probeTimeoutMs: 1000,
    });
    assert.equal(counter.n, 1);
    assert.equal(result.ok, true, "lost writes must never surface as errors");
  });

  it("bypasses the cache entirely when ttlMs <= 0", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const counter = { n: 0 };
    const mod: ProviderModule = {
      id: "opencode",
      ttlMs: 0,
      probe: async () => {
        counter.n += 1;
        return hit("opencode");
      },
    };
    await fetchProvider(mod, { cachePath });
    await fetchProvider(mod, { cachePath });
    assert.equal(counter.n, 2, "no cache reads or writes for ttlMs 0");
    assert.ok(!existsSync(cachePath));
  });

  it("GCs the lock when the holder's pid is dead, then probes", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    const lockPath = `${cachePath}.lock`;
    const dead = spawnSyncDeadPid();
    seedCache(cachePath, "glm", hit("glm"), 150_000);
    writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAt: Date.now() }));
    const counter = { n: 0 };
    const result = await fetchProvider(countingModule("glm", hit("glm"), counter), { cachePath });
    assert.equal(counter.n, 1, "dead holder must not block the probe");
    assert.equal(result.ok, true);
    assert.ok(!existsSync(lockPath), "our own acquired lock is released in finally");
  });

  it("maps a crashing probe to a structured parse-failure, never a throw", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const exploding: ProviderModule = {
      id: "openrouter",
      ttlMs: 60_000,
      probe: async () => {
        throw new Error("boom");
      },
    };
    const result = await fetchProvider(exploding, { cachePath: join(dir, "cache.json"), probeTimeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "parse-failure");
    assert.match(result.error?.message ?? "", /boom/);
  });

  it("maps a probe exceeding its timeout to kind=timeout", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const slow: ProviderModule = {
      id: "openrouter",
      ttlMs: 60_000,
      probe: () => new Promise(() => {}),
    };
    const result = await fetchProvider(slow, { cachePath: join(dir, "cache.json"), probeTimeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "timeout");
  });
});

// A pid that is definitely gone: spawn a child that exits immediately.
function spawnSyncDeadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid, "spawnSync must report a pid");
  return r.pid;
}

describe("removeCachedProvider", () => {
  it("removes only the target entry and keeps schemaVersion", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        glm: { data: hit("glm"), fetchedAt: Date.now(), ttlMs: 60_000 },
        claude: { data: hit("claude"), fetchedAt: Date.now(), ttlMs: 300_000 },
      }),
    );
    removeCachedProvider(dir, "glm");
    const after = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(Object.keys(after).sort(), ["claude", "schemaVersion"]);
    assert.equal(after.schemaVersion, 1);
    assert.equal(after.claude.data.id, "claude");
  });

  it("absent entry, absent file, and corrupt file are all silent no-ops", (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    removeCachedProvider(dir, "glm"); // no file at all
    assert.ok(!existsSync(cachePath));
    writeFileSync(
      cachePath,
      JSON.stringify({ schemaVersion: 1, glm: { data: hit("glm"), fetchedAt: Date.now(), ttlMs: 60_000 } }),
    );
    removeCachedProvider(dir, "claude"); // wrong id
    assert.ok(existsSync(cachePath));
    const kept = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(kept.glm.data.id, "glm", "unrelated entry survives");
    writeFileSync(cachePath, "{corrupt");
    removeCachedProvider(dir, "glm"); // corrupt file – no throw
  });
});

describe("remedy/refreshable scrubbing", () => {
  it("remedy and refreshable pass through scrubValue untouched – they are not secrets", () => {
    clearSecrets();
    registerSecret("sek-fixture-123");
    const out = scrubValue({
      refreshable: true,
      error: {
        kind: "no-credentials",
        message: "token sek-fixture-123 expired",
        remedy: "subtrk auth refresh --provider alibaba",
      },
    });
    assert.equal(out.refreshable, true);
    assert.equal(out.error.remedy, "subtrk auth refresh --provider alibaba");
    assert.equal(out.error.message, "token *** expired", "real secrets in messages still scrub");
    clearSecrets();
  });
});

describe("scheduling math", () => {
  const now = 1_789_500_000_000;

  it("nextEvent = max(resetsAt, fetchedAt + ttl), earliest across windows/providers", () => {
    const fetchedAt = new Date(now).toISOString();
    const resetA = now + 5 * 3600_000; // later reset
    const resetB = now + 60_000; // earlier reset
    const ttl = 300_000;
    const entries: { result: ProviderResult; ttlMs: number }[] = [
      {
        result: {
          id: "claude",
          ok: true,
          stale: false,
          fetchedAt,
          windows: [
            { kind: "5h", resetsAt: new Date(resetA).toISOString() },
            { kind: "7d", resetsAt: new Date(resetA + 3600_000).toISOString() },
          ],
        },
        ttlMs: ttl,
      },
      {
        result: {
          id: "glm",
          ok: true,
          stale: false,
          fetchedAt,
          windows: [{ kind: "5h", resetsAt: new Date(resetB).toISOString() }],
        },
        ttlMs: 60_000,
      },
    ];
    const next = computeNextEvent(entries, now);
    assert.ok(next);
    // glm wins: max(resetB, fetchedAt + 60s) = now+60s, earlier than claude's
    // max(resetA, fetchedAt + 300s) = now+300s. The TTL gate, not the raw
    // reset, decides when new information can first exist.
    assert.equal(next.providerId, "glm");
    assert.equal(next.atMs, now + 60_000);
    assert.equal(next.type, "window-reset");
  });

  it("a window whose raw reset already passed is still gated by fetchedAt + ttl, clamped >= now+1s", () => {
    const fetchedAt = new Date(now - 10_000).toISOString();
    const next = computeNextEvent(
      [
        {
          result: {
            id: "claude",
            ok: true,
            stale: false,
            fetchedAt,
            windows: [{ kind: "5h", resetsAt: new Date(now - 3600_000).toISOString() }],
          },
          ttlMs: 300_000,
        },
      ],
      now,
    );
    assert.ok(next);
    assert.equal(next.atMs, Math.max(now - 10_000 + 300_000, now + 1000));
  });

  it("returns null when no ok provider has windows", () => {
    assert.equal(
      computeNextEvent(
        [{ result: { id: "glm", ok: false, stale: false, fetchedAt: new Date(now).toISOString() }, ttlMs: 60_000 }],
        now,
      ),
      null,
    );
    assert.equal(
      computeNextEvent(
        [{ result: { id: "glm", ok: true, stale: false, fetchedAt: new Date(now).toISOString() }, ttlMs: 60_000 }],
        now,
      ),
      null,
    );
  });

  it("recheckAfter clamps the min ok ttl into [60s, 300s]", () => {
    assert.equal(computeRecheckAfter([], now), new Date(now + 300_000).toISOString());
    assert.equal(computeRecheckAfter([1000], now), new Date(now + 60_000).toISOString());
    assert.equal(computeRecheckAfter([86_400_000], now), new Date(now + 300_000).toISOString());
    assert.equal(computeRecheckAfter([120_000, 60_000], now), new Date(now + 60_000).toISOString());
    assert.equal(computeRecheckAfter([120_000], now), new Date(now + 120_000).toISOString());
  });
});
