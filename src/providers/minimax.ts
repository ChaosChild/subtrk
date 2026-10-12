// minimax – MiniMax coding-plan token quota and pay-as-you-go balance.
// Credentials, in order: env MINIMAX_API_KEY (process env first, then
// ~/.subtrk/env), then the MiniMax CLI's own config ~/.mmx/config.json (dir
// overridable via MMX_CONFIG_DIR) – only the key/host fields are read. Two
// endpoint families across two pinned first-party hosts: a plain (bearer) key
// reads /v1/token_plan/remains (per-model 5h + weekly quota windows), an
// "sk-api-" key reads /account/query_balance (the account balance). A
// config-declared base URL must target api.minimax.io or api.minimaxi.com or
// the credential is refused – never followed.
// Window normalization adapted from quota-axi (MIT), src/providers/minimax.ts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credits, ProviderError, ProviderId, ProviderModule, ProviderResult, Window } from "../core.ts";
import { traceEnv, traceInput } from "../lib/input-trace.ts";
import { redactSecret, usableLiteralSecret } from "../lib/secret.ts";
import { slugify } from "./google.ts";
import { windowKindFromSeconds } from "./openai.ts";

// core.ts's ProviderId union gains "minimax" in the core workstream; the local
// widening keeps this module typecheck-clean until that lands.
const ID = "minimax" as ProviderId;

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const GLOBAL_BASE_URL = "https://api.minimax.io";
const CHINA_BASE_URL = "https://api.minimaxi.com";
const QUOTA_PATH = "/v1/token_plan/remains";
const BALANCE_PATH = "/account/query_balance";

// Deployment host pin: the ONLY hosts a MiniMax credential may be sent to –
// exactly the vendor's two first-party API deployments (global, China). A
// tampered config can therefore never redirect the bearer.
const MINIMAX_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.minimax.io", "api.minimaxi.com"]);

// Pure: a target is credential-bearing only when it is https on a pinned
// first-party host (default port). Anything else is refused before the
// credential leaves the process.
export function minimaxTargetAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.port === "" && MINIMAX_ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// Pure: the MiniMax CLI config path – MMX_CONFIG_DIR overrides the ~/.mmx
// default (empty/whitespace values fall back to the default).
export function minimaxConfigPath(configDir: string | undefined = process.env.MMX_CONFIG_DIR): string {
  const dir = typeof configDir === "string" && configDir.trim() !== "" ? configDir : join(homedir(), ".mmx");
  return join(dir, "config.json");
}

export interface MinimaxConfig {
  key: string | null; // usable literal credential (api_key or oauth.access_token)
  foreignBase: string | null; // parseable declared base URL that is NOT pinned (refusal)
  baseUrl: string | null; // pinned origin from the declaration (null when none/unparseable)
  region: string | null; // "cn" selects the China deployment
}

// Pure: the parsed config object -> only the fields this probe needs. A base
// URL that parses but does not target a pinned host is reported as foreignBase
// – a refusal, never a redirect. Secret firewall: a key shaped like an
// indirection ($/!-prefixed, control chars) is present-but-unusable – null,
// never sent, never expanded.
export function parseMinimaxConfig(fileObj: unknown): MinimaxConfig {
  const out: MinimaxConfig = { key: null, foreignBase: null, baseUrl: null, region: null };
  if (typeof fileObj !== "object" || fileObj === null) return out;
  const o = fileObj as Record<string, unknown>;
  if (typeof o.api_key === "string" && o.api_key !== "" && usableLiteralSecret(o.api_key)) out.key = o.api_key;
  if (!out.key) {
    const oauth = typeof o.oauth === "object" && o.oauth !== null ? (o.oauth as Record<string, unknown>) : null;
    const token = oauth?.access_token;
    if (typeof token === "string" && token !== "" && usableLiteralSecret(token)) out.key = token;
  }
  const declared = typeof o.base_url === "string" ? o.base_url : undefined;
  if (declared !== undefined) {
    try {
      const origin = new URL(declared).origin;
      if (minimaxTargetAllowed(origin)) out.baseUrl = origin;
      else out.foreignBase = declared;
    } catch {
      // unparseable – not an endpoint declaration, keep the default host
    }
  }
  if (!out.baseUrl && !out.foreignBase) {
    const oauth = typeof o.oauth === "object" && o.oauth !== null ? (o.oauth as Record<string, unknown>) : null;
    const resource = oauth?.resource_url;
    if (typeof resource === "string" && resource !== "") {
      try {
        const origin = new URL(resource).origin;
        if (minimaxTargetAllowed(origin)) out.baseUrl = origin;
        else out.foreignBase = resource;
      } catch {
        // unparseable – not an endpoint declaration
      }
    }
  }
  if (typeof o.region === "string" && o.region !== "") out.region = o.region;
  return out;
}

// Read + parse the config file; "absent" | "invalid" (exists but not JSON) |
// "ok". The parsers never touch the filesystem; traceInput runs BEFORE the
// read so the cache stamp covers the file's identity at consult time.
export function readMinimaxConfig(
  path: string,
): { state: "absent" } | { state: "invalid" } | { state: "ok"; obj: Record<string, unknown> } {
  traceInput(path); // identity stats only, BEFORE the read (cache stamp)
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { state: "absent" } : { state: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { state: "ok", obj: parsed as Record<string, unknown> };
    }
    return { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function quotaNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Pure: epoch seconds or milliseconds (numbers or numeric strings) -> ISO
// string; null when unusable.
function epochToIso(v: unknown): string | null {
  const n = quotaNumber(v);
  if (n === null || n <= 0) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Pure: clamp to 0..100.
function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

// The two per-model window prefixes: current_interval (the 5h session-kind
// window) and current_weekly. Field names follow the vendor's wire shape.
const WINDOW_PREFIXES = ["current_interval", "current_weekly"] as const;

// Pure: one model_remains row + prefix -> a Window; null when the entry is
// absent (fields for that prefix not present at all), the vendor's
// no-allocation marker (status 3 with zero totals), or the reset time is
// unusable (subtrk windows always carry resetsAt). percentRemaining comes from
// the explicit *_remaining_percent when present, else from the counts – which
// the vendor's CLI reads as REMAINING when no explicit percentage exists.
function modelWindow(row: Record<string, unknown>, prefix: string, scope: string): Window | null {
  const status = row[`${prefix}_status`];
  const total = row[`${prefix}_total_count`];
  const usage = row[`${prefix}_usage_count`];
  const explicitRemaining = row[`${prefix}_remaining_percent`];
  if (status === undefined && total === undefined && usage === undefined && explicitRemaining === undefined) {
    return null; // prefix absent from this row entirely
  }
  if (quotaNumber(status) === 3 && quotaNumber(total) === 0 && quotaNumber(usage) === 0) {
    return null; // no-allocation window – nothing to report
  }
  const startKey = prefix === "current_weekly" ? "weekly_start_time" : "start_time";
  const endKey = prefix === "current_weekly" ? "weekly_end_time" : "end_time";
  const resetsAt = epochToIso(row[endKey]);
  if (resetsAt === null) return null;
  const startMs = epochToIso(row[startKey]);
  let kind: string;
  if (startMs !== null) {
    const seconds = (Date.parse(resetsAt) - Date.parse(startMs)) / 1000;
    kind = seconds > 0 ? windowKindFromSeconds(seconds) : prefix === "current_weekly" ? "7d" : "5h";
  } else {
    kind = prefix === "current_weekly" ? "7d" : "5h"; // the vendor's fixed cadences
  }
  let usedPercent: number | undefined;
  const remaining =
    typeof explicitRemaining === "number" && Number.isFinite(explicitRemaining)
      ? clampPercent(explicitRemaining)
      : remainingFromCounts(quotaNumber(usage), quotaNumber(total));
  if (remaining !== null) usedPercent = clampPercent(100 - remaining);
  else if (quotaNumber(status) === 2) usedPercent = 100; // exhausted, no usable numbers
  const window: Window = { kind, resetsAt, ...(usedPercent !== undefined ? { usedPercent } : {}), scope };
  return window;
}

// Pure: (usage/total)*100 as a remaining percent; null when the pair is
// unusable. MiniMax's official CLI preserves the legacy meaning of usage_count
// when no explicit percentage is present: it is the remaining count.
function remainingFromCounts(usage: number | null, total: number | null): number | null {
  if (usage === null || total === null || total <= 0 || usage < 0 || usage > total) return null;
  return clampPercent((usage / total) * 100);
}

export interface MinimaxUsage {
  windows: Window[];
  plan?: string;
  empty?: true;
}

// Pure: the token_plan/remains body -> per-model windows. null is reserved for
// shape failures (non-object body, model_remains absent or not an array) – the
// probe maps null to parse-failure. Rows without a usable model name are
// skipped; a body whose every row is no-allocation degrades to the empty state.
export function parseMinimaxTokenPlan(body: unknown): MinimaxUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const data =
    typeof (body as { data?: unknown }).data === "object" && (body as { data?: unknown }).data !== null
      ? ((body as { data: unknown }).data as Record<string, unknown>)
      : (body as Record<string, unknown>);
  const rows = data.model_remains;
  if (!Array.isArray(rows)) return null;
  const windows: Window[] = [];
  let plan: string | undefined;
  for (const name of ["plan", "plan_name", "planName"] as const) {
    if (typeof data[name] === "string" && data[name] !== "") {
      plan = data[name] as string;
      break;
    }
  }
  let namedRows = 0;
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const modelName = typeof row.model_name === "string" ? row.model_name : "";
    const scope = slugify(modelName);
    if (scope === "") continue;
    namedRows += 1;
    for (const prefix of WINDOW_PREFIXES) {
      const w = modelWindow(row, prefix, scope);
      if (w) windows.push(w);
    }
  }
  if (namedRows > 0 && windows.length === 0) return { windows, ...(plan ? { plan } : {}), empty: true };
  return { windows, ...(plan ? { plan } : {}) };
}

// Pure: the query_balance body -> the available amount; null when the shape is
// unrecognized (non-object body or no usable available_amount).
export function parseMinimaxBalance(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const data =
    typeof (body as { data?: unknown }).data === "object" && (body as { data?: unknown }).data !== null
      ? ((body as { data: unknown }).data as Record<string, unknown>)
      : (body as Record<string, unknown>);
  return quotaNumber(data.available_amount);
}

// Pure: base_resp.status_code != 0 is the vendor's application-level error;
// 1004/2049 are the auth rejections. null when the body carries no error.
function baseRespError(body: unknown): { statusCode: number; auth: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const baseResp = (body as { base_resp?: unknown }).base_resp;
  if (typeof baseResp !== "object" || baseResp === null) return null;
  const statusCode = quotaNumber((baseResp as { status_code?: unknown }).status_code);
  if (statusCode === null || statusCode === 0) return null;
  return { statusCode, auth: statusCode === 1004 || statusCode === 2049 };
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

// Every credential-bearing request goes through the deployment pin: a target
// that is not a pinned first-party host is refused client-side (clear error,
// no fetch), whatever the caller passed in.
function credFetch(url: string, init: RequestInit): Promise<FetchOutcome> {
  if (!minimaxTargetAllowed(url)) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: "forbidden",
        message: `refusing to send the MiniMax credential to a non-first-party target (${url})`,
        hint: "the MiniMax endpoints are fixed first-party hosts – no local setting may redirect them",
      },
    });
  }
  return fetchText(url, init);
}

// Pure: the deployment the config implies – a pinned declared origin wins,
// else a region of "cn" selects the China deployment, else the global default.
export function minimaxBaseUrl(cfg: MinimaxConfig | null): string {
  if (cfg?.baseUrl) return cfg.baseUrl;
  return cfg?.region?.toLowerCase() === "cn" ? CHINA_BASE_URL : GLOBAL_BASE_URL;
}

async function getSecret(name: string): Promise<string | undefined> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    if (typeof core.getSecret === "function") {
      const s = core.getSecret(name);
      if (s) return s;
    }
  } catch {
    // core not present – process.env only
  }
  return undefined;
}

async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: ID, ok: false, stale: false, fetchedAt, error };
}

// Honest UA – vendor client UAs are never spoofed.
function usageHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "subtrk" };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();

  const envKey = await getSecret("MINIMAX_API_KEY");
  traceEnv("MINIMAX_API_KEY", envKey); // value digest only (cache stamp)
  const configDir = process.env.MMX_CONFIG_DIR;
  traceEnv("MMX_CONFIG_DIR", configDir); // selects which credential file is consulted
  const configPath = minimaxConfigPath(configDir);
  const file = readMinimaxConfig(configPath);
  const cfg = file.state === "ok" ? parseMinimaxConfig(file.obj) : null;

  // A poisoned config must not hide behind the env fallback: a parseable
  // declared base URL that is not a pinned first-party host refuses the whole
  // probe (kimi's rule). The declaration is file content, so credential values
  // are redacted from the message.
  if (cfg?.foreignBase) {
    const secrets = [envKey, cfg.key].filter((s): s is string => typeof s === "string" && s !== "");
    return fail(
      {
        kind: "forbidden",
        message: redactSecret(
          `${configPath} declares a non-first-party endpoint (${cfg.foreignBase}) – refusing to use it`,
          secrets,
        ),
        hint: "remove the base_url/resource_url override from the MiniMax CLI config or point it at api.minimax.io / api.minimaxi.com",
      },
      fetchedAt,
    );
  }
  // A config file that exists but is not JSON is an INVALID credential source –
  // reported, never silently skipped (the operator must see the corruption).
  if (file.state === "invalid" && !envKey) {
    return fail(
      {
        kind: "parse-failure",
        message: `${configPath} exists but is not valid JSON`,
        hint: "fix or remove the MiniMax CLI config, or set MINIMAX_API_KEY",
      },
      fetchedAt,
    );
  }
  // Secret firewall: an env key shaped like an indirection is an INVALID
  // credential – reported, never sent, never expanded, no fallback that masks it.
  if (envKey !== undefined && envKey !== "" && !usableLiteralSecret(envKey)) {
    return fail(
      {
        kind: "parse-failure",
        message: "MINIMAX_API_KEY is set but not a literal secret (indirection) – refusing to use it",
        hint: "set a literal key in ~/.subtrk/env (run subtrk init)",
      },
      fetchedAt,
    );
  }

  const key = envKey ?? cfg?.key ?? null;
  if (!key) {
    return fail(
      {
        kind: "no-credentials",
        message: "no MINIMAX_API_KEY and no usable key in the MiniMax CLI config",
        hint: `set MINIMAX_API_KEY (subtrk init) or store a key in ${minimaxConfigPath()}`,
      },
      fetchedAt,
    );
  }
  void registerSecret(key);

  const baseUrl = minimaxBaseUrl(cfg);
  // An "sk-api-" key is an account key: it reads the balance. Any other key is
  // a plan bearer and reads the per-model token quota.
  const url = `${baseUrl}${key.startsWith("sk-api-") ? BALANCE_PATH : QUOTA_PATH}`;
  const out = await credFetch(url, { headers: usageHeaders(key) });
  if (!out.ok) {
    if (out.status === 401 || out.status === 403) {
      return fail(
        { kind: "no-credentials", message: `MiniMax rejected the API key (${out.status})`, hint: "check the key" },
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
  const appError = baseRespError(body);
  if (appError) {
    return fail(
      appError.auth
        ? { kind: "no-credentials", message: `MiniMax rejected the API key (status_code ${appError.statusCode})` }
        : {
            kind: "not-readable-remotely",
            message: `MiniMax request failed (status_code ${appError.statusCode})`,
          },
      fetchedAt,
    );
  }

  if (key.startsWith("sk-api-")) {
    const amount = parseMinimaxBalance(body);
    if (amount === null) {
      return fail({ kind: "parse-failure", message: "balance response shape unrecognized" }, fetchedAt);
    }
    // The China deployment denominates in CNY; Credits.unit has no CNY, so the
    // number is surfaced as a note instead of a mislabelled credits field.
    if (baseUrl === CHINA_BASE_URL) {
      return { id: ID, ok: true, stale: false, fetchedAt, note: `balance ${amount} CNY` };
    }
    const credits: Credits = { remaining: amount, unit: "usd", source: "api" };
    return { id: ID, ok: true, stale: false, fetchedAt, credits };
  }

  const parsed = parseMinimaxTokenPlan(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "usage response shape unrecognized" }, fetchedAt);
  const result: ProviderResult = {
    id: ID,
    ok: true,
    stale: false,
    fetchedAt,
    windows: parsed.windows,
  };
  if (parsed.plan) result.plan = parsed.plan;
  if (parsed.empty) result.note = "no quota data reported yet";
  return result;
}

const provider: ProviderModule = {
  id: ID,
  ttlMs: 300_000,
  tracesInputs: true, // probe traces the MiniMax CLI config + MINIMAX_API_KEY / MMX_CONFIG_DIR
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
