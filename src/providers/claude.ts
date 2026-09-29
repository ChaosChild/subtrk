// claude – Claude Pro personal subscription via the OAuth usage endpoint.
// Credential: ~/.claude/.credentials.json. Claude Code only refreshes the token
// while it runs, so when the access token is expired but the refresh token is
// still live, subtrk refreshes it against Claude Code's public OAuth client and
// writes the rotated pair back best-effort.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";

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
    if (typeof rt === "string" && rt !== "" && (typeof rte !== "number" || !Number.isFinite(rte) || rte > nowMs)) {
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

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "claude", ok: false, stale: false, fetchedAt, error };
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

// Best-effort atomic merge into the SAME credentials file: temp+rename, ~2
// attempts, silent give-up – Claude Code rewrites this file too, so races are
// expected. The rotated refresh token MUST be persisted or the file becomes
// unusable; the caller keeps using the new pair in memory regardless.
function writeBackCredentials(credPath: string, fileObj: object, fresh: Refreshed): void {
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
        return;
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* silent – a lost write-back costs one re-refresh next run */
  }
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const credPath = join(homedir(), ".claude", ".credentials.json");
  let text: string;
  try {
    text = readFileSync(credPath, "utf8");
  } catch {
    return fail(
      {
        kind: "no-credentials",
        message: "no Claude credentials at ~/.claude/.credentials.json",
        hint: "run claude /login",
      },
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
    writeBackCredentials(credPath, fileObj as object, fresh);
    accessToken = fresh.accessToken;
  } else {
    return fail(auth.error, fetchedAt);
  }

  const out = await fetchText(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "claude-code/2.1.11",
    },
  });
  if (!out.ok) {
    if (out.status === 401) {
      return fail(
        { kind: "expired-token", message: "Claude rejected the access token (401)", hint: "run claude /login" },
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
  refresh: async () => {
    const r = await probe();
    return {
      ok: r.ok,
      message: r.ok ? "claude token refreshed" : (r.error?.message ?? "claude refresh failed"),
    };
  },
};
export default provider;
