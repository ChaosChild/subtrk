// fixes-w-note.test.ts – re-verification review fixes:
//  (1) core's finishProbe must carry the CURRENT probe's note through the
//      stale-on-error branch (claude's write-back-failed warning used to be
//      dropped on the common stale+error path) and must suppress a stale
//      entry's note when the live probe reports none – a stale note never
//      masquerades as current.
//  (2) claude's usage read is deadline-aware: a slow refresh-token exchange
//      shrinks the read's timeout into core's whole-probe budget instead of
//      pushing past it, so the rotated-token result (and its write-back note)
//      survives where core's kind=timeout used to discard both.
// Offline: every fetch is stubbed (an unrouted URL hard-fails); temp HOMEs
// isolate the credential store; CLAUDE_* env vars are stripped at module load.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderError, ProviderModule, ProviderResult } from "../src/core.ts";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-fixes-home-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"];
const CLAUDE_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
for (const k of [...ISOLATE_KEYS, ...CLAUDE_KEYS]) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.APPDATA = join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
for (const k of CLAUDE_KEYS) delete process.env[k];
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const { fetchProvider, PROBE_TIMEOUT_MS } = await import("../src/core.ts");
const { default: claudeMod, usageReadTimeoutMs } = await import("../src/providers/claude.ts");

// ---- helpers ----------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-fixes-test-"));
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

// A cached ok entry, well past its TTL but < 24h old: exactly the state whose
// probe failure serves stale-on-error.
function staleEntry(id: ProviderResult["id"], note: string | undefined): ProviderResult {
  return {
    id,
    ok: true,
    stale: false,
    fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
    windows: [{ kind: "5h", usedPercent: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ...(note === undefined ? {} : { note }),
  };
}

function failModule(
  id: ProviderResult["id"],
  over: Partial<ProviderResult> = {},
  counter = { n: 0 },
): ProviderModule & { counter: { n: number } } {
  return {
    id,
    counter,
    ttlMs: 60_000,
    probe: async () => {
      counter.n += 1;
      return {
        id,
        ok: false,
        stale: false,
        fetchedAt: new Date().toISOString(),
        error: { kind: "rate-limited", message: "429", retryAfterMs: 30_000 } satisfies ProviderError,
        ...over,
      };
    },
  };
}

const OLD_NOTE = "stale note from the previously stored entry";
const FRESH_NOTE = "fresh note from the live probe";

// ---- finding 1: the current probe's note wins on the stale path -------------

describe("finishProbe note semantics on the stale path", () => {
  it("stale-on-error carries the live probe's note (the write-back warning is no longer dropped)", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", staleEntry("glm", undefined), 3_600_000);
    const mod = failModule("glm", { note: FRESH_NOTE });
    const r = await fetchProvider(mod, { cachePath });
    assert.equal(mod.counter.n, 1, "the TTL-lapsed entry forces a live probe");
    assert.equal(r.ok, false);
    assert.equal(r.stale, true, "cached windows < 24h serve stale-on-error");
    assert.equal(r.error?.kind, "rate-limited");
    assert.ok(r.windows?.length === 1, "cached windows ride along");
    assert.equal(r.note, FRESH_NOTE, "the current probe's note reaches the output");
  });

  it("a stale entry's note is suppressed when the live probe reports none", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", staleEntry("glm", OLD_NOTE), 3_600_000);
    const mod = failModule("glm", {});
    const r = await fetchProvider(mod, { cachePath });
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.equal(r.note, undefined, "the old entry's note must not masquerade as current");
  });

  it("when both have notes, the live probe's note wins", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", staleEntry("glm", OLD_NOTE), 3_600_000);
    const r = await fetchProvider(failModule("glm", { note: FRESH_NOTE }), { cachePath });
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.equal(r.note, FRESH_NOTE);
  });

  it("stale-on-ok: a fresh ok probe replaces the entry wholesale – no stale note survives", async (t) => {
    const dir = tempDir();
    t.after(cleanup(dir));
    const cachePath = join(dir, "cache.json");
    seedCache(cachePath, "glm", staleEntry("glm", OLD_NOTE), 3_600_000);
    const mod: ProviderModule & { counter: { n: number } } = {
      id: "glm",
      counter: { n: 0 },
      ttlMs: 60_000,
      probe: async () => {
        mod.counter.n += 1;
        return staleEntry("glm", undefined);
      },
    };
    const r = await fetchProvider(mod, { cachePath });
    assert.equal(mod.counter.n, 1);
    assert.equal(r.ok, true);
    assert.equal(r.stale, false);
    assert.equal(r.note, undefined, "the current (note-less) probe wins over the stored note");
    const stored = (JSON.parse(readFileSync(cachePath, "utf8")) as { glm: { data: ProviderResult } }).glm.data;
    assert.equal(stored.note, undefined, "the rewritten cache entry holds no stale note");
  });
});

// ---- finding 2: the usage read fits inside the probe budget ------------------

describe("claude usage-read budget", () => {
  it("usageReadTimeoutMs: most of the budget when fresh, exactly 0 at the boundary, negative after", () => {
    const t0 = 1_750_000_000_000;
    const fresh = usageReadTimeoutMs(t0, t0);
    assert.ok(fresh > 9_000 && fresh < PROBE_TIMEOUT_MS, `a fresh read keeps nearly the whole budget (${fresh}ms)`);
    const margin = PROBE_TIMEOUT_MS - fresh; // reserved at probe start
    assert.equal(
      usageReadTimeoutMs(t0, t0 + (PROBE_TIMEOUT_MS - margin - 1)),
      1,
      "the last millisecond of budget still allows a 1ms read",
    );
    assert.equal(usageReadTimeoutMs(t0, t0 + (PROBE_TIMEOUT_MS - margin)), 0, "budget gone -> skip the read");
    assert.ok(
      usageReadTimeoutMs(t0, t0 + 2 * PROBE_TIMEOUT_MS) < 0,
      "past the budget -> negative, the caller must skip",
    );
  });

  it("a slow rotation shrinks the usage read into the budget: note survives, core never times out", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "subtrk-fixes-claude-"));
    const saved = new Map<string, string | undefined>(ISOLATE_KEYS.map((k) => [k, process.env[k]]));
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    const credPath = join(home, ".claude", ".credentials.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-file-token",
          expiresAt: Date.now() - 3_600_000,
          refreshToken: "file-refresh-token",
        },
      }),
    );
    // Break the write-back deterministically: a DIRECTORY at the helper's
    // temp path makes both temp+rename attempts throw -> the result carries
    // the spent-token note.
    const tmpDir = `${credPath}.${process.pid}.tmp`;
    mkdirSync(tmpDir);
    t.after(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    const REFRESH = "console.anthropic.com/v1/oauth/token";
    const USAGE = "api.anthropic.com/api/oauth/usage";
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes(REFRESH)) {
        // ~2s rotation exchange: eats a fifth of core's 10s budget.
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    access_token: "rotated-access",
                    refresh_token: "rotated-refresh",
                    expires_in: 3600,
                  }),
                  { status: 200 },
                ),
              ),
            2_000,
          ),
        );
      }
      if (url.includes(USAGE)) {
        // Would hang far past the remaining budget; honour the abort signal
        // the way a real fetch does so fetchText maps it to its own timeout.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }
      return Promise.reject(new Error(`network must not be reached: ${url}`));
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });

    const start = Date.now();
    const r = await fetchProvider(claudeMod, { cachePath: join(home, "cache.json") });
    const elapsed = Date.now() - start;
    assert.equal(r.ok, false, "the usage read was cut – but by the provider's shrunk deadline");
    assert.equal(r.error?.kind, "timeout");
    assert.match(r.error?.message ?? "", /request timed out/, "the shrunk usage-read timeout fired");
    assert.ok(!/probe exceeded/.test(r.error?.message ?? ""), "core must NOT have timed the whole probe out");
    assert.match(
      r.note ?? "",
      /credential store could not be updated/,
      "the spent-token warning survives the budget squeeze",
    );
    assert.equal(
      calls.filter((c) => c.includes(USAGE)).length,
      1,
      "the read was attempted with the shrunk deadline, not skipped",
    );
    assert.ok(elapsed < PROBE_TIMEOUT_MS, `returns within core's probe budget (took ${elapsed}ms)`);
  });
});
