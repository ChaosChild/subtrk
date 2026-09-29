// zcode – z.ai Start Plan token bundles ("ZCode Trust Build") as delivered by
// the ZCode desktop app. Credential: ~/.zcode/v2/credentials.json key
// zcodejwttoken – an AES-256-GCM blob "enc:v1:<iv>.<tag>.<ciphertext>" (base64url
// parts, key = sha256 of a machine-derived secret). The balance endpoint is
// https://zcode.z.ai/api/v1/zcode-plan/billing/balance with the JWT as Bearer and
// telemetry-state.json deviceMid as X-Device-Mid – a presence check, the server
// accepts any value. Live-verified 2026-09-29.

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";
import { slugify } from "./google.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.3";
const FALLBACK_DEVICE_MID = "00000000-0000-0000-0000-000000000000";

// Pure: the env secret wins when set, else the desktop's fixed fallback template.
export function deriveCredentialSecret(
  envSecret: string | undefined,
  platform: string,
  home: string,
  user: string,
): string {
  if (envSecret) return envSecret;
  return `zcode-credential-fallback:${platform}:${home}:${user}`;
}

// Pure: decrypt one store value ("enc:v1:<iv>.<tag>.<ct>", base64url) – null for
// anything else. Plaintext passthrough is the desktop's behavior but is not
// accepted here: the store always encrypts, so non-enc: values fail.
export function decryptZcodeValue(value: string, key: Buffer): string | null {
  const PREFIX = "enc:v1:";
  if (!value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const dec = (s: string): Buffer | null =>
    /^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, "base64url").toString("base64url") === s
      ? Buffer.from(s, "base64url")
      : null;
  const iv = dec(parts[0]);
  const tag = dec(parts[1]);
  const ct = dec(parts[2]);
  if (!iv || !tag || !ct || iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null; // failed auth
  }
}

// Pure: the store object -> its decrypted JWT. null when the key is missing,
// not a string, or undecryptable.
export function parseZcodeCredentials(obj: unknown, key: Buffer): { jwt: string } | null {
  if (typeof obj !== "object" || obj === null) return null;
  const raw = (obj as { zcodejwttoken?: unknown }).zcodejwttoken;
  if (typeof raw !== "string") return null;
  const jwt = decryptZcodeValue(raw, key);
  return jwt ? { jwt } : null;
}

// Pure: telemetry-state.json -> deviceMid; null when absent or not a string
// (caller falls back to the zero UUID).
export function readDeviceMid(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const mid = (obj as { deviceMid?: unknown }).deviceMid;
  return typeof mid === "string" && mid !== "" ? mid : null;
}

// Pure: entitlement period -> window kind; unknown periods slugify.
export function periodKind(period: string): string {
  if (period === "one_time") return "bundle";
  if (period === "daily") return "1d";
  if (period === "weekly") return "7d";
  if (period === "monthly") return "30d";
  return slugify(period);
}

interface ZcodeEntitlement {
  entitlement_id?: unknown;
  show_name?: unknown;
  period?: unknown;
  capabilities?: unknown;
}

interface ZcodePlan {
  plan_id?: unknown;
  user_plan_id?: unknown;
  name?: unknown;
  status?: unknown;
  ends_at?: unknown;
  entitlements?: unknown;
}

interface ZcodeBalance {
  plan_id?: unknown;
  user_plan_id?: unknown;
  entitlement_id?: unknown;
  meter?: unknown;
  total_units?: unknown;
  used_units?: unknown;
  expires_at?: unknown;
}

// Pure: the billing body { code, msg, data } -> windows per active-plan balance
// bucket. null is reserved for shape failures (non-object body, data absent or
// not an object) – the probe maps that to parse-failure. A plan is ACTIVE only
// when status is "active" and ends_at is past the reference seconds (server_time
// when usable, else now) – the desktop normalizes already-past end dates to
// expired itself, so no active plans -> { expired: true }. Balances join their
// plan by user_plan_id, falling back to plan_id; orphans are skipped. Unusable
// buckets (no slug, non-positive total, non-finite used/expiry) are skipped too.
export function parseZcodeBalance(
  body: unknown,
  nowMs: number,
): { windows: Window[]; plan?: string; expired?: true; empty?: true } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as { server_time?: unknown; plans?: unknown; balances?: unknown };
  const refSec =
    typeof d.server_time === "number" && Number.isFinite(d.server_time) && d.server_time > 0
      ? d.server_time
      : nowMs / 1000;
  const plans = (Array.isArray(d.plans) ? d.plans : []).filter((p): p is ZcodePlan => {
    if (typeof p !== "object" || p === null) return false;
    const plan = p as ZcodePlan;
    return (
      typeof plan.status === "string" &&
      plan.status.toLowerCase() === "active" &&
      typeof plan.ends_at === "number" &&
      Number.isFinite(plan.ends_at) &&
      plan.ends_at > refSec
    );
  });
  if (plans.length === 0) return { windows: [], expired: true };
  const first = plans[0];
  const plan = typeof first.name === "string" && first.name !== "" ? first.name : undefined;
  const balances = Array.isArray(d.balances) ? d.balances : [];
  const windows: Window[] = [];
  for (const raw of balances) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as ZcodeBalance;
    const joined = plans.find(
      (p) =>
        (typeof b.user_plan_id === "string" && b.user_plan_id !== "" && b.user_plan_id === p.user_plan_id) ||
        (typeof b.plan_id === "string" && b.plan_id !== "" && b.plan_id === p.plan_id),
    );
    if (!joined) continue; // orphaned bucket – no active plan claims it
    const entitlements = Array.isArray(joined.entitlements) ? joined.entitlements : [];
    const ent = entitlements.find(
      (e): e is ZcodeEntitlement =>
        typeof e === "object" && e !== null && (e as ZcodeEntitlement).entitlement_id === b.entitlement_id,
    );
    const period =
      typeof ent?.period === "string" && ent.period !== ""
        ? ent.period
        : typeof b.meter === "string" && b.meter !== ""
          ? b.meter
          : "bundle";
    const showName = typeof ent?.show_name === "string" ? ent.show_name : "";
    let scope = slugify(showName);
    if (!scope) {
      const caps = Array.isArray(ent?.capabilities) ? ent.capabilities : [];
      const model = caps.find((c): c is string => typeof c === "string" && c.startsWith("model:"));
      scope = model ? slugify(model.slice("model:".length)) : "";
    }
    if (!scope) continue; // neither show_name nor a "model:X" capability yields a slug
    if (typeof b.total_units !== "number" || !Number.isFinite(b.total_units) || b.total_units <= 0) continue;
    if (typeof b.used_units !== "number" || !Number.isFinite(b.used_units)) continue;
    if (typeof b.expires_at !== "number" || !Number.isFinite(b.expires_at) || b.expires_at <= 0) continue;
    windows.push({
      kind: periodKind(period),
      scope,
      usedPercent: Math.round((b.used_units / b.total_units) * 1000) / 10,
      resetsAt: new Date(b.expires_at * 1000).toISOString(),
    });
  }
  if (windows.length === 0) return { windows: [], plan, empty: true };
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
  return { id: "zcode", ok: false, stale: false, fetchedAt, error };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  let storeObj: unknown = null;
  let storeUnreadable = false;
  try {
    storeObj = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "credentials.json"), "utf8"));
  } catch {
    storeUnreadable = true;
  }
  if (storeUnreadable) {
    return fail(
      {
        kind: "no-credentials",
        message: "no ZCode credential store at ~/.zcode/v2/credentials.json",
        hint: "log in once in the ZCode desktop app",
      },
      fetchedAt,
    );
  }
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    // desktop parity – the fallback template uses "unknown" there too
  }
  const secret = deriveCredentialSecret(await getSecret("ZCODE_CREDENTIAL_SECRET"), platform(), homedir(), user);
  const key = createHash("sha256").update(secret).digest();
  const creds = parseZcodeCredentials(storeObj, key);
  if (!creds) {
    return fail(
      {
        kind: "no-credentials",
        message: "the ZCode credential store could not be decrypted",
        hint: "set ZCODE_CREDENTIAL_SECRET if the store was created with a custom secret",
      },
      fetchedAt,
    );
  }
  void registerSecret(creds.jwt);

  let deviceMid = FALLBACK_DEVICE_MID;
  try {
    deviceMid =
      readDeviceMid(JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "telemetry-state.json"), "utf8"))) ??
      deviceMid;
  } catch {
    // presence check – the server accepts any value
  }

  const out = await fetchText(BALANCE_URL, {
    headers: { Authorization: `Bearer ${creds.jwt}`, "X-Device-Mid": deviceMid },
  });
  if (!out.ok) {
    if (out.status === 401) {
      return fail(
        {
          kind: "expired-token",
          message: "ZCode rejected the stored login (401)",
          hint: "log in again in the ZCode desktop app",
        },
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
  const env = body as { code?: unknown; msg?: unknown };
  // desktop parity – an absent code field is success, only a non-zero code fails
  if (env.code !== undefined && env.code !== 0) {
    const msg = typeof env.msg === "string" && env.msg !== "" ? `: ${env.msg}` : "";
    return fail({ kind: "not-readable-remotely", message: `balance request failed${msg}` }, fetchedAt);
  }
  const parsed = parseZcodeBalance(body, Date.now());
  if (!parsed) return fail({ kind: "parse-failure", message: "balance response shape unrecognized" }, fetchedAt);
  if (parsed.expired) {
    return fail(
      {
        kind: "not-readable-remotely",
        message: "no active Start Plan bundle for this ZCode account",
        hint: "bundles appear when z.ai issues them and are consumed in ZCode",
      },
      fetchedAt,
    );
  }
  const result: ProviderResult = {
    id: "zcode",
    ok: true,
    stale: false,
    fetchedAt,
    plan: parsed.plan,
    windows: parsed.windows,
  };
  if (parsed.empty) {
    result.note = "bundle active but no balances reported yet";
  }
  return result;
}

const provider: ProviderModule = {
  id: "zcode",
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
