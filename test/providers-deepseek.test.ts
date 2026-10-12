// providers-deepseek.test.ts – offline coverage for the EXPERIMENTAL DeepSeek
// adapter: the DEEPSEEK_API_KEY ladder, host pinning, the literal-secret
// firewall, clean degrades, the fixture-parsed USD/CNY balance (credits-style,
// no time windows), and the cache identity stamp. No network: every fetch is
// stubbed; the refusal predicate is exercised pure.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderError, ProviderResult } from "../src/core.ts";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-deepseek-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "DEEPSEEK_API_KEY"];
for (const k of ISOLATE_KEYS) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.DEEPSEEK_API_KEY;
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const deepseekMod = (await import("../src/providers/deepseek.ts")).default;
const { deepseekTargetAllowed, parseDeepSeekBalance } = await import("../src/providers/deepseek.ts");
const { fetchProvider } = await import("../src/core.ts");

const BALANCE_FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/deepseek-balance.json", import.meta.url), "utf8"),
);

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(t: { after(fn: () => unknown): unknown }, answer: unknown | null): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (answer === null) return Promise.reject(new Error("network must not be reached"));
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

function cleanFailure(r: ProviderResult, kind?: string): asserts r is ProviderResult & { error: ProviderError } {
  assert.equal(r.id, "deepseek");
  assert.equal(r.ok, false);
  assert.equal(r.stale, false);
  assert.ok(r.error, "a clean failure carries an error");
  if (kind) assert.equal(r.error.kind, kind);
  assert.equal(r.windows, undefined, "DeepSeek has no time windows");
  assert.equal(r.credits, undefined);
}

// ---- host pin + pure parsing ----------------------------------------------

describe("deepseek host pin", () => {
  it("deepseekTargetAllowed: only api.deepseek.com over https on the default port", () => {
    assert.equal(deepseekTargetAllowed("https://api.deepseek.com/user/balance"), true);
    assert.equal(deepseekTargetAllowed("http://api.deepseek.com/user/balance"), false);
    assert.equal(deepseekTargetAllowed("https://api.deepseek.com:8443/user/balance"), false);
    assert.equal(deepseekTargetAllowed("https://api.deepseek.com.evil.test/user/balance"), false);
    assert.equal(deepseekTargetAllowed("https://evil.test/user/balance"), false);
    assert.equal(deepseekTargetAllowed("garbage"), false);
  });
});

describe("deepseek balance parsing", () => {
  it("fixture -> available flag + USD and CNY totals; amounts are decimal strings on the wire", () => {
    const parsed = parseDeepSeekBalance(BALANCE_FIXTURE);
    assert.deepEqual(parsed, { available: true, usd: 12.34, cny: 88 });
  });

  it("is_available is required and must be a boolean – anything else is a shape failure (null)", () => {
    assert.equal(parseDeepSeekBalance(null), null);
    assert.equal(parseDeepSeekBalance("x"), null);
    assert.equal(parseDeepSeekBalance({ balance_infos: [] }), null);
    assert.equal(parseDeepSeekBalance({ is_available: "yes" }), null);
  });

  it("degrades cleanly: absent/junk rows and unsupported currencies are skipped, first duplicate wins", () => {
    assert.deepEqual(parseDeepSeekBalance({ is_available: false }), { available: false, usd: null, cny: null });
    assert.deepEqual(parseDeepSeekBalance({ is_available: true, balance_infos: "x" }), {
      available: true,
      usd: null,
      cny: null,
    });
    const parsed = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "EUR", total_balance: "5.00" }, // unsupported currency – skipped
        { currency: "USD", total_balance: "junk" }, // unusable amount – skipped
        { currency: "USD", total_balance: "1.50" },
        { currency: "USD", total_balance: "9.99" }, // duplicate – first row kept
        "junk-row",
      ],
    });
    assert.deepEqual(parsed, { available: true, usd: 1.5, cny: null });
  });
});

// ---- probe behavior (offline, stubbed fetch) -------------------------------

describe("deepseek probe degrade paths", () => {
  it("no key -> clean no-credentials; the hint marks the provider experimental", async (t) => {
    stubFetch(t, null);
    const r = await deepseekMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /DEEPSEEK_API_KEY not set/);
    assert.match(r.error.hint ?? "", /experimental/);
  });

  it("a $-containing key is an INVALID credential -> parse-failure, never sent", async (t) => {
    const { calls } = stubFetch(t, null);
    process.env.DEEPSEEK_API_KEY = "$FROM_SOMEWHERE";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const r = await deepseekMod.probe();
    cleanFailure(r, "parse-failure");
    assert.match(r.error.message, /not a literal secret/);
    assert.equal(calls.length, 0, "an indirection-shaped key never reaches a request");
  });

  it("401 -> no-credentials naming the rejected key", async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("denied", { status: 401 }))) as typeof fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    process.env.DEEPSEEK_API_KEY = "sk-rejected";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const r = await deepseekMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /rejected the API key/);
  });

  it("non-JSON success body -> parse-failure", async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("<html>not json</html>", { status: 200 }))) as typeof fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    process.env.DEEPSEEK_API_KEY = "sk-test";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const r = await deepseekMod.probe();
    cleanFailure(r, "parse-failure");
    assert.match(r.error.message, /not JSON/);
  });
});

describe("deepseek probe happy paths", () => {
  it("fixture balance -> usd credits, experimental note, CNY in the note; bearer auth on the pinned URL", async (t) => {
    const { calls } = stubFetch(t, BALANCE_FIXTURE);
    process.env.DEEPSEEK_API_KEY = "sk-fixture-key";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const r = await deepseekMod.probe();
    assert.equal(r.ok, true);
    assert.deepEqual(r.credits, { remaining: 12.34, unit: "usd", source: "api" });
    assert.equal(r.windows, undefined, "balance only – no time windows");
    assert.match(r.note ?? "", /experimental/);
    assert.match(r.note ?? "", /CNY balance 88/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
    assert.equal(calls[0].headers.Authorization, "Bearer sk-fixture-key");
  });

  it("CNY-only account -> note only, no mislabelled credits; unavailable flag lands in the note", async (t) => {
    stubFetch(t, { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "3.00" }] });
    process.env.DEEPSEEK_API_KEY = "sk-cny-key";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const r = await deepseekMod.probe();
    assert.equal(r.ok, true);
    assert.equal(r.credits, undefined);
    assert.match(r.note ?? "", /CNY balance 3/);
    assert.match(r.note ?? "", /unavailable/);
  });
});

// ---- cache identity stamp (pattern: w1-cache-stamps.test.ts) ---------------

describe("deepseek cache stamp", () => {
  it("a probe stamps the consulted env name; the key value never enters the cache", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subtrk-deepseek-stamp-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    stubFetch(t, BALANCE_FIXTURE);
    process.env.DEEPSEEK_API_KEY = "sk-stamp-key";
    t.after(() => delete process.env.DEEPSEEK_API_KEY);
    const cachePath = join(dir, "cache.json");
    const r = await fetchProvider(deepseekMod, { cachePath });
    assert.equal(r.ok, true);
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as {
      deepseek?: { stamp?: { paths: string[]; envNames: string[]; digest: string } };
    };
    assert.deepEqual(stored.deepseek?.stamp?.paths, [], "no credential file – env only");
    assert.deepEqual(stored.deepseek?.stamp?.envNames, ["DEEPSEEK_API_KEY"]);
    assert.match(stored.deepseek?.stamp?.digest ?? "", /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(cachePath, "utf8").includes("sk-stamp-key"), "the key value never enters the cache");
  });
});
