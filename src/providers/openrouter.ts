// openrouter – pay-as-you-go. /key with the inference key; /credits ONLY with the
// management key (never the inference key – that is a guaranteed 403).

import type { Credits, ProviderError, ProviderModule, ProviderResult } from "../core.ts";
import { traceEnv } from "../lib/input-trace.ts";
import { usableLiteralSecret } from "../lib/secret.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

// Pure: data.usage_daily (USD) -> note line; data absent -> null; usage_daily absent -> no note.
export function parseOpenrouterKey(body: unknown): { note?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const daily = (data as { usage_daily?: unknown }).usage_daily;
  if (daily === undefined) return {};
  if (typeof daily !== "number" || !Number.isFinite(daily)) return null;
  return { note: `key today $${daily.toFixed(2)}` };
}

// Pure: { total_credits, total_usage } -> credits with remaining = total - usage.
export function parseOpenrouterCredits(body: unknown): Credits | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const total = (data as { total_credits?: unknown }).total_credits;
  const usage = (data as { total_usage?: unknown }).total_usage;
  if (typeof total !== "number" || typeof usage !== "number") return null;
  return { remaining: total - usage, unit: "usd", source: "api" };
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

// Real process env wins; core (which merges ~/.subtrk/env) is consulted when present.
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
  return { id: "openrouter", ok: false, stale: false, fetchedAt, error };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  // Secret firewall: a key that is not a plain literal (env/template/command
  // indirection) is an INVALID credential – present-but-unusable, never sent,
  // never expanded.
  const key = await getSecret("OPENROUTER_API_KEY");
  traceEnv("OPENROUTER_API_KEY", key); // value digest only (cache stamp)
  if (!key) {
    return fail(
      { kind: "no-credentials", message: "OPENROUTER_API_KEY not set", hint: "run subtrk init", remedy: "subtrk init" },
      fetchedAt,
    );
  }
  if (!usableLiteralSecret(key)) {
    return fail(
      {
        kind: "parse-failure",
        message: "OPENROUTER_API_KEY is set but not a literal secret (indirection) – refusing to use it",
        hint: "set a literal key in ~/.subtrk/env (run subtrk init)",
        remedy: "subtrk init",
      },
      fetchedAt,
    );
  }
  void registerSecret(key);

  const out = await fetchText(KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!out.ok) {
    if (out.status === 401) {
      return fail(
        { kind: "no-credentials", message: "OpenRouter rejected the API key (401)", hint: "run subtrk init" },
        fetchedAt,
      );
    }
    return fail(out.error, fetchedAt);
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "key response was not JSON" }, fetchedAt);
  }
  const parsed = parseOpenrouterKey(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "key response missing data object" }, fetchedAt);

  const result: ProviderResult = { id: "openrouter", ok: true, stale: false, fetchedAt };
  if (parsed.note) result.note = parsed.note;

  const mgmt = await getSecret("OPENROUTER_MANAGEMENT_KEY");
  traceEnv("OPENROUTER_MANAGEMENT_KEY", mgmt); // value digest only (cache stamp)
  if (mgmt && usableLiteralSecret(mgmt)) {
    void registerSecret(mgmt);
    const cr = await fetchText(CREDITS_URL, { headers: { Authorization: `Bearer ${mgmt}` } });
    if (cr.ok) {
      try {
        const credits = parseOpenrouterCredits(JSON.parse(cr.text));
        if (credits) result.credits = credits;
      } catch {
        // auxiliary call – omit credits rather than fail the provider
      }
    }
  }
  return result;
}

const provider: ProviderModule = {
  id: "openrouter",
  ttlMs: 60_000,
  tracesInputs: true, // probe traces OPENROUTER_API_KEY / OPENROUTER_MANAGEMENT_KEY values
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
