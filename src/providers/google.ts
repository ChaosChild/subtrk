// google – Google AI Pro, best-effort. Credential discovery order:
//   1. Windows Credential Manager generic credential "gemini:antigravity" (agy's OAuth
//      blob, UTF-8 JSON) – read with a FIXED literal PowerShell P/Invoke script, win32 only.
//   2. ~/.gemini/oauth_creds.json (legacy gemini: access_token, refresh_token,
//      expiry_date ms) – expired tokens are refreshed and written back to the same file.
//   3. ~/.gemini/antigravity-cli/antigravity-oauth-token (legacy antigravity).
// The implicit/*.pb files under antigravity-cli are encrypted trajectory data – never read.
// No third-party credential stores are read or written.
// Quota sources, in order:
//   1. The Antigravity DESKTOP app's local language server (win32) – the
//      authoritative view: the same two-group RetrieveUserQuotaSummary payload
//      the app's Model Quota panel renders. Discovery is a FIXED literal
//      PowerShell script (Win32_Process command line + Get-NetTCPConnection,
//      argument-vector spawn); the RPC is a loopback HTTPS Connect call
//      carrying the process's --csrf_token and needs NO OAuth material. The
//      listener's certificate is self-signed, so TLS verification is relaxed
//      for this literal-host 127.0.0.1 request only.
//   2. Remote fallback (any platform): POST /v1internal:retrieveUserQuotaSummary
//      with an EMPTY {} body (no loadCodeAssist step). This is the Code Assist
//      quota domain – live-verified 2026-09-28 to return synthetic full-quota
//      resets (fetch time +5h/+7d to the second) that do NOT reflect
//      Antigravity usage – so ok results carry a note saying the numbers may
//      not match the Antigravity dashboard.
// The agy-keyring lineage self-refreshes: the stored refresh token mints access
// tokens via the PUBLIC Antigravity client constants from ~/.subtrk/env.
// Google's refresh tokens are non-rotating (verified 2026-09-25) – the minted token
// lives in a local variable for the quota call only and nothing is ever written back
// to the keyring. Read-only refresh: agy does not need to be running. On quota 401
// the credential is re-read once (agy refreshes its store in place while running)
// and the call retried once. Legacy gemini/antigravity file lineages keep
// their own refresh (write-back for the gemini lineage only).

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";

const TIMEOUT_MS = 10_000;
const KEYRING_TIMEOUT_MS = 5_000; // Add-Type compile is slow on its first run
const MAX_RESPONSE_CHARS = 1_000_000;
const SKEW_MS = 60_000;
// Expired or inside this window -> mint a fresh access token.
const REFRESH_WINDOW_MS = 5 * 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PRIMARY_HOST = "https://cloudcode-pa.googleapis.com";
const FALLBACK_HOST = "https://daily-cloudcode-pa.googleapis.com";
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";

// Local language server (Antigravity desktop app) – the dashboard's own source.
const LS_QUOTA_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const LS_PS_TIMEOUT_MS = 4_000; // PowerShell CIM + TCP enumeration startup
const LS_PORT_TIMEOUT_MS = 1_500;
const LS_MAX_CANDIDATES = 3;
const LS_MAX_PORTS = 3;
// The remote REST view reads a different quota domain than the Antigravity
// dashboard (synthetic resets; agent usage never shows up) – label the result
// wherever it is the best available read.
const REMOTE_VIEW_NOTE =
  "remote Code Assist quota view – may not match the Antigravity dashboard; start the Antigravity app for its exact limits";

// The OAuth client constants for token refresh live in ~/.subtrk/env
// (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ANTIGRAVITY_CLIENT_ID /
// ANTIGRAVITY_CLIENT_SECRET). They are PUBLIC values – `subtrk init` fetches them
// from upstream sources – kept out of this repo so secret scanners stay quiet.
async function envClientValue(name: string): Promise<string | undefined> {
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    return core.getSecret?.(name);
  } catch {
    return undefined;
  }
}

// FIXED literal – nothing is ever interpolated into it. CredReadW (CharSet Unicode)
// reads the generic credential "gemini:antigravity" (type 1); CredFree releases the
// buffer; the CredentialBlob bytes are copied verbatim to stdout (UTF-8 JSON).
const AGY_KEYRING_PS_SCRIPT = `$src = 'using System;using System.Runtime.InteropServices;public static class SubtrkCredRead { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred); }';
Add-Type -TypeDefinition $src;
$p = [IntPtr]::Zero;
if (-not [SubtrkCredRead]::CredRead('gemini:antigravity', 1, 0, [ref]$p)) { exit 1 }
try { $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][SubtrkCredRead+CREDENTIAL]); $n = $c.CredentialBlobSize; $b = New-Object byte[] $n; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $n); $s = [Console]::OpenStandardOutput(); $s.Write($b, 0, $n); $s.Flush() } finally { [SubtrkCredRead]::CredFree($p) }`;

export interface GoogleCreds {
  accessToken?: string; // optional: an absent token simply means mint (needsRefresh)
  refreshToken?: string;
  expiresAtMs?: number;
  lineage: "gemini" | "antigravity" | "agy-keyring";
  raw?: Record<string, unknown>; // original JSON object, for gemini-lineage write-back
}

export interface AgyKeyringToken {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

// Pure: agy keyring blob { token: { access_token, refresh_token?, expiry? (RFC3339) } }.
export function parseAgyKeyringBlob(obj: unknown): AgyKeyringToken | null {
  if (typeof obj !== "object" || obj === null) return null;
  const token = (obj as { token?: unknown }).token;
  if (typeof token !== "object" || token === null) return null;
  const t = token as { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
  if (typeof t.access_token !== "string" || t.access_token === "") return null;
  const out: AgyKeyringToken = { accessToken: t.access_token };
  if (typeof t.refresh_token === "string" && t.refresh_token !== "") out.refreshToken = t.refresh_token;
  if (typeof t.expiry === "string") {
    const ms = Date.parse(t.expiry);
    if (Number.isFinite(ms)) out.expiresAtMs = ms;
  }
  return out;
}

// Pure: legacy gemini oauth_creds.json shape.
export function parseGeminiCreds(obj: unknown): GoogleCreds | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as { access_token?: unknown; refresh_token?: unknown; expiry_date?: unknown };
  if (typeof o.access_token !== "string" || o.access_token === "") return null;
  const creds: GoogleCreds = { accessToken: o.access_token, lineage: "gemini", raw: o as Record<string, unknown> };
  if (typeof o.refresh_token === "string" && o.refresh_token !== "") creds.refreshToken = o.refresh_token;
  if (typeof o.expiry_date === "number" && Number.isFinite(o.expiry_date)) creds.expiresAtMs = o.expiry_date;
  return creds;
}

// Pure: antigravity token file – JSON with access_token if it parses as such, else the
// bare token string (no refresh, no known expiry).
export function parseAntigravityTokenFile(text: string): GoogleCreds | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof (obj as { access_token?: unknown }).access_token === "string"
    ) {
      const creds = parseGeminiCreds(obj);
      return creds ? { ...creds, lineage: "antigravity" } : null;
    }
    return null;
  } catch {
    return { accessToken: trimmed, lineage: "antigravity" };
  }
}

// Pure: past expiry with the 60s clock skew; unknown expiry counts as unexpired.
export function googleExpired(creds: GoogleCreds, nowMs: number): boolean {
  if (creds.expiresAtMs === undefined) return false;
  return nowMs >= creds.expiresAtMs - SKEW_MS;
}

// Shared wording for the self-refresh lineage: a rejected grant means the stored
// login died – re-login once in the owning tool. agy need not be running.
const GRANT_REJECTED_ERROR: ProviderError = {
  kind: "expired-token",
  message: "refresh token rejected by Google",
  hint: "the stored login was revoked – re-login once",
  remedy: "re-login inside agy",
};

// Pure: the public Antigravity client constants are fetched by `subtrk init` into
// ~/.subtrk/env – no literal lives in this repo, so secret scanners stay quiet.
export const ANTIGRAVITY_CONSTANTS_MISSING: ProviderError = {
  kind: "no-credentials",
  message: "antigravity client constants missing",
  hint: "run subtrk init (fetches the public values)",
  remedy: "subtrk init",
};

// Pure: self-refresh decision for the agy-keyring lineage – an absent
// access token or an expiry inside the safety window means mint instead of fail.
export function needsRefresh(creds: GoogleCreds, nowMs: number): boolean {
  if (!creds.accessToken) return true;
  if (typeof creds.expiresAtMs !== "number" || !Number.isFinite(creds.expiresAtMs)) return false;
  return nowMs >= creds.expiresAtMs - REFRESH_WINDOW_MS;
}

// Pure: "Gemini Models" -> "gemini-models".
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Pure: "gemini-weekly"-style bucketId -> window kind when the `window` field is absent.
function kindFromBucketId(bucketId: unknown): string | null {
  if (typeof bucketId !== "string" || bucketId === "") return null;
  const lower = bucketId.toLowerCase();
  if (lower.includes("weekly")) return "7d";
  if (lower.includes("5h")) return "5h";
  return slugify(bucketId) || null;
}

// Pure: the desktop language server nests the summary under `response`; the
// remote REST call does not. Accept both shapes.
export function googleSummaryRoot(body: unknown): unknown {
  if (typeof body === "object" && body !== null) {
    const inner = (body as { response?: unknown }).response;
    if (typeof inner === "object" && inner !== null && Array.isArray((inner as { groups?: unknown }).groups)) {
      return inner;
    }
  }
  return body;
}

// Pure: groups[].displayName -> scope, buckets[] -> windows. null when groups is absent
// or not an array; empty groups array is a valid (degraded) shape -> [].
export function parseGoogleSummary(body: unknown): Window[] | null {
  if (typeof body !== "object" || body === null) return null;
  const groups = (googleSummaryRoot(body) as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const windows: Window[] = [];
  for (const rawGroup of groups) {
    if (typeof rawGroup !== "object" || rawGroup === null) continue;
    const g = rawGroup as { displayName?: unknown; buckets?: unknown };
    const scope = typeof g.displayName === "string" && g.displayName !== "" ? slugify(g.displayName) : undefined;
    if (!Array.isArray(g.buckets)) continue;
    for (const rawBucket of g.buckets) {
      if (typeof rawBucket !== "object" || rawBucket === null) continue;
      const b = rawBucket as {
        window?: unknown;
        bucketId?: unknown;
        remainingFraction?: unknown;
        resetTime?: unknown;
        disabled?: unknown;
      };
      // A disabled bucket carries no measurement (e.g. the 5h bucket while the
      // weekly limit is hit: "the 5-hour limit does not currently apply").
      if (b.disabled === true) continue;
      if (typeof b.remainingFraction !== "number" || typeof b.resetTime !== "string") continue;
      // "weekly" is normalized to "7d" for cross-provider consistency (claude/glm report the same measure as "7d").
      const rawKind = typeof b.window === "string" && b.window !== "" ? b.window : kindFromBucketId(b.bucketId);
      const kind = rawKind === "weekly" ? "7d" : rawKind;
      if (kind === null) continue;
      const t = Date.parse(b.resetTime);
      if (!Number.isFinite(t)) continue;
      const w: Window = { kind, resetsAt: new Date(t).toISOString(), remainingFraction: b.remainingFraction };
      if (scope) w.scope = scope;
      windows.push(w);
    }
  }
  return windows;
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

function postJson(url: string, body: unknown, token: string): Promise<FetchOutcome> {
  return fetchText(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
    body: JSON.stringify(body),
  });
}

function postForm(url: string, params: URLSearchParams): Promise<FetchOutcome> {
  return fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
}

async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

async function registerCreds(creds: GoogleCreds): Promise<void> {
  if (creds.accessToken) await registerSecret(creds.accessToken);
  if (creds.refreshToken) await registerSecret(creds.refreshToken);
}

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Credential Manager read: fixed-literal script, argument-vector spawn (no shell).
// Any failure – spawn error, non-zero exit, timeout, non-JSON stdout – is simply "no
// keyring credential". Blob text (a secret) never reaches an error message.
function runKeyringScript(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", AGY_KEYRING_PS_SCRIPT],
        { timeout: KEYRING_TIMEOUT_MS, windowsHide: true, maxBuffer: 1_000_000 },
        (err, stdout) => resolve(err ? null : String(stdout ?? "")),
      );
    } catch {
      resolve(null);
    }
  });
}

async function readKeyringCreds(): Promise<GoogleCreds | null> {
  if (process.platform !== "win32") return null;
  const text = await runKeyringScript();
  if (text === null) return null;
  try {
    const blob = parseAgyKeyringBlob(JSON.parse(text));
    return blob ? { ...blob, lineage: "agy-keyring" } : null;
  } catch {
    return null;
  }
}

async function discoverCreds(): Promise<{ creds: GoogleCreds; path?: string } | null> {
  const keyring = await readKeyringCreds();
  if (keyring) return { creds: keyring };
  const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
  const geminiText = readTextIfExists(geminiPath);
  if (geminiText !== null) {
    try {
      const creds = parseGeminiCreds(JSON.parse(geminiText));
      if (creds) return { creds, path: geminiPath };
    } catch {
      // fall through to the antigravity lineage
    }
  }
  const antiPath = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const antiText = readTextIfExists(antiPath);
  if (antiText !== null) {
    const creds = parseAntigravityTokenFile(antiText);
    if (creds) return { creds, path: antiPath };
  }
  return null;
}

// Best-effort write-back of the refreshed token to the SAME gemini file (temp+rename);
// gemini-cli rewrites it too – tolerate races, swallow all errors.
function writeBackCreds(path: string, raw: Record<string, unknown>, accessToken: string, expiresAtMs: number): void {
  try {
    raw.access_token = accessToken;
    raw.expiry_date = expiresAtMs;
    const tmp = `${path}.subtrk-tmp`;
    writeFileSync(tmp, JSON.stringify(raw), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort only
  }
}

type RefreshOutcome = { ok: true; accessToken: string; expiresAtMs: number } | { ok: false; error: ProviderError };

async function refreshAccessToken(creds: GoogleCreds): Promise<RefreshOutcome> {
  const missing = (what: string): RefreshOutcome => ({
    ok: false,
    error: {
      kind: "no-credentials",
      message: `${what} not configured`,
      hint: "run subtrk init (fetches the public values) or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in ~/.subtrk/env",
    },
  });
  const clientId = await envClientValue(creds.lineage === "gemini" ? "GOOGLE_CLIENT_ID" : "ANTIGRAVITY_CLIENT_ID");
  if (!clientId) return missing(creds.lineage === "gemini" ? "GOOGLE_CLIENT_ID" : "ANTIGRAVITY_CLIENT_ID");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken ?? "",
    client_id: clientId,
  });
  if (creds.lineage === "gemini") {
    const clientSecret = await envClientValue("GOOGLE_CLIENT_SECRET");
    if (!clientSecret) return missing("GOOGLE_CLIENT_SECRET");
    params.set("client_secret", clientSecret);
  }
  const out = await postForm(TOKEN_URL, params);
  if (!out.ok) {
    let code = "";
    if (typeof out.text === "string") {
      try {
        code = String((JSON.parse(out.text) as { error?: unknown }).error ?? "");
      } catch {
        // body not JSON – no error code available
      }
    }
    if (code === "invalid_client") {
      return {
        ok: false,
        error: {
          kind: "expired-token",
          message: "token refresh rejected (invalid_client)",
          hint: "log in again with agy",
          remedy: "re-login inside agy",
        },
      };
    }
    return { ok: false, error: out.error };
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response was not JSON" } };
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response missing access_token/expires_in" } };
  }
  return { ok: true, accessToken, expiresAtMs: Date.now() + expiresIn * 1000 };
}

// ---- self-refresh for the agy-keyring lineage ----

// Pure: form-encoded refresh grant for the Antigravity client – a CONFIDENTIAL
// client, so both constants travel.
export function buildAntigravityRefreshForm(refreshToken: string, clientId: string, clientSecret: string): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
}

// Pure: map a failed token-endpoint grant to the operator error. Google answers a
// revoked login with 400/401 (body error invalid_grant); anything else stays a
// transport-level http-error.
export function mapGrantFailure(status: number | undefined, errorCode: string): ProviderError {
  if (status === 400 || status === 401 || errorCode === "invalid_grant") return GRANT_REJECTED_ERROR;
  return status === undefined
    ? { kind: "http-error", message: "token endpoint unreachable" }
    : { kind: "http-error", message: `HTTP ${status}`, status };
}

// Pure: validate the token endpoint's success body. Google returns NO new
// refresh_token (non-rotating) – nothing here is ever persisted.
export function parseMintResponse(text: string, nowMs: number): RefreshOutcome {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response was not JSON" } };
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response missing access_token/expires_in" } };
  }
  return { ok: true, accessToken, expiresAtMs: nowMs + expiresIn * 1000 };
}

// Thin wrapper (untested, like alibaba's mapRefreshOutcome caller): resolve the
// public constants from ~/.subtrk/env, post the grant, map the outcome.
async function mintAccessToken(refreshToken: string): Promise<RefreshOutcome> {
  const clientId = await envClientValue("ANTIGRAVITY_CLIENT_ID");
  const clientSecret = await envClientValue("ANTIGRAVITY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, error: ANTIGRAVITY_CONSTANTS_MISSING };
  const out = await postForm(
    TOKEN_URL,
    new URLSearchParams(buildAntigravityRefreshForm(refreshToken, clientId, clientSecret)),
  );
  if (!out.ok) {
    let code = "";
    if (typeof out.text === "string") {
      try {
        code = String((JSON.parse(out.text) as { error?: unknown }).error ?? "");
      } catch {
        // body not JSON – no error code available
      }
    }
    return { ok: false, error: mapGrantFailure(out.status, code) };
  }
  return parseMintResponse(out.text, Date.now());
}

// ---- Antigravity desktop language server (the dashboard's own source) ----

export interface LsCandidate {
  pid: number;
  csrf: string;
  ports: number[];
}

// FIXED literal discovery script (argument-vector spawn, nothing interpolated):
// desktop-app language servers only (`--app_data_dir antigravity` – the IDE
// extension's `antigravity-ide` does not match) that carry a --csrf_token,
// with their loopback HTTPS listeners. Windows PowerShell 5.1 compatible;
// -InputObject keeps the empty/single-element result a JSON array.
const LS_DISCOVERY_PS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$out = @()
Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | ForEach-Object {
  $cl = [string]$_.CommandLine
  if ($cl -match '--app_data_dir\\s+antigravity(\\s|$)' -and $cl -match '--csrf_token\\s+([0-9a-fA-F-]{8,64})') {
    $ports = @(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
      Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
    $out += [pscustomobject]@{ pid = $_.ProcessId; csrf = $Matches[1]; ports = $ports }
  }
}
ConvertTo-Json -InputObject $out -Compress`;

// Pure: parse the discovery script's JSON. Malformed, credential-less or
// port-invalid entries are dropped, ports deduped. A bare single object (a PS
// pipeline quirk) is tolerated alongside the array form.
export function parseLsCandidates(text: string): LsCandidate[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: LsCandidate[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as { pid?: unknown; csrf?: unknown; ports?: unknown };
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) continue;
    if (typeof o.csrf !== "string" || o.csrf === "") continue;
    if (!Array.isArray(o.ports)) continue;
    const ports = [
      ...new Set(
        o.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65_535),
      ),
    ];
    if (ports.length === 0) continue;
    out.push({ pid: o.pid, csrf: o.csrf, ports });
  }
  return out;
}

// Thin wrapper (untested, like runKeyringScript): any failure is simply "no
// local source". Output is tiny; the 1MB cap is generous.
function runLsDiscovery(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", LS_DISCOVERY_PS_SCRIPT],
        { timeout: LS_PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1_000_000 },
        (err, stdout) => resolve(err ? null : String(stdout ?? "")),
      );
    } catch {
      resolve(null);
    }
  });
}

// Thin wrapper (untested): loopback Connect-RPC POST to the language server.
// The certificate is self-signed and the host is the fixed literal 127.0.0.1,
// so TLS verification is relaxed for THIS request only – the peer is pinned by
// the literal loopback host, the CSRF header, and the local process boundary.
function lsQuotaPost(csrf: string, port: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: LS_QUOTA_PATH,
        timeout: LS_PORT_TIMEOUT_MS,
        rejectUnauthorized: false,
        headers: {
          "X-Codeium-Csrf-Token": csrf,
          "Connect-Protocol-Version": "1",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total <= MAX_RESPONSE_CHARS) chunks.push(chunk);
        });
        res.on("error", () => resolve({ ok: false }));
        res.on("end", () => {
          if (res.statusCode !== 200 || total > MAX_RESPONSE_CHARS) {
            resolve({ ok: false });
            return;
          }
          resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on("error", () => resolve({ ok: false }));
    req.end("{}");
  });
}

type LocalProbe = { windows: Window[] } | { windows: null; reason?: string };

// The desktop app's language server serves the same two-group payload its
// Model Quota panel renders – the authoritative Antigravity view, reachable
// with no OAuth material. Every failure degrades to a reason string; the
// remote fallback decides what the operator sees.
async function probeLocalLanguageServer(): Promise<LocalProbe> {
  if (process.platform !== "win32") return { windows: null };
  const text = await runLsDiscovery();
  const candidates = text === null ? [] : parseLsCandidates(text);
  if (candidates.length === 0) {
    return { windows: null, reason: "no Antigravity desktop language server process" };
  }
  for (const cand of candidates.slice(0, LS_MAX_CANDIDATES)) {
    await registerSecret(cand.csrf);
    for (const port of cand.ports.slice(0, LS_MAX_PORTS)) {
      const out = await lsQuotaPost(cand.csrf, port);
      if (!out.ok) continue;
      let body: unknown;
      try {
        body = JSON.parse(out.text);
      } catch {
        continue; // a listener that is not the Connect endpoint (empty or other body)
      }
      const windows = parseGoogleSummary(body);
      if (windows && windows.length > 0) return { windows };
    }
  }
  return { windows: null, reason: "quota RPC unreachable on all language server ports" };
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "google", ok: false, stale: false, fetchedAt, error };
}

// Remote Code Assist REST fallback: credential load + (stale -> mint) + quota
// read. The response is the Code Assist quota domain – synthetic resets, not
// the Antigravity dashboard's numbers – so ok results carry REMOTE_VIEW_NOTE.
async function probeRemote(fetchedAt: string): Promise<ProviderResult> {
  const found = await discoverCreds();
  if (!found) {
    return fail(
      {
        kind: "no-credentials",
        message: "no Google/Antigravity credential found (agy keyring and file lineages)",
        hint: "log in once with agy (irm https://antigravity.google/cli/install.ps1 | iex)",
      },
      fetchedAt,
    );
  }
  await registerCreds(found.creds);

  let token = found.creds.accessToken ?? "";
  // Self-refresh lineage: an absent or stale token is MINTED, not an error – the
  // stored refresh token stays valid. Google's refresh tokens are non-rotating
  // (verified 2026-09-25), so nothing is ever written back to the keyring; the
  // minted token lives in this local variable only.
  // File lineages keep the expiry check + refresh (write-back for gemini only).
  if (found.creds.lineage === "agy-keyring") {
    if (needsRefresh(found.creds, Date.now())) {
      if (!found.creds.refreshToken) {
        return fail(
          {
            kind: "expired-token",
            message: "access token stale and the credential carries no refresh_token",
            hint: "re-login once in the owning tool",
            remedy: "re-login inside agy",
          },
          fetchedAt,
        );
      }
      const minted = await mintAccessToken(found.creds.refreshToken);
      if (!minted.ok) return fail(minted.error, fetchedAt);
      await registerSecret(minted.accessToken);
      token = minted.accessToken;
    }
  } else if (googleExpired(found.creds, Date.now())) {
    if (!found.creds.refreshToken) {
      return fail(
        {
          kind: "expired-token",
          message: "access token expired and no refresh_token in the credential file",
          hint: "log in again with agy",
          remedy: "re-login inside agy",
        },
        fetchedAt,
      );
    }
    const refreshed = await refreshAccessToken(found.creds);
    if (!refreshed.ok) return fail(refreshed.error, fetchedAt);
    token = refreshed.accessToken;
    if (found.creds.lineage === "gemini" && found.creds.raw && found.path) {
      writeBackCreds(found.path, found.creds.raw, refreshed.accessToken, refreshed.expiresAtMs);
    }
  }

  let out = await postJson(`${PRIMARY_HOST}${QUOTA_PATH}`, {}, token);
  if (!out.ok && out.status === 401) {
    // agy may have refreshed its stored credential in place –
    // re-read once, retry once.
    const reread = await discoverCreds();
    if (reread) {
      await registerCreds(reread.creds);
      token = reread.creds.accessToken ?? token;
    }
    out = await postJson(`${PRIMARY_HOST}${QUOTA_PATH}`, {}, token);
    if (!out.ok && out.status === 401) {
      return fail(
        {
          kind: "expired-token",
          message: "token rejected (401, also after one credential re-read)",
          hint: "the stored login was revoked – re-login once",
          remedy: "re-login inside agy",
        },
        fetchedAt,
      );
    }
  }
  if (!out.ok && (out.status === 403 || out.status === 404)) {
    const retry = await postJson(`${FALLBACK_HOST}${QUOTA_PATH}`, {}, token);
    if (!retry.ok) {
      return fail(
        {
          kind: "not-readable-remotely",
          message: `quota summary failed on both hosts (HTTP ${out.status} then ${retry.status ?? retry.error.kind})`,
          hint: "run agy /usage",
        },
        fetchedAt,
      );
    }
    out = retry;
  }
  if (!out.ok) return fail(out.error, fetchedAt);

  let summary: unknown;
  try {
    summary = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "quota summary was not JSON" }, fetchedAt);
  }
  const windows = parseGoogleSummary(summary);
  if (windows === null) return fail({ kind: "parse-failure", message: "quota summary shape unrecognized" }, fetchedAt);
  if (windows.length === 0) {
    return fail(
      { kind: "not-readable-remotely", message: "quota groups empty or free-tier shaped", hint: "run agy /usage" },
      fetchedAt,
    );
  }
  return { id: "google", ok: true, stale: false, fetchedAt, windows };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  // 1) The Antigravity desktop app's language server – the dashboard's exact
  //    numbers, no OAuth material involved.
  const local = await probeLocalLanguageServer();
  if (local.windows) return { id: "google", ok: true, stale: false, fetchedAt, windows: local.windows };
  // 2) Remote REST fallback (any platform, any running state).
  const remote = await probeRemote(fetchedAt);
  if (remote.ok) return { ...remote, note: REMOTE_VIEW_NOTE };
  const err: ProviderError = remote.error ?? { kind: "not-readable-remotely", message: "quota read failed" };
  if (local.reason) {
    return {
      ...remote,
      error: {
        ...err,
        message: `${err.message}; local Antigravity language server unavailable (${local.reason})`,
      },
    };
  }
  return { ...remote, error: err };
}

// probe = local language server first, then the remote REST fallback.
// refresh reuses it: the remote path already mints from the stored
// non-rotating refresh token (read-only, no write-back), so "refresh" is simply
// "probe now".
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
  id: "google",
  ttlMs: 60_000,
  probe,
  refresh: async () => {
    const r = await probe();
    return {
      ok: r.ok,
      message: r.ok ? "google quota refreshed" : (r.error?.message ?? "google refresh failed"),
    };
  },
};
export default provider;
