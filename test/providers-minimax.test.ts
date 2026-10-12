// providers-minimax.test.ts – offline coverage for the MiniMax adapter: the
// credential ladder (env key -> MiniMax CLI config), the two key-shaped
// endpoint routes (bearer -> token-plan remains, sk-api- -> account balance),
// host pinning (a declared foreign base URL is refused, never followed), the
// literal-secret firewall, clean degrades for every malformed input, the
// fixture-parsed per-model 5h + weekly windows, and the cache identity stamp.
// No network: every fetch is stubbed; refusal paths assert fetch is never
// reached.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderError, ProviderResult } from "../src/core.ts";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-minimax-"));
const mmxDir = join(tempHome, "mmx-config");
mkdirSync(mmxDir, { recursive: true });
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "MINIMAX_API_KEY", "MMX_CONFIG_DIR"];
for (const k of ISOLATE_KEYS) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.MINIMAX_API_KEY;
process.env.MMX_CONFIG_DIR = mmxDir;
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const minimaxMod = (await import("../src/providers/minimax.ts")).default;
const {
  minimaxTargetAllowed,
  minimaxConfigPath,
  minimaxBaseUrl,
  parseMinimaxConfig,
  parseMinimaxTokenPlan,
  parseMinimaxBalance,
} = await import("../src/providers/minimax.ts");
const { fetchProvider } = await import("../src/core.ts");

const CONFIG_PATH = join(mmxDir, "config.json");
const TOKEN_PLAN_FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/minimax-token-plan.json", import.meta.url), "utf8"),
);
const BALANCE_FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/minimax-balance.json", import.meta.url), "utf8"),
);

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

// Swap global fetch for a stub that records every call and answers with a
// canned JSON response; restores in t.after. A null `answer` makes any call a
// hard failure – for refusal paths that must never reach the network.
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

// A failing probe is clean: resolved (never thrown), stamped with the provider
// id, and carrying no partial usage data.
function cleanFailure(r: ProviderResult, kind?: string): asserts r is ProviderResult & { error: ProviderError } {
  assert.equal(r.id, "minimax");
  assert.equal(r.ok, false);
  assert.equal(r.stale, false);
  assert.ok(r.error, "a clean failure carries an error");
  if (kind) assert.equal(r.error.kind, kind);
  assert.equal(r.windows, undefined);
  assert.equal(r.credits, undefined);
}

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj), "utf8");
}

// ---- host pin + config path ------------------------------------------------

describe("minimax host pin + config path", () => {
  it("minimaxTargetAllowed: only the two pinned first-party hosts over https", () => {
    assert.equal(minimaxTargetAllowed("https://api.minimax.io/v1/token_plan/remains"), true);
    assert.equal(minimaxTargetAllowed("https://api.minimaxi.com/account/query_balance"), true);
    assert.equal(minimaxTargetAllowed("http://api.minimax.io/v1/token_plan/remains"), false); // not https
    assert.equal(minimaxTargetAllowed("https://api.minimax.io:8443/x"), false); // non-default port
    assert.equal(minimaxTargetAllowed("https://api.minimax.io.evil.test/x"), false); // suffix spoof
    assert.equal(minimaxTargetAllowed("https://evil.test/x"), false);
    assert.equal(minimaxTargetAllowed("not a url"), false);
  });

  it("minimaxConfigPath: MMX_CONFIG_DIR overrides ~/.mmx; empty override falls back", () => {
    assert.equal(minimaxConfigPath("/tmp/elsewhere"), join("/tmp/elsewhere", "config.json"));
    assert.equal(minimaxConfigPath("   "), join(tempHome, ".mmx", "config.json"));
    assert.equal(minimaxConfigPath(""), join(tempHome, ".mmx", "config.json"));
    assert.equal(minimaxConfigPath(), CONFIG_PATH); // reads the env var
  });

  it("parseMinimaxConfig: reads only key/host/region fields; indirection keys are unusable", () => {
    const cfg = parseMinimaxConfig({
      api_key: "mmx-key",
      base_url: "https://api.minimaxi.com",
      region: "cn",
      unrelated: "ignored",
    });
    assert.deepEqual(cfg, { key: "mmx-key", foreignBase: null, baseUrl: "https://api.minimaxi.com", region: "cn" });
    // $ anywhere marks an env/template indirection – present-but-unusable.
    assert.equal(parseMinimaxConfig({ api_key: "$SECRET" }).key, null);
    assert.equal(parseMinimaxConfig({ api_key: "!history" }).key, null);
    // oauth.access_token is a fallback key source.
    assert.equal(parseMinimaxConfig({ oauth: { access_token: "tok" } }).key, "tok");
    assert.equal(parseMinimaxConfig("junk").key, null);
    assert.equal(parseMinimaxConfig(null).key, null);
  });

  it("parseMinimaxConfig: a parseable foreign declaration is reported for refusal", () => {
    const cfg = parseMinimaxConfig({ base_url: "https://evil.test/api" });
    assert.equal(cfg.foreignBase, "https://evil.test/api");
    assert.equal(cfg.baseUrl, null);
    // pinned declarations map to their origin
    assert.equal(parseMinimaxConfig({ base_url: "https://api.minimax.io/v1" }).baseUrl, "https://api.minimax.io");
    // unparseable junk is not an endpoint declaration
    assert.equal(parseMinimaxConfig({ base_url: ":::" }).foreignBase, null);
    assert.equal(parseMinimaxConfig({ oauth: { resource_url: "https://evil.test" } }).foreignBase, "https://evil.test");
  });

  it("minimaxBaseUrl: declared pinned origin wins, region cn selects China, default global", () => {
    assert.equal(minimaxBaseUrl(null), "https://api.minimax.io");
    assert.equal(
      minimaxBaseUrl({ key: null, foreignBase: null, baseUrl: "https://api.minimaxi.com", region: null }),
      "https://api.minimaxi.com",
    );
    assert.equal(
      minimaxBaseUrl({ key: null, foreignBase: null, baseUrl: null, region: "CN" }),
      "https://api.minimaxi.com",
    );
    assert.equal(
      minimaxBaseUrl({ key: null, foreignBase: null, baseUrl: null, region: "global" }),
      "https://api.minimax.io",
    );
  });
});

// ---- fixture parsing -------------------------------------------------------

describe("minimax fixture parsing", () => {
  it("token-plan fixture -> per-model 5h + weekly windows with scopes", () => {
    const parsed = parseMinimaxTokenPlan(TOKEN_PLAN_FIXTURE);
    assert.ok(parsed, "fixture shape must parse");
    assert.equal(parsed.plan, "pro");
    assert.equal(parsed.windows.length, 3, "two models: 5h+weekly, one no-allocation weekly skipped");
    // 25 of 100 remaining (usage_count is the remaining count) -> 75% used
    const m2Interval = parsed.windows.find((w) => w.scope === "minimax-m2" && w.kind === "5h");
    assert.ok(m2Interval);
    assert.equal(m2Interval.usedPercent, 75);
    assert.equal(m2Interval.resetsAt, new Date(1792894800 * 1000).toISOString());
    const m2Weekly = parsed.windows.find((w) => w.scope === "minimax-m2" && w.kind === "7d");
    assert.ok(m2Weekly);
    assert.equal(m2Weekly.usedPercent, 75);
    assert.equal(m2Weekly.resetsAt, new Date(1792848000 * 1000).toISOString());
    // explicit remaining_percent 0 + status 2 (exhausted) -> 100% used
    const textInterval = parsed.windows.find((w) => w.scope === "minimax-text-01");
    assert.ok(textInterval);
    assert.equal(textInterval.kind, "5h");
    assert.equal(textInterval.usedPercent, 100);
  });

  it("token-plan: shape failures are null; all-no-allocation degrades to empty; rows without names skip", () => {
    assert.equal(parseMinimaxTokenPlan(null), null);
    assert.equal(parseMinimaxTokenPlan("x"), null);
    assert.equal(parseMinimaxTokenPlan({ data: {} }), null, "model_remains absent");
    assert.equal(parseMinimaxTokenPlan({ data: { model_remains: "x" } }), null, "model_remains not an array");
    const noAlloc = parseMinimaxTokenPlan({
      data: {
        model_remains: [
          {
            model_name: "M",
            current_interval_status: 3,
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
          },
        ],
      },
    });
    assert.deepEqual(noAlloc, { windows: [], empty: true });
    const unnamed = parseMinimaxTokenPlan({
      data: {
        model_remains: [
          { current_interval_status: 1, current_interval_total_count: 5, current_interval_usage_count: 1 },
        ],
      },
    });
    assert.deepEqual(unnamed, { windows: [] }, "a row without a model name is skipped");
    // end_time unusable -> no resetsAt -> window dropped (subtrk windows always
    // carry resetsAt); the named row with no usable windows degrades to empty.
    assert.deepEqual(
      parseMinimaxTokenPlan({ data: { model_remains: [{ model_name: "M", current_interval_status: 1 }] } }),
      { windows: [], empty: true },
    );
  });

  it("balance fixture parses to the available amount", () => {
    assert.equal(parseMinimaxBalance(BALANCE_FIXTURE), 42.5);
    assert.equal(parseMinimaxBalance({ data: { available_amount: "7.25" } }), 7.25, "numeric strings accepted");
    assert.equal(parseMinimaxBalance({ data: {} }), null);
    assert.equal(parseMinimaxBalance({ base_resp: { status_code: 1 } }), null);
    assert.equal(parseMinimaxBalance(null), null);
  });
});

// ---- probe behavior (offline, stubbed fetch) -------------------------------

describe("minimax probe degrade paths", () => {
  it("no credentials anywhere -> clean no-credentials", async (t) => {
    stubFetch(t, null);
    const r = await minimaxMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /no MINIMAX_API_KEY/);
  });

  it("a $-containing env key is an INVALID credential -> parse-failure, never sent", async (t) => {
    stubFetch(t, null);
    process.env.MINIMAX_API_KEY = "$TAKE_FROM_ENV";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    cleanFailure(r, "parse-failure");
    assert.match(r.error.message, /not a literal secret/);
  });

  it("config exists but is not JSON and no env key -> parse-failure naming the file", async (t) => {
    stubFetch(t, null);
    writeFileSync(CONFIG_PATH, "{broken", "utf8");
    t.after(() => rmSync(CONFIG_PATH, { force: true }));
    const r = await minimaxMod.probe();
    cleanFailure(r, "parse-failure");
    assert.match(r.error.message, /not valid JSON/);
    assert.match(r.error.message, /config\.json/);
  });

  it("a declared foreign base URL refuses the probe even with a usable env key", async (t) => {
    const { calls } = stubFetch(t, TOKEN_PLAN_FIXTURE);
    writeConfig({ base_url: "https://evil.test" });
    t.after(() => rmSync(CONFIG_PATH, { force: true }));
    process.env.MINIMAX_API_KEY = "mmx-env-key";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    cleanFailure(r, "forbidden");
    assert.match(r.error.message, /non-first-party endpoint/);
    assert.equal(calls.length, 0, "refusal never fetches");
  });

  it("401/403 -> no-credentials naming the rejected key", async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("denied", { status: 401 }))) as typeof fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    process.env.MINIMAX_API_KEY = "mmx-rejected";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /rejected the API key/);
  });
});

describe("minimax probe routes", () => {
  it("bearer key -> /v1/token_plan/remains on api.minimax.io, fixture windows out", async (t) => {
    const { calls } = stubFetch(t, TOKEN_PLAN_FIXTURE);
    process.env.MINIMAX_API_KEY = "mmx-bearer-key";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    assert.equal(r.ok, true);
    assert.equal(r.windows?.length, 3);
    assert.equal(r.plan, "pro");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.minimax.io/v1/token_plan/remains");
    assert.equal(calls[0].headers.Authorization, "Bearer mmx-bearer-key");
    assert.equal(calls[0].headers["User-Agent"], "subtrk", "honest UA");
  });

  it("sk-api- key -> /account/query_balance, balance as usd credits", async (t) => {
    const { calls } = stubFetch(t, BALANCE_FIXTURE);
    process.env.MINIMAX_API_KEY = "sk-api-account-key";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    assert.equal(r.ok, true);
    assert.deepEqual(r.credits, { remaining: 42.5, unit: "usd", source: "api" });
    assert.equal(calls[0].url, "https://api.minimax.io/account/query_balance");
  });

  it("region cn + sk-api- key -> api.minimaxi.com balance surfaced as a CNY note", async (t) => {
    const { calls } = stubFetch(t, BALANCE_FIXTURE);
    writeConfig({ region: "cn" });
    t.after(() => rmSync(CONFIG_PATH, { force: true }));
    process.env.MINIMAX_API_KEY = "sk-api-cn-key";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const r = await minimaxMod.probe();
    assert.equal(r.ok, true);
    assert.equal(r.credits, undefined, "CNY is never mislabelled as usd");
    assert.match(r.note ?? "", /balance 42\.5 CNY/);
    assert.equal(calls[0].url, "https://api.minimaxi.com/account/query_balance");
  });

  it("config key is used when the env var is absent; vendor status_code 1004 -> no-credentials", async (t) => {
    const { calls } = stubFetch(t, { base_resp: { status_code: 1004, status_msg: "invalid api key" } });
    writeConfig({ api_key: "mmx-config-key" });
    t.after(() => rmSync(CONFIG_PATH, { force: true }));
    const r = await minimaxMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /rejected the API key/);
    assert.equal(calls[0].headers.Authorization, "Bearer mmx-config-key", "the config key rode the request");
  });
});

// ---- cache identity stamp (pattern: w1-cache-stamps.test.ts) ---------------

describe("minimax cache stamp", () => {
  it("a probe stamps the config path and both consulted env names", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subtrk-minimax-stamp-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    stubFetch(t, TOKEN_PLAN_FIXTURE);
    process.env.MINIMAX_API_KEY = "mmx-stamp-key";
    t.after(() => delete process.env.MINIMAX_API_KEY);
    const cachePath = join(dir, "cache.json");
    const r = await fetchProvider(minimaxMod, { cachePath });
    assert.equal(r.ok, true);
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as {
      minimax?: { stamp?: { paths: string[]; envNames: string[]; digest: string } };
    };
    assert.deepEqual(stored.minimax?.stamp?.paths, [CONFIG_PATH]);
    assert.deepEqual(stored.minimax?.stamp?.envNames, ["MINIMAX_API_KEY", "MMX_CONFIG_DIR"]);
    assert.match(stored.minimax?.stamp?.digest ?? "", /^[0-9a-f]{64}$/);
    const raw = readFileSync(cachePath, "utf8");
    assert.ok(!raw.includes("mmx-stamp-key"), "the key value never enters the cache");
  });
});
