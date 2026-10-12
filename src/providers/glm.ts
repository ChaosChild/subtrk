// glm – GLM Coding Plan via the ZCode monitor route.
// Credential: ~/.zcode/cli/config.json -> provider.zai.apiKey (fallback env ANTHROPIC_AUTH_TOKEN).
// Zhipu aliases ride the same lane: a provider.zhipu/zhipuai config key or env
// ZHIPUAI_API_KEY routes to open.bigmodel.cn, reusing the same host-relative
// monitor path (mapping after quota-axi, MIT, src/providers/zai.ts). A
// config-declared base URL is honored only when it targets a first-party host
// (api.z.ai or open.bigmodel.cn) – anything else is refused, never followed.
// Auth header is the RAW key – no Bearer prefix.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";
import { traceEnv, traceInput } from "../lib/input-trace.ts";
import { redactSecret, usableLiteralSecret } from "../lib/secret.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const DEFAULT_HOST = "https://api.z.ai";
const BIGMODEL_HOST = "https://open.bigmodel.cn";

// Deployment host pin: the ONLY hosts a GLM/Zhipu credential may be sent to –
// exactly the first-party deployments this lane uses. A config-declared base
// URL targeting anything else is a refusal, never a redirect.
const GLM_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.z.ai", "open.bigmodel.cn"]);

// Pure: an origin is a credential target only when it is https on a pinned
// first-party host (default port).
export function glmHostAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.port === "" && GLM_ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// Pure: a config-declared baseURL -> its pinned origin, or null when absent or
// unparseable (an unparseable value is not an endpoint declaration – the
// default host stands, as before).
function pinnedOrigin(baseURL: unknown): string | null {
  if (typeof baseURL !== "string" || baseURL === "") return null;
  try {
    const origin = new URL(baseURL).origin;
    return glmHostAllowed(origin) ? origin : null;
  } catch {
    return null;
  }
}

// Pure: the first parseable config-declared base URL that does NOT target a
// pinned first-party host – a refusal the probe reports instead of a fetch.
// Checked across both lanes: a poisoned declaration must not hide behind a
// credential from the other lane.
export function glmForeignDeclared(configObj: unknown): string | null {
  if (typeof configObj !== "object" || configObj === null) return null;
  const provider = (configObj as { provider?: unknown }).provider;
  if (typeof provider !== "object" || provider === null) return null;
  for (const lane of ["zai", "zhipu", "zhipuai"] as const) {
    const entry = (provider as Record<string, unknown>)[lane];
    if (typeof entry !== "object" || entry === null) continue;
    const baseURL = (entry as { options?: { baseURL?: unknown } }).options?.baseURL;
    if (typeof baseURL !== "string" || baseURL === "") continue;
    let origin: string | null = null;
    try {
      origin = new URL(baseURL).origin;
    } catch {
      continue; // unparseable – not an endpoint declaration
    }
    if (!glmHostAllowed(origin)) return baseURL;
  }
  return null;
}

// One credential lane: the usable literal key found under its config names
// (if any) plus the host its declaration implies. Secret firewall: an
// indirection-shaped key is present-but-unusable (null), never sent.
interface GlmLane {
  key: string | null;
  origin: string | null; // pinned origin from a declared baseURL
}

function laneOf(configObj: unknown, names: readonly string[]): GlmLane {
  let key: string | null = null;
  let origin: string | null = null;
  if (typeof configObj === "object" && configObj !== null) {
    const provider = (configObj as { provider?: unknown }).provider;
    if (typeof provider === "object" && provider !== null) {
      for (const name of names) {
        const entry = (provider as Record<string, unknown>)[name];
        if (typeof entry !== "object" || entry === null) continue;
        const z = entry as { apiKey?: unknown; options?: { baseURL?: unknown } };
        if (!key && typeof z.apiKey === "string" && z.apiKey !== "" && usableLiteralSecret(z.apiKey)) {
          key = z.apiKey;
        }
        if (!origin) origin = pinnedOrigin(z.options?.baseURL);
      }
    }
  }
  return { key, origin };
}

// Secret firewall: a candidate that is not a plain literal (env/template/
// command indirection) is an INVALID credential – present-but-unusable. It is
// treated like an absent source (never sent, never expanded) and the other
// source is still tried; null = no usable candidate at all. The shape is kept
// backward-compatible for the usage harvester's glmAuth consumer.
// Lanes, in priority order: config provider.zai (host api.z.ai by default),
// config provider.zhipu/zhipuai (open.bigmodel.cn by default), env
// ANTHROPIC_AUTH_TOKEN (z.ai lane), env ZHIPUAI_API_KEY (bigmodel lane). A
// config-declared base URL moves its whole lane's host (declared zhipu host
// + env key included) as long as it stays first-party; a foreign declaration
// makes glmAuth report no usable credential (glmForeignDeclared names it).
export function glmAuth(
  configObj: unknown,
  envToken: string | undefined,
  zhipuEnvToken?: string,
): { apiKey: string; host: string } | null {
  const zai = laneOf(configObj, ["zai"]);
  const zhipu = laneOf(configObj, ["zhipu", "zhipuai"]);
  const literal = (v: string | undefined): v is string => typeof v === "string" && v !== "" && usableLiteralSecret(v);
  const candidates: { apiKey: string; host: string }[] = [];
  if (zai.key) candidates.push({ apiKey: zai.key, host: zai.origin ?? DEFAULT_HOST });
  if (zhipu.key) candidates.push({ apiKey: zhipu.key, host: zhipu.origin ?? BIGMODEL_HOST });
  if (literal(envToken)) candidates.push({ apiKey: envToken, host: zai.origin ?? DEFAULT_HOST });
  if (literal(zhipuEnvToken)) candidates.push({ apiKey: zhipuEnvToken, host: zhipu.origin ?? BIGMODEL_HOST });
  if (glmForeignDeclared(configObj) !== null) return null; // poisoned config – refuse, never follow
  return candidates[0] ?? null;
}

interface GlmLimit {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

// Pure: data.limits[] TOKENS_LIMIT entries -> windows (unit 3 = hours, unit 6 = weeks);
// TIME_LIMIT unit 5 is the monthly MCP-tool quota (z.ai's web-search / web-reader /
// zread calls) and joins the windows as a scoped "MCP" entry; other TIME_LIMIT units
// are older shapes with unknown semantics and stay ignored. data.level -> plan label.
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
  const mcpWindows: Window[] = []; // MCP quota renders after the token windows
  for (const raw of d.limits) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as GlmLimit;
    if (l.type === "TIME_LIMIT") {
      // unit 5 = the monthly MCP-tool quota; currentValue sums usageDetails
      // (search-prime / web-reader / zread calls). z.ai drops nextResetTime on
      // inactive entries here too – same skip rule as tokens.
      if (l.unit !== 5) continue;
      if (l.nextResetTime === undefined || l.nextResetTime === null) continue;
      if (typeof l.percentage !== "number") return null;
      if (typeof l.nextResetTime !== "number" || !Number.isFinite(l.nextResetTime)) return null;
      mcpWindows.push({
        kind: "MCP",
        scope: "MCP",
        usedPercent: l.percentage,
        resetsAt: new Date(l.nextResetTime).toISOString(),
      });
      continue;
    }
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
  windows.push(...mcpWindows);
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
  const configPath = join(homedir(), ".zcode", "cli", "config.json");
  traceInput(configPath); // identity stats only, BEFORE the read (cache stamp)
  try {
    configObj = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    configUnreadable = true;
  }
  const envToken = await getSecret("ANTHROPIC_AUTH_TOKEN");
  traceEnv("ANTHROPIC_AUTH_TOKEN", envToken); // value digest only (cache stamp)
  const zhipuEnvToken = await getSecret("ZHIPUAI_API_KEY");
  traceEnv("ZHIPUAI_API_KEY", zhipuEnvToken); // value digest only (cache stamp)
  const auth = glmAuth(configObj, envToken, zhipuEnvToken);
  if (!auth) {
    // A parseable config-declared base URL that is not first-party is a
    // refusal, not a missing credential – named so the operator can fix the
    // file. The declaration is file content, so key values are redacted from it.
    const foreign = glmForeignDeclared(configObj);
    if (foreign) {
      const secrets = [envToken, zhipuEnvToken].filter(
        (s): s is string => typeof s === "string" && s !== "" && usableLiteralSecret(s),
      );
      return fail(
        {
          kind: "forbidden",
          message: redactSecret(
            `~/.zcode/cli/config.json declares a non-first-party endpoint (${foreign}) – refusing to use this credential`,
            secrets,
          ),
          hint: "remove the endpoint override from ~/.zcode/cli/config.json or point it at api.z.ai / open.bigmodel.cn",
        },
        fetchedAt,
      );
    }
    return fail(
      {
        kind: "no-credentials",
        message: configUnreadable
          ? "~/.zcode/cli/config.json unreadable and no ANTHROPIC_AUTH_TOKEN/ZHIPUAI_API_KEY set"
          : "no provider.zai/zhipu apiKey in ~/.zcode/cli/config.json and no ANTHROPIC_AUTH_TOKEN/ZHIPUAI_API_KEY set",
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
  tracesInputs: true, // probe traces the ZCode config + ANTHROPIC_AUTH_TOKEN – cache entries carry an identity stamp
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
