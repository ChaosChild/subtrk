// claude – Claude Pro personal subscription via the OAuth usage endpoint.
//
// Credential doctrine (read before touching the auth paths):
//  - Rotation-on-use. Claude Code's OAuth refresh tokens are SINGLE-USE: every
//    successful token exchange – ours or Claude Code's own – spends the old
//    refresh token and mints a rotated pair; the previous pair is dead the
//    moment the exchange returns.
//  - Shared store. subtrk's self-refresh writes the rotated pair back to the
//    SAME credentials store Claude Code reads (~/.claude/.credentials.json, or
//    $CLAUDE_CONFIG_DIR/.credentials.json when set). A concurrent refresh by
//    Claude Code can make subtrk's exchange fail benignly (its grant was
//    already spent) – that degrades to the plain expired-token advice. The
//    write-back itself is a blind last-writer merge off the file as subtrk
//    read it, so it CAN clobber a store Claude Code refreshed in the
//    meantime; a fresher-state guard would be lock machinery and is
//    deliberately out of scope here.
//  - Advice first. Doing nothing is the zero-risk alternative: the
//    expired-token hint (EXPIRED_HINT) tells the operator to start Claude Code
//    so it refreshes on its own – that path never touches the store from this
//    side.
//  - Env lane. CLAUDE_CODE_OAUTH_TOKEN (Claude Code's own precedence: env
//    before the file) is used for the usage read only – never refreshed,
//    never persisted, never logged.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";
import { traceEnv, traceInput } from "../lib/input-trace.ts";
import { usableLiteralSecret } from "../lib/secret.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const SKEW_MS = 60_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client id, published across OSS forks.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const EXPIRED_HINT = "start Claude Code once so it refreshes the token, or run claude /login";

export interface ClaudeAuthOk {
  ok: true;
  accessToken: string;
}
export interface ClaudeAuthFail {
  ok: false;
  error: ProviderError;
  // Present iff error.kind is "expired-token" but the refresh token can still
  // mint a new access token – the caller may self-refresh.
  refreshToken?: string;
}
export type ClaudeAuth = ClaudeAuthOk | ClaudeAuthFail;

// Pure: given the parsed credentials file and the current time, either hand back the
// access token (probe keeps it in a local variable only) or the failure it represents.
// The expired-but-refreshable state is the failure plus `refreshToken`.
// Secret firewall: a stored token that is not a plain literal (env/template/command
// indirection) is an INVALID credential – present-but-unusable, never sent, never
// expanded; the refresh token is attached only when it too is a plain literal.
export function claudeAuth(fileObj: unknown, nowMs: number): ClaudeAuth {
  const oauth = (fileObj as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    return {
      ok: false,
      error: {
        kind: "no-credentials",
        message: "credentials file has no claudeAiOauth object",
        hint: "run claude /login",
      },
    };
  }
  const o = oauth as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    refreshTokenExpiresAt?: unknown;
  };
  if (typeof o.accessToken !== "string" || o.accessToken === "") {
    return {
      ok: false,
      error: { kind: "no-credentials", message: "claudeAiOauth.accessToken missing", hint: "run claude /login" },
    };
  }
  if (!usableLiteralSecret(o.accessToken)) {
    return {
      ok: false,
      error: {
        kind: "parse-failure",
        message: "claudeAiOauth.accessToken is not a literal secret (indirection) – refusing to use it",
        hint: "run claude /login",
      },
    };
  }
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) {
    return {
      ok: false,
      error: {
        kind: "parse-failure",
        message: "claudeAiOauth.expiresAt is not an epoch-ms number",
        hint: "run claude /login",
      },
    };
  }
  if (nowMs >= o.expiresAt - SKEW_MS) {
    const expired: ClaudeAuthFail = {
      ok: false,
      error: { kind: "expired-token", message: "Claude OAuth token expired", hint: EXPIRED_HINT },
    };
    const rt = o.refreshToken;
    const rte = o.refreshTokenExpiresAt;
    if (
      typeof rt === "string" &&
      usableLiteralSecret(rt) &&
      (typeof rte !== "number" || !Number.isFinite(rte) || rte > nowMs)
    ) {
      expired.refreshToken = rt;
    }
    return expired;
  }
  return { ok: true, accessToken: o.accessToken };
}

// Pure: JSON body for the OAuth refresh endpoint (tested directly).
export function buildRefreshBody(refreshToken: string): string {
  return JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });
}

interface ClaudeUsageWin {
  utilization?: unknown;
  resets_at?: unknown;
}

// Pure: map the usage endpoint body to spec windows; null when the shape is unrecognized.
// resets_at null or missing marks an inactive window (e.g. no open 5h session) – skip it, never a parse failure.
// seven_day_breakdown (per-surface mix: Claude Code / Chats / Cowork) rides along as
// `surfaces` when present – percentages, no tokens; absent/degenerate shapes are ignored.
export function parseClaudeUsage(
  body: unknown,
): { windows: Window[]; surfaces?: { key: string; name: string; percent: number }[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { five_hour?: ClaudeUsageWin; seven_day?: ClaudeUsageWin; seven_day_breakdown?: unknown };
  const windows: Window[] = [];
  const pairs: Array<[string, ClaudeUsageWin | undefined]> = [
    ["5h", b.five_hour],
    ["7d", b.seven_day],
  ];
  for (const [kind, w] of pairs) {
    if (w === undefined) continue;
    if (w.resets_at === null || w.resets_at === undefined) continue; // inactive window
    if (typeof w.utilization !== "number" || typeof w.resets_at !== "string") return null;
    const t = Date.parse(w.resets_at);
    if (!Number.isFinite(t)) return null;
    windows.push({ kind, usedPercent: w.utilization, resetsAt: new Date(t).toISOString() });
  }
  if (windows.length === 0) return null;
  const bd = b.seven_day_breakdown as { rows?: unknown } | undefined;
  const surfaces: { key: string; name: string; percent: number }[] = [];
  if (Array.isArray(bd?.rows)) {
    for (const raw of bd.rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as { key?: unknown; display_name?: unknown; percent?: unknown };
      if (typeof r.key !== "string" || r.key === "" || typeof r.percent !== "number" || !Number.isFinite(r.percent))
        continue;
      surfaces.push({
        key: r.key,
        name: typeof r.display_name === "string" && r.display_name !== "" ? r.display_name : r.key,
        percent: r.percent,
      });
    }
  }
  return surfaces.length > 0 ? { windows, surfaces } : { windows };
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

// Resolve a credential env var via core's getSecret (process.env first, then
// ~/.subtrk/env) and trace the resolved value for the cache stamp – one-way
// digest only, the value itself never leaves this lane. getSecret already
// registers non-empty values with the redaction layer; the core-less fallback
// leaves the value in a local variable.
async function tracedEnv(name: string): Promise<string | undefined> {
  let value: string | undefined;
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    value = core.getSecret?.(name);
  } catch {
    value = process.env[name];
  }
  traceEnv(name, value); // value digest only (cache stamp)
  return value;
}

// The credential store: $CLAUDE_CONFIG_DIR when set (traced – it selects which
// store is consulted), else ~/.claude. Keeps self-refresh from rotating a
// stale sibling store when Claude Code runs with a non-default config dir.
async function credentialsPath(): Promise<string> {
  const dir = await tracedEnv("CLAUDE_CONFIG_DIR");
  return join(dir !== undefined && dir.trim() !== "" ? dir : join(homedir(), ".claude"), ".credentials.json");
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "claude", ok: false, stale: false, fetchedAt, error };
}

// A failed write-back colors EVERY result that follows it: the live store
// keeps the SPENT refresh token regardless of how the usage read then ends,
// so each subsequent result carries the note (fail results keep their error
// kind and gain the note; ok results keep their windows).
function withNote(result: ProviderResult, note: string | undefined): ProviderResult {
  return note === undefined ? result : { ...result, note };
}

interface Refreshed {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

// Exchange the refresh token for a rotated pair. Null on any failure – the
// caller falls back to the plain expired-token error.
async function refreshOAuthToken(refreshToken: string): Promise<Refreshed | null> {
  const out = await fetchText(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: buildRefreshBody(refreshToken),
  });
  if (!out.ok) return null;
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return null;
  }
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (
    typeof b.access_token !== "string" ||
    b.access_token === "" ||
    typeof b.refresh_token !== "string" ||
    b.refresh_token === "" ||
    typeof b.expires_in !== "number" ||
    !Number.isFinite(b.expires_in) ||
    b.expires_in <= 0
  ) {
    return null;
  }
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAtMs: Date.now() + b.expires_in * 1000 };
}

// What a failed write-back means: the live store keeps the SPENT refresh
// token, so Claude Code signs out at its next refresh. This is surfaced on the
// ProviderResult, never silent.
const WRITE_BACK_FAILED_NOTE =
  "token refreshed but the credential store could not be updated — Claude Code may sign out; run claude /login to re-sync";

// Atomic merge into the SAME credentials file: temp+rename, ~2 attempts.
// Returns undefined on success, else WRITE_BACK_FAILED_NOTE for the caller to
// carry on EVERY ProviderResult that follows (ok results surface it as a
// warning, fail results keep their error and gain the note – the operator
// must learn the store holds a spent token either way). The merge is blind
// last-writer: it is based on the file as read before the exchange and does
// not detect a store Claude Code refreshed in the meantime (see the doctrine
// header – guarding that is lock machinery, out of scope).
function writeBackCredentials(credPath: string, fileObj: object, fresh: Refreshed): string | undefined {
  try {
    const merged = { ...(fileObj as Record<string, unknown>) };
    merged.claudeAiOauth = {
      ...((merged.claudeAiOauth as Record<string, unknown> | undefined) ?? {}),
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAtMs,
    };
    const payload = JSON.stringify(merged);
    for (let attempt = 0; attempt < 2; attempt++) {
      const tmp = `${credPath}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, payload);
        renameSync(tmp, credPath);
        return undefined;
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* fall through to the note */
  }
  return WRITE_BACK_FAILED_NOTE;
}

function usageRequest(token: string): Promise<FetchOutcome> {
  return fetchText(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "claude-code/2.1.11",
    },
  });
}

// Shared tail of both lanes: parse the usage body into the ok result.
function usageResult(text: string, fetchedAt: string): ProviderResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail({ kind: "parse-failure", message: "usage response was not JSON" }, fetchedAt);
  }
  const parsed = parseClaudeUsage(body);
  if (!parsed)
    return fail({ kind: "parse-failure", message: "usage response missing five_hour/seven_day keys" }, fetchedAt);
  return {
    id: "claude",
    ok: true,
    stale: false,
    fetchedAt,
    windows: parsed.windows,
    ...(parsed.surfaces ? { surfaces: parsed.surfaces } : {}),
  };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const credPath = await credentialsPath(); // traces CLAUDE_CONFIG_DIR (identity stamp)

  // Lane 1 – CLAUDE_CODE_OAUTH_TOKEN, Claude Code's own precedence: env before
  // the file. Blank/whitespace-only counts as nothing selected (fall through
  // to the file lane, not an error); a non-literal value is an INVALID
  // credential – present-but-unusable, never sent, never expanded.
  const envToken = await tracedEnv("CLAUDE_CODE_OAUTH_TOKEN");
  if (envToken !== undefined && envToken.trim() !== "") {
    if (!usableLiteralSecret(envToken)) {
      return fail(
        {
          kind: "parse-failure",
          message: "CLAUDE_CODE_OAUTH_TOKEN is not a literal secret (indirection) – refusing to use it",
          hint: "set a plain literal token, or unset the variable to use the credential file",
        },
        fetchedAt,
      );
    }
    void registerSecret(envToken);
    // Env tokens have no refresh token: this lane never rotates and never
    // persists – an expired response is terminal advice here, not a trigger.
    const out = await usageRequest(envToken);
    if (!out.ok) {
      if (out.status === 401) {
        return fail(
          {
            kind: "expired-token",
            message: "Claude rejected the CLAUDE_CODE_OAUTH_TOKEN access token (401)",
            hint: "replace CLAUDE_CODE_OAUTH_TOKEN with a fresh token, or unset it to fall back to the credential file – env tokens are never refreshed",
          },
          fetchedAt,
        );
      }
      return fail(out.error, fetchedAt);
    }
    return usageResult(out.text, fetchedAt);
  }

  // Lane 2 – the credential file (with rotation-on-use self-refresh).
  traceInput(credPath); // identity stats only, BEFORE the read (cache stamp)
  let text: string;
  try {
    text = readFileSync(credPath, "utf8");
  } catch {
    return fail(
      { kind: "no-credentials", message: `no Claude credentials at ${credPath}`, hint: "run claude /login" },
      fetchedAt,
    );
  }
  let fileObj: unknown;
  try {
    fileObj = JSON.parse(text);
  } catch {
    return fail(
      { kind: "parse-failure", message: "Claude credentials file is not valid JSON", hint: "run claude /login" },
      fetchedAt,
    );
  }
  const auth = claudeAuth(fileObj, Date.now());
  let accessToken: string;
  let note: string | undefined;
  if (auth.ok) {
    accessToken = auth.accessToken;
    void registerSecret(accessToken);
  } else if (auth.refreshToken) {
    // Expired but refreshable: register the old values before anything else,
    // then rotate. New values register before the write-back is attempted.
    const old = (fileObj as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
    if (typeof old?.accessToken === "string") void registerSecret(old.accessToken);
    void registerSecret(auth.refreshToken);
    const fresh = await refreshOAuthToken(auth.refreshToken);
    if (!fresh) {
      return fail(auth.error, fetchedAt);
    }
    void registerSecret(fresh.accessToken);
    void registerSecret(fresh.refreshToken);
    note = writeBackCredentials(credPath, fileObj as object, fresh);
    accessToken = fresh.accessToken;
  } else {
    return fail(auth.error, fetchedAt);
  }

  const out = await usageRequest(accessToken);
  if (!out.ok) {
    if (out.status === 401) {
      return withNote(
        fail(
          { kind: "expired-token", message: "Claude rejected the access token (401)", hint: "run claude /login" },
          fetchedAt,
        ),
        note,
      );
    }
    return withNote(fail(out.error, fetchedAt), note);
  }
  return withNote(usageResult(out.text, fetchedAt), note);
}

// probe = credential load + (expired -> self-refresh + write-back) + usage read.
// refresh reuses it: the self-refresh path already rotates the OAuth pair and
// persists it, so "refresh" is simply "probe now".
function probe(): Promise<ProviderResult> {
  return probeInner().catch(
    (e: unknown): ProviderResult =>
      fail(
        { kind: "http-error", message: `probe failed: ${e instanceof Error ? e.message : "unknown"}` },
        new Date().toISOString(),
      ),
  );
}

const provider: ProviderModule = {
  id: "claude",
  ttlMs: 300_000,
  probe,
  tracesInputs: true, // probe traces the credential file AND the CLAUDE_* env values – cache entries carry an identity stamp
  refresh: async () => {
    const r = await probe();
    const warning = r.note !== undefined ? ` – ${r.note}` : "";
    return {
      ok: r.ok,
      message: r.ok
        ? r.note !== undefined
          ? `claude token refreshed – ${r.note}`
          : "claude token refreshed"
        : `${r.error?.message ?? "claude refresh failed"}${warning}`,
    };
  },
};
export default provider;
