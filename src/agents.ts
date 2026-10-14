// agents.ts – `subtrk init --agent <harness>`: subtrk's instruction section for
// agent harnesses. Five targets, global paths verified 2026-09-26; the section
// is wrapped in conda-init-style sentinels so a re-run replaces only subtrk's
// own block and removal is a clean delete. The file belongs to the user –
// nothing outside the markers is ever rewritten.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentId = "claude" | "zcode" | "codex" | "opencode" | "agy";

export interface AgentTarget {
  label: string;
  file: string; // absolute; derived from os.homedir() – never manual ~ expansion
  hint: string; // one-line note for the unknown-name listing
  skillsDirs: string[]; // harness skills roots; subtrk owns <dir>/subtrk*/ there
}

// Ordered record – the listing and the usage line follow this order. base
// replaces homedir (tests inject a temp dir so tests never touch real files).
export function agentTargets(base: string = homedir()): Record<AgentId, AgentTarget> {
  return {
    claude: {
      label: "Claude Code",
      file: join(base, ".claude", "CLAUDE.md"),
      hint: "global memory file",
      skillsDirs: [join(base, ".claude", "skills")],
    },
    zcode: {
      label: "ZCode",
      file: join(base, ".zcode", "AGENTS.md"),
      hint: "global instructions",
      skillsDirs: [join(base, ".zcode", "skills")],
    },
    codex: {
      label: "Codex CLI",
      file: join(base, ".codex", "AGENTS.md"),
      hint: "global instructions",
      skillsDirs: [join(base, ".codex", "skills")],
    },
    opencode: {
      label: "OpenCode",
      file: join(base, ".config", "opencode", "AGENTS.md"),
      hint: "this exact path even on Windows",
      skillsDirs: [join(base, ".config", "opencode", "skills")],
    },
    agy: {
      label: "Antigravity",
      file: join(base, ".gemini", "AGENTS.md"),
      hint: "Antigravity global rules (path is ~/.gemini by convention)",
      skillsDirs: [join(base, ".gemini", "config", "skills"), join(base, ".gemini", "antigravity-cli", "skills")],
    },
  };
}

export const AGENT_TARGETS: Readonly<Record<AgentId, AgentTarget>> = agentTargets();

export const AGENT_SECTION_BEGIN = "<!-- subtrk:begin -->";
export const AGENT_SECTION_END = "<!-- subtrk:end -->";

// The blurb comes in two tiers (D19). Since v0.22 both tiers are SLIM: the
// detailed contracts moved on demand into skills (see SUBTRK_SKILL_MD /
// SUBTRK_TRACK_SKILL_MD below) because an AGENTS.md body is always-in-context
// cost. Keep the sections terse and in sync with the skills.
const AGENT_STATUS_BODY = `## subtrk

\`subtrk\` reports remaining quota for the AI plans configured on this machine.
Run \`subtrk status --json\` before committing to large or long-running provider
work, when a provider fails with quota or rate-limit errors, and on wake-ups -
\`nextEvent.at\` (or \`recheckAfter\` when absent) says when new information can
exist, so schedule around it instead of polling. The full contract (windows,
error kinds and remedies, exit codes, cache etiquette) is in the \`subtrk\`
skill. Run \`subtrk auth refresh\` only after the operator says go - it opens a
browser tab; surface any other remedy verbatim. A missing provider is not
configured, not an error.`;

// Tier 2 adds the track trigger – a pointer, not the playbook. The playbook
// lives in the subtrk-track skill; the lifecycle hooks nudge at the moments.
const AGENT_TRACK_SECTION = `### track

Track every task that produces or changes a deliverable. First actions of any
task: \`subtrk track status\` (it lists every folder and session - touch only
markers you opened in this folder), then
\`subtrk track start --task "<short description>" --complexity <xs|s|m|l|xl>\`
(one-line ladder guess, no research; remember the printed id). When the task
ends: \`subtrk track stop --status done|aborted|failed|paused --complexity
<reassessed>\` (omit --id to close the newest open marker for this folder). The
full lifecycle playbook (pause/resume, reassessment, subagent session pins) is
the \`subtrk-track\` skill; hooks will remind you at the right moments.`;

// ---------- skills (on-demand depth; installed into each harness's skills dir) ----------

export const SUBTRK_SKILL_NAME = "subtrk";
export const SUBTRK_TRACK_SKILL_NAME = "subtrk-track";

// Tier 1 skill: the quota/status contract that used to live in AGENTS.md.
export const SUBTRK_SKILL_MD = `---
name: subtrk
description: >
  Use before committing to large or long-running AI provider work, before
  handing work to another agent, when a provider fails with quota or
  rate-limit errors, and when scheduling a wake-up. Reports remaining quota
  per plan via subtrk status --json (machine contract: windows,
  nextEvent.at, recheckAfter, error kinds + remedies, exit codes).
---

# subtrk – quota status contract

Plain \`subtrk\` or \`subtrk status\` prints a compact view; \`subtrk status --json\`
is the machine-readable contract:

- \`providers[].windows[]\` – per-provider usage windows with \`usedPercent\` and \`resetsAt\` (ISO-8601 UTC)
- \`nextEvent.at\` – the earliest time new information can exist; schedule wake-ups there, never poll
- \`recheckAfter\` – heartbeat when no \`nextEvent\` applies
- \`error.kind\` – branch on it, never on message text; \`error.remedy\` is the exact command that fixes the error
- exit codes: 0 ran · 1 runtime failure · 2 usage error · 3 --strict violation
- plain calls go through a shared TTL cache and are polite; \`--fresh\` only when a result is actively stale
- when an error's \`remedy\` is \`subtrk auth refresh --provider <id>\`, the provider's login expired – you may run that command yourself, but it opens a browser tab on this machine: tell the operator first and wait for their go
- any other remedy is an interactive operator step (logins, setup prompts) – surface it verbatim instead of attempting it
- a missing provider means the plan is not configured on this machine, not an error`;

// Tier 2 skill: the lifecycle playbook that used to live in AGENTS.md.
export const SUBTRK_TRACK_SKILL_MD = `---
name: subtrk-track
description: >
  Use when starting, pausing, resuming or finishing any task that changes a
  deliverable - code, docs, research, planning, batch runs, releases - when
  dispatching a subagent, or when a subtrk hook nudge names this skill.
  Covers the marker lifecycle (track start / stop / resume / recode) and
  the complexity ladder.
---

# subtrk track – the lifecycle playbook

- Applies to every task that produces or changes a deliverable - code, docs,
  research writeups, planning, batch runs, releases - and anything expected
  to span more than a few minutes. When unsure, start a marker: an extra
  record costs ~350 bytes; a missing one is unrecoverable - that window's
  burn can never be attributed again, and stats/estimate lose the calibration.
- First actions of the task, before the first file read or search:
  1. \`subtrk track status\` - it lists every folder and session. Touch only
     markers you opened in this folder: stop one that is no longer live
     (\`track stop --id <id> --status aborted\`), resume a paused task that
     this work continues (\`track resume --id <id>\`), prune dead ones
     (\`subtrk track prune\`). Never stack open markers.
  2. \`subtrk track start --task "<short description>" --complexity <xs|s|m|l|xl>\`
     - remember the printed id. The complexity is a ONE-LINE ladder guess -
     no research, no lookups; accuracy is earned at stop. xs=quick edit or
     doc tweak, s=focused change, m=multi-file feature, l=subsystem,
     xl=multi-day epic (split into tracks).
- Complexity means the WHOLE tree's burn, delegation included: an
  orchestrated task carries its fleet. Judge by total tokens, never by your
  own session's effort or the wall clock - parallel workers hide epic scale.
  A subagent's own marker covers its own subtree - that is the nesting, not
  double counting.
- Lifecycle: stop \`--status done\` once the deliverable is handed over and
  nothing YOU started is still running (timer, CI run, background command,
  a reply you asked for). A possible later review is not pending - if it
  comes, resume. In a one-shot run with no way back, stop before your last
  message. While feedback is pending: \`track stop --status paused\`; when it
  lands and the work continues: \`track resume --id <id>\` (same identity, t0
  kept). Omitting --id stops the newest open marker for this folder. A
  genuinely new instruction closes the current marker first.
- ALWAYS reassess complexity at stop - hard rule. The stop output shows the
  delegation split; drifted labels get fixed right there
  (\`track stop --complexity <cx>\`), or afterwards on the record
  (\`subtrk track recode --id <id> --complexity <cx>\`).
- When you dispatch a subagent, put this in its brief:
  \`subtrk track start --task "<sub-task>" --complexity <cx> --session <pin>\`
  plus the matching stop. The pin: zcode
  \`sess_subagent_agent_<agentId>\` and claude \`agent-<agentId>\` both use the
  agentId from the spawn RESULT - it does not exist before the spawn, so
  relay it to the child as your first message after it starts; codex and agy
  children self-pin (\`$CODEX_THREAD_ID\`; the SessionStart hook payload's
  conversationId). A child without a pin still tracks - unpinned is better
  than untracked.
- Before committing to large work, ask:
  \`subtrk track estimate --complexity m --provider <id>\`
  (provider ids: \`subtrk status --json\` -> providers[].id; no provider in
  mind: \`--suggest\`). If the verdict says p90 does not fit the remaining
  window, defer, split the task, or switch model - discovering a rate limit
  mid-task wastes the work.`;

// Idempotent skill write: subtrk owns <skillsDir>/subtrk*/ outright.
export function writeAgentSkill(skillsDir: string, name: string, body: string): "created" | "updated" {
  const skillFile = join(skillsDir, name, "SKILL.md");
  let existed = true;
  try {
    readFileSync(skillFile, "utf8");
  } catch {
    existed = false;
  }
  mkdirSync(dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, body.endsWith("\n") ? body : `${body}\n`);
  return existed ? "updated" : "created";
}

// Symmetric removal (tier downgrade strips the track skill).
export function removeAgentSkill(skillsDir: string, name: string): boolean {
  const skillDir = join(skillsDir, name);
  if (!existsSync(skillDir)) return false;
  rmSync(skillDir, { recursive: true, force: true });
  return true;
}

// The full marked section for a tier. Tier 2 = tier 1 + the track section.
export function agentSectionFor(track: boolean): string {
  const body = track ? `${AGENT_STATUS_BODY}\n\n${AGENT_TRACK_SECTION}` : AGENT_STATUS_BODY;
  return `${AGENT_SECTION_BEGIN}\n${body}\n${AGENT_SECTION_END}`;
}

// Pure: add or replace the marked section. No markers -> append with one blank
// line before. Markers present -> replace only the block between the first
// begin/end pair, everything outside is preserved. A begin marker without an
// end means the file was hand-truncated – replace from begin to EOF.
export function upsertAgentSection(existing: string | null, section: string): string {
  if (existing === null || existing.trim() === "") return section;
  const begin = existing.indexOf(AGENT_SECTION_BEGIN);
  if (begin === -1) return `${existing.replace(/\s+$/, "")}\n\n${section}`;
  const end = existing.indexOf(AGENT_SECTION_END, begin);
  const after = end === -1 ? "" : existing.slice(end + AGENT_SECTION_END.length);
  return `${existing.slice(0, begin)}${section}${after}`;
}

// Read-modify-write, temp+rename in the same directory (the core.ts cache
// discipline, ~2 attempts) – but the user's file is load-bearing, so a failed
// write throws instead of giving up silently. created = the file did not exist.
export function applyAgentSection(targetPath: string, section: string): { status: "created" | "updated" } {
  let existing: string | null = null;
  try {
    existing = readFileSync(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const next = upsertAgentSection(existing, section);
  const payload = next.endsWith("\n") ? next : `${next}\n`;
  const tmp = `${targetPath}.${process.pid}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, targetPath);
      return { status: existing === null ? "created" : "updated" };
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      if (attempt >= 1) throw err;
    }
  }
}

// Read-only check for the listing: is subtrk's marked block in the file today?
export function hasAgentSection(filePath: string): boolean {
  try {
    return readFileSync(filePath, "utf8").includes(AGENT_SECTION_BEGIN);
  } catch {
    return false;
  }
}

// The unknown/missing-name response: every supported harness with its file and
// whether the section is present right now, then the usage line. On stderr.
export function printAgentListing(base: string = homedir()): void {
  for (const [id, t] of Object.entries(agentTargets(base))) {
    const state = hasAgentSection(t.file) ? "section present" : "section absent";
    console.error(`  ${id} – ${t.label} – ${t.file} – ${state} – ${t.hint}`);
  }
  console.error("usage: subtrk init --agent <claude|zcode|codex|opencode|agy>");
}
