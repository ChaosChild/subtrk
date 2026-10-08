// agents.test.ts – the `init --agent` machinery: the pure marker upsert, the
// temp+rename file writer, the target table. Tests inject temp dirs and never
// touch real home files.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentSectionFor, agentTargets, applyAgentSection, upsertAgentSection } from "../src/agents.ts";

test("agentSectionFor: two tiers over one shared status body", () => {
  const tier1 = agentSectionFor(false);
  const tier2 = agentSectionFor(true);
  assert.ok(tier1.includes("## subtrk"), "tier 1 has the status section");
  assert.ok(!tier1.includes("### track"), "tier 1 is silent about tracking (D3)");
  assert.ok(tier2.includes("### track"), "tier 2 adds the track section");
  assert.ok(tier2.includes("before the first file read or search"), "tier 2 carries the rewritten trigger");
  assert.ok(!tier2.includes("a task you expect to take more than a few minutes"), "the predictive gate is gone");
  for (const t of [tier1, tier2]) {
    assert.equal(t.split("<!-- subtrk:begin -->").length - 1, 1, "exactly one begin sentinel");
    assert.equal(t.split("<!-- subtrk:end -->").length - 1, 1, "exactly one end sentinel");
  }
  // The status body is shared verbatim: everything except the track block.
  const strip = (s: string): string => s.replace(/\n\n### track[\s\S]*?(?=\n<!-- subtrk:end -->)/, "");
  assert.equal(strip(tier2), tier1);
});

test("upsertAgentSection: null or blank -> the section alone", () => {
  assert.equal(upsertAgentSection(null, "SEC"), "SEC");
  assert.equal(upsertAgentSection("", "SEC"), "SEC");
  assert.equal(upsertAgentSection("   \n", "SEC"), "SEC");
});

test("upsertAgentSection: no markers -> appended with one blank line before", () => {
  assert.equal(upsertAgentSection("mine\n", "SEC"), "mine\n\nSEC");
  assert.equal(upsertAgentSection("mine\n\n\n", "SEC"), "mine\n\nSEC", "trailing whitespace collapses");
});

test("upsertAgentSection: markers -> only the block between them is replaced", () => {
  const existing = "before\n\n<!-- subtrk:begin -->\nold\n<!-- subtrk:end -->\n\nafter\n";
  assert.equal(upsertAgentSection(existing, "SEC"), "before\n\nSEC\n\nafter\n");
});

test("upsertAgentSection: unterminated begin -> replace from begin to EOF", () => {
  assert.equal(upsertAgentSection("head\n\n<!-- subtrk:begin -->\ntruncated", "SEC"), "head\n\nSEC");
});

test("upsertAgentSection: double apply -> the section appears exactly once", () => {
  const once = upsertAgentSection("keep me\n", agentSectionFor(true));
  const twice = upsertAgentSection(once, agentSectionFor(true));
  assert.equal(twice.split("<!-- subtrk:begin -->").length - 1, 1);
  assert.equal(twice.split("## subtrk").length - 1, 1);
  assert.ok(twice.startsWith("keep me\n\n"), "user text preserved");
});

test("applyAgentSection: created when absent, updated when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-agents-"));
  try {
    const file = join(dir, ".claude", "CLAUDE.md");
    assert.deepEqual(applyAgentSection(file, agentSectionFor(true)), { status: "created" });
    assert.equal(readFileSync(file, "utf8"), `${agentSectionFor(true)}\n`, "created file holds only the section");
    assert.deepEqual(applyAgentSection(file, agentSectionFor(true)), { status: "updated" });
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.split("<!-- subtrk:begin -->").length - 1, 1, "idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentSection: the user's text outside the markers survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-agents-"));
  try {
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "my rules\n");
    applyAgentSection(file, agentSectionFor(true));
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.startsWith("my rules\n\n<!-- subtrk:begin -->"));
    assert.ok(raw.endsWith("<!-- subtrk:end -->\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentTargets: five ids in order, base replaces homedir", () => {
  const t = agentTargets(join("base", "x"));
  assert.deepEqual(Object.keys(t), ["claude", "zcode", "codex", "opencode", "agy"]);
  assert.equal(t.claude.file, join("base", "x", ".claude", "CLAUDE.md"));
  assert.equal(t.opencode.file, join("base", "x", ".config", "opencode", "AGENTS.md"));
  assert.equal(t.agy.file, join("base", "x", ".gemini", "AGENTS.md"));
});
