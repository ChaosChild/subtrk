// alibaba – Model Studio Token Plan (international: credits, 30-day cycle)
// via the official Bailian CLI (`bl`). `bl usage token-plan` drops the monthly
// fields (formatter bug as of bl 2.0.1), so we use bl's raw gateway passthrough:
// `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/*`.
// Fixed literal commands; nothing is ever interpolated into a command line.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credits, ProviderError, ProviderModule, ProviderResult, RefreshResult, Window } from "../core.ts";
import { withCrossProcessLock } from "../lib/fetch-lock.ts";

const BL_TIMEOUT_MS = 10_000;
// The console re-login blocks on the browser callback and bl has its own idle
// timeout – give it a generous budget instead of the probe's 10s.
const REFRESH_TIMEOUT_MS = 300_000;
// bl self-updates: on a "significant" version delta its runtime prints a
// banner to stderr, then runs `npm install -g bailian-cli@latest` as a
// blocking child of the very command we spawned. Killing that tree
// mid-extraction truncates files in the global install and breaks bl for
// every caller until someone reinstalls it (2026-10-20: a 10s exec-timeout
// kill landed mid-install and cut one sdk chunk to 27,045 of 47,980 bytes).
// So a detected update is supervised for up to this long and never killed.
export const BL_UPDATE_CAP_MS = 300_000;
// The banner, printed before the install starts (plain text when piped –
// bl only emits ANSI colors on a TTY):
//   ⚡ Significant update detected: 2.3.3 → 2.4.0
//   Auto-updating to keep your CLI up to date...
const UPDATE_BANNER = /(major|significant) update detected|auto-updating/i;
// Wording-independent fallback: bl rewrites this file right before installing.
const BL_UPDATE_STATE = join(homedir(), ".bailian", "update-state.json");
const MAX_OUTPUT = 1_000_000; // the old exec() default maxBuffer

const API_USAGE = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const API_SUBSCRIPTION = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
const API_QUOTA_CONFIG = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";

function callArgs(api: string): { literal: string; args: string[] } {
  return {
    literal: `bl console call --api ${api} --data "{}" --output json`,
    args: ["bl", "console", "call", "--api", api, "--data", "{}", "--output", "json"],
  };
}

interface BlRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  toolMissing: boolean;
  timedOut: boolean;
  /** bl's self-update ran during this invocation (it may still have answered). */
  selfUpdated: boolean;
  /** supervised update overran BL_UPDATE_CAP_MS; the child was left to finish on its own. */
  updateAbandoned: boolean;
  /** another subtrk process held the bl lock for the whole wait – bl never ran. */
  busy: boolean;
}

interface SuperviseOptions {
  timeoutMs?: number;
  updateCapMs?: number;
  tickMs?: number;
  /** Override the update-state file to watch, or null to disable the fallback (tests). */
  statePath?: string | null;
}

function snapshotState(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

// Runs whose bl is currently sitting out a self-update. serve() drains these
// at shutdown so process exit never lands mid-install (see runSupervised).
const activeSelfUpdates = new Set<Promise<BlRun>>();
export function pendingSelfUpdates(): Promise<BlRun>[] {
  return [...activeSelfUpdates];
}

/**
 * Spawn bl under a supervisor. Normal runs are killed at `timeoutMs`, exactly
 * like the old `exec({ timeout })`. Once the update banner appears (or bl's
 * update-state file changes), the run is treated as a self-update: the budget
 * widens to `updateCapMs` and the child is NEVER killed – at the cap it is
 * abandoned (left running, detached) rather than terminated, because a kill
 * mid-`npm install` is what corrupts the global install. While supervised,
 * Ctrl+C is deferred for the same reason: a signal-driven exit tears down the
 * child tree. Exported for the supervisor tests.
 */
export function runSupervised(
  literal: string,
  args: readonly string[],
  {
    timeoutMs = BL_TIMEOUT_MS,
    updateCapMs = BL_UPDATE_CAP_MS,
    tickMs = 100,
    statePath = BL_UPDATE_STATE,
  }: SuperviseOptions = {},
): Promise<BlRun> {
  let resolveRun: (run: BlRun) => void;
  const promise = new Promise<BlRun>((resolve) => {
    resolveRun = resolve;
  });
  const out: BlRun = {
    ok: false,
    stdout: "",
    stderr: "",
    toolMissing: false,
    timedOut: false,
    selfUpdated: false,
    updateAbandoned: false,
    busy: false,
  };

  let stdout = "";
  let stderrTail = ""; // banner-sized tail; guards against banners split across chunks
  let updateMode = false;
  let settled = false;

  const sameState = (
    a: { mtimeMs: number; size: number } | null,
    b: { mtimeMs: number; size: number } | null,
  ): boolean => a === b || (a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size);
  const state0 = statePath ? snapshotState(statePath) : undefined;
  const stateChanged = (): boolean =>
    statePath !== null && statePath !== undefined && !sameState(snapshotState(statePath), state0);

  // Kill bl and every descendant. A bare child.kill() is not enough: on
  // Windows the direct child is cmd.exe (bl's node lives one level down and
  // survives, orphaned, holding our pipe write-ends); taskkill /T is the
  // reliable tree kill. Never called in update mode – that is the point.
  const killTree = (): void => {
    if (process.platform === "win32") {
      if (child.pid === undefined) return;
      const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      tk.on("error", () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
      return;
    }
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); // the detached process group
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  };

  const child =
    process.platform === "win32"
      ? // .cmd shim requires the shell; the literal is a fixed string, never interpolated.
        spawn(literal, { shell: true, windowsHide: true })
      : // Own process group so the timeout can signal bl AND its children
        // (an update's npm) together; a bare kill() would orphan them.
        spawn(args[0], args.slice(1), { windowsHide: true, detached: true });

  let sigintArmed = false;
  const sigintHandler = (): void => {
    // Second Ctrl+C is honoured; the first buys the install time to land.
    if (sigintArmed) {
      process.exit(130);
      return;
    }
    sigintArmed = true;
    process.stderr.write(
      "subtrk: bl is mid-self-update – deferring exit so the install is not corrupted (Ctrl+C again to force)\n",
    );
  };
  const armSignals = (): void => {
    process.on("SIGINT", sigintHandler);
    sigintArmed = false;
  };
  const detachSignals = (): void => process.off("SIGINT", sigintHandler);

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearInterval(tick);
    detachSignals();
    out.stdout = stdout;
    resolveRun(out);
  };

  const enterUpdateMode = (): void => {
    if (updateMode) return;
    updateMode = true;
    out.selfUpdated = true;
    activeSelfUpdates.add(promise);
    armSignals();
  };

  const startedAt = performance.now();
  const tick = setInterval((): void => {
    const elapsed = performance.now() - startedAt;
    if (updateMode) {
      if (elapsed >= Math.max(timeoutMs, updateCapMs)) {
        // Never kill mid-update: detach and let it finish on its own. The
        // still-draining stdio streams keep this process alive until the
        // child exits, so a plain `subtrk status` also waits it out.
        out.updateAbandoned = true;
        child.unref();
        settle();
      }
      return;
    }
    if (elapsed >= timeoutMs) {
      // Last-chance state check before the axe: a renamed banner must not
      // turn into a mid-install kill.
      if (stateChanged()) {
        enterUpdateMode();
        return;
      }
      out.timedOut = true;
      killTree();
    }
  }, tickMs);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    out.stderr = (out.stderr + text).slice(-MAX_OUTPUT);
    stderrTail = (stderrTail + text).slice(-200);
    if (UPDATE_BANNER.test(stderrTail)) enterUpdateMode();
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    out.toolMissing = err.code === "ENOENT";
    settle();
  });
  // "close" can stall forever: a killed cmd.exe leaves an orphaned grandchild
  // holding the pipe write-ends, so exit + a short drain grace settles the
  // run instead of waiting for it. A killed run's tail output is worthless.
  let exitGrace: NodeJS.Timeout | undefined;
  child.on("exit", (code: number | null) => {
    out.ok = code === 0 && !out.timedOut;
    // cmd.exe reports a missing command as exit code 9009 (the old exec()
    // surfaced it as err.code; mapError's stderr sniff needs no change).
    if (process.platform === "win32" && code === 9009) out.toolMissing = true;
    if (updateMode) activeSelfUpdates.delete(promise);
    exitGrace = setTimeout(settle, 250);
    exitGrace.unref?.();
  });
  child.on("close", () => {
    if (exitGrace) clearTimeout(exitGrace);
    if (updateMode) activeSelfUpdates.delete(promise);
    settle();
  });

  return promise;
}

// One bl at a time, machine-wide: concurrent bl spawns each spotting the same
// "significant update" would race several `npm install -g` into one directory
// (all three probe calls used to run in parallel). The lock serialises every
// spawn across processes; a peer that never releases costs one honest error.
async function runBl(literal: string, args: readonly string[], timeoutMs: number = BL_TIMEOUT_MS): Promise<BlRun> {
  const dir = process.env.SUBTRK_DIR ?? join(homedir(), ".subtrk");
  const run = await withCrossProcessLock(
    join(dir, "locks", "bl.lock"),
    () => runSupervised(literal, args, { timeoutMs }),
    // staleMs must exceed the longest hold (an update rides the lock for up
    // to BL_UPDATE_CAP_MS) or a peer would take the lock over mid-update.
    { waitMs: 60_000, staleMs: BL_UPDATE_CAP_MS + 100_000 },
  );
  if (run) return run;
  return {
    ok: false,
    stdout: "",
    stderr: "",
    toolMissing: false,
    timedOut: false,
    selfUpdated: false,
    updateAbandoned: false,
    busy: true,
  };
}

// Pure: pull the JSON object out of stdout that may carry banners – first "{" to last "}".
export function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Unwrap the bl console-call envelope, which double-nests the zelda payload:
// {code:"200", data:{DataV2:{ret, data:{msg, code, data:{…fields}}}}} – and also
// accept the bare zelda envelope {msg, code, data:{…fields}}.
function dataOf(envelope: unknown): Record<string, unknown> | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  let d: unknown = (envelope as { data?: unknown }).data;
  const v2 = (d as { DataV2?: { data?: unknown } } | null | undefined)?.DataV2;
  if (v2 && typeof v2.data === "object" && v2.data !== null) d = v2.data;
  const inner = (d as { data?: unknown } | null | undefined)?.data;
  if (inner && typeof inner === "object") d = inner;
  if (typeof d !== "object" || d === null) return null;
  return d as Record<string, unknown>;
}

// Pure: v2/usage windows. per1MonthPercentage is a RATIO of the monthly credits
// (0.004359 = 0.44% used); the legacy per5Hour*/per1Week* families
// are whole percents and optional (intl went monthly-only 2026-09-22).
export function parseTokenPlanUsage(envelope: unknown): Window[] {
  const d = dataOf(envelope);
  if (!d) return [];
  const windows: Window[] = [];
  const ratio = d.per1MonthPercentage;
  const resetMs = d.per1MonthResetTime;
  if (typeof ratio === "number" && Number.isFinite(ratio) && typeof resetMs === "number" && Number.isFinite(resetMs)) {
    // full precision – the renderer rounds for display; deriveCredits uses it for the pool math
    windows.push({ kind: "30d", usedPercent: ratio * 100, resetsAt: new Date(resetMs).toISOString() });
  }
  const pct = (kind: string, p: unknown, r: unknown): void => {
    if (typeof p === "number" && Number.isFinite(p) && typeof r === "number" && Number.isFinite(r)) {
      windows.push({ kind, usedPercent: p, resetsAt: new Date(r).toISOString() });
    }
  };
  pct("5h", d.per5HourPercentage, d.per5HourResetTime);
  pct("7d", d.per1WeekPercentage, d.per1WeekResetTime);
  return windows;
}

export interface SubscriptionInfo {
  specCode?: string;
  remainingDays?: number;
  status?: string;
}

// Pure: v2/subscription – spec tier ("standard"), renewal countdown, status.
export function parseSubscription(envelope: unknown): SubscriptionInfo {
  const d = dataOf(envelope);
  if (!d) return {};
  const info: SubscriptionInfo = {};
  if (typeof d.specCode === "string") info.specCode = d.specCode;
  if (typeof d.remainingDays === "number") info.remainingDays = d.remainingDays;
  if (typeof d.status === "string") info.status = d.status;
  return info;
}

// Pure: v2/quota-config – every spec's monthly credit total (e.g. standard 45000).
export function parseQuotaConfig(envelope: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const d = dataOf(envelope);
  if (!d) return out;
  for (const [spec, v] of Object.entries(d)) {
    if (typeof v !== "object" || v === null) continue;
    const monthly = (v as { monthly?: unknown }).monthly;
    if (typeof monthly === "number" && Number.isFinite(monthly)) out[spec] = monthly;
  }
  return out;
}

// Pure: join the monthly window with the spec total -> credit pool.
export function deriveCredits(monthly: Window | undefined, specTotal: number | undefined): Credits | null {
  if (!monthly || specTotal === undefined) return null;
  const used = ((monthly.usedPercent ?? 0) / 100) * specTotal;
  return {
    total: specTotal,
    remaining: Math.max(0, Math.round(specTotal - used)),
    unit: "credits",
    cycleEndsAt: monthly.resetsAt,
    source: "derived",
  };
}

// Pure: stderr may embed tokens – only ever surfaced after truncation to the last
// 200 chars AND a pass through the redaction layer. Without a redact fn it is withheld.
export function stderrMessage(stderr: string, redact?: (s: string) => string): string {
  if (typeof redact !== "function") return "bl exited non-zero (stderr withheld)";
  return `bl exited non-zero: ${redact(stderr.slice(-200))}`;
}

async function coreRedact(): Promise<((s: string) => string) | undefined> {
  try {
    const core = (await import("../core.ts")) as { redact?: (s: string) => string; scrub?: (s: string) => string };
    if (typeof core.scrub === "function") return core.scrub; // core.ts's actual export name
    if (typeof core.redact === "function") return core.redact;
  } catch {
    // core not present – stderr will be withheld
  }
  return undefined;
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "alibaba", ok: false, stale: false, fetchedAt, error };
}

// Pure: spawn outcome -> probe failure. toolMissing is checked FIRST: when the
// bl spawn itself fails (ENOENT on POSIX, cmd.exe's 9009 "not recognized") the
// shell prints nothing to stderr, so the text sniffing below can never fire and
// the failure would misreport as subprocess-failed. The flag runBl sets from
// the spawn error code is the only reliable signal.
export function mapError(run: BlRun, fetchedAt: string, redact?: (s: string) => string): ProviderResult | null {
  if (run.ok) return null;
  if (run.toolMissing) {
    return fail(
      { kind: "tool-missing", message: "'bl' not found on PATH", hint: "npm i -g bailian-cli, then subtrk init" },
      fetchedAt,
    );
  }
  const s = (run.stderr ?? "").toLowerCase();
  // Only the shells' own missing-command phrasing names a missing TOOL; a
  // vendor/gateway message that merely contains "not found" (a 404 body like
  // "API endpoint not found") is a run of an installed bl that failed.
  if (s.includes("is not recognized") || s.includes("command not found")) {
    return fail(
      { kind: "tool-missing", message: "'bl' not found on PATH", hint: "npm i -g bailian-cli, then subtrk init" },
      fetchedAt,
    );
  }
  if (s.includes("no console access token") || s.includes("not logged in or has expired")) {
    return fail(
      {
        kind: "no-credentials",
        message: "bl console session missing or expired",
        hint: "run subtrk init (bl auth login --console)",
        remedy: "subtrk auth refresh --provider alibaba",
      },
      fetchedAt,
    );
  }
  if (run.busy) {
    return fail(
      {
        kind: "subprocess-failed",
        message: "bl busy – another subtrk process is running it (or riding out a self-update)",
      },
      fetchedAt,
    );
  }
  if (run.updateAbandoned) {
    return fail(
      {
        kind: "self-update",
        message: `bl self-update exceeded ${Math.round(BL_UPDATE_CAP_MS / 1000)}s – left it running to finish; data returns next cycle`,
      },
      fetchedAt,
    );
  }
  if (run.selfUpdated && !run.ok) {
    return fail(
      {
        kind: "self-update",
        message: "bl self-updated itself this run – no quota data yet; the next refresh uses the new version",
      },
      fetchedAt,
    );
  }
  if (run.timedOut) {
    return fail({ kind: "timeout", message: `bl timed out after ${BL_TIMEOUT_MS / 1000}s` }, fetchedAt);
  }
  return fail({ kind: "subprocess-failed", message: stderrMessage(run.stderr, redact) }, fetchedAt);
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const redact = await coreRedact();

  // Every bl spawn goes through the machine-wide bl lock, sequentially:
  // parallel spawns that all spot the same "significant update" race several
  // npm installs into one directory. usage goes first alone so a self-update
  // surfaces (and finishes) before the secondary calls spend their spawns.
  const usage = callArgs(API_USAGE);
  let usageRun = await runBl(usage.literal, usage.args);
  // Known gateway flakiness: 200-Success with empty data – retry once or twice.
  // A run whose bl self-updated also lands here and retries on the new build.
  for (let i = 0; i < 2 && usageRun.ok && parseTokenPlanUsage(extractJson(usageRun.stdout)).length === 0; i++) {
    usageRun = await runBl(usage.literal, usage.args);
  }
  const usageErr = mapError(usageRun, fetchedAt, redact);
  if (usageErr) return usageErr;
  const windows = parseTokenPlanUsage(extractJson(usageRun.stdout));

  // A failure here degrades to fewer fields, never a provider error.
  const sub = callArgs(API_SUBSCRIPTION);
  const qc = callArgs(API_QUOTA_CONFIG);
  const info = parseSubscription(extractJson((await runBl(sub.literal, sub.args)).stdout));
  const quotas = parseQuotaConfig(extractJson((await runBl(qc.literal, qc.args)).stdout));

  const monthly = windows.find((w) => w.kind === "30d");
  const credits = deriveCredits(monthly, info.specCode ? quotas[info.specCode] : undefined);

  const result: ProviderResult = { id: "alibaba", ok: true, stale: false, fetchedAt, plan: "Token Plan" };
  if (info.specCode) result.plan = `Token Plan ${info.specCode}`;
  if (windows.length > 0) result.windows = windows;
  if (credits) result.credits = credits;
  if (!result.windows && !result.credits) {
    // console session valid but zero plan data – wrong site or account, not "ok".
    result.note = "logged in, but no plan data returned – wrong console site or account?";
  }
  return result;
}

// ---------- interactive refresh (subtrk auth refresh / POST /api/refresh) ----------

// Fixed literal – the same console re-login init runs; never interpolated.
const CONSOLE_LOGIN_LITERAL = "bl auth login --console --console-site international";
const CONSOLE_LOGIN_ARGS = ["bl", "auth", "login", "--console", "--console-site", "international"];

// Pure: spawn outcome -> refresh result. The message is a fixed literal;
// stdout/stderr are dropped and never become part of the result.
export function mapRefreshOutcome(run: Pick<BlRun, "ok" | "toolMissing">): RefreshResult {
  if (run.ok) return { ok: true, message: "console session re-authorised" };
  if (run.toolMissing) return { ok: false, message: "bl not found – install bailian-cli" };
  return { ok: false, message: "console login failed – run subtrk init" };
}

async function refresh(): Promise<RefreshResult> {
  return mapRefreshOutcome(await runBl(CONSOLE_LOGIN_LITERAL, CONSOLE_LOGIN_ARGS, REFRESH_TIMEOUT_MS));
}

const provider: ProviderModule = {
  id: "alibaba",
  ttlMs: 300_000,
  refresh,
  probe: () =>
    probeInner().catch((err: unknown) => ({
      id: "alibaba" as const,
      ok: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      error: { kind: "parse-failure" as const, message: `probe crashed: ${String(err).slice(0, 120)}` },
    })),
};

export default provider;
