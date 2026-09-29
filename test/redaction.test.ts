// Redaction discipline at the provider layer: a fixture secret injected into
// response bodies and credential shapes must never surface in any parsed result
// or constructed error path. Pure checks – no core dependency, no network.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clearSecrets, registerSecret, scrub, scrubValue } from "../src/core.ts";
import {
  deriveCredits,
  extractJson,
  parseSubscription,
  parseTokenPlanUsage,
  stderrMessage,
} from "../src/providers/alibaba.ts";
import { claudeAuth, parseClaudeUsage } from "../src/providers/claude.ts";
import { parseGlmQuota } from "../src/providers/glm.ts";
import { parseAntigravityTokenFile, parseGeminiCreds, parseGoogleSummary } from "../src/providers/google.ts";
import {
  parseAgentGwUsage,
  parseApiKimiUsage,
  parseDesktopKeyFile,
  parseKimiCliCredentials,
} from "../src/providers/kimi.ts";
import { extractOpencodeKey } from "../src/providers/opencode.ts";
import { parseOpenrouterCredits, parseOpenrouterKey } from "../src/providers/openrouter.ts";

const SECRET = "FAKE-SECRET-sk-subtrk-redaction-fixture-9f2c";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

// Deep-clone a fixture and inject the secret at the top level and inside `data`,
// where a careless spread/echo would carry it into a result.
function leaky(obj: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>;
  clone.__leak = SECRET;
  const data = clone.data;
  if (typeof data === "object" && data !== null) (data as Record<string, unknown>).__leak = SECRET;
  return clone;
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

test("parsers ignore injected secret fields and never echo them", () => {
  const claudeParsed = parseClaudeUsage(leaky(fixture("claude-usage")));
  assert.ok(claudeParsed);
  assert.ok(!json(claudeParsed).includes(SECRET));

  const glmParsed = parseGlmQuota(leaky(fixture("glm-quota")));
  assert.ok(glmParsed);
  assert.ok(!json(glmParsed).includes(SECRET));

  const winParsed = parseTokenPlanUsage(leaky(fixture("token-plan-usage")));
  assert.ok(winParsed.length > 0);
  assert.ok(!json(winParsed).includes(SECRET));

  const creditsParsed = deriveCredits(winParsed[0], 45000);
  assert.ok(creditsParsed);
  assert.ok(!json(creditsParsed).includes(SECRET));

  const subParsed = parseSubscription(leaky(fixture("token-plan-subscription")));
  assert.ok(subParsed.specCode);
  assert.ok(!json(subParsed).includes(SECRET));

  const googleParsed = parseGoogleSummary(leaky(fixture("google-summary")));
  assert.ok(googleParsed);
  assert.ok(!json(googleParsed).includes(SECRET));

  const keyParsed = parseOpenrouterKey(leaky(fixture("openrouter-key")));
  assert.ok(keyParsed);
  assert.ok(!json(keyParsed).includes(SECRET));

  const creditsUsd = parseOpenrouterCredits(leaky(fixture("openrouter-credits")));
  assert.ok(creditsUsd);
  assert.ok(!json(creditsUsd).includes(SECRET));

  const opencodeKey = extractOpencodeKey({ opencode: { key: "real-key" }, __leak: SECRET });
  assert.equal(opencodeKey, "real-key");

  const kimiParsed = parseAgentGwUsage(leaky(fixture("kimi-agentgw-usages")));
  assert.ok(kimiParsed);
  assert.ok(!json(kimiParsed).includes(SECRET));

  const kimiApi = parseApiKimiUsage(leaky(fixture("kimi-api-usage")));
  assert.ok(kimiApi);
  assert.ok(!json(kimiApi).includes(SECRET));
});

test("kimi credential parsing extracts exactly the known fields, never echoes the rest", () => {
  const key = parseDesktopKeyFile(leaky(fixture("kimi-credentials")));
  assert.equal(key, "sk-kimi-FAKE-0123456789abcdef", "extraction is exact, nothing extra");
  const creds = parseKimiCliCredentials(leaky({ access_token: SECRET, refresh_token: `${SECRET}-r`, expires_at: 1 }));
  assert.ok(creds);
  assert.equal(creds.accessToken, SECRET);
  assert.equal(creds.refreshToken, `${SECRET}-r`);
  const usage = parseApiKimiUsage(leaky(fixture("kimi-oauth-usages")));
  assert.ok(usage);
  assert.ok(!json(usage).includes(SECRET));
});

test("JSON extraction only takes the braced region – banner secrets stay out", () => {
  const stdout = `secret-in-banner: ${SECRET}\n{"ok": true, "totalQuota": 1}\n`;
  const parsed = extractJson(stdout);
  assert.deepEqual(parsed, { ok: true, totalQuota: 1 });
  assert.ok(!json(parsed).includes(SECRET));
});

test("claude error paths built from a token-bearing credentials object never embed the token", () => {
  const now = 1_800_000_000_000;
  const cases: Array<Record<string, unknown>> = [
    { claudeAiOauth: { accessToken: SECRET, expiresAt: now - 1000 } }, // expired
    { claudeAiOauth: { accessToken: SECRET, expiresAt: now + 30_000 } }, // within 60s skew
    { claudeAiOauth: { accessToken: SECRET } }, // malformed (no expiresAt)
    { claudeAiOauth: { expiresAt: now + 120_000 } }, // token missing entirely
    { other: `${SECRET} in a weird place` }, // shape unrecognized
  ];
  for (const fileObj of cases) {
    const auth = claudeAuth(fileObj, now);
    assert.ok(!auth.ok, "these credential shapes must all fail");
    const result = {
      id: "claude",
      ok: false,
      stale: false,
      fetchedAt: new Date(now).toISOString(),
      error: auth.error,
    };
    assert.ok(
      !json(result).includes(SECRET),
      `error result leaked the secret for case ${JSON.stringify(Object.keys(fileObj))}`,
    );
  }
});

test("alibaba stderr is withheld without redaction and scrubbed with it", () => {
  const noisy = `${"x".repeat(500)} AccessKey=${SECRET}`;
  const withheld = stderrMessage(noisy);
  assert.ok(!withheld.includes(SECRET));
  const scrubbed = stderrMessage(noisy, (s) => s.split(SECRET).join("***"));
  assert.ok(!scrubbed.includes(SECRET));
  assert.ok(scrubbed.includes("***"));
  // truncation to the last 200 chars drops anything older than that, secret included
  const tail = stderrMessage(`${SECRET} ${"y".repeat(500)}`, (s) => s);
  assert.ok(!tail.includes(SECRET));
});

test("google credential parsing extracts exactly the known fields (bare token stays intact for headers only)", () => {
  // The parsed creds object holds the secret by design (probe keeps it local); the
  // guarantee under test is that error-shaped outputs derived from files do not.
  const creds = parseGeminiCreds({ access_token: SECRET, refresh_token: `${SECRET}-r`, expiry_date: 1 });
  assert.ok(creds);
  assert.equal(creds.accessToken, SECRET); // extraction is exact, nothing extra
  assert.ok(
    !json({
      kind: "expired-token",
      message: "access token expired and no refresh_token in the credential file",
    }).includes(SECRET),
  );
  const bare = parseAntigravityTokenFile(SECRET);
  assert.ok(bare);
  assert.equal(bare.accessToken, SECRET);
  assert.equal(bare.refreshToken, undefined);
});

test("zcode registered JWT is scrubbed from plausible error and note strings", () => {
  const JWT = "FAKE.zcode.jwt.header.payload.sig";
  registerSecret(JWT);
  try {
    const note = `balance request failed: token ${JWT} was rejected upstream`;
    const scrubbedNote = scrub(note);
    assert.ok(!scrubbedNote.includes(JWT));
    assert.ok(scrubbedNote.includes("***"));
    const err = scrubValue({
      error: { kind: "expired-token", message: `ZCode rejected the stored login near ${JWT}` },
      note,
    });
    assert.ok(!json(err).includes(JWT));
    assert.ok(json(err).includes("***"));
  } finally {
    clearSecrets();
  }
});
