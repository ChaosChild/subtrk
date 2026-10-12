// glm-bigmodel.test.ts – offline coverage for the zhipu/zhipuai aliases on the
// GLM lane: config provider.zhipu/zhipuai keys and env ZHIPUAI_API_KEY route to
// open.bigmodel.cn reusing the SAME host-relative monitor path (never a new
// endpoint), first-party host pinning (api.z.ai / open.bigmodel.cn only – a
// foreign declared base URL is refused, never followed), lane priority,
// unchanged z.ai behavior when no zhipu indicator is present, and the cache
// identity stamp. No network: every fetch is stubbed; refusal paths assert
// fetch is never reached.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderError, ProviderResult } from "../src/core.ts";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-glm-bigmodel-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "ANTHROPIC_AUTH_TOKEN", "ZHIPUAI_API_KEY"];
for (const k of ISOLATE_KEYS) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ZHIPUAI_API_KEY;
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const glmMod = (await import("../src/providers/glm.ts")).default;
const { glmAuth, glmHostAllowed, glmForeignDeclared } = await import("../src/providers/glm.ts");
const { fetchProvider } = await import("../src/core.ts");

const CONFIG_PATH = join(tempHome, ".zcode", "cli", "config.json");
// A minimal ok quota body – parseGlmQuota itself is covered by the degrade suite.
const OK_QUOTA = { data: { level: 2, limits: [] } };

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
  assert.equal(r.id, "glm");
  assert.equal(r.ok, false);
  assert.equal(r.stale, false);
  assert.ok(r.error, "a clean failure carries an error");
  if (kind) assert.equal(r.error.kind, kind);
  assert.equal(r.windows, undefined);
  assert.equal(r.credits, undefined);
}

function writeConfig(obj: unknown): void {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(obj), "utf8");
}

function removeConfig(): void {
  rmSync(CONFIG_PATH, { force: true });
}

// ---- host pin --------------------------------------------------------------

describe("glm host pin", () => {
  it("glmHostAllowed: api.z.ai and open.bigmodel.cn over https only – the two first-party deployments", () => {
    assert.equal(glmHostAllowed("https://api.z.ai"), true);
    assert.equal(glmHostAllowed("https://open.bigmodel.cn"), true);
    assert.equal(glmHostAllowed("http://api.z.ai"), false); // not https
    assert.equal(glmHostAllowed("https://open.bigmodel.cn:8443"), false); // non-default port
    assert.equal(glmHostAllowed("https://api.z.ai.evil.test"), false); // suffix spoof
    assert.equal(glmHostAllowed("https://evil.test"), false);
    assert.equal(glmHostAllowed("not a url"), false);
  });

  it("glmForeignDeclared: a foreign declaration on EITHER lane is named for refusal", () => {
    assert.equal(
      glmForeignDeclared({ provider: { zai: { options: { baseURL: "https://evil.test" } } } }),
      "https://evil.test",
    );
    assert.equal(
      glmForeignDeclared({ provider: { zhipu: { options: { baseURL: "http://mirror.test" } } } }),
      "http://mirror.test",
    );
    assert.equal(
      glmForeignDeclared({ provider: { zhipuai: { options: { baseURL: "https://evil.test" } } } }),
      "https://evil.test",
      "the zhipuai spelling is checked too",
    );
    // first-party declarations, no declaration, unparseable junk, junk shapes -> null
    assert.equal(glmForeignDeclared({ provider: { zai: { options: { baseURL: "https://api.z.ai/v1" } } } }), null);
    assert.equal(
      glmForeignDeclared({ provider: { zhipu: { options: { baseURL: "https://open.bigmodel.cn" } } } }),
      null,
    );
    assert.equal(glmForeignDeclared({ provider: { zai: { options: { baseURL: ":::" } } } }), null);
    assert.equal(glmForeignDeclared({ provider: "junk" }), null);
    assert.equal(glmForeignDeclared(null), null);
    assert.equal(glmForeignDeclared(undefined), null);
  });
});

// ---- credential lanes (pure glmAuth) ---------------------------------------

describe("glm bigmodel credential lanes", () => {
  it("config provider.zhipu / zhipuai keys route to open.bigmodel.cn", () => {
    assert.deepEqual(glmAuth({ provider: { zhipu: { apiKey: "zhipu-key" } } }, undefined), {
      apiKey: "zhipu-key",
      host: "https://open.bigmodel.cn",
    });
    assert.deepEqual(glmAuth({ provider: { zhipuai: { apiKey: "zhipuai-key" } } }, undefined), {
      apiKey: "zhipuai-key",
      host: "https://open.bigmodel.cn",
    });
  });

  it("env ZHIPUAI_API_KEY routes to open.bigmodel.cn when the config has no key", () => {
    assert.deepEqual(glmAuth(undefined, undefined, "env-zhipu-key"), {
      apiKey: "env-zhipu-key",
      host: "https://open.bigmodel.cn",
    });
  });

  it("lane priority: config zai > config zhipu > env ANTHROPIC_AUTH_TOKEN > env ZHIPUAI_API_KEY", () => {
    const both = { provider: { zai: { apiKey: "zai-key" }, zhipu: { apiKey: "zhipu-key" } } };
    assert.equal(glmAuth(both, undefined)?.host, "https://api.z.ai", "config zai wins");
    const zhipuOnly = { provider: { zhipu: { apiKey: "zhipu-key" } } };
    assert.equal(glmAuth(zhipuOnly, "env-zai-token")?.apiKey, "zhipu-key", "config zhipu beats the z.ai env token");
    assert.equal(glmAuth(undefined, "env-zai-token", "env-zhipu-key")?.host, "https://api.z.ai", "z.ai env token wins");
  });

  it("a first-party declared baseURL moves its lane's host – including a declared zhipu host with an env key", () => {
    assert.deepEqual(
      glmAuth({ provider: { zhipu: { apiKey: "k", options: { baseURL: "https://open.bigmodel.cn" } } } }, undefined),
      { apiKey: "k", host: "https://open.bigmodel.cn" },
    );
    assert.deepEqual(
      glmAuth({ provider: { zai: { apiKey: "k", options: { baseURL: "https://api.z.ai" } } } }, undefined),
      { apiKey: "k", host: "https://api.z.ai" },
    );
    // an unpinned-but-parseable declared host is NOT honored (nor followed)
    assert.equal(glmAuth({ provider: { zhipu: { options: { baseURL: "https://evil.test" } } } }, undefined), null);
  });

  it("a foreign declaration on either lane poisons the whole credential (refusal, never a fallback)", () => {
    const poisoned = { provider: { zai: { apiKey: "zai-key" }, zhipu: { options: { baseURL: "https://evil.test" } } } };
    assert.equal(glmAuth(poisoned, "env-zai", "env-zhipu"), null, "no lane may hide behind a poisoned declaration");
  });

  it("the secret firewall: indirection-shaped keys are unusable and the next lane is tried", () => {
    // $-containing zhipu key -> skipped, env ZHIPUAI still answers
    const cfg = { provider: { zhipu: { apiKey: "$SECRET" } } };
    assert.deepEqual(glmAuth(cfg, undefined, "env-zhipu-key"), {
      apiKey: "env-zhipu-key",
      host: "https://open.bigmodel.cn",
    });
    // every candidate unusable -> null
    assert.equal(glmAuth({ provider: { zhipu: { apiKey: "$SECRET" } } }, undefined, undefined), null);
  });

  it("z.ai behavior is unchanged when no zhipu indicator exists (legacy 2-arg calls included)", () => {
    assert.deepEqual(glmAuth({ provider: { zai: { apiKey: "zai-key" } } }, undefined), {
      apiKey: "zai-key",
      host: "https://api.z.ai",
    });
    assert.deepEqual(glmAuth(undefined, "env-token"), { apiKey: "env-token", host: "https://api.z.ai" });
    // a z.ai config entry without a usable key falls through to the env token
    assert.deepEqual(glmAuth({ provider: { zai: { apiKey: "" } } }, "env-token"), {
      apiKey: "env-token",
      host: "https://api.z.ai",
    });
    // malformed shapes never throw and never yield a credential
    assert.equal(glmAuth({ provider: { zhipu: 7 } }, undefined), null);
    assert.equal(glmAuth([], undefined), null);
  });
});

// ---- probe behavior (offline, stubbed fetch) -------------------------------

describe("glm bigmodel probe", () => {
  it("a zhipu config key fetches the SAME monitor path on open.bigmodel.cn with the raw key header", async (t) => {
    const { calls } = stubFetch(t, OK_QUOTA);
    writeConfig({ provider: { zhipu: { apiKey: "zhipu-probe-key" } } });
    t.after(removeConfig);
    const r = await glmMod.probe();
    assert.equal(r.ok, true, "the bigmodel lane parses with the unchanged quota parser");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit", "host-relative path reused");
    assert.equal(calls[0].headers.Authorization, "zhipu-probe-key", "raw key – no Bearer prefix");
  });

  it("an env ZHIPUAI_API_KEY alone rides the same bigmodel lane", async (t) => {
    const { calls } = stubFetch(t, OK_QUOTA);
    process.env.ZHIPUAI_API_KEY = "env-zhipu-probe";
    t.after(() => delete process.env.ZHIPUAI_API_KEY);
    const r = await glmMod.probe();
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  });

  it("the z.ai lane is byte-for-byte unchanged without zhipu indicators", async (t) => {
    const { calls } = stubFetch(t, OK_QUOTA);
    writeConfig({ provider: { zai: { apiKey: "zai-probe-key" } } });
    t.after(removeConfig);
    const r = await glmMod.probe();
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
    assert.equal(calls[0].headers.Authorization, "zai-probe-key");
  });

  it("a foreign declared baseURL refuses the probe even when a usable env key exists", async (t) => {
    const { calls } = stubFetch(t, OK_QUOTA);
    writeConfig({ provider: { zhipu: { apiKey: "k", options: { baseURL: "https://evil.test" } } } });
    t.after(removeConfig);
    process.env.ANTHROPIC_AUTH_TOKEN = "env-zai-token";
    t.after(() => delete process.env.ANTHROPIC_AUTH_TOKEN);
    const r = await glmMod.probe();
    cleanFailure(r, "forbidden");
    assert.match(r.error.message, /non-first-party endpoint/);
    assert.match(r.error.message, /evil\.test/);
    assert.equal(calls.length, 0, "refusal never fetches");
  });

  it("no credential on either lane -> clean no-credentials naming both lanes", async (t) => {
    stubFetch(t, null);
    writeConfig({ provider: { zhipu: { apiKey: "" } } });
    t.after(removeConfig);
    const r = await glmMod.probe();
    cleanFailure(r, "no-credentials");
    assert.match(r.error.message, /no provider\.zai\/zhipu apiKey/);
  });
});

// ---- cache identity stamp (pattern: w1-cache-stamps.test.ts) ---------------

describe("glm bigmodel cache stamp", () => {
  it("a probe stamps the config file and both consulted env names; the key never enters the cache", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subtrk-glm-bigmodel-stamp-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    stubFetch(t, OK_QUOTA);
    writeConfig({ provider: { zhipu: { apiKey: "zhipu-stamp-key" } } });
    t.after(removeConfig);
    const cachePath = join(dir, "cache.json");
    const r = await fetchProvider(glmMod, { cachePath });
    assert.equal(r.ok, true);
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as {
      glm?: { stamp?: { paths: string[]; envNames: string[]; digest: string } };
    };
    assert.deepEqual(stored.glm?.stamp?.paths, [CONFIG_PATH]);
    assert.deepEqual(stored.glm?.stamp?.envNames, ["ANTHROPIC_AUTH_TOKEN", "ZHIPUAI_API_KEY"]);
    assert.match(stored.glm?.stamp?.digest ?? "", /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(cachePath, "utf8").includes("zhipu-stamp-key"), "the key value never enters the cache");
  });
});
