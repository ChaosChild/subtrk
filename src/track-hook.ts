// track-hook.ts – `subtrk track hook --event <e> --harness <h>`: the half of
// task tracking the HARNESS runs (D19). `init --agent --track` registers this
// command in each harness's hook config; the harness fires it at lifecycle
// moments (session start, turn end). It reads the local track store, emits one
// short reminder in the harness's native output shape, and never does anything
// else – no marker writes (a hook cannot know --task, and done-vs-aborted is
// the agent's judgment), no network, no provider probes, no blocking: exit 0
// always, empty output when there is nothing to say. A tiny state file
// throttles nudges to the first fire per session plus open-marker-set changes
// (D5) – the same rule keeps a per-model-call event safe if a future harness
// needs one.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SUBTRK_DIR, scrub } from "./core.ts";
import { readTrackStore, type TrackMarker, type TrackRecord } from "./track.ts";

export const HOOK_EVENTS = ["session-start", "stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_DIALECTS = ["claude", "zcode", "codex"] as const;
export type HookDialect = (typeof HOOK_DIALECTS)[number];

export interface HookInput {
  sessionId?: string; // claude/zcode/codex stdin: session_id
  cwd?: string;
}

// Best-effort stdin JSON parse: harnesses send {session_id, cwd, …}; agy-style
// camelCase (conversationId/workspacePaths) is accepted for the future. Any
// garbage parses to {} – the hook never errors over its input.
export function parseHookInput(raw: string): HookInput {
  const input: HookInput = {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const sid = j.session_id ?? j.conversationId;
    if (typeof sid === "string" && sid !== "") input.sessionId = sid;
    const rawCwd = j.cwd ?? (Array.isArray(j.workspacePaths) ? (j.workspacePaths as unknown[])[0] : undefined);
    if (typeof rawCwd === "string" && rawCwd !== "") input.cwd = rawCwd;
  } catch {
    /* not JSON – run with defaults */
  }
  return input;
}

// Marker scoping: a marker belongs to this session when its project dir IS the
// session cwd or an ancestor of it (an agent may work in a subdirectory of the
// folder the marker was opened in). Win32 paths compare case-insensitively.
function dirMatches(markerDir: string, cwd: string): boolean {
  const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const a = norm(markerDir);
  const b = norm(cwd);
  return a === b || b.startsWith(`${a}${sep}`);
}

export function markersInScope(markers: TrackMarker[], cwd: string): TrackMarker[] {
  return markers.filter((m) => dirMatches(m.project, cwd));
}

export function pausedInScope(records: TrackRecord[], cwd: string): TrackRecord[] {
  return records.filter((r) => r.status === "paused" && dirMatches(r.project, cwd));
}

// The throttle state, as a comparable string: which markers are open and
// which records sit paused (a parked task must surface once per change, like
// an open one – not on every fire, and not never).
export function openStateKey(markers: TrackMarker[], paused: TrackRecord[] = []): string {
  const open = markers.map((m) => m.id).sort();
  const pz = paused.map((p) => p.id).sort();
  const parts: string[] = [];
  if (open.length > 0) parts.push(`open:${open.join(",")}`);
  if (pz.length > 0) parts.push(`paused:${pz.join(",")}`);
  return parts.length > 0 ? parts.join("|") : "none";
}

function clock(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Pure: the reminder text for a state, or null for silence.
//  - session-start: nudge on any state change (first fire included) – nothing
//    open ("start one, guess the ladder in one line"), something open, or a
//    paused task parked for this folder ("resume if this continues it").
//  - stop (turn end): nudge only when something is open or paused AND the
//    state changed since the last nudge – a turn ending markerless is normal.
export function nudgeText(event: HookEvent, markers: TrackMarker[], paused: TrackRecord[] = []): string | null {
  // Turn-end nudges need an OPEN marker: a paused-only state at turn end is
  // usually the pause the agent just made on purpose - telling it to resume
  // its own deliberate pause is noise (B1). Parked tasks surface at session
  // start instead.
  if (event === "stop" && markers.length === 0) return null;
  if (markers.length === 0 && paused.length > 0) {
    const p = paused[0] as TrackRecord;
    const task = p.task.length > 48 ? `${p.task.slice(0, 47)}…` : p.task;
    const more = paused.length > 1 ? ` (+${paused.length - 1} more paused)` : "";
    return scrub(
      `subtrk: track ${p.id} ("${task}") is paused in this folder${more}. ` +
        `If this session continues that work, resume it: subtrk track resume --id ${p.id}; ` +
        `otherwise it stays parked for a later session. New task? ` +
        `subtrk track start --task "<short description>" --complexity <xs|s|m|l|xl>`,
    );
  }
  if (markers.length === 0) {
    return scrub(
      "subtrk: no open track marker. If this session starts a task that produces or changes a deliverable, " +
        'open one first: subtrk track start --task "<short description>" --complexity <xs|s|m|l|xl> ' +
        "(one-line ladder guess, no research – you reassess at stop; playbook: the subtrk-track skill)",
    );
  }
  const first = markers[0] as TrackMarker;
  const task = first.task.length > 48 ? `${first.task.slice(0, 47)}…` : first.task;
  const more = markers.length > 1 ? ` (+${markers.length - 1} more open)` : "";
  return scrub(
    `subtrk: track marker ${first.id} ("${task}") open since ${clock(first.t0)} in this folder${more}. ` +
      `Continue under it, or stop it before new work: subtrk track stop --id ${first.id} ` +
      `--status done|aborted|paused (paused while feedback is pending; resume --id reopens it; ` +
      `--complexity is the final reassessment; playbook: the subtrk-track skill)`,
  );
}

// The native output shape per dialect. claude and zcode inject context via
// hookSpecificOutput.additionalContext; codex SessionStart takes the same
// shape and its Stop wants a top-level systemMessage. Empty nudges emit
// nothing – valid everywhere and required for zcode's strict stdout schema.
export function hookOutput(dialect: HookDialect, event: HookEvent, text: string): string {
  if (dialect === "codex" && event === "stop") return JSON.stringify({ systemMessage: text });
  const eventName = event === "session-start" ? "SessionStart" : "Stop";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

// ---------- throttle state (~/.subtrk/hooks-state.json) ----------

interface HookStateFile {
  schemaVersion: 1;
  sessions: Record<string, { s: string; at: number }>;
}

const STATE_MAX_AGE_MS = 7 * 24 * 3600_000;

function statePath(subtrkDir: string): string {
  return join(subtrkDir, "hooks-state.json");
}

function readState(subtrkDir: string): HookStateFile {
  try {
    const parsed = JSON.parse(readFileSync(statePath(subtrkDir), "utf8")) as HookStateFile | null;
    if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1 && typeof parsed.sessions === "object") {
      return parsed;
    }
  } catch {
    /* absent or unreadable – fresh */
  }
  return { schemaVersion: 1, sessions: {} };
}

// Write-through with GC: entries older than a week go; a lost write costs one
// extra nudge, never an error (the hook must stay silent in failure).
function writeState(subtrkDir: string, state: HookStateFile, key: string, value: string, nowMs: number): void {
  const sessions: HookStateFile["sessions"] = {};
  for (const [k, v] of Object.entries(state.sessions)) {
    if (nowMs - v.at <= STATE_MAX_AGE_MS && k !== key) sessions[k] = v;
  }
  sessions[key] = { s: value, at: nowMs };
  try {
    const path = statePath(subtrkDir);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(subtrkDir, { recursive: true });
      const text = JSON.stringify({ schemaVersion: 1, sessions }, null, 2);
      writeFileSync(tmp, `${text}\n`);
      renameSync(tmp, path);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

// ---------- the verb ----------

export interface TrackHookDeps {
  subtrkDir?: string;
  stdin?: string; // injected in tests; real runs read process.stdin when piped
  cwd?: () => string;
  now?: () => number;
}

function readStdinPiped(): string {
  // Hook stdin is a pipe, never a TTY. readFileSync(0) is the sync, sub-300ms
  // path; when there is nothing piped (manual run) it throws or returns "" –
  // both fine.
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export interface TrackHookOutcome {
  code: number;
  output: string; // "" = silence
}

// Sync by design: a hook must answer in well under the harness timeouts, and
// everything it touches is a local file. Never throws – the worst case is
// silence, printed nothing, exit 0.
export function trackHookCommand(args: { event: string; harness: string }, deps: TrackHookDeps = {}): TrackHookOutcome {
  try {
    const event = args.event as HookEvent;
    const dialect = args.harness as HookDialect;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) return { code: 0, output: "" };
    if (!(HOOK_DIALECTS as readonly string[]).includes(dialect)) return { code: 0, output: "" };

    const raw = deps.stdin !== undefined ? deps.stdin : readStdinPiped();
    const input = parseHookInput(raw);
    const cwd = resolve(input.cwd ?? (deps.cwd ? deps.cwd() : process.cwd()));
    const nowMs = deps.now ? deps.now() : Date.now();
    const subtrkDir = deps.subtrkDir ?? SUBTRK_DIR;

    const store = readTrackStore(subtrkDir);
    const scoped = markersInScope(store.markers, cwd);
    const paused = pausedInScope(store.records, cwd);
    const current = openStateKey(scoped, paused);

    // Session key: the harness session id, or a cwd+hour fallback so even
    // input-less fires stay bounded.
    const key = input.sessionId ?? `anon:${cwd}:${Math.floor(nowMs / 3600_000)}`;
    const state = readState(subtrkDir);
    const seen = existsSync(statePath(subtrkDir)) ? state.sessions[key]?.s : undefined;
    if (seen === current) return { code: 0, output: "" }; // D5: state-change only

    const text = nudgeText(event, scoped, paused);
    writeState(subtrkDir, state, key, current, nowMs);
    if (text === null) return { code: 0, output: "" };
    return { code: 0, output: hookOutput(dialect, event, text) };
  } catch {
    return { code: 0, output: "" };
  }
}
