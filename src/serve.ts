// serve.ts – `subtrk serve` (M2): the localhost web console backend.
// Loopback-only HTTP: the browser shell (src/console.html) is the one static
// route; /api/status replays `subtrk status --json`, /api/refresh re-runs a
// provider's interactive login, and /api/config persists the console's
// provider selection and card order to config.json – all behind the per-run
// Bearer token. No CORS
// headers, ever – same-origin plus the custom Authorization header (preflight)
// is the cross-site defense. Probe work inherits core's 10s per-provider
// budget, so every request is bounded; refresh spawns are the provider
// modules' own (alibaba's console login gets a 300s budget) and their output
// is never forwarded – responses carry fixed-literal messages only.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  ALL_PROVIDER_IDS,
  collectStatus,
  errorMessage,
  isValidCardKey,
  loadConfig,
  pkgVersion,
  type ProviderId,
  type ProviderModule,
  type RefreshResult,
  removeCachedProvider,
  SUBTRK_DIR,
  saveConfig,
  scrubValue,
} from "./core.ts";
import { allProviders, refreshableProviders } from "./providers/index.ts";
import { aggregateUsage, harvestUsage, readUsageStore } from "./usage.ts";

export interface ServeDeps {
  providers?: ProviderModule[]; // stub registry (tests)
  subtrkDir?: string; // override ~/.subtrk (tests)
  consoleHtmlPath?: string; // shell served at / (default: src/console.html next to this module)
  port?: number; // default 0 – random ephemeral port
  version?: string; // package version surfaced via /api/config (default: pkgVersion())
  refresh?: (id: string) => Promise<RefreshResult>; // stub seam (tests); default: module registry
}

export interface ServeHandle {
  port: number;
  token: string;
  close(): Promise<void>; // resolves once the socket is down
  closed: Promise<void>;
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function respond(
  res: ServerResponse,
  code: number,
  body: string | Uint8Array,
  type = "application/json",
  extra: Record<string, string> = {},
): void {
  try {
    res.writeHead(code, { "content-type": `${type}; charset=utf-8`, ...extra });
    res.end(body);
  } catch {
    /* client went away mid-response */
  }
}

// Only 127.0.0.1[:port] / localhost[:port] are ours; anything else stops here,
// before routing (DNS-rebinding and cross-host surfing die on this header).
function hostAllowed(header: string | undefined): boolean {
  const host = (header ?? "").toLowerCase();
  const colon = host.lastIndexOf(":");
  const name = colon > 0 ? host.slice(0, colon) : host;
  const port = colon > 0 ? host.slice(colon + 1) : "";
  return (name === "127.0.0.1" || name === "localhost") && (port === "" || /^\d+$/.test(port));
}

// Length guard first, then a constant-time compare on the utf8 buffers.
function tokenOk(header: string | undefined, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  const expected = Buffer.from(token, "utf8");
  const given = match ? Buffer.from(match[1], "utf8") : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const CONFIG_BODY_CAP_BYTES = 10_000; // the largest useful config patch is a few hundred bytes

// Drain the request body (capped). Never throws – over-cap and stream errors
// come back as null, which the caller answers 400.
async function readBody(req: IncomingMessage, cap = CONFIG_BODY_CAP_BYTES): Promise<string | null> {
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > cap) return null;
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

type ConfigPatch = { enabled?: ProviderId[]; order?: string[]; hidden?: string[]; theme?: "light" | "dark" };

// Pure: validate a parsed /api/config body. Fixed-literal errors; unknown extra
// keys are ignored. enabled: all ids known, ≥1. order: valid card keys
// ("<providerId>" or "<providerId>:<scope>"), deduped, may name
// currently-disabled providers. hidden: valid card keys, deduped, capped at 64.
// theme: exactly "light" or "dark".
function parseConfigPatch(raw: unknown): { patch: ConfigPatch } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid config body" };
  const body = raw as { enabled?: unknown; order?: unknown; hidden?: unknown; theme?: unknown };
  if (body.enabled === undefined && body.order === undefined && body.hidden === undefined && body.theme === undefined) {
    return { error: "config body must include enabled, order, hidden or theme" };
  }
  const known = (v: unknown): v is ProviderId =>
    typeof v === "string" && (ALL_PROVIDER_IDS as readonly string[]).includes(v);
  const patch: ConfigPatch = {};
  if (body.enabled !== undefined) {
    if (!Array.isArray(body.enabled) || !body.enabled.every(known)) return { error: "unknown provider id in enabled" };
    if (body.enabled.length === 0) return { error: "enabled must contain at least one provider id" };
    patch.enabled = [...body.enabled];
  }
  if (body.order !== undefined) {
    if (!Array.isArray(body.order) || !body.order.every((k) => isValidCardKey(k))) {
      return { error: "invalid card key in order" };
    }
    patch.order = [...new Set(body.order)];
  }
  if (body.hidden !== undefined) {
    if (!Array.isArray(body.hidden) || !body.hidden.every((k) => isValidCardKey(k))) {
      return { error: "invalid card key in hidden" };
    }
    if (body.hidden.length > 64) return { error: "hidden must hold at most 64 card keys" };
    patch.hidden = [...new Set(body.hidden)];
  }
  if (body.theme !== undefined) {
    if (body.theme !== "light" && body.theme !== "dark") return { error: "invalid theme" };
    patch.theme = body.theme;
  }
  return { patch };
}

export async function startConsole(deps: ServeDeps = {}): Promise<ServeHandle> {
  const token = randomBytes(32).toString("hex"); // per run, memory only
  const version = deps.version ?? pkgVersion();
  let shell: Buffer | null = null;
  try {
    shell = readFileSync(deps.consoleHtmlPath ?? fileURLToPath(new URL("./console.html", import.meta.url)));
  } catch {
    shell = null; // / answers 404 text until the shell file exists
  }

  // Single refresh per provider at a time – a second request for the same id
  // gets 409 while one is in flight; other providers keep running.
  const inFlight = new Map<string, Promise<RefreshResult>>();
  const runRefresh: (id: string) => Promise<RefreshResult> =
    deps.refresh ??
    ((id) => {
      const mod = allProviders.find((m) => m.id === id);
      return mod?.refresh ? mod.refresh() : Promise.resolve({ ok: false, message: "no interactive refresh" });
    });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!hostAllowed(req.headers.host)) {
        respond(res, 403, JSON.stringify({ error: "forbidden host" }));
        return;
      }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/" || path.startsWith("/provider/")) {
        if (req.method !== "GET") {
          respond(res, 405, JSON.stringify({ error: "method not allowed" }));
          return;
        }
        if (shell === null) {
          respond(res, 404, "console shell missing", "text/plain");
          return;
        }
        // /provider/<id> serves the SAME static shell – the page reads the path
        // and renders the drill-down view. Only known provider ids route here;
        // anything else is a plain 404 (no file serving, ever).
        if (path !== "/") {
          const id = path.slice("/provider/".length);
          if (!(ALL_PROVIDER_IDS as readonly string[]).includes(id)) {
            respond(res, 404, "unknown provider", "text/plain");
            return;
          }
        }
        respond(res, 200, shell, "text/html", { "content-security-policy": CSP });
        return;
      }
      if (path === "/api/status") {
        if (req.method !== "GET") {
          respond(res, 405, JSON.stringify({ error: "method not allowed" }));
          return;
        }
        if (!tokenOk(req.headers.authorization, token)) {
          respond(res, 401, JSON.stringify({ error: "unauthorized" }));
          return;
        }
        void collectStatus({ subtrkDir: deps.subtrkDir, providers: deps.providers }).then(
          (c) => {
            respond(res, 200, JSON.stringify(scrubValue(c.out)));
            // Usage harvest rides every dashboard refresh (M3): fire-and-forget
            // with its own budget – never blocks the response, never throws.
            void harvestUsage(c.out.providers, { subtrkDir: deps.subtrkDir, budgetMs: 30_000 }).catch(() => {});
          },
          (err: unknown) => {
            console.error(`subtrk: ${errorMessage(err)}`);
            respond(res, 500, JSON.stringify({ error: "status unavailable" }));
          },
        );
        return;
      }
      if (path === "/api/usage") {
        if (req.method !== "GET") {
          respond(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json", { allow: "GET" });
          return;
        }
        if (!tokenOk(req.headers.authorization, token)) {
          respond(res, 401, JSON.stringify({ error: "unauthorized" }));
          return;
        }
        // Reads the store only – no vendor calls. Defaults: local month-to-date
        // across every provider with stored data, day granularity. `local`
        // controls the this-machine sections: the MTD summary excludes them
        // (vendor-served totals only), a provider drill-down includes them.
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const provider = url.searchParams.get("provider");
        if (provider && !(ALL_PROVIDER_IDS as readonly string[]).includes(provider)) {
          respond(res, 400, JSON.stringify({ error: "unknown provider" }));
          return;
        }
        const localParam = url.searchParams.get("local");
        const local = localParam === "only" ? "only" : localParam === "include" || provider !== null ? "include" : "exclude";
        const granularity = url.searchParams.get("granularity") === "hour" ? "hour" : "day";
        const parseMs = (name: string): number | null => {
          const raw = url.searchParams.get(name);
          if (raw === null) return null;
          if (/^\d+$/.test(raw)) return Number(raw);
          const t = Date.parse(raw);
          return Number.isFinite(t) ? t : null;
        };
        const fromParam = parseMs("from");
        const toParam = parseMs("to");
        const nowMs = Date.now();
        const from = fromParam ?? new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), 1).getTime();
        const to = toParam ?? nowMs;
        if (from > to) {
          respond(res, 400, JSON.stringify({ error: "from is after to" }));
          return;
        }
        try {
          const store = readUsageStore(deps.subtrkDir ?? SUBTRK_DIR);
          const agg = aggregateUsage(store, { provider: provider ?? undefined, granularity, fromMs: from, toMs: to, local });
          respond(
            res,
            200,
            JSON.stringify({
              schemaVersion: 1,
              generatedAt: new Date(nowMs).toISOString(),
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
              granularity,
              providers: agg.providers,
            }),
          );
        } catch (err) {
          console.error(`subtrk: ${errorMessage(err)}`);
          respond(res, 500, JSON.stringify({ error: "usage unavailable" }));
        }
        return;
      }
      if (path === "/api/refresh") {
        if (req.method !== "POST") {
          respond(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json", { allow: "POST" });
          return;
        }
        if (!tokenOk(req.headers.authorization, token)) {
          respond(res, 401, JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("provider") ?? "";
        if (!(refreshableProviders() as readonly string[]).includes(id)) {
          respond(res, 400, JSON.stringify({ error: "unknown or non-refreshable provider" }));
          return;
        }
        if (inFlight.has(id)) {
          respond(res, 409, JSON.stringify({ error: "refresh already running" }));
          return;
        }
        const run = runRefresh(id).finally(() => inFlight.delete(id));
        inFlight.set(id, run);
        void run.then(
          (r) => {
            if (r.ok) removeCachedProvider(deps.subtrkDir ?? SUBTRK_DIR, id);
            // 200 even when ok:false – the endpoint worked; the body carries
            // the action's outcome as a fixed-literal message.
            respond(res, 200, JSON.stringify(scrubValue(r)));
          },
          (err: unknown) => {
            console.error(`subtrk: ${errorMessage(err)}`);
            respond(res, 500, JSON.stringify({ error: "refresh failed" }));
          },
        );
        return;
      }
      if (path === "/api/config") {
        if (req.method === "GET") {
          // Current display config for the console's menus (provider selection,
          // card manager). Bearer-protected like the other endpoints; the file
          // holds no secrets – these are the same fields init writes.
          if (!tokenOk(req.headers.authorization, token)) {
            respond(res, 401, JSON.stringify({ error: "unauthorized" }));
            return;
          }
          try {
            const cfg = loadConfig(deps.subtrkDir ?? SUBTRK_DIR);
            respond(
              res,
              200,
              JSON.stringify({
                enabled: cfg.enabled,
                order: cfg.order ?? [],
                hidden: cfg.hidden ?? [],
                theme: cfg.theme ?? null,
                version,
              }),
            );
          } catch (err) {
            console.error(`subtrk: ${errorMessage(err)}`);
            respond(res, 500, JSON.stringify({ error: "config unavailable" }));
          }
          return;
        }
        if (req.method !== "POST") {
          respond(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json", {
            allow: "GET, POST",
          });
          return;
        }
        if (!tokenOk(req.headers.authorization, token)) {
          respond(res, 401, JSON.stringify({ error: "unauthorized" }));
          return;
        }
        // Persist a console patch (enabled and/or order) to config.json via the
        // atomic saveConfig. Responses are fixed literals – the file is echoed
        // back through /api/status only.
        void (async () => {
          let raw: unknown;
          try {
            raw = JSON.parse((await readBody(req)) ?? "");
          } catch {
            respond(res, 400, JSON.stringify({ error: "invalid config body" }));
            return;
          }
          const parsed = parseConfigPatch(raw);
          if ("error" in parsed) {
            respond(res, 400, JSON.stringify({ error: parsed.error }));
            return;
          }
          saveConfig(deps.subtrkDir ?? SUBTRK_DIR, parsed.patch);
          respond(res, 200, JSON.stringify({ ok: true }));
        })().catch((err: unknown) => {
          console.error(`subtrk: ${errorMessage(err)}`);
          respond(res, 500, JSON.stringify({ error: "internal error" }));
        });
        return;
      }
      respond(res, 404, JSON.stringify({ error: "not found" }));
    } catch (err: unknown) {
      console.error(`subtrk: ${errorMessage(err)}`);
      respond(res, 500, JSON.stringify({ error: "internal error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : (deps.port ?? 0);
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  return {
    port,
    token,
    closed,
    close: async () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      await closed;
    },
  };
}

// CLI entry: listen, print the one URL – the token rides the fragment and is
// never written anywhere else – then sit quiet until SIGINT/SIGTERM (exit 0).
// While running, an hourly sampler probes + harvests even when nobody is
// watching, so the window-% history fills hourly instead of only when a
// status call happens.
export async function runServe(deps: ServeDeps = {}): Promise<void> {
  const h = await startConsole(deps);
  console.log(`http://127.0.0.1:${h.port}/#${h.token}`);
  console.log("token auth required – API calls need Authorization: Bearer <token>");
  const sampler = setInterval(() => {
    void collectStatus({ subtrkDir: deps.subtrkDir, providers: deps.providers })
      .then((c) => harvestUsage(c.out.providers, { subtrkDir: deps.subtrkDir, budgetMs: 30_000 }))
      .catch(() => {});
  }, 3_600_000);
  sampler.unref();
  const stop = (): void => {
    clearInterval(sampler);
    const force = setTimeout(() => process.exit(0), 1000);
    void h.close().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await h.closed;
}
