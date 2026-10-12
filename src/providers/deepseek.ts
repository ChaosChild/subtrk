// deepseek – EXPERIMENTAL: pay-as-you-go account balance, no usage windows.
// Credential: env DEEPSEEK_API_KEY (process env first, then ~/.subtrk/env) ->
// GET https://api.deepseek.com/user/balance, the vendor's documented account
// endpoint, host-pinned. Not verified against a live account: the result note,
// the error hints and the README row all mark the provider experimental.
// Balance normalization adapted from quota-axi (MIT), src/providers/deepseek.ts.

import type { Credits, ProviderError, ProviderId, ProviderModule, ProviderResult } from "../core.ts";
import { traceEnv } from "../lib/input-trace.ts";
import { usableLiteralSecret } from "../lib/secret.ts";

// core.ts's ProviderId union gains "deepseek" in the core workstream; the
// local widening keeps this module typecheck-clean until that lands.
const ID = "deepseek" as ProviderId;

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const EXPERIMENTAL_NOTE = "experimental – balance only, not verified against a live account";

// Deployment host pin: the ONLY host the DeepSeek credential may be sent to.
const DEEPSEEK_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.deepseek.com"]);

// Pure: a target is credential-bearing only when it is https on the pinned
// first-party host (default port). Anything else is refused before the
// credential leaves the process.
export function deepseekTargetAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.port === "" && DEEPSEEK_ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export interface DeepSeekBalance {
  available: boolean; // the vendor's is_available flag
  usd: number | null; // USD total_balance when reported
  cny: number | null; // CNY total_balance when reported
}

// Pure: the /user/balance body -> the balances it carries. null is reserved
// for shape failures (non-object body, is_available missing or not a boolean)
// – the probe maps null to parse-failure. Rows with an unsupported currency or
// an unusable amount are skipped (degrade cleanly); duplicate currencies keep
// their first row.
export function parseDeepSeekBalance(body: unknown): DeepSeekBalance | null {
  if (typeof body !== "object" || body === null) return null;
  const available = (body as { is_available?: unknown }).is_available;
  if (typeof available !== "boolean") return null;
  const out: DeepSeekBalance = { available, usd: null, cny: null };
  const infos = (body as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) return out;
  for (const raw of infos) {
    if (typeof raw !== "object" || raw === null) continue;
    const info = raw as { currency?: unknown; total_balance?: unknown };
    if (info.currency !== "USD" && info.currency !== "CNY") continue;
    const amount = decimalAmount(info.total_balance);
    if (amount === null) continue;
    if (info.currency === "USD") {
      if (out.usd === null) out.usd = amount;
    } else if (out.cny === null) {
      out.cny = amount;
    }
  }
  return out;
}

// The wire carries amounts as decimal strings; accept those verbatim plus
// finite numbers, refuse anything else.
function decimalAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

// Every credential-bearing request goes through the deployment pin.
function credFetch(url: string, init: RequestInit): Promise<FetchOutcome> {
  if (!deepseekTargetAllowed(url)) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: "forbidden",
        message: `refusing to send the DeepSeek credential to a non-first-party target (${url})`,
        hint: "the DeepSeek endpoint is a fixed first-party host – no local setting may redirect it",
      },
    });
  }
  return fetchText(url, init);
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

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  // Secret firewall: a key that is not a plain literal (env/template/command
  // indirection) is an INVALID credential – present-but-unusable, never sent,
  // never expanded.
  const key = await getSecret("DEEPSEEK_API_KEY");
  traceEnv("DEEPSEEK_API_KEY", key); // value digest only (cache stamp)
  if (!key) {
    return fail(
      {
        kind: "no-credentials",
        message: "DEEPSEEK_API_KEY not set",
        hint: `set it in ~/.subtrk/env (run subtrk init) – ${EXPERIMENTAL_NOTE}`,
      },
      fetchedAt,
    );
  }
  if (!usableLiteralSecret(key)) {
    return fail(
      {
        kind: "parse-failure",
        message: "DEEPSEEK_API_KEY is set but not a literal secret (indirection) – refusing to use it",
        hint: "set a literal key in ~/.subtrk/env (run subtrk init)",
      },
      fetchedAt,
    );
  }
  void registerSecret(key);

  const out = await credFetch(BALANCE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "subtrk" },
  });
  if (!out.ok) {
    if (out.status === 401 || out.status === 403) {
      return fail(
        { kind: "no-credentials", message: `DeepSeek rejected the API key (${out.status})`, hint: "check the key" },
        fetchedAt,
      );
    }
    return fail(out.error, fetchedAt);
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "balance response was not JSON" }, fetchedAt);
  }
  const parsed = parseDeepSeekBalance(body);
  if (!parsed) return fail({ kind: "parse-failure", message: "balance response shape unrecognized" }, fetchedAt);

  const result: ProviderResult = { id: ID, ok: true, stale: false, fetchedAt, note: EXPERIMENTAL_NOTE };
  // USD maps onto the credits field honestly (unit "usd"); a CNY balance has
  // no matching unit, so it is surfaced as a note instead of a mislabel.
  if (parsed.usd !== null) {
    const credits: Credits = { remaining: parsed.usd, unit: "usd", source: "api" };
    result.credits = credits;
  }
  if (parsed.cny !== null) {
    result.note = `${result.note ?? ""} CNY balance ${parsed.cny}`.trim();
  }
  if (!parsed.available) result.note = `${result.note ?? ""} (DeepSeek reports the account as unavailable)`.trim();
  return result;
}

const provider: ProviderModule = {
  id: ID,
  ttlMs: 300_000,
  tracesInputs: true, // probe traces the DEEPSEEK_API_KEY value digest
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
