// agent-hooks.ts – the install/remove half of `subtrk init --agent --track`
// (D19). Registers `subtrk track hook` as a lifecycle hook so the harness
// itself reminds agents to use `track start`/`track stop`:
//
//   claude – merge into ~/.claude/settings.json   hooks.SessionStart/.Stop
//   zcode  – merge into ~/.zcode/cli/config.json  hooks.events.* (+ enabled)
//   codex  – a sentinel-marked [[hooks.*]] block in ~/.codex/config.toml
//
// opencode and agy ship instructions only in v0.1.19. Every handler subtrk
// writes carries the literal `subtrk track hook` in its command – that literal
// is the only thing removal ever matches, so a user's own hooks survive both
// directions. JSON targets get a one-time `.subtrk-bak` copy before the first
// modification; codex's TOML is managed as a marked block, no parsing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HookHarnessId = "claude" | "zcode" | "codex";
export const HOOK_HARNESSES: readonly HookHarnessId[] = ["claude", "zcode", "codex"];

export function hookCapable(id: string): id is HookHarnessId {
  return (HOOK_HARNESSES as readonly string[]).includes(id);
}

// The literal identifying our handlers in a user's hook config. Never change
// without a removal path for the old one.
export const HOOK_TAG = "subtrk track hook";

type HookEvent = "session-start" | "stop";

function hookCommand(event: HookEvent, harness: HookHarnessId): string {
  return `subtrk track hook --event ${event} --harness ${harness}`;
}

export interface HookInstallResult {
  ok: boolean;
  changed: boolean;
  lines: string[]; // already formatted "[ok]      …"-style lines for init
}

// ---------- shared file discipline ----------

// Temp+rename in the target's directory, ~2 attempts (the agents.ts writer's
// discipline). Throws on the second failure – init reports it, nothing silent.
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, text);
      renameSync(tmp, path);
      return;
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

// One-time backup before the first modification of a user-owned JSON file.
function backupOnce(path: string): void {
  const bak = `${path}.subtrk-bak`;
  if (existsSync(bak)) return;
  try {
    copyFileSync(path, bak);
  } catch {
    /* best effort – the atomic write is the real safety net */
  }
}

function readJsonFile(path: string): { file: Record<string, unknown> | null; reason?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { file: {} }; // absent = start fresh
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { file: parsed as Record<string, unknown> };
    }
    return { file: null, reason: "not a JSON object" };
  } catch {
    return { file: null, reason: "invalid JSON" };
  }
}

// A matcher-group is ours when any of its handlers runs our command.
function isOurGroup(group: unknown): boolean {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h !== null &&
      typeof h === "object" &&
      typeof (h as { command?: unknown }).command === "string" &&
      ((h as { command: string }).command as string).includes(HOOK_TAG),
  );
}

function ourHandler(event: HookEvent, harness: HookHarnessId, kind: "claude" | "zcode"): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: "command", command: hookCommand(event, harness) };
  if (kind === "claude")
    handler.timeout = 10; // seconds
  else handler.timeoutMs = 10_000;
  return handler;
}

// Upsert our group into eventKey's array of matcher-groups, preserving every
// foreign group. `install=false` strips ours instead. `changed` is true only
// when the resulting array differs in VALUE from what was there – a re-install
// of our own unchanged group is a no-op. An absent/invalid array is treated as
// empty (never a failure – a malformed user value is left exactly as found).
function upsertEventGroups(
  container: Record<string, unknown>,
  eventKey: string,
  group: Record<string, unknown> | null,
): { changed: boolean; malformed: boolean } {
  const raw = container[eventKey];
  if (raw !== undefined && !Array.isArray(raw)) return { changed: false, malformed: true };
  const orig = Array.isArray(raw) ? (raw as unknown[]) : null;
  const groups = orig === null ? [] : orig.filter((g) => !isOurGroup(g));
  if (group !== null) groups.push(group);
  const same =
    orig !== null &&
    orig.length === groups.length &&
    orig.every((g, i) => JSON.stringify(g) === JSON.stringify(groups[i]));
  if (same || (orig === null && groups.length === 0)) return { changed: false, malformed: false };
  if (groups.length > 0) container[eventKey] = groups;
  else delete container[eventKey];
  return { changed: true, malformed: false };
}

// ---------- claude ----------

function claudeSettingsPath(base: string): string {
  return join(base, ".claude", "settings.json");
}

function claudeHooks(base: string, install: boolean): HookInstallResult {
  const path = claudeSettingsPath(base);
  const { file, reason } = readJsonFile(path);
  if (!file) return { ok: false, changed: false, lines: [`[failed]  hooks – ${path} is ${reason}; not touched`] };
  // A present-but-malformed hooks key is the user's; never clobbered.
  if (
    file.hooks !== undefined &&
    (file.hooks === null || typeof file.hooks !== "object" || Array.isArray(file.hooks))
  ) {
    return {
      ok: false,
      changed: false,
      lines: ["[failed]  hooks – settings.json 'hooks' is not an object; not touched"],
    };
  }
  const existed = existsSync(path);
  if (existed) backupOnce(path);
  const hooks = (file.hooks ?? {}) as Record<string, unknown>;
  const g1 = upsertEventGroups(
    hooks,
    "SessionStart",
    install ? { hooks: [ourHandler("session-start", "claude", "claude")] } : null,
  );
  const g2 = upsertEventGroups(hooks, "Stop", install ? { hooks: [ourHandler("stop", "claude", "claude")] } : null);
  const changed = g1.changed || g2.changed;
  if (!changed) return { ok: true, changed: false, lines: [] };
  if (Object.keys(hooks).length === 0) delete file.hooks;
  else file.hooks = hooks;
  writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return {
    ok: true,
    changed: true,
    lines: [
      `[ok]      hooks – ${install ? "installed" : "removed"} SessionStart + Stop in ${path}` +
        (existed ? "" : " (file created)"),
    ],
  };
}

// ---------- zcode ----------

function zcodeConfigPath(base: string): string {
  return join(base, ".zcode", "cli", "config.json");
}

function zcodeHooks(base: string, install: boolean): HookInstallResult {
  const path = zcodeConfigPath(base);
  const { file, reason } = readJsonFile(path);
  if (!file) return { ok: false, changed: false, lines: [`[failed]  hooks – ${path} is ${reason}; not touched`] };
  const existed = existsSync(path);
  if (existed) backupOnce(path);
  // Config-file hooks are disabled until hooks.enabled=true (zcode pitfall #1);
  // installing flips it and says so – that enables the runner globally.
  const rawHooks = file.hooks;
  if (rawHooks !== null && typeof rawHooks === "object" && !Array.isArray(rawHooks)) {
    const hooks = rawHooks as Record<string, unknown>;
    let events: Record<string, unknown> | null = null;
    if (hooks.events !== undefined) {
      if (hooks.events === null || typeof hooks.events !== "object" || Array.isArray(hooks.events)) {
        return {
          ok: false,
          changed: false,
          lines: ["[failed]  hooks – config.json 'hooks.events' is not an object; not touched"],
        };
      }
      events = hooks.events as Record<string, unknown>;
    }
    const lines: string[] = [];
    const work: Record<string, unknown> = events ?? {};
    const g1 = upsertEventGroups(
      work,
      "SessionStart",
      install ? { hooks: [ourHandler("session-start", "zcode", "zcode")] } : null,
    );
    const g2 = upsertEventGroups(work, "Stop", install ? { hooks: [ourHandler("stop", "zcode", "zcode")] } : null);
    const changed = g1.changed || g2.changed;
    if (install && hooks.enabled !== true) {
      hooks.enabled = true;
      lines.push(
        "[note]    hooks – set hooks.enabled=true in ~/.zcode/cli/config.json (required for any config hook to run)",
      );
    }
    if (Object.keys(work).length === 0) {
      if (events !== null) delete hooks.events;
    } else {
      hooks.events = work;
    }
    if (!changed && lines.length === 0) return { ok: true, changed: false, lines: [] };
    if (Object.keys(hooks).length === 0) delete file.hooks;
    writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
    if (changed) lines.unshift(`[ok]      hooks – ${install ? "installed" : "removed"} SessionStart + Stop in ${path}`);
    return { ok: true, changed, lines };
  }
  if (!install) return { ok: true, changed: false, lines: [] };
  file.hooks = {
    enabled: true,
    events: {
      SessionStart: [{ hooks: [ourHandler("session-start", "zcode", "zcode")] }],
      Stop: [{ hooks: [ourHandler("stop", "zcode", "zcode")] }],
    },
  };
  const lines = [
    `[ok]      hooks – installed SessionStart + Stop in ${path}${existed ? "" : " (file created)"}`,
    "[note]    hooks – set hooks.enabled=true in ~/.zcode/cli/config.json (required for any config hook to run)",
  ];
  writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return { ok: true, changed: true, lines };
}

// ---------- codex ----------

function codexConfigPath(base: string): string {
  return join(base, ".codex", "config.toml");
}

const CODEX_BEGIN = "# subtrk:hooks:begin";
const CODEX_END = "# subtrk:hooks:end";

function codexBlock(): string {
  // TOML literal strings (single quotes) – the commands contain spaces but no
  // quotes, so no escaping is ever needed. command_windows mirrors the command:
  // subtrk resolves the same way under cmd through the .cmd shim.
  return `${CODEX_BEGIN} – subtrk track hooks (installed by \`subtrk init --agent codex --track\`)
[[hooks.SessionStart.hooks]]
type = "command"
command = '${hookCommand("session-start", "codex")}'
command_windows = '${hookCommand("session-start", "codex")}'
timeout = 10

[[hooks.Stop.hooks]]
type = "command"
command = '${hookCommand("stop", "codex")}'
command_windows = '${hookCommand("stop", "codex")}'
timeout = 10
${CODEX_END}`;
}

// Sentinel-block upsert (the AGENTS.md discipline, applied to TOML): replace
// between markers when present, else append. Removal deletes the block. No
// TOML parsing – repeated [[hooks.*]] tables are legal and append, so ours
// never interact with the user's own hook tables.
function codexHooks(base: string, install: boolean): HookInstallResult {
  const path = codexConfigPath(base);
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  const existing = text;
  let next: string;
  if (existing === null) {
    if (!install) return { ok: true, changed: false, lines: [] };
    next = `${codexBlock()}\n`;
  } else {
    const begin = existing.indexOf(CODEX_BEGIN);
    if (begin === -1) {
      if (!install) return { ok: true, changed: false, lines: [] };
      const trimmed = existing.replace(/\s+$/, "");
      next = `${trimmed}\n\n${codexBlock()}\n`;
    } else {
      const end = existing.indexOf(CODEX_END, begin);
      const after = end === -1 ? "" : existing.slice(end + CODEX_END.length);
      if (!install) {
        const before = existing.slice(0, begin).replace(/\n{3,}$/, "\n\n");
        next = `${before.endsWith("\n") || before === "" ? before : `${before}\n`}${after.replace(/^\n/, "")}`;
        if (next.trim() === "") return { ok: true, changed: false, lines: [] };
      } else {
        next = `${existing.slice(0, begin)}${codexBlock()}${after}`;
      }
    }
  }
  writeAtomic(path, next);
  const lines = [
    `[ok]      hooks – ${install ? "installed" : "removed"} [[hooks.SessionStart/.Stop]] block in ${path}`,
  ];
  if (install) {
    lines.push("[note]    hooks – run /hooks once inside Codex to review and trust the new hooks (trust is hash-tied)");
  }
  return { ok: true, changed: true, lines };
}

// ---------- entry points ----------

export function installAgentHooks(harness: HookHarnessId, base: string = homedir()): HookInstallResult {
  if (harness === "claude") return claudeHooks(base, true);
  if (harness === "zcode") return zcodeHooks(base, true);
  return codexHooks(base, true);
}

export function removeAgentHooks(harness: HookHarnessId, base: string = homedir()): HookInstallResult {
  if (harness === "claude") return claudeHooks(base, false);
  if (harness === "zcode") return zcodeHooks(base, false);
  return codexHooks(base, false);
}
