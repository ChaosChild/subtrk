// glm – GLM Coding Plan via the ZCode monitor route.
// Credential: ~/.zcode/cli/config.json -> provider.zai.apiKey (fallback env ANTHROPIC_AUTH_TOKEN).
// Auth header is the RAW key – no Bearer prefix.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const DEFAULT_HOST = "https://api.z.ai";

// Pure: extract the API key and monitor host from the ZCode config (env token as fallback).
// host is scheme+host only. Returns null when no key is available from either source.
export function glmAuth(configObj: unknown, envToken: string | undefined): { apiKey: string; host: string } | null {
  let apiKey: string | undefined;
  let host = DEFAULT_HOST;
  if (typeof configObj === "object" && configObj !== null) {
    const zai = ((configObj as { provider?: unknown }).provider as { zai?: unknown } | undefined)?.zai;
    if (typeof zai === "object" && zai !== null) {
      const z = zai as { apiKey?: unknown; options?: { baseURL?: unknown } };
      if (typeof z.apiKey === "string" && z.apiKey !== "") apiKey = z.apiKey;
      if (typeof z.options?.baseURL === "string" && z.options.baseURL !== "") {
        try {
          host = new URL(z.options.baseURL).origin;
        } catch {
          // unparseable baseURL – keep the default host
        }
      }
    }
  }
  if (!apiKey && typeof envToken === "string" && envToken !== "") apiKey = envToken;
  return apiKey ? { apiKey, host } : null;
}

interface GlmLimit {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

// Pure: data.limits[] TOKENS_LIMIT entries -> windows (unit 3 = hours, unit 6 = weeks);
// TIME_LIMIT entries are built-in-tool quota and ignored in v0. data.level -> plan label.
// A window sitting at 0% (no query in it yet) omits nextResetTime entirely – skipped as
// inactive, like claude's resets_at-less entries, never a parse failure.
// Empty state: no usable windows after that (data missing/null, no limits array, or
// every TOKENS_LIMIT entry at 0%) means zero GLM queries in the current window ->
// { windows: [], empty: true }.
// null is reserved for bodies that are not JSON objects at all, arrays included, and
// ACTIVE entries with malformed number/percentage/nextResetTime (probe maps null to
// parse-failure).
export function parseGlmQuota(body: unknown): { windows: Window[]; plan?: string; empty?: true } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return { windows: [], empty: true };
  const d = data as { limits?: unknown; level?: unknown };
  const plan = typeof d.level === "string" || typeof d.level === "number" ? `GLM ${String(d.level)}` : undefined;
  if (!Array.isArray(d.limits)) return plan ? { windows: [], plan, empty: true } : { windows: [], empty: true };
  const windows: Window[] = [];
  for (const raw of d.limits) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as GlmLimit;
    if (l.type !== "TOKENS_LIMIT") continue;
    // z.ai drops nextResetTime while a window is at 0% – inactive, skip it
    if (l.nextResetTime === undefined || l.nextResetTime === null) continue;
    if (typeof l.number !== "number" || typeof l.percentage !== "number") return null;
    if (typeof l.nextResetTime !== "number" || !Number.isFinite(l.nextResetTime)) return null;
    let kind: string;
    if (l.unit === 3)
      kind = `${l.number}h`; // hours – the 5h window when number is 5
    else if (l.unit === 6)
      kind = l.number === 1 ? "7d" : `${l.number}w`; // weeks
    else continue; // unknown unit – ignore entry
    windows.push({ kind, usedPercent: l.percentage, resetsAt: new Date(l.nextResetTime).toISOString() });
  }
  if (windows.length === 0) return plan ? { windows, plan, empty: true } : { windows, empty: true };
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
  return { id: "glm", ok: false, stale: false, fetchedAt, error };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  let configObj: unknown = null;
  let configUnreadable = false;
  try {
    configObj = JSON.parse(readFileSync(join(homedir(), ".zcode", "cli", "config.json"), "utf8"));
  } catch {
    configUnreadable = true;
  }
  const auth = glmAuth(configObj, await getSecret("ANTHROPIC_AUTH_TOKEN"));
  if (!auth) {
    return fail(
      {
        kind: "no-credentials",
        message: configUnreadable
          ? "~/.zcode/cli/config.json unreadable and no ANTHROPIC_AUTH_TOKEN set"
          : "no provider.zai.apiKey in ~/.zcode/cli/config.json and no ANTHROPIC_AUTH_TOKEN set",
        hint: "check ZCode login",
        remedy: "subtrk init",
      },
      fetchedAt,
    );
  }
  void registerSecret(auth.apiKey);

  const out = await fetchText(`${auth.host}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: auth.apiKey }, // raw key – no Bearer prefix
  });
  if (!out.ok) {
    if (out.status === 401) {
      return fail(
        { kind: "no-credentials", message: "GLM rejected the API key (401)", hint: "check ZCode login" },
        fetchedAt,
      );
    }
    return fail(out.error, fetchedAt);
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "quota response was not JSON" }, fetchedAt);
  }
  const parsed = parseGlmQuota(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "quota response shape unrecognized" }, fetchedAt);
  const result: ProviderResult = {
    id: "glm",
    ok: true,
    stale: false,
    fetchedAt,
    plan: parsed.plan,
    windows: parsed.windows,
  };
  if (parsed.empty) {
    // Post-reset idle window – the monitor omits data.limits until the first query.
    result.note = "no usage reported yet in the current window – appears after the first GLM query";
  }
  return result;
}

const provider: ProviderModule = {
  id: "glm",
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
