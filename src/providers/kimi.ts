// kimi – Kimi (Moonshot AI) coding-plan usage. Credential discovery order:
//   1. The Kimi Desktop app's scoped API key: %APPDATA%\kimi-desktop\daimon-share\
//      daimon\kimi-code-key.json -> keys[0].apiKey ("sk-kimi-..."). win32 only –
//      the path is the Desktop app's own, resolved via process.env.APPDATA.
//   2. The Kimi Code CLI's OAuth login: ~/.kimi-code/credentials/kimi-code.json –
//      access tokens live 15 minutes; a stale one is refreshed via the vendor's
//      token endpoint and the FULL bundle is written back atomically (best effort –
//      refresh tokens rotate, so the new one must be persisted, but this probe keeps
//      using the fresh token even when the write fails). The public OAuth client id
//      (KIMI_CLIENT_ID) lives in ~/.subtrk/env, fetched by `subtrk init` from the
//      vendor's OSS source – no literal lives in this repo.
// Both files belong to their owning apps; subtrk never runs an interactive login –
// on a dead refresh grant it points at the owning tool, which is why this module
// has no refresh().

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";
import { windowKindFromSeconds } from "./openai.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const AGENT_GW_USAGE_URL = "https://agent-gw.kimi.com/coding/v1/usages";
const API_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const TOKEN_URL_FALLBACK = "https://auth.kimi.ai/api/oauth/token";
const SKEW_MS = 60_000;
const EXPIRED_HINT = "launch the Kimi Code CLI (or Kimi Desktop) once to re-login";

// The Kimi Desktop app is a Windows product and its key file lives under the
// Windows app-data dir – elsewhere only the CLI OAuth source applies.
export function desktopKeyPath(): string | null {
  if (process.platform !== "win32" || !process.env.APPDATA) return null;
  return join(process.env.APPDATA, "kimi-desktop", "daimon-share", "daimon", "kimi-code-key.json");
}

// Pure: the parsed key file -> keys[0].apiKey, or null (shape unusable – the
// caller owns the "no credential" error for the missing/unparseable file).
export function parseDesktopKeyFile(fileObj: unknown): string | null {
  if (typeof fileObj !== "object" || fileObj === null) return null;
  const keys = (fileObj as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const first = keys[0];
  if (typeof first !== "object" || first === null) return null;
  const apiKey = (first as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" && apiKey !== "" ? apiKey : null;
}

// Pure: "LEVEL_FREE" -> "Kimi Free"; unknown levels keep their title-cased raw
// text ("Kimi Vip Test"); absent/unparseable -> no plan label.
export function kimiPlanLabel(level: unknown): string | undefined {
  if (typeof level !== "string" || level === "") return undefined;
  const raw = level.startsWith("LEVEL_") ? level.slice(6) : level;
  const words = raw
    .toLowerCase()
    .split("_")
    .filter((w) => w !== "");
  if (words.length === 0) return undefined;
  return `Kimi ${words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}`;
}

export interface KimiUsage {
  windows: Window[];
  plan?: string;
  note?: string;
}

// The wire carries quota numbers as STRINGS; accept either, reject junk/empty.
function quotaNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Pure: (limit - remaining) / limit -> clamped used percent; null when the pair
// is unusable (missing, unparseable, or limit <= 0).
function usedPercentFromQuota(limit: unknown, remaining: unknown): number | null {
  const l = quotaNumber(limit);
  const r = quotaNumber(remaining);
  if (l === null || r === null || l <= 0) return null;
  return Math.min(100, Math.max(0, ((l - r) / l) * 100));
}

// Pure: one {limit, remaining, resetTime} quota object -> a Window; null when
// unusable. resetTime (RFC3339) names both the kind (via the shared seconds
// mapping) and resetsAt.
function quotaWindow(quota: Record<string, unknown>, nowMs: number): Window | null {
  const usedPercent = usedPercentFromQuota(quota.limit, quota.remaining);
  const resetTime = typeof quota.resetTime === "string" ? quota.resetTime : null;
  const resetMs = resetTime === null ? NaN : Date.parse(resetTime);
  if (usedPercent === null || resetTime === null || !Number.isFinite(resetMs)) return null;
  return {
    kind: windowKindFromSeconds((resetMs - nowMs) / 1000),
    usedPercent,
    resetsAt: resetTime,
  };
}

// Pure: agent-gw rich shape {user:{membership:{level}}, totalQuota:{...}} ->
// plan label + one window; null when the shape is unrecognized. Unusable quota
// numbers or resetTime degrade to the empty state (note, no window) – the shape
// and the plan label still parse.
export function parseAgentGwUsage(body: unknown, nowMs: number = Date.now()): KimiUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { user?: unknown; totalQuota?: unknown };
  const user = typeof b.user === "object" && b.user !== null ? (b.user as Record<string, unknown>) : null;
  const quota =
    typeof b.totalQuota === "object" && b.totalQuota !== null ? (b.totalQuota as Record<string, unknown>) : null;
  if (!user && !quota) return null;
  const out: KimiUsage = { windows: [] };
  const membership =
    typeof user?.membership === "object" && user.membership !== null
      ? (user.membership as Record<string, unknown>)
      : null;
  const plan = kimiPlanLabel(membership?.level);
  if (plan) out.plan = plan;
  if (quota) {
    const window = quotaWindow(quota, nowMs);
    if (window) out.windows.push(window);
  }
  if (out.windows.length === 0) out.note = "no quota data reported yet";
  return out;
}

// Fixed kinds for the OAuth usages shape; limit_month_code is the code-scoped
// slice of the monthly pool.
const OAUTH_WINDOWS: ReadonlyArray<readonly [field: string, kind: string, scope?: string]> = [
  ["limit_5h", "5h"],
  ["limit_7d", "7d"],
  ["limit_month_total", "30d"],
  ["limit_month_code", "30d", "code"],
];

// Pure: the OAuth "usages" object -> windows. The shape is degradable by design:
// absent fields are skipped; a present-but-malformed field fails the whole parse,
// claude-style. boosterWallet also exists on the wire but is not surfaced.
function parseOauthUsageWindows(usages: Record<string, unknown>): Window[] | null {
  const windows: Window[] = [];
  for (const [field, kind, scope] of OAUTH_WINDOWS) {
    const raw = usages[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object") return null;
    const o = raw as { used_ratio?: unknown; reset_time?: unknown };
    if (typeof o.used_ratio !== "number" || !Number.isFinite(o.used_ratio)) return null;
    if (typeof o.reset_time !== "string" || !Number.isFinite(Date.parse(o.reset_time))) return null;
    const window: Window = {
      kind,
      usedPercent: Math.min(100, Math.max(0, o.used_ratio * 100)),
      resetsAt: new Date(Date.parse(o.reset_time)).toISOString(),
    };
    if (scope) window.scope = scope;
    windows.push(window);
  }
  return windows;
}

// Pure: api.kimi.com body -> windows; null when unrecognized. The shape depends
// on the auth method – the CLI OAuth login gets the multi-window "usages" shape,
// an API key the single-window simple {"usage":{...}} shape – one parser handles
// both.
export function parseApiKimiUsage(body: unknown, nowMs: number = Date.now()): KimiUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { usage?: unknown; usages?: unknown };
  if (typeof b.usages === "object" && b.usages !== null) {
    const windows = parseOauthUsageWindows(b.usages as Record<string, unknown>);
    return windows === null ? null : { windows };
  }
  if (typeof b.usage !== "object" || b.usage === null) return null;
  const window = quotaWindow(b.usage as Record<string, unknown>, nowMs);
  if (!window) return null;
  return { windows: [window] };
}

export interface KimiCliCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAtSec?: number; // unix SECONDS
  raw: Record<string, unknown>; // original JSON object, for the refresh write-back
}

// Pure: ~/.kimi-code/credentials/kimi-code.json shape.
export function parseKimiCliCredentials(fileObj: unknown): KimiCliCredentials | null {
  if (typeof fileObj !== "object" || fileObj === null) return null;
  const o = fileObj as Record<string, unknown>;
  if (typeof o.access_token !== "string" || o.access_token === "") return null;
  const creds: KimiCliCredentials = { accessToken: o.access_token, raw: o };
  if (typeof o.refresh_token === "string" && o.refresh_token !== "") creds.refreshToken = o.refresh_token;
  if (typeof o.expires_at === "number" && Number.isFinite(o.expires_at)) creds.expiresAtSec = o.expires_at;
  return creds;
}

// Pure: past expiry with the 60s clock skew; unknown expiry counts as fresh –
// a probe right after the CLI refreshed its own token must not mint needlessly.
export function kimiTokenStale(expiresAtSec: unknown, nowMs: number): boolean {
  if (typeof expiresAtSec !== "number" || !Number.isFinite(expiresAtSec)) return false;
  return nowMs >= expiresAtSec * 1000 - SKEW_MS;
}

// Pure: form-encoded refresh grant for the vendor's PUBLIC OAuth client.
export function buildKimiRefreshForm(refreshToken: string, clientId: string): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  }).toString();
}

// Pure: 400/401 with error invalid_grant -> retry ONCE against the fallback
// host; anything else is final.
export function shouldTryFallbackTokenHost(status: number | undefined, errorCode: string): boolean {
  return (status === 400 || status === 401) && errorCode === "invalid_grant";
}

export interface KimiRefreshedToken {
  accessToken: string;
  refreshToken?: string; // rotates – present only when the response carried a new one
  expiresAtSec: number;
  expiresInSec: number;
}

// Pure: the token endpoint's success body.
export function parseKimiRefreshResponse(
  text: string,
  nowSec: number,
): { ok: true; token: KimiRefreshedToken } | { ok: false; error: ProviderError } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "parse-failure", message: "token response was not JSON" } };
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    return {
      ok: false,
      error: { kind: "parse-failure", message: "token response missing access_token/expires_in" },
    };
  }
  const token: KimiRefreshedToken = { accessToken, expiresAtSec: nowSec + expiresIn, expiresInSec: expiresIn };
  const refreshToken = (body as { refresh_token?: unknown }).refresh_token;
  if (typeof refreshToken === "string" && refreshToken !== "") token.refreshToken = refreshToken;
  return { ok: true, token };
}

// Pure: the FULL updated bundle for the write-back – fields the response did not
// change (scope, token_type, …) are preserved, and the old refresh_token stays
// when the response carried no new one.
export function mergeKimiCredentials(raw: Record<string, unknown>, token: KimiRefreshedToken): Record<string, unknown> {
  return {
    ...raw,
    access_token: token.accessToken,
    refresh_token: token.refreshToken ?? raw.refresh_token,
    expires_at: token.expiresAtSec,
    expires_in: token.expiresInSec,
  };
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

// Best-effort: register the loaded secrets with core's redaction layer when it
// exists; otherwise they simply stay in local variables and never enter a result.
async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

// The PUBLIC OAuth client id lives in ~/.subtrk/env (KIMI_CLIENT_ID) – `subtrk
// init` fetches it from the vendor's OSS source so no literal lives in this repo
// and secret scanners stay quiet.
async function envClientValue(name: string): Promise<string | undefined> {
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    return core.getSecret?.(name);
  } catch {
    return undefined;
  }
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "kimi", ok: false, stale: false, fetchedAt, error };
}

// Read + parse a JSON file; null when absent or not JSON – the caller owns that
// outcome (the parsers never touch the filesystem).
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function usageHeaders(token: string): Record<string, string> {
  // Honest UA – vendor client UAs are never spoofed.
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "subtrk" };
}

const NO_CREDENTIALS_ERROR: ProviderError = {
  kind: "no-credentials",
  message: "no Kimi Desktop key or Kimi Code CLI credential found",
  hint: "launch Kimi Desktop (%APPDATA%\\kimi-desktop\\daimon-share\\daimon\\kimi-code-key.json) or log in with the Kimi Code CLI (~/.kimi-code/credentials/kimi-code.json)",
};

const GRANT_REJECTED_ERROR: ProviderError = {
  kind: "expired-token",
  message: "refresh token rejected by Kimi",
  hint: EXPIRED_HINT,
};

function errorCodeFromBody(text: string | undefined): string {
  if (typeof text !== "string") return "";
  try {
    return String((JSON.parse(text) as { error?: unknown }).error ?? "");
  } catch {
    return ""; // body not JSON – no error code available
  }
}

// Refresh the CLI OAuth token: the public client id comes from ~/.subtrk/env; a
// 400/401 invalid_grant on the primary host retries ONCE against the fallback
// host; a grant that dies on both is the re-login error.
async function refreshCliToken(
  refreshToken: string,
): Promise<{ ok: true; token: KimiRefreshedToken } | { ok: false; error: ProviderError }> {
  const clientId = await envClientValue("KIMI_CLIENT_ID");
  if (!clientId) {
    return {
      ok: false,
      error: {
        kind: "no-credentials",
        message: "KIMI_CLIENT_ID not configured",
        hint: "run subtrk init (fetches the public value)",
        remedy: "subtrk init",
      },
    };
  }
  const form = buildKimiRefreshForm(refreshToken, clientId);
  let out = await fetchText(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!out.ok && shouldTryFallbackTokenHost(out.status, errorCodeFromBody(out.text))) {
    out = await fetchText(TOKEN_URL_FALLBACK, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
  }
  if (!out.ok) {
    if (out.status === 400 || out.status === 401) return { ok: false, error: GRANT_REJECTED_ERROR };
    return { ok: false, error: out.error };
  }
  return parseKimiRefreshResponse(out.text, Math.floor(Date.now() / 1000));
}

// Best-effort atomic write-back of the refreshed bundle (tmp + rename,
// preserving the fields subtrk did not change) – kimi-code rewrites the file
// too, so tolerate races and swallow every error.
function writeBackCliCredentials(path: string, merged: Record<string, unknown>): void {
  try {
    const tmp = `${path}.subtrk-tmp`;
    writeFileSync(tmp, JSON.stringify(merged), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort only
  }
}

// The CLI OAuth path: read the credential file, refresh the 15-minute access
// token when stale (writing the rotated bundle back, best-effort), then GET the
// coding usage endpoint. Null when the file is absent/unparseable – the caller
// owns that outcome.
async function probeCliPath(fetchedAt: string): Promise<ProviderResult | null> {
  const credPath = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");
  const creds = parseKimiCliCredentials(readJsonFile(credPath));
  if (!creds) return null;
  await registerSecret(creds.accessToken);
  if (creds.refreshToken) await registerSecret(creds.refreshToken);

  let token = creds.accessToken;
  if (kimiTokenStale(creds.expiresAtSec, Date.now())) {
    if (!creds.refreshToken) {
      return fail(
        {
          kind: "expired-token",
          message: "Kimi access token expired and the credential carries no refresh_token",
          hint: EXPIRED_HINT,
        },
        fetchedAt,
      );
    }
    const refreshed = await refreshCliToken(creds.refreshToken);
    if (!refreshed.ok) return fail(refreshed.error, fetchedAt);
    await registerSecret(refreshed.token.accessToken);
    if (refreshed.token.refreshToken) await registerSecret(refreshed.token.refreshToken);
    token = refreshed.token.accessToken;
    // Best-effort – this probe keeps the fresh token even when the write fails.
    writeBackCliCredentials(credPath, mergeKimiCredentials(creds.raw, refreshed.token));
  }

  const out = await fetchText(API_USAGE_URL, { headers: usageHeaders(token) });
  if (!out.ok) {
    if (out.status === 401 || out.status === 403) {
      return fail(
        { kind: "expired-token", message: `Kimi rejected the access token (${out.status})`, hint: EXPIRED_HINT },
        fetchedAt,
      );
    }
    return fail(out.error, fetchedAt);
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "usage response was not JSON" }, fetchedAt);
  }
  const parsed = parseApiKimiUsage(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "usage response shape unrecognized" }, fetchedAt);
  return { id: "kimi", ok: true, stale: false, fetchedAt, windows: parsed.windows, note: parsed.note };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();

  // Source 1: the Kimi Desktop app's scoped API key.
  const keyPath = desktopKeyPath();
  const desktopKey = keyPath ? parseDesktopKeyFile(readJsonFile(keyPath)) : null;
  if (desktopKey) {
    void registerSecret(desktopKey);
    const out = await fetchText(AGENT_GW_USAGE_URL, { headers: usageHeaders(desktopKey) });
    if (!out.ok && (out.status === 401 || out.status === 403)) {
      // Auth-rejected: try the CLI OAuth source once before erroring.
      const cli = await probeCliPath(fetchedAt);
      if (cli) return cli;
      return fail(
        out.status === 401
          ? {
              kind: "expired-token",
              message: "Kimi rejected the desktop API key (401)",
              hint: "launch Kimi Desktop once so it re-issues the key",
            }
          : {
              kind: "forbidden",
              message: "Kimi rejected the desktop API key (403)",
              hint: "launch Kimi Desktop once so it re-issues the key",
            },
        fetchedAt,
      );
    }
    if (!out.ok) return fail(out.error, fetchedAt);
    let body: unknown;
    try {
      body = JSON.parse(out.text);
    } catch {
      return fail({ kind: "parse-failure", message: "usage response was not JSON" }, fetchedAt);
    }
    const parsed = parseAgentGwUsage(body);
    if (!parsed) return fail({ kind: "parse-failure", message: "usage response shape unrecognized" }, fetchedAt);
    return {
      id: "kimi",
      ok: true,
      stale: false,
      fetchedAt,
      plan: parsed.plan,
      windows: parsed.windows,
      note: parsed.note,
    };
  }

  // Source 2 (also the auth-rejected fallback): the Kimi Code CLI's OAuth login.
  const cli = await probeCliPath(fetchedAt);
  if (cli) return cli;
  return fail(NO_CREDENTIALS_ERROR, fetchedAt);
}

const provider: ProviderModule = {
  id: "kimi",
  ttlMs: 300_000,
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
