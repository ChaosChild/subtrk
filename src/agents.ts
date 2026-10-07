// agents.ts – `subtrk init --agent <harness>`: subtrk's instruction section for
// agent harnesses. Five targets, global paths verified 2026-09-26; the section
// is wrapped in conda-init-style sentinels so a re-run replaces only subtrk's
// own block and removal is a clean delete. The file belongs to the user –
// nothing outside the markers is ever rewritten.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentId = "claude" | "zcode" | "codex" | "opencode" | "agy";

export interface AgentTarget {
  label: string;
  file: string; // absolute; derived from os.homedir() – never manual ~ expansion
  hint: string; // one-line note for the unknown-name listing
}

// Ordered record – the listing and the usage line follow this order. base
// replaces homedir (tests inject a temp dir so tests never touch real files).
export function agentTargets(base: string = homedir()): Record<AgentId, AgentTarget> {
  return {
    claude: { label: "Claude Code", file: join(base, ".claude", "CLAUDE.md"), hint: "global memory file" },
    zcode: { label: "ZCode", file: join(base, ".zcode", "AGENTS.md"), hint: "global instructions" },
    codex: { label: "Codex CLI", file: join(base, ".codex", "AGENTS.md"), hint: "global instructions" },
    opencode: {
      label: "OpenCode",
      file: join(base, ".config", "opencode", "AGENTS.md"),
      hint: "this exact path even on Windows",
    },
    agy: {
      label: "Antigravity",
      file: join(base, ".gemini", "AGENTS.md"),
      hint: "Antigravity global rules (path is ~/.gemini by convention)",
    },
  };
}

export const AGENT_TARGETS: Readonly<Record<AgentId, AgentTarget>> = agentTargets();

export const AGENT_SECTION_BEGIN = "<!-- subtrk:begin -->";
export const AGENT_SECTION_END = "<!-- subtrk:end -->";

// The blurb: a `## subtrk` section an agent of any harness can act on. Keep it
// terse and in sync with the status contract (spec §Output contract) – when a
// provider is added, check whether this text needs updating.
export const AGENT_SECTION = `<!-- subtrk:begin -->
## subtrk

\`subtrk\` reports remaining quota for the AI plans configured on this machine.
Use it before committing to large or long-running work on a provider –
discovering a rate limit mid-task wastes the work – when a provider starts
failing with quota or rate-limit errors, and on wake-ups: \`recheckAfter\` and
\`nextEvent.at\` say when new information can exist, so schedule around them
instead of polling.

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
- a missing provider means the plan is not configured on this machine, not an error

### track - task effort accounting (local only)

- Housekeeping first: run \`subtrk track status\` before starting - if a marker
  you own is still open, stop it (\`track stop --id <id> --status aborted\`) or,
  if it is clearly dead (a crashed session), \`subtrk track prune\`. Never stack
  open markers.
- Before a task you expect to take more than a few minutes:
  \`subtrk track start --task "<short description>" --complexity <xs|s|m|l|xl>\`
  and remember the printed id. xs=single-file tweak, s=focused change+tests,
  m=multi-file feature, l=subsystem, xl=multi-day epic (split it into tracks).
- When finished, aborted or failed: \`subtrk track stop --status done|aborted|failed\`
  (omit --id to close the newest open marker for this folder). subtrk then
  records the task window's real token usage from local harness stores.
- Before committing to large work, ask:
  \`subtrk track estimate --complexity m --provider <id>\`
  If the verdict says p90 does not fit the remaining window, defer, split the
  task, or switch model - discovering a rate limit mid-task wastes the work.
<!-- subtrk:end -->`;

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
