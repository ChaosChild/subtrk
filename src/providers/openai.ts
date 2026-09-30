// openai – ChatGPT plan usage via the OpenAI Codex CLI's stored login.
// Credential: ~/.codex/auth.json, read-only. Codex owns its tokens (~10d
// access-token life, refreshed while codex runs) – subtrk never refreshes; on
// 401 the credential file is re-read once and the call retried with a changed
// token, which is why this module has no refresh().

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const EXPIRED_HINT = "launch codex once so it refreshes its login, or run codex login";

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
// error for the missing/unparseable file).
export function parseOpenaiAuth(fileObj: unknown): OpenaiAuth | null {
  if (typeof fileObj !== "object" || fileObj === null) return null;
  const o = fileObj as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
  const tokens = typeof o.tokens === "object" && o.tokens !== null ? (o.tokens as Record<string, unknown>) : null;
  if (o.auth_mode === "chatgpt" && typeof tokens?.access_token === "string" && tokens.access_token !== "") {
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
function parseOpenaiWindow(w: unknown, nowMs: number): Window | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as OpenaiLimitWindow;
  if (typeof o.used_percent !== "number" || !Number.isFinite(o.used_percent)) return null;
  if (typeof o.limit_window_seconds !== "number" || !Number.isFinite(o.limit_window_seconds)) return null;
  let resetsAt: string | null = null;
  if (typeof o.reset_at === "number" && Number.isFinite(o.reset_at)) {
    resetsAt = new Date(o.reset_at * 1000).toISOString();
  } else if (typeof o.reset_after_seconds === "number" && Number.isFinite(o.reset_after_seconds)) {
    resetsAt = new Date(nowMs + o.reset_after_seconds * 1000).toISOString();
  }
  if (!resetsAt) return null;
  return { kind: windowKindFromSeconds(o.limit_window_seconds), usedPercent: o.used_percent, resetsAt };
}

// Pure: wham/usage body -> windows + plan label; null when the shape is
// unrecognized. Strict, claude-style: every observed response carries a primary
// window, so primary_window/rate_limit missing is a parse failure, never an
// empty state. credits/spend_control/promo/additional_rate_limits/
// code_review_rate_limit are NOT surfaced in v1.
export function parseOpenaiUsage(
  body: unknown,
  nowMs: number = Date.now(),
): { windows: Window[]; plan?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { plan_type?: unknown; rate_limit?: unknown };
  if (typeof b.rate_limit !== "object" || b.rate_limit === null) return null;
  const rl = b.rate_limit as { primary_window?: unknown; secondary_window?: unknown };
  const primary = parseOpenaiWindow(rl.primary_window, nowMs);
  if (!primary) return null;
  const windows = [primary];
  // secondary_window null/absent -> skipped (claude's inactive windows);
  // present -> parsed like primary, malformed fails the whole parse.
  if (rl.secondary_window !== null && rl.secondary_window !== undefined) {
    const secondary = parseOpenaiWindow(rl.secondary_window, nowMs);
    if (!secondary) return null;
    windows.push(secondary);
  }
  const plan = typeof b.plan_type === "string" && b.plan_type !== "" ? `ChatGPT ${b.plan_type}` : undefined;
  return { windows, plan };
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
  try {
    return { fileObj: JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) };
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
  if (!out.ok) return fail(out.error, fetchedAt);
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "usage response was not JSON" }, fetchedAt);
  }
  const parsed = parseOpenaiUsage(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "usage response missing rate_limit windows" }, fetchedAt);
  return { id: "openai", ok: true, stale: false, fetchedAt, plan: parsed.plan, windows: parsed.windows };
}

const provider: ProviderModule = {
  id: "openai",
  ttlMs: 60_000,
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
