// alibaba – Model Studio Token Plan (international: credits, 30-day cycle)
// via the official Bailian CLI (`bl`). `bl usage token-plan` drops the monthly
// fields (formatter bug as of bl 2.0.1), so we use bl's raw gateway passthrough:
// `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/*`.
// Fixed literal commands; nothing is ever interpolated into a command line.

import { exec, execFile } from "node:child_process";
import type { Credits, ProviderError, ProviderModule, ProviderResult, RefreshResult, Window } from "../core.ts";

const BL_TIMEOUT_MS = 10_000;
// The console re-login blocks on the browser callback and bl has its own idle
// timeout – give it a generous budget instead of the probe's 10s.
const REFRESH_TIMEOUT_MS = 300_000;
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
}

function runBl(literal: string, args: readonly string[], timeoutMs: number = BL_TIMEOUT_MS): Promise<BlRun> {
  return new Promise((resolve) => {
    const finish = (
      err: (Error & { code?: string | number; killed?: boolean }) | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ): void => {
      const out = String(stdout ?? "");
      const errText = String(stderr ?? "");
      if (err) {
        const toolMissing = err.code === "ENOENT" || (process.platform === "win32" && err.code === 9009);
        const timedOut = err.killed === true;
        resolve({ ok: false, stdout: out, stderr: errText, toolMissing, timedOut });
      } else {
        resolve({ ok: true, stdout: out, stderr: errText, toolMissing: false, timedOut: false });
      }
    };
    if (process.platform === "win32") {
      // .cmd shim requires the shell; the literal is a fixed string, never interpolated.
      exec(literal, { timeout: timeoutMs, windowsHide: true }, finish);
    } else {
      execFile(args[0], args.slice(1), { timeout: timeoutMs }, finish);
    }
  });
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
  if (s.includes("is not recognized") || s.includes("command not found") || s.includes("not found")) {
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
  if (run.timedOut) {
    return fail({ kind: "timeout", message: `bl timed out after ${BL_TIMEOUT_MS / 1000}s` }, fetchedAt);
  }
  return fail({ kind: "subprocess-failed", message: stderrMessage(run.stderr, redact) }, fetchedAt);
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const redact = await coreRedact();

  // Secondary calls run in parallel with usage – each bl spawn costs seconds.
  const sub = callArgs(API_SUBSCRIPTION);
  const qc = callArgs(API_QUOTA_CONFIG);
  const subPromise = runBl(sub.literal, sub.args);
  const qcPromise = runBl(qc.literal, qc.args);

  const usage = callArgs(API_USAGE);
  let usageRun = await runBl(usage.literal, usage.args);
  // Known gateway flakiness: 200-Success with empty data – retry once or twice.
  for (let i = 0; i < 2 && usageRun.ok && parseTokenPlanUsage(extractJson(usageRun.stdout)).length === 0; i++) {
    usageRun = await runBl(usage.literal, usage.args);
  }
  const usageErr = mapError(usageRun, fetchedAt, redact);
  if (usageErr) return usageErr;
  const windows = parseTokenPlanUsage(extractJson(usageRun.stdout));

  // A failure here degrades to fewer fields, never a provider error.
  const info = parseSubscription(extractJson((await subPromise).stdout));
  const quotas = parseQuotaConfig(extractJson((await qcPromise).stdout));

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
