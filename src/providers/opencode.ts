// opencode – Zen pay-as-you-go, presence check only (D1): no usage/balance API exists.
// Key from env OPENCODE_API_KEY (core merges ~/.subtrk/env) or ~/.local/share/opencode/auth.json.
// ttlMs 0 – bypasses the cache entirely.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModule, ProviderResult } from "../core.ts";
import { traceEnv, traceInput } from "../lib/input-trace.ts";
import { usableLiteralSecret } from "../lib/secret.ts";

export const OPENCODE_NOTE = "PAYG – no usage/balance API; inference errors are the only signal";

// Pure: auth.json shape is { opencode: { key: "..." } }.
export function extractOpencodeKey(authObj: unknown): string | null {
  if (typeof authObj !== "object" || authObj === null) return null;
  const key = ((authObj as { opencode?: unknown }).opencode as { key?: unknown } | undefined)?.key;
  return typeof key === "string" && key !== "" ? key : null;
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

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  // Secret firewall: a candidate that is not a plain literal (env/template/
  // command indirection) is an INVALID credential – present-but-unusable. The
  // source is skipped like an absent one, the value never sent, never expanded.
  let key = await getSecret("OPENCODE_API_KEY");
  traceEnv("OPENCODE_API_KEY", key); // value digest only (cache stamp; ttl 0 never caches, tracing is inert)
  if (key !== undefined && !usableLiteralSecret(key)) key = undefined;
  if (!key) {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    traceInput(authPath); // identity stats only, BEFORE the read (cache stamp; ttl 0 never caches)
    try {
      const fromFile = extractOpencodeKey(JSON.parse(readFileSync(authPath, "utf8"))) ?? undefined;
      if (fromFile !== undefined && usableLiteralSecret(fromFile)) key = fromFile;
    } catch {
      // absent or unreadable – treated as no key
    }
  }
  if (!key) {
    return {
      id: "opencode",
      ok: false,
      stale: false,
      fetchedAt,
      error: {
        kind: "no-credentials",
        message: "no OPENCODE_API_KEY and no opencode.key in ~/.local/share/opencode/auth.json",
        hint: "run subtrk init or opencode auth login",
        remedy: "subtrk init",
      },
    };
  }
  void registerSecret(key);
  return { id: "opencode", ok: true, stale: false, fetchedAt, plan: "Zen PAYG", note: OPENCODE_NOTE };
}

const provider: ProviderModule = {
  id: "opencode",
  ttlMs: 0,
  tracesInputs: true, // inputs traced for uniformity; ttlMs 0 bypasses the cache, so no stamp is ever written
  probe(): Promise<ProviderResult> {
    return probeInner().catch(
      (e: unknown): ProviderResult => ({
        id: "opencode",
        ok: false,
        stale: false,
        fetchedAt: new Date().toISOString(),
        error: { kind: "http-error", message: `probe failed: ${e instanceof Error ? e.message : "unknown"}` },
      }),
    );
  },
};
export default provider;
