// w1-cred-secret.test.ts – the literal-secret firewall helpers: the full
// accept/reject matrix for usableLiteralSecret and the redaction behavior of
// redactSecret. Pure checks – no env, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecret, usableLiteralSecret } from "../src/lib/secret.ts";

test("usableLiteralSecret: plain literal tokens pass", () => {
  const ok = [
    "sk-kimi-FAKE-0123456789abcdef",
    "ghp_FAKEtoken1234567890",
    "FAKE.zcode.jwt.header.payload.sig",
    "ya29.FAKE-access-token",
    "plain-token",
    "a b c", // inner spaces are literals
    "tök-én", // non-ASCII is not control
    "0",
    "-",
    "tok",
  ];
  for (const v of ok) assert.equal(usableLiteralSecret(v), true, JSON.stringify(v));
});

test("usableLiteralSecret: empty and control characters are rejected", () => {
  const bad = ["", "\n", "\r", "\t", "\0", "\x1f", "\x7f", "tok\nen", "\r\n", " tok\ten", "tok\x00"];
  for (const v of bad) assert.equal(usableLiteralSecret(v), false, JSON.stringify(v));
});

test("usableLiteralSecret: '$' anywhere is an indirection and is rejected", () => {
  const bad = ["$VAR", "$" + "{ENV}", "tok$en", "$", "prefix-$suffix", "$HOME/.cred", "a$$b"];
  for (const v of bad) assert.equal(usableLiteralSecret(v), false, JSON.stringify(v));
});

test("usableLiteralSecret: a leading '!' is a shell/history reference and is rejected", () => {
  const bad = ["!cmd", "! recon '$(...)'", "!!", "!"];
  for (const v of bad) assert.equal(usableLiteralSecret(v), false, JSON.stringify(v));
  // '!' not in leading position is a literal character
  assert.equal(usableLiteralSecret("tok!en"), true);
});

test("redactSecret: every occurrence of every secret is replaced", () => {
  assert.equal(redactSecret("a SECRET b SECRET c", ["SECRET"]), "a [redacted] b [redacted] c");
  assert.equal(redactSecret("x A1 y B2 z A1", ["A1", "B2"]), "x [redacted] y [redacted] z [redacted]");
  // template-shaped text with the token embedded twice
  assert.equal(
    redactSecret("Authorization: Bearer TOK; retry with TOK", ["TOK"]),
    "Authorization: Bearer [redacted]; retry with [redacted]",
  );
});

test("redactSecret: overlapping secrets redact whole, longest first", () => {
  // the longer secret must win – a shorter one carving it up would leak the remainder
  assert.equal(redactSecret("value: tokensecret;", ["tok", "tokensecret"]), "value: [redacted];");
  assert.equal(redactSecret("value: tokensecret;", ["tokensecret", "tok"]), "value: [redacted];");
  // non-overlapping shorter secret still redacts elsewhere
  assert.equal(redactSecret("tok + tokensecret", ["tok", "tokensecret"]), "[redacted] + [redacted]");
});

test("redactSecret: no secrets (or none matching) leaves the text unchanged", () => {
  assert.equal(redactSecret("nothing to hide", []), "nothing to hide");
  assert.equal(redactSecret("nothing to hide", [""]), "nothing to hide");
  assert.equal(redactSecret("nothing to hide", ["absent"]), "nothing to hide");
  // an empty-string secret never shatters the text
  assert.equal(redactSecret("abc", ["", "zzz"]), "abc");
});
