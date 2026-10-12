// w1-cred-firewall.test.ts – the secret firewall at the provider boundary,
// driven through the REAL probe() with a sanitized environment (temp HOME /
// APPDATA, stripped credential env vars), offline: every scenario below fails
// or refuses BEFORE any fetch, so a passing run never touches the network.
//
// Concerns under test:
//   - a stored credential containing "$" or a leading "!" (env/template/command
//     indirection) is an INVALID credential: present-but-unusable, never sent,
//     never expanded (claude, codex/openai, kimi, google, glm, zcode).
//   - kimi deployment host pinning: a credential file declaring a non-first-
//     party endpoint is refused with a clear error; the pinned first-party
//     targets are accepted at the pure layer.
//   - errors built from credential-file content pass through redactSecret:
//     "[redacted]" appears, the raw value does not.
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// ---- environment isolation (same discipline as providers-degrade.test.ts) --
const SAVED_ENV = new Map<string, string | undefined>();
const SECRET_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "KIMI_CLIENT_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ANTIGRAVITY_CLIENT_ID",
  "ANTIGRAVITY_CLIENT_SECRET",
  "ZCODE_CREDENTIAL_SECRET",
];
for (const k of SECRET_KEYS) {
  SAVED_ENV.set(k, process.env[k]);
  delete process.env[k];
}
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const claudeMod = (await import("../src/providers/claude.ts")).default;
const openaiMod = (await import("../src/providers/openai.ts")).default;
const kimiMod = (await import("../src/providers/kimi.ts")).default;
const { claudeAuth } = await import("../src/providers/claude.ts");
const { parseGeminiCreds, parseAntigravityTokenFile } = await import("../src/providers/google.ts");
const { kimiForeignBaseHost, kimiTargetAllowed, parseKimiCliCredentials, parseDesktopKeyFile } = await import(
  "../src/providers/kimi.ts"
);
const { glmAuth } = await import("../src/providers/glm.ts");
const { parseZcodeCredentials } = await import("../src/providers/zcode.ts");
const { redactSecret } = await import("../src/lib/secret.ts");

// ---- helpers ----------------------------------------------------------

interface HomeHandle {
  write(rel: string[], text: string): void;
}

// Point HOME/USERPROFILE/APPDATA/LOCALAPPDATA at a fresh temp dir for the
// duration of one probe; restore and delete afterwards.
async function withHome(fn: (h: HomeHandle) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "subtrk-w1-cred-"));
  const saved = new Map<string, string | undefined>([
    ["USERPROFILE", process.env.USERPROFILE],
    ["HOME", process.env.HOME],
    ["APPDATA", process.env.APPDATA],
    ["LOCALAPPDATA", process.env.LOCALAPPDATA],
  ]);
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  const handle: HomeHandle = {
    write(rel: string[], text: string): void {
      const p = join(home, ...rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    },
  };
  try {
    await fn(handle);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

const TOKEN_DOLLAR = "subtrk-w1-fixture-$HOME-expanded-token";
const TOKEN_BANG = "!subtrk-w1-fixture-history-token";

// ---- claude ---------------------------------------------------------------

describe("claude secret firewall", () => {
  it('stored accessToken with "$" -> invalid classification, never sent, offline', async () => {
    await withHome(async (h) => {
      h.write(
        [".claude", ".credentials.json"],
        JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_DOLLAR, expiresAt: Date.now() + 3_600_000 } }),
      );
      const r = await claudeMod.probe();
      assert.equal(r.ok, false, "an indirection-shaped token must not probe");
      assert.equal(r.error?.kind, "parse-failure");
      assert.match(r.error.message, /not a literal secret/);
      assert.equal(r.windows, undefined, "no windows without a usable credential");
      assert.ok(!json(r).includes(TOKEN_DOLLAR), "the raw value never enters the result");
    });
  });

  it("stored accessToken with a leading '!' -> same invalid classification", async () => {
    await withHome(async (h) => {
      h.write(
        [".claude", ".credentials.json"],
        JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_BANG, expiresAt: Date.now() + 3_600_000 } }),
      );
      const r = await claudeMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "parse-failure");
      assert.match(r.error.message, /not a literal secret/);
      assert.ok(!json(r).includes(TOKEN_BANG));
    });
  });

  it("expired accessToken + non-literal refreshToken -> expired error, refresh grant never built", async () => {
    await withHome(async (h) => {
      h.write(
        [".claude", ".credentials.json"],
        JSON.stringify({
          claudeAiOauth: { accessToken: "expired-literal-token", refreshToken: TOKEN_DOLLAR, expiresAt: 1 },
        }),
      );
      const r = await claudeMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "expired-token", "the expired state stands, without a refreshable grant");
      assert.equal((r as { refreshToken?: string }).refreshToken, undefined);
      // and at the pure layer: the indirection-shaped refresh token is not attached
      const auth = claudeAuth(
        { claudeAiOauth: { accessToken: "literal", refreshToken: TOKEN_DOLLAR, expiresAt: 1 } },
        Date.now(),
      );
      assert.ok(!auth.ok);
      assert.equal((auth as { refreshToken?: string }).refreshToken, undefined);
      const good = claudeAuth(
        { claudeAiOauth: { accessToken: "literal", refreshToken: "literal-refresh", expiresAt: 1 } },
        Date.now(),
      );
      assert.equal((good as { refreshToken?: string }).refreshToken, "literal-refresh");
    });
  });
});

// ---- openai (codex) ---------------------------------------------------------

describe("openai (codex) secret firewall", () => {
  it('stored chatgpt access_token with "$" -> invalid classification, never sent, offline', async () => {
    await withHome(async (h) => {
      h.write(
        [".codex", "auth.json"],
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "$(cat ~/.aws/credentials)", account_id: "acct-fake" },
        }),
      );
      const r = await openaiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "parse-failure");
      assert.match(r.error.message, /not a literal secret/);
      assert.equal(r.windows, undefined);
      assert.ok(!json(r).includes("$(cat ~/.aws/credentials)"), "the raw value never enters the result");
    });
  });

  it("stored chatgpt access_token with a leading '!' -> same invalid classification", async () => {
    await withHome(async (h) => {
      h.write(
        [".codex", "auth.json"],
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: TOKEN_BANG, account_id: "acct-fake" } }),
      );
      const r = await openaiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "parse-failure");
      assert.match(r.error.message, /not a literal secret/);
      assert.ok(!json(r).includes(TOKEN_BANG));
    });
  });
});

// ---- kimi: secret firewall + deployment host pinning (W1.4) -----------------

const KIMI_KEY_FILE = ["AppData", "Roaming", "kimi-desktop", "daimon-share", "daimon", "kimi-code-key.json"];
const KIMI_CLI_FILE = [".kimi-code", "credentials", "kimi-code.json"];

describe("kimi secret firewall", () => {
  it("desktop key shaped as an indirection -> source skipped, clean no-credentials, offline", async () => {
    await withHome(async (h) => {
      h.write(KIMI_KEY_FILE, JSON.stringify({ v: 2, keys: [{ apiKey: TOKEN_DOLLAR }] }));
      const r = await kimiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "no-credentials", "the invalid source degrades, nothing is sent");
      assert.ok(!json(r).includes(TOKEN_DOLLAR));
      assert.equal(parseDesktopKeyFile({ keys: [{ apiKey: TOKEN_BANG }] }), null);
    });
  });

  it("CLI credential with an indirection access_token -> source unusable, clean no-credentials", async () => {
    await withHome(async (h) => {
      h.write(KIMI_CLI_FILE, JSON.stringify({ access_token: TOKEN_BANG, refresh_token: "literal" }));
      assert.equal(parseKimiCliCredentials({ access_token: TOKEN_BANG }), null);
      const r = await kimiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "no-credentials");
      assert.ok(!json(r).includes(TOKEN_BANG));
    });
  });
});

describe("kimi deployment host pinning", () => {
  it("only the pinned first-party hosts are credential targets", () => {
    // the provider's actual first-party targets pass the pin
    const firstParty = [
      "https://agent-gw.kimi.com/coding/v1/usages",
      "https://api.kimi.com/coding/v1/usages",
      "https://auth.kimi.com/api/oauth/token",
      "https://auth.kimi.ai/api/oauth/token",
    ];
    for (const url of firstParty) assert.equal(kimiTargetAllowed(url), true, url);
    // everything else is refused before the credential leaves the process
    const foreign = [
      "https://evil.example/coding/v1/usages",
      "https://api.kimi.com.evil.example/usages",
      "http://api.kimi.com/coding/v1/usages", // not https
      "https://api.kimi.com:8443/usages", // not the default port
      "https://auth.kimi.com:443@evil.example/token",
      "not a url",
    ];
    for (const url of foreign) assert.equal(kimiTargetAllowed(url), false, url);
  });

  it("a desktop key file declaring a foreign base URL -> refused with a clear error, no fetch", async () => {
    await withHome(async (h) => {
      const key = "SK-FAKE-w1-desktop-key";
      h.write(KIMI_KEY_FILE, JSON.stringify({ v: 2, keys: [{ apiKey: key, apiUrl: "https://evil.example/collect" }] }));
      assert.equal(
        kimiForeignBaseHost(JSON.parse('{"keys":[{"apiUrl":"https://evil.example/collect"}]}')),
        "https://evil.example/collect",
      );
      const r = await kimiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "forbidden");
      assert.match(r.error.message, /non-first-party endpoint/);
      assert.ok(!json(r).includes(key), "the key value never enters the result");
    });
  });

  it("a CLI credential file declaring a foreign host -> refused, never followed", async () => {
    await withHome(async (h) => {
      h.write(
        KIMI_CLI_FILE,
        JSON.stringify({ access_token: "literal-w1-cli-token", base_url: "https://redirect.example/v1" }),
      );
      const r = await kimiMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "forbidden");
      assert.match(r.error.message, /non-first-party endpoint/);
      assert.ok(!json(r).includes("literal-w1-cli-token"));
    });
  });

  it("first-party endpoint declarations (and files without any) are not refusals", () => {
    assert.equal(kimiForeignBaseHost({ keys: [{ apiKey: "k", baseUrl: "https://api.kimi.com" }] }), null);
    assert.equal(kimiForeignBaseHost({ baseUrl: "https://api.kimi.com/coding/v1" }), null);
    assert.equal(kimiForeignBaseHost({}), null);
    assert.equal(kimiForeignBaseHost({ keys: [{ apiKey: "k" }] }), null);
    assert.equal(kimiForeignBaseHost(null), null);
    // a non-URL value in a URL-ish field is not an endpoint declaration
    assert.equal(kimiForeignBaseHost({ endpoint: "production" }), null);
  });
});

// ---- redaction on error paths ----------------------------------------------

describe("credential values are redacted from credential-file error content", () => {
  it("a key embedded in a refused endpoint declaration comes out as [redacted]", async () => {
    await withHome(async (h) => {
      const key = "SK-FAKE-w1-embed-9f2c";
      h.write(
        KIMI_KEY_FILE,
        JSON.stringify({ v: 2, keys: [{ apiKey: key, apiUrl: `https://evil.example/leak?k=${key}` }] }),
      );
      const r = await kimiMod.probe();
      assert.equal(r.ok, false);
      assert.ok(r.error);
      assert.ok(r.error.message.includes("[redacted]"), `expected [redacted] in: ${r.error.message}`);
      assert.ok(!r.error.message.includes(key), "the raw value must not survive redaction");
      assert.ok(!json(r).includes(key));
      // and the helper directly: both the message shape and overlap behavior
      const msg = `declared (${`https://evil.example/leak?k=${key}${key}`})`;
      const red = redactSecret(msg, [key]);
      assert.ok(red.includes("[redacted]"));
      assert.ok(!red.includes(key));
    });
  });
});

// ---- other providers: parse-level firewall ---------------------------------

describe("remaining providers classify non-literal stored credentials as unusable", () => {
  it("google: indirection tokens fail every lineage at the parse layer", () => {
    assert.equal(parseGeminiCreds({ access_token: TOKEN_DOLLAR }), null);
    assert.equal(parseGeminiCreds({ access_token: TOKEN_BANG }), null);
    // a bad refresh_token is omitted, a literal one kept
    const creds = parseGeminiCreds({ access_token: "literal", refresh_token: TOKEN_DOLLAR });
    assert.ok(creds);
    assert.equal(creds.refreshToken, undefined);
    assert.equal(
      parseGeminiCreds({ access_token: "literal", refresh_token: "literal-refresh" })?.refreshToken,
      "literal-refresh",
    );
    // the bare-token antigravity file form has the same firewall
    assert.equal(parseAntigravityTokenFile(TOKEN_DOLLAR), null);
    assert.equal(parseAntigravityTokenFile(TOKEN_BANG), null);
    assert.equal(parseAntigravityTokenFile("literal-bare-token")?.accessToken, "literal-bare-token");
  });

  it("glm: an indirection candidate is present-but-unusable; the other source still wins", () => {
    // invalid candidates degrade to absent (the signature stays backward-
    // compatible for the usage harvester's glmAuth consumer)
    assert.equal(glmAuth({ provider: { zai: { apiKey: TOKEN_DOLLAR } } }, undefined), null);
    assert.equal(glmAuth(undefined, TOKEN_BANG), null);
    assert.deepEqual(glmAuth({ provider: { zai: { apiKey: TOKEN_DOLLAR } } }, "literal-env"), {
      apiKey: "literal-env",
      host: "https://api.z.ai",
    });
    assert.deepEqual(glmAuth({ provider: { zai: { apiKey: "literal-config" } } }, undefined), {
      apiKey: "literal-config",
      host: "https://api.z.ai",
    });
    assert.equal(glmAuth({ provider: { zai: {} } }, undefined), null);
    assert.equal(glmAuth(undefined, undefined), null);
  });

  it("zcode: a decrypted JWT that is not a plain literal is present-but-unusable", () => {
    const key = createHash("sha256").update("w1-secret").digest();
    const seal = (plain: string): string => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
    };
    assert.deepEqual(parseZcodeCredentials({ zcodejwttoken: seal("FAKE.jwt.value") }, key), { jwt: "FAKE.jwt.value" });
    assert.equal(parseZcodeCredentials({ zcodejwttoken: seal(TOKEN_DOLLAR) }, key), null);
    assert.equal(parseZcodeCredentials({ zcodejwttoken: seal(TOKEN_BANG) }, key), null);
  });
});
