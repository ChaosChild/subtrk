// openai – ChatGPT plan usage via the OpenAI Codex CLI's stored login.
// Credential: ~/.codex/auth.json, read-only. Codex owns its tokens (~10d
// access-token life, refreshed while codex runs) – subtrk never refreshes; on
// 401 the credential file is re-read once and the call retried with a changed
// token, which is why this module has no refresh().

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Credits,
  PROBE_TIMEOUT_MS,
  type ProviderError,
  type ProviderModule,
  type ProviderResult,
  type Window,
} from "../core.ts";
import { traceInput } from "../lib/input-trace.ts";
import { usableLiteralSecret } from "../lib/secret.ts";
import { readCodexRpcUsage } from "./codex-rpc.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const EXPIRED_HINT = "launch codex once so it refreshes its login, or run codex login";
// The fallback spawn (app-server boot + RPC round-trips) is budgeted: at most
// this much wall clock, and never more than the probe has left – otherwise it
// stacks past core's probe timeout and the work is thrown away anyway.
const FALLBACK_BUDGET_MS = 8_000;

export interface OpenaiAuthOk {
  ok: true;
  accessToken: string;
  accountId: string;
}
export interface OpenaiAuthFail {
  ok: false;
  error: ProviderError;
}
export type OpenaiAuth = OpenaiAuthOk | OpenaiAuthFail;

// Pure: chatgpt_account_id from the id_token JWT payload (base64url middle segment).
function chatgptAccountIdFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string" || idToken === "") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts[1] === "") return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as {
      chatgpt_account_id?: unknown;
    };
    return typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id !== ""
      ? payload.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

// Pure: the parsed auth.json -> the credential, the distinct API-key-only
// failure, or null (shape unusable – the caller owns the "no Codex credentials"
// error for the missing/unparseable file). Secret firewall: a stored token that
// is not a plain literal (env/template/command indirection) is an INVALID
// credential – present-but-unusable, never sent, never expanded.
export function parseOpenaiAuth(fileObj: unknown): OpenaiAuth | null {
  if (typeof fileObj !== "object" || fileObj === null) return null;
  const o = fileObj as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
  const tokens = typeof o.tokens === "object" && o.tokens !== null ? (o.tokens as Record<string, unknown>) : null;
  if (o.auth_mode === "chatgpt" && typeof tokens?.access_token === "string" && tokens.access_token !== "") {
    if (!usableLiteralSecret(tokens.access_token)) {
      return {
        ok: false,
        error: {
          kind: "parse-failure",
          message: "tokens.access_token is not a literal secret (indirection) – refusing to use it",
          hint: "run codex login",
        },
      };
    }
    const accountId =
      typeof tokens.account_id === "string" && tokens.account_id !== ""
        ? tokens.account_id
        : chatgptAccountIdFromIdToken(tokens.id_token);
    if (!accountId) {
      return {
        ok: false,
        error: {
          kind: "parse-failure",
          message: "Codex auth.json has a ChatGPT login but no account id",
          hint: "run codex login",
        },
      };
    }
    return { ok: true, accessToken: tokens.access_token, accountId };
  }
  if (o.OPENAI_API_KEY) {
    return {
      ok: false,
      error: {
        kind: "no-credentials",
        message: "auth.json holds an API key, not a ChatGPT login",
        hint: "run codex login (plan usage needs a ChatGPT account)",
      },
    };
  }
  return null;
}

// Pure: limit_window_seconds -> window kind. The payload is self-describing
// (free = monthly, paid = 5h + weekly); canonical lengths get exact names,
// then whole days/hours, else a rounded hour estimate. Kimi's free plan resets
// on a two-week cycle whose remaining seconds count down hourly – name that
// window 14d instead of the meaningless "336h".."1h" countdown.
export function windowKindFromSeconds(seconds: number): string {
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "7d";
  if (seconds === 2_592_000) return "30d";
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds > 13 * 86_400 && seconds <= 15 * 86_400) return "14d";
    if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  }
  return `${Math.round(seconds / 3_600)}h`;
}

interface OpenaiLimitWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

// Pure: one rate-limit window object -> Window; null when unusable.
// reset_at is epoch SECONDS; without it, now + reset_after_seconds; neither -> null.
// defaultSeconds stands in for a missing limit_window_seconds (extras only –
// code-review/model windows omit it; the base windows stay strict).
function parseOpenaiWindow(w: unknown, nowMs: number, defaultSeconds?: number): Window | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as OpenaiLimitWindow;
  if (typeof o.used_percent !== "number" || !Number.isFinite(o.used_percent)) return null;
  const seconds =
    typeof o.limit_window_seconds === "number" && Number.isFinite(o.limit_window_seconds)
      ? o.limit_window_seconds
      : defaultSeconds;
  if (seconds === undefined) return null;
  let resetsAt: string | null = null;
  if (typeof o.reset_at === "number" && Number.isFinite(o.reset_at)) {
    resetsAt = new Date(o.reset_at * 1000).toISOString();
  } else if (typeof o.reset_after_seconds === "number" && Number.isFinite(o.reset_after_seconds)) {
    resetsAt = new Date(nowMs + o.reset_after_seconds * 1000).toISOString();
  }
  if (!resetsAt) return null;
  return { kind: windowKindFromSeconds(seconds), usedPercent: o.used_percent, resetsAt };
}

// Pure: a scoped {primary_window, secondary_window} pair -> windows. Lenient:
// an unusable extra window is skipped, never fails the whole parse.
// codex window mapping / cli-rpc fallback after quota-axi (MIT).
function parseScopedPair(container: unknown, scope: string, nowMs: number): Window[] {
  if (typeof container !== "object" || container === null) return [];
  const c = container as { primary_window?: unknown; secondary_window?: unknown };
  const out: Window[] = [];
  for (const [w, fallback] of [
    [c.primary_window, 18_000],
    [c.secondary_window, 604_800],
  ] as const) {
    const parsed = parseOpenaiWindow(w, nowMs, fallback);
    if (parsed) out.push({ ...parsed, scope });
  }
  return out;
}

// Numbers arrive as JSON numbers or numeric strings ("72000").
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// Pure: spend_control.individual_limit (workspace credit cap) -> Credits;
// undefined without usable limit/used totals. reached=true pins remaining to 0.
export function parseSpendControl(raw: unknown, nowMs: number = Date.now()): Credits | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const control = raw as { reached?: unknown; individual_limit?: unknown };
  if (typeof control.individual_limit !== "object" || control.individual_limit === null) return undefined;
  const cap = control.individual_limit as Record<string, unknown>;
  const limit = num(cap.limit);
  const used = num(cap.used);
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
  const remaining = control.reached === true ? 0 : Math.max(0, num(cap.remaining) ?? limit - used);
  const credits: Credits = { total: limit, remaining, unit: "credits", source: "api" };
  const resetAt = num(cap.reset_at);
  const resetAfter = num(cap.reset_after_seconds);
  if (resetAt !== undefined) credits.cycleEndsAt = new Date(resetAt * 1000).toISOString();
  else if (resetAfter !== undefined && resetAfter >= 0)
    credits.cycleEndsAt = new Date(nowMs + resetAfter * 1000).toISOString();
  return credits;
}

// Pure: wham/usage body -> windows + plan label (+ spend_control credits);
// null when the shape is unrecognized. Strict, claude-style for the base
// limit: a present rate_limit needs a primary window. Extras are lenient:
// code_review_rate_limit -> scope "code-review", additional_rate_limits ->
// scope = limit_name, spend_control -> credits. A body without rate_limit is
// accepted only when spend_control yields credits (business workspaces).
// credits (balance) and promo are NOT surfaced.
export function parseOpenaiUsage(
  body: unknown,
  nowMs: number = Date.now(),
): { windows: Window[]; plan?: string; credits?: Credits } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as {
    plan_type?: unknown;
    rate_limit?: unknown;
    code_review_rate_limit?: unknown;
    additional_rate_limits?: unknown;
    spend_control?: unknown;
  };
  const credits = parseSpendControl(b.spend_control, nowMs);
  const windows: Window[] = [];
  if (typeof b.rate_limit === "object" && b.rate_limit !== null) {
    const rl = b.rate_limit as { primary_window?: unknown; secondary_window?: unknown };
    const primary = parseOpenaiWindow(rl.primary_window, nowMs);
    if (!primary) return null;
    windows.push(primary);
    // secondary_window null/absent -> skipped (claude's inactive windows);
    // present -> parsed like primary, malformed fails the whole parse.
    if (rl.secondary_window !== null && rl.secondary_window !== undefined) {
      const secondary = parseOpenaiWindow(rl.secondary_window, nowMs);
      if (!secondary) return null;
      windows.push(secondary);
    }
  } else if (!credits) {
    return null;
  }
  windows.push(...parseScopedPair(b.code_review_rate_limit, "code-review", nowMs));
  if (Array.isArray(b.additional_rate_limits)) {
    for (const entry of b.additional_rate_limits) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { limit_name?: unknown; metered_feature?: unknown; rate_limit?: unknown };
      const scope =
        typeof e.limit_name === "string" && e.limit_name !== ""
          ? e.limit_name
          : typeof e.metered_feature === "string" && e.metered_feature !== ""
            ? e.metered_feature
            : null;
      if (scope) windows.push(...parseScopedPair(e.rate_limit, scope, nowMs));
    }
  }
  const plan = typeof b.plan_type === "string" && b.plan_type !== "" ? `ChatGPT ${b.plan_type}` : undefined;
  return credits ? { windows, plan, credits } : { windows, plan };
}

type FetchOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; text?: string; error: ProviderError };

function retryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function fetchText(url: string, init: RequestInit): Promise<FetchOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_RESPONSE_CHARS) {
      return { ok: false, status: res.status, error: { kind: "parse-failure", message: "response exceeds 1MB cap" } };
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      return { ok: false, status: res.status, error: { kind: "parse-failure", message: "response exceeds 1MB cap" } };
    }
    if (res.status === 429) {
      return {
        ok: false,
        status: res.status,
        text,
        error: {
          kind: "rate-limited",
          message: "rate limited (429)",
          retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
        },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        text,
        error: { kind: "http-error", message: `HTTP ${res.status}`, status: res.status },
      };
    }
    return { ok: true, status: res.status, text };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: { kind: "timeout", message: `request timed out after ${TIMEOUT_MS / 1000}s` } };
    }
    return {
      ok: false,
      error: { kind: "http-error", message: `network error: ${e instanceof Error ? e.message : "unknown"}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort: register the loaded secret with core's redaction layer when it exists;
// otherwise the token simply stays in a local variable and never enters any result.
async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "openai", ok: false, stale: false, fetchedAt, error };
}

// Read + parse ~/.codex/auth.json; null when the file is absent or not JSON –
// the caller owns that error (the parser never touches the filesystem).
function readAuthFile(): { fileObj: unknown } | null {
  const authPath = join(homedir(), ".codex", "auth.json");
  traceInput(authPath); // identity stats only, BEFORE the read (cache stamp)
  try {
    return { fileObj: JSON.parse(readFileSync(authPath, "utf8")) };
  } catch {
    return null;
  }
}

const NO_CREDENTIALS_ERROR: ProviderError = {
  kind: "no-credentials",
  message: "no Codex credentials at ~/.codex/auth.json",
  hint: "run codex login",
};

function usageHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": accountId,
    "User-Agent": "codex-cli",
  };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const probeStartedMs = Date.parse(fetchedAt);
  const read = readAuthFile();
  const auth = parseOpenaiAuth(read?.fileObj);
  if (!auth?.ok) return fail(auth ? auth.error : NO_CREDENTIALS_ERROR, fetchedAt);
  void registerSecret(auth.accessToken);

  let out = await fetchText(USAGE_URL, { headers: usageHeaders(auth.accessToken, auth.accountId) });
  if (!out.ok && out.status === 401) {
    // codex refreshes its stored login in place while running – re-read the
    // credential once; a changed token gets exactly one retry.
    const reread = readAuthFile();
    const fresh = parseOpenaiAuth(reread?.fileObj);
    if (fresh?.ok && fresh.accessToken !== auth.accessToken) {
      void registerSecret(fresh.accessToken);
      out = await fetchText(USAGE_URL, { headers: usageHeaders(fresh.accessToken, fresh.accountId) });
    }
    if (!out.ok && out.status === 401) {
      return fail(
        {
          kind: "expired-token",
          message: "Codex rejected the access token (401, also after one credential re-read)",
          hint: EXPIRED_HINT,
        },
        fetchedAt,
      );
    }
  }
  let error: ProviderError | null = null;
  let parsed: ReturnType<typeof parseOpenaiUsage> = null;
  if (!out.ok) error = out.error;
  else {
    try {
      parsed = parseOpenaiUsage(JSON.parse(out.text));
      if (!parsed) error = { kind: "parse-failure", message: "usage response missing rate_limit windows" };
    } catch {
      error = { kind: "parse-failure", message: "usage response was not JSON" };
    }
  }
  if (error !== null && isDefinitiveFailure(error)) {
    // Definitive HTTP failure with a stored login -> read-only codex
    // app-server lane; its failure keeps the original error. The lane is
    // deadline-capped to fit inside the probe budget: whatever is left of
    // PROBE_TIMEOUT_MS, at most FALLBACK_BUDGET_MS.
    const remainingMs = PROBE_TIMEOUT_MS - (Date.now() - probeStartedMs);
    const deadlineMs = Date.now() + Math.max(0, Math.min(remainingMs, FALLBACK_BUDGET_MS));
    const viaRpc = parseOpenaiUsage(await readCodexRpcUsage(process.env, { deadlineMs }));
    if (viaRpc) {
      parsed = viaRpc;
      error = null;
    }
  }
  if (error || !parsed) return fail(error ?? { kind: "parse-failure", message: "usage unreadable" }, fetchedAt);
  const result: ProviderResult = { id: "openai", ok: true, stale: false, fetchedAt, plan: parsed.plan };
  if (parsed.windows.length > 0) result.windows = parsed.windows;
  if (parsed.credits) result.credits = parsed.credits;
  return result;
}

// Only a DEFINITIVE failure justifies the expensive fallback spawn: the server
// answered with a real HTTP status (>= 400) or sent a body that could not be
// used (parse-failure). Network-level errors (offline, DNS, ECONNREFUSED)
// carry no status and propagate with NO fallback – the RPC lane would only
// hit the same dead network and outlast the probe budget. 401 is handled
// above (codex would refresh – rewrite – its login, which subtrk never does);
// timeout and rate-limited are transient (a fallback there would outlive the
// probe budget or hit the same throttled backend).
function isDefinitiveFailure(e: ProviderError): boolean {
  if (e.kind === "parse-failure") return true;
  return e.kind === "http-error" && typeof e.status === "number" && e.status >= 400;
}

const provider: ProviderModule = {
  id: "openai",
  ttlMs: 60_000,
  tracesInputs: true, // probe traces ~/.codex/auth.json – cache entries carry an identity stamp
  probe(): Promise<ProviderResult> {
    return probeInner().catch(
      (e: unknown): ProviderResult =>
        fail(
          { kind: "http-error", message: `probe failed: ${e instanceof Error ? e.message : "unknown"}` },
          new Date().toISOString(),
        ),
    );
  },
};
export default provider;
