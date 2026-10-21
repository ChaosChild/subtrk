// providers-degrade.test.ts – every provider module's failure behavior, driven
// through the REAL probe() with a sanitized environment: temp HOME /
// APPDATA / LOCALAPPDATA, stripped credential env vars. Missing credentials
// must degrade to a clean no-credentials result and malformed/corrupt
// credential files must degrade without throwing and without leaking partial
// windows. No network: every probe below returns before any fetch because no
// usable credential exists.
//
// The one offline exception is google on Windows: discoverCreds() consults the
// machine-global Windows Credential Manager ('gemini:antigravity') first, which
// a HOME override cannot isolate – a live agy login would make probe() mint a
// token (network). The full google probe therefore runs only off-Windows; on
// Windows the local-tier degrade and the parser layer are covered instead.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderError, ProviderModule, ProviderResult } from "../src/core.ts";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-probehome-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"];
const SECRET_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", // claude's env lane would win over the temp-HOME file store
  "CLAUDE_CONFIG_DIR", // claude's store-path override would leave the temp HOME
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
for (const k of [...ISOLATE_KEYS, ...SECRET_KEYS]) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.APPDATA = join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
for (const k of SECRET_KEYS) delete process.env[k];
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const claudeMod = (await import("../src/providers/claude.ts")).default;
const glmMod = (await import("../src/providers/glm.ts")).default;
const alibabaMod = (await import("../src/providers/alibaba.ts")).default;
const googleMod = (await import("../src/providers/google.ts")).default;
const opencodeMod = (await import("../src/providers/opencode.ts")).default;
const openrouterMod = (await import("../src/providers/openrouter.ts")).default;
const openaiMod = (await import("../src/providers/openai.ts")).default;
const kimiMod = (await import("../src/providers/kimi.ts")).default;
const zcodeMod = (await import("../src/providers/zcode.ts")).default;
const { allProviders } = await import("../src/providers/index.ts");
const {
  parseAgyKeyringBlob,
  parseAntigravityTokenFile,
  parseGeminiCreds,
  googleExpired,
  needsRefresh,
  spawnLsAndProbe,
} = await import("../src/providers/google.ts");
const { extractJson, mapError, parseSubscription, parseTokenPlanUsage } = await import("../src/providers/alibaba.ts");
type BlRunShape = Parameters<typeof mapError>[0];
// mapError's BlRun grew update-supervision lanes; tests only care about the
// classification inputs, so fill the rest from this base.
const blRun = (partial: Partial<BlRunShape>): BlRunShape =>
  ({
    ok: false,
    stdout: "",
    stderr: "",
    toolMissing: false,
    timedOut: false,
    selfUpdated: false,
    updateAbandoned: false,
    busy: false,
    exitCode: null,
    exited: Promise.resolve(),
    ...partial,
  }) as BlRunShape;
const { glmAuth, parseGlmQuota } = await import("../src/providers/glm.ts");
const { claudeAuth } = await import("../src/providers/claude.ts");
const { extractOpencodeKey } = await import("../src/providers/opencode.ts");
const { parseOpenaiAuth } = await import("../src/providers/openai.ts");
const { parseDesktopKeyFile } = await import("../src/providers/kimi.ts");
const { parseZcodeBalance } = await import("../src/providers/zcode.ts");

// ---- helpers ----------------------------------------------------------

interface HomeHandle {
  home: string;
  write(rel: string[], text: string): string;
  mkdir(rel: string[]): string;
  done(): void;
}

// Point HOME/USERPROFILE/APPDATA/LOCALAPPDATA at a fresh temp dir for the
// duration of one probe; restore and delete afterwards.
function withHome(fn: (h: HomeHandle) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "subtrk-probe-"));
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
    home,
    write(rel: string[], text: string): string {
      const p = join(home, ...rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    mkdir(rel: string[]): string {
      const p = join(home, ...rel);
      mkdirSync(p, { recursive: true });
      return p;
    },
    done(): void {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
  return fn(handle).finally(() => handle.done());
}

// Alibaba's credential is the `bl` CLI session, not a file – keep it out of the
// picture by giving the probe a PATH without it (bl IS installed on some dev
// machines; a logged-in session would make probe() call the gateway).
function stripPath(): { prev: string | undefined; restore(): void } {
  const prev = process.env.PATH;
  process.env.PATH = process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin";
  return {
    prev,
    restore(): void {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
    },
  };
}

function assertCleanFailure(
  r: ProviderResult,
  expectedId: string,
): asserts r is ProviderResult & { error: ProviderError } {
  assert.equal(r.id, expectedId);
  assert.equal(r.ok, false, "a missing/malformed credential must be a failure result");
  assert.equal(r.stale, false);
  assert.match(r.fetchedAt, /Z$/);
  assert.ok(r.error, "failure results carry an error object");
  assert.ok(r.error.message.length > 0, "error messages are non-empty");
  assert.equal(r.windows, undefined, "never a partial window leak");
  assert.equal(r.credits, undefined, "never a partial credits leak");
  assert.equal(r.plan, undefined, "no plan label without data");
}

// ---- claude ---------------------------------------------------------------

describe("claude probe degrade paths", () => {
  it("no credentials file -> clean no-credentials, hint names the login", async () => {
    await withHome(async () => {
      assertCleanFailure(await claudeMod.probe(), "claude");
    });
    // (assertions inside withHome run before done(); re-check nothing leaked)
  });

  it("corrupt credentials file -> parse-failure, never a throw", async () => {
    await withHome(async (h) => {
      h.write([".claude", ".credentials.json"], "{not json at all");
      const r = await claudeMod.probe();
      assertCleanFailure(r, "claude");
      assert.equal(r.error.kind, "parse-failure");
      assert.match(r.error.message, /not valid JSON/);
    });
  });

  it("structurally wrong credentials -> no-credentials / parse-failure, offline", async () => {
    await withHome(async (h) => {
      h.write([".claude", ".credentials.json"], JSON.stringify({}));
      let r = await claudeMod.probe();
      assertCleanFailure(r, "claude");
      assert.equal(r.error.kind, "no-credentials");
      assert.match(r.error.message, /no claudeAiOauth/);

      // accessToken present but expiresAt garbage -> parse-failure. No
      // refresh_token anywhere, so the probe can never attempt a network mint.
      h.write([".claude", ".credentials.json"], JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
      r = await claudeMod.probe();
      assertCleanFailure(r, "claude");
      assert.equal(r.error.kind, "parse-failure");
      assert.match(r.error.message, /expiresAt/);
    });
  });

  it("claudeAuth: malformed oauth objects never throw and never yield a token", () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { claudeAiOauth: "x" }, { claudeAiOauth: [] }]) {
      const a = claudeAuth(bad, Date.now());
      assert.ok(!a.ok, JSON.stringify(bad));
      assert.equal((a as { accessToken?: string }).accessToken, undefined);
    }
  });
});

// ---- glm ------------------------------------------------------------------

describe("glm probe degrade paths", () => {
  it("no config and no env token -> clean no-credentials naming both sources", async () => {
    await withHome(async () => {
      const r = await glmMod.probe();
      assertCleanFailure(r, "glm");
      assert.equal(r.error.kind, "no-credentials");
      assert.match(r.error.message, /config\.json unreadable and no ANTHROPIC_AUTH_TOKEN/);
    });
  });

  it("corrupt config.json -> same clean degradation, never a throw", async () => {
    await withHome(async (h) => {
      h.write([".zcode", "cli", "config.json"], "{broken");
      const r = await glmMod.probe();
      assertCleanFailure(r, "glm");
      assert.equal(r.error.kind, "no-credentials");
    });
  });

  it("config.json with provider.zai but no apiKey -> clean no-credentials", async () => {
    await withHome(async (h) => {
      h.write([".zcode", "cli", "config.json"], JSON.stringify({ provider: { zai: { apiKey: "" } } }));
      const r = await glmMod.probe();
      assertCleanFailure(r, "glm");
      // The message names both credential lanes (z.ai + zhipu) now that the
      // bigmodel aliases ride the same provider.
      assert.match(r.error.message, /no provider\.zai\/zhipu apiKey/);
    });
  });

  it("glmAuth/parseGlmQuota: malformed shapes degrade without throwing", () => {
    assert.equal(glmAuth(undefined, undefined), null);
    assert.equal(glmAuth([], undefined), null);
    assert.equal(glmAuth({ provider: "x" }, undefined), null);
    assert.equal(glmAuth({ provider: { zai: 7 } }, ""), null);
    // 0%-window edge (z.ai omits nextResetTime while a window is unused):
    // skipped as inactive, never a parse failure and never a partial window.
    const zero = parseGlmQuota({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 }] } });
    assert.deepEqual(zero, { windows: [], empty: true });
    assert.equal(parseGlmQuota(undefined), null);
    assert.equal(parseGlmQuota(7), null);
  });
});

// ---- alibaba --------------------------------------------------------------

describe("alibaba probe degrade paths", () => {
  it("no `bl` on PATH -> clean failure, no windows/credits, never a throw", async () => {
    await withHome(async () => {
      const p = stripPath();
      try {
        const r = await alibabaMod.probe();
        assert.equal(r.id, "alibaba");
        assert.equal(r.ok, false);
        assert.ok(r.error, "clean failure carries an error");
        assert.ok(
          ["tool-missing", "subprocess-failed", "timeout", "no-credentials"].includes(r.error.kind),
          `expected a clean degrade kind, got ${r.error.kind}`,
        );
        assert.ok(r.error.message.length > 0);
        assert.equal(r.windows, undefined);
        assert.equal(r.credits, undefined);
      } finally {
        p.restore();
      }
    });
  });

  it("malformed bl output degrades at the parse layer: no windows, no crash", () => {
    for (const junk of ["", "banner only", "{broken", '{"code":"200","data":null}', "[1,2,3]"]) {
      assert.deepEqual(parseTokenPlanUsage(extractJson(junk)), [], JSON.stringify(junk));
      assert.deepEqual(parseSubscription(extractJson(junk)), {}, JSON.stringify(junk));
    }
    // extractJson null (no braces at all) flows through the same empty state.
    assert.deepEqual(parseTokenPlanUsage(null), []);
  });

  it("mapError: a failed bl spawn (toolMissing, empty stderr) reports tool-missing, not subprocess-failed", () => {
    // ENOENT on POSIX / cmd.exe 9009: the shell prints NOTHING to stderr, so
    // only the flag runBl set can classify it (regression: misreported as
    // 'subprocess-failed: bl exited non-zero (stderr withheld)').
    const fetchedAt = "2026-10-12T00:00:00.000Z";
    const r = mapError(blRun({ toolMissing: true }), fetchedAt);
    assert.ok(r);
    assert.equal(r.ok, false);
    assert.equal(r.fetchedAt, fetchedAt);
    assert.ok(r.error);
    assert.equal(r.error.kind, "tool-missing");
    assert.equal(r.error.message, "'bl' not found on PATH");
    assert.ok(r.error.hint?.includes("bailian-cli"));
  });

  it("mapError: empty stderr WITHOUT the toolMissing flag stays subprocess-failed (withheld, never invented)", () => {
    const r = mapError(blRun({}), new Date().toISOString());
    assert.ok(r?.error);
    assert.equal(r.error.kind, "subprocess-failed");
    assert.equal(r.error.message, "bl exited non-zero (stderr withheld)");
  });

  it("mapError: a gateway 404 body is a failed run, NOT tool-missing", () => {
    // Regression: ANY stderr containing "not found" was classified as the bl
    // binary being absent, telling users to reinstall a CLI that is installed.
    const r = mapError(blRun({ stderr: "API endpoint not found (404)" }), new Date().toISOString());
    assert.ok(r?.error);
    assert.equal(r.error.kind, "subprocess-failed", "a gateway 404 is subprocess-failed");
    assert.notEqual(r.error.kind, "tool-missing");
  });

  it("mapError: the POSIX shell's own missing-command phrasing is tool-missing", () => {
    const r = mapError(blRun({ stderr: "/bin/sh: 1: bl: command not found\n" }), new Date().toISOString());
    assert.ok(r?.error);
    assert.equal(r.error.kind, "tool-missing");
    assert.equal(r.error.message, "'bl' not found on PATH");
  });

  it("mapError: cmd.exe's missing-command phrasing is tool-missing", () => {
    const r = mapError(
      blRun({
        stderr: "'bl' is not recognized as an internal or external command,\r\noperable program or batch file.",
      }),
      new Date().toISOString(),
    );
    assert.ok(r?.error);
    assert.equal(r.error.kind, "tool-missing");
    assert.equal(r.error.message, "'bl' not found on PATH");
  });
});

// ---- google ---------------------------------------------------------------

const WIN = process.platform === "win32";

describe("google probe degrade paths", () => {
  it("standalone language server binary absent -> local tier degrades to a reason", async () => {
    await withHome(async () => {
      const probe = await spawnLsAndProbe(Date.now() + 2_000);
      assert.equal(probe.windows, null);
      assert.match(probe.reason ?? "", /not installed/);
    });
  });

  it("full probe with no credentials -> clean no-credentials (non-Windows only)", {
    skip: WIN
      ? "google's remote tier reads the machine-global Windows Credential Manager, which a HOME override cannot isolate offline"
      : false,
  }, async () => {
    await withHome(async () => {
      assertCleanFailure(await googleMod.probe(), "google");
    });
  });

  it("credential parsers: malformed files for every lineage degrade to null, offline", () => {
    // gemini oauth_creds.json lineage
    assert.equal(parseGeminiCreds(null), null);
    assert.equal(parseGeminiCreds(undefined), null);
    assert.equal(parseGeminiCreds("garbage"), null);
    assert.equal(parseGeminiCreds([]), null);
    assert.equal(parseGeminiCreds({ access_token: "" }), null, "empty token is not a credential");
    assert.equal(parseGeminiCreds({ refresh_token: 7 }), null);
    // antigravity token file lineage – the file's normal form IS a bare opaque
    // token, so non-JSON text degrades to a clean single-field credential
    // (downstream auth then rejects it), never a throw; only truly empty or
    // JSON-without-a-token content is null.
    assert.equal(parseAntigravityTokenFile(""), null);
    const corruptAsBare = parseAntigravityTokenFile("{broken");
    assert.deepEqual(corruptAsBare, { accessToken: "{broken", lineage: "antigravity" });
    assert.equal(parseAntigravityTokenFile('{"access_token":42}'), null);
    assert.equal(parseAntigravityTokenFile('{"other": 1}'), null);
    // agy keyring blob lineage
    assert.equal(parseAgyKeyringBlob(undefined), null);
    assert.equal(parseAgyKeyringBlob(42), null);
    assert.equal(parseAgyKeyringBlob({ token: [] }), null);
    assert.equal(parseAgyKeyringBlob({ token: { access_token: 42 } }), null);
  });

  it("expiry helpers: malformed expiry fields never throw on the degrade path", () => {
    const junk = { accessToken: "t", lineage: "gemini" as const, expiresAtMs: "soon" as unknown as number };
    assert.equal(typeof googleExpired(junk, Date.now()), "boolean");
    assert.equal(
      typeof needsRefresh({ lineage: "agy-keyring" as const, refreshToken: 42 as unknown as string }, Date.now()),
      "boolean",
    );
  });
});

// ---- opencode ---------------------------------------------------------------

describe("opencode probe degrade paths", () => {
  it("no env key and no auth.json -> clean no-credentials", async () => {
    await withHome(async () => {
      assertCleanFailure(await opencodeMod.probe(), "opencode");
    });
  });

  it("corrupt and wrong-shaped auth.json -> clean no-credentials, never a throw", async () => {
    await withHome(async (h) => {
      h.write([".local", "share", "opencode", "auth.json"], "{broken");
      let r = await opencodeMod.probe();
      assertCleanFailure(r, "opencode");
      assert.equal(r.error.kind, "no-credentials");

      h.write([".local", "share", "opencode", "auth.json"], JSON.stringify({ opencode: { key: "" } }));
      r = await opencodeMod.probe();
      assertCleanFailure(r, "opencode");

      h.write([".local", "share", "opencode", "auth.json"], JSON.stringify({ opencode: 7 }));
      r = await opencodeMod.probe();
      assertCleanFailure(r, "opencode");
    });
  });

  it("a present key is enough (presence check): ok result offline, no windows", async () => {
    await withHome(async (h) => {
      h.write([".local", "share", "opencode", "auth.json"], JSON.stringify({ opencode: { key: "FAKE-KEY" } }));
      const r = await opencodeMod.probe();
      assert.equal(r.ok, true, "opencode is presence-checked – no network behind ok");
      assert.equal(r.plan, "Zen PAYG");
      assert.equal(r.windows, undefined);
      assert.ok(r.note?.includes("no usage/balance API"));
    });
  });

  it("extractOpencodeKey: junk shapes are null, never a throw", () => {
    for (const junk of [null, undefined, "x", [], { opencode: null }, { opencode: { key: 7 } }]) {
      assert.equal(extractOpencodeKey(junk), null, JSON.stringify(junk));
    }
  });
});

// ---- openrouter --------------------------------------------------------------

describe("openrouter probe degrade paths", () => {
  it("no env key -> clean no-credentials", async () => {
    await withHome(async () => {
      const r = await openrouterMod.probe();
      assertCleanFailure(r, "openrouter");
      assert.match(r.error.message, /OPENROUTER_API_KEY not set/);
    });
  });

  it("an empty-string env key is treated as missing, never forwarded", async () => {
    await withHome(async () => {
      process.env.OPENROUTER_API_KEY = "";
      try {
        const r = await openrouterMod.probe();
        assertCleanFailure(r, "openrouter");
        assert.match(r.error.message, /not set/);
      } finally {
        delete process.env.OPENROUTER_API_KEY;
      }
    });
  });
});

// ---- openai ----------------------------------------------------------------

describe("openai probe degrade paths", () => {
  it("no auth.json -> clean no-credentials pointing at codex login", async () => {
    await withHome(async () => {
      assertCleanFailure(await openaiMod.probe(), "openai");
    });
  });

  it("corrupt / wrong-shaped auth.json -> clean no-credentials, never a throw", async () => {
    await withHome(async (h) => {
      h.write([".codex", "auth.json"], "{broken");
      let r = await openaiMod.probe();
      assertCleanFailure(r, "openai");
      assert.match(r.error.message, /no Codex credentials/);

      h.write([".codex", "auth.json"], JSON.stringify({}));
      r = await openaiMod.probe();
      assertCleanFailure(r, "openai");
      assert.match(r.error.message, /no Codex credentials/);
    });
  });

  it("an API-key-only auth.json is the distinct no-credentials failure, offline", async () => {
    await withHome(async (h) => {
      h.write([".codex", "auth.json"], JSON.stringify({ OPENAI_API_KEY: "sk-openai" }));
      const r = await openaiMod.probe();
      assertCleanFailure(r, "openai");
      assert.equal(r.error.kind, "no-credentials");
      assert.match(r.error.message, /API key, not a ChatGPT login/);
      assert.equal(r.error.hint, "run codex login (plan usage needs a ChatGPT account)");
    });
  });

  it("parseOpenaiAuth: malformed files never throw", () => {
    for (const junk of [null, undefined, "x", [], 7]) {
      const a = parseOpenaiAuth(junk);
      assert.equal(a, null, JSON.stringify(junk));
    }
  });
});

// ---- kimi ------------------------------------------------------------------

describe("kimi probe degrade paths", () => {
  it("no desktop key file and no CLI credential -> clean no-credentials", async () => {
    await withHome(async () => {
      const r = await kimiMod.probe();
      assertCleanFailure(r, "kimi");
      assert.match(r.error.message, /no Kimi Desktop key or Kimi Code CLI credential/);
    });
  });

  it("corrupt desktop key + corrupt CLI credential -> clean no-credentials, never a throw", async () => {
    await withHome(async (h) => {
      h.write(["AppData", "Roaming", "kimi-desktop", "daimon-share", "daimon", "kimi-code-key.json"], "{broken");
      h.write([".kimi-code", "credentials", "kimi-code.json"], "{broken too");
      const r = await kimiMod.probe();
      assertCleanFailure(r, "kimi");
      assert.equal(r.error.kind, "no-credentials");
    });
  });

  it("wrong-shaped credential files fall through both sources cleanly", async () => {
    await withHome(async (h) => {
      // valid JSON but no usable key -> source 1 skipped
      h.write(
        ["AppData", "Roaming", "kimi-desktop", "daimon-share", "daimon", "kimi-code-key.json"],
        JSON.stringify({ v: 2, keys: [] }),
      );
      // valid JSON but no access_token -> source 2 unusable
      h.write([".kimi-code", "credentials", "kimi-code.json"], JSON.stringify({ scope: "kimi-code" }));
      const r = await kimiMod.probe();
      assertCleanFailure(r, "kimi");
    });
  });

  it("parseDesktopKeyFile: junk shapes are null, never a throw", () => {
    for (const junk of [null, undefined, "x", [], { keys: "nope" }, { keys: [null] }]) {
      assert.equal(parseDesktopKeyFile(junk), null, JSON.stringify(junk));
    }
  });
});

// ---- zcode -----------------------------------------------------------------

describe("zcode probe degrade paths", () => {
  it("no credential store -> clean no-credentials pointing at the desktop login", async () => {
    await withHome(async () => {
      const r = await zcodeMod.probe();
      assertCleanFailure(r, "zcode");
      assert.match(r.error.message, /no ZCode credential store/);
    });
  });

  it("corrupt store JSON -> same clean no-credentials, never a throw", async () => {
    await withHome(async (h) => {
      h.write([".zcode", "v2", "credentials.json"], "{broken");
      const r = await zcodeMod.probe();
      assertCleanFailure(r, "zcode");
      assert.equal(r.error.kind, "no-credentials");
    });
  });

  it("valid JSON that cannot be decrypted -> 'could not be decrypted', no windows", async () => {
    await withHome(async (h) => {
      h.write([".zcode", "v2", "credentials.json"], JSON.stringify({}));
      let r = await zcodeMod.probe();
      assertCleanFailure(r, "zcode");
      assert.match(r.error.message, /could not be decrypted/);

      // a plaintext JWT where the encrypted store value belongs – rejected
      h.write([".zcode", "v2", "credentials.json"], JSON.stringify({ zcodejwttoken: "plaintext.jwt" }));
      r = await zcodeMod.probe();
      assertCleanFailure(r, "zcode");
      assert.match(r.error.message, /could not be decrypted/);
    });
  });

  it("parseZcodeBalance: malformed balance bodies are null, never a throw", () => {
    for (const junk of [null, undefined, "x", [], {}, { data: 7 }]) {
      assert.equal(parseZcodeBalance(junk, Date.now()), null, JSON.stringify(junk));
    }
  });
});

// ---- registry sweep ---------------------------------------------------------

describe("registry-wide offline sweep", () => {
  it("every module (minus google on Windows) probes to a clean failure on an empty home", async () => {
    await withHome(async () => {
      const p = stripPath();
      try {
        const mods: ProviderModule[] = WIN ? allProviders.filter((m) => m.id !== "google") : allProviders;
        const results = await Promise.all(mods.map((m) => m.probe()));
        for (const [i, r] of results.entries()) {
          assertCleanFailure(r, mods[i].id);
        }
      } finally {
        p.restore();
      }
    });
  });
});
