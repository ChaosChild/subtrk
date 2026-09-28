#!/usr/bin/env node
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// cli.ts – subtrk entry point. `subtrk` / `subtrk status` / `subtrk init` /
// `subtrk auth refresh` / `subtrk serve`. The providers registry lives in
// ./providers/index.ts (allProviders) and is imported lazily (from collectStatus)
// so tests can inject a stub registry via main()'s deps seam.
import { parseArgs } from "node:util";
import { printAgentListing } from "./agents.ts";
import {
  ALL_PROVIDER_IDS,
  type Credits,
  collectStatus,
  errorMessage,
  type ProviderModule,
  type ProviderResult,
  readCacheEntry,
  removeCachedProvider,
  type StatusOutput,
  SUBTRK_DIR,
  scrub,
  scrubValue,
  type Window,
} from "./core.ts";
import { runInit } from "./init.ts";
import { runServe } from "./serve.ts";

export interface CliDirs {
  subtrk?: string; // override ~/.subtrk (tests)
  agentsDir?: string; // base for agent instruction files (replaces homedir; tests)
}

export interface CliDeps {
  providers?: ProviderModule[];
  dirs?: CliDirs;
}

const STATUS_FIELDS = ["windows", "credits", "errors", "hints"] as const;
type StatusField = (typeof STATUS_FIELDS)[number];

const USAGE = `subtrk – remaining quota across your tracked providers

usage:
  subtrk                  same as: subtrk status
  subtrk status [flags]   probe enabled providers, compact text
  subtrk init             one-time interactive setup
  subtrk init --agent <id>  write agent instructions for a harness and exit
                          (claude|zcode|codex|opencode|agy)
  subtrk auth refresh     re-authorise one provider interactively (--provider <id>)
  subtrk serve            local web console (loopback only)
  subtrk --version        print the version

status flags:
  --json                machine-readable output (schemaVersion 1)
  --provider <id>       restrict to provider (repeatable)
  --fields a,b          text filter: windows,credits,errors,hints
  --fresh               bypass cache TTLs once (claude keeps its 300s floor)
  --strict              exit 3 if any provider failed
  -h, --help            this screen

exit codes: 0 ran · 1 runtime failure · 2 usage error · 3 --strict violation`;

const SERVE_USAGE = `subtrk serve – local web console (loopback only)

Serves one URL, http://127.0.0.1:<port>/#<token> – the per-run random token rides
the fragment, never argv or logs; API calls need Authorization: Bearer <token>.
POST /api/refresh re-runs a provider's interactive login (dashboard "Refresh now").
Ctrl-C stops the server. flag: --port N (default: random ephemeral port)`;

const INIT_USAGE = `subtrk init – one-time interactive setup

Checks every provider, offers installs and logins where missing, and writes
new secrets to ~/.subtrk/env (mode 0600 on POSIX). Secrets are never echoed.

--agent <id> skips all of that: it only writes subtrk's instruction section
into harness <id>'s global instructions file (claude|zcode|codex|opencode|agy)
and exits. Idempotent – only subtrk's own marked block is touched.

flags:
  --agent <id>  install agent instructions for <id>, no interaction
  -h, --help    this screen`;

// ---------- text rendering (spec §Text format) ----------

// package.json rides next to src/ in the repo and in the npm tarball alike.
function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "??:??";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function relative(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function windowLabel(w: Window, scoped: boolean): string {
  const prefix = scoped && w.scope ? `${w.scope} ` : "";
  if (typeof w.usedPercent === "number") {
    return `${prefix}${w.kind} ${Math.round(w.usedPercent)}% (reset ${clock(w.resetsAt)})`;
  }
  if (typeof w.remainingFraction === "number") {
    return `${prefix}${w.kind} ${Math.round(w.remainingFraction * 100)}% left`;
  }
  return `${prefix}${w.kind}`;
}

function isHot(r: ProviderResult): boolean {
  return (r.windows ?? []).some(
    (w) =>
      (typeof w.usedPercent === "number" && w.usedPercent >= 95) ||
      (typeof w.remainingFraction === "number" && w.remainingFraction <= 0.05),
  );
}

function creditsLabel(c: Credits): string {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  const main =
    c.unit === "usd"
      ? `$${c.remaining.toFixed(2)} left`
      : typeof c.total === "number"
        ? `credits ${fmt(c.remaining)}/${fmt(c.total)}`
        : `credits ${fmt(c.remaining)} left`;
  return c.cycleEndsAt ? `${main} · cycle ends ${c.cycleEndsAt.slice(0, 10)}` : main;
}

function renderText(
  out: StatusOutput,
  fields: Set<StatusField> | null,
  nowMs: number,
  ttlById: Map<string, number>,
): string[] {
  // Default = spec §Text format: windows, credits, error lines. Hints are an
  // extra field (--fields hints).
  const DEFAULT_FIELDS: ReadonlySet<StatusField> = new Set<StatusField>(["windows", "credits", "errors"]);
  const show = (f: StatusField): boolean => (fields ?? DEFAULT_FIELDS).has(f);
  // Providers promise one-line messages; hold that line even if stderr tails
  // leak in with newlines.
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  for (const r of out.providers) {
    const segs: string[] = [];
    if (show("windows") && r.windows?.length) {
      const scopes = new Set(r.windows.map((w) => w.scope).filter(Boolean));
      const scoped = scopes.size > 1;
      segs.push(r.windows.map((w) => windowLabel(w, scoped)).join(" · "));
    }
    if (show("credits") && r.credits) segs.push(creditsLabel(r.credits));
    if (r.note) segs.push(r.note);
    if (segs.length === 0 && r.ok) segs.push("ok");
    let line = `${r.id.padEnd(10)} ${segs.join(" · ")}`;
    if (!r.ok && r.error) {
      if (segs.length === 0)
        line = `${r.id.padEnd(10)} error: ${r.error.kind} – ${oneLine(r.error.message)}${r.error.hint ? ` (${oneLine(r.error.hint)})` : ""}`;
      else if (show("errors")) line += ` · error: ${r.error.kind} – ${oneLine(r.error.message)}`;
    }
    if (show("hints") && r.error?.hint) line += ` – hint: ${oneLine(r.error.hint)}`;
    if (r.stale) line += "  [stale]";
    if (isHot(r)) line += " !";
    lines.push(scrub(line.trimEnd()));
  }
  const next = out.nextEvent;
  if (next) {
    const provider = out.providers.find((p) => p.id === next.providerId);
    const ttl = ttlById.get(next.providerId) ?? 0;
    const win = provider?.windows?.find((w) => {
      const resetMs = Date.parse(w.resetsAt);
      if (!Number.isFinite(resetMs)) return false;
      const fetchedMs = Date.parse(provider.fetchedAt);
      const effective = Number.isFinite(fetchedMs) ? Math.max(resetMs, fetchedMs + ttl) : resetMs;
      return effective === next.atMs;
    });
    const kind = win ? `${win.kind} ` : "";
    lines.push(scrub(`next: ${next.providerId} ${kind}at ${clock(next.at)} (${relative(next.atMs - nowMs)})`));
  }
  lines.push(scrub("help: subtrk status --json | subtrk status --provider <id> | subtrk init"));
  return lines;
}

// ---------- main ----------

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        provider: { type: "string", multiple: true },
        fields: { type: "string" },
        fresh: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        port: { type: "string" },
        agent: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`subtrk: ${msg}`);
    // a bare `--agent` (no value) lands here – same listing as an unknown name
    if (msg.includes("--agent")) printAgentListing(deps.dirs?.agentsDir);
    return 2;
  }
  const positionals = parsed.positionals;
  if (positionals[0] === "auth") {
    // the only two-verb command: exactly "auth refresh"
    if (positionals[1] !== "refresh" || positionals.length > 2) {
      console.error(`subtrk: unknown command '${positionals.join(" ")}' – try subtrk --help`);
      return 2;
    }
  } else if (positionals.length > 1) {
    console.error(`subtrk: unexpected argument '${positionals[1]}' – try subtrk --help`);
    return 2;
  }
  // bare `subtrk` = status, never help
  const cmd = positionals[0] === "auth" ? "auth refresh" : (positionals[0] ?? "status");
  const {
    json,
    provider = [],
    fields,
    fresh,
    strict,
    port,
    agent,
    help,
    version: versionFlag,
  } = parsed.values as {
    json?: boolean;
    provider?: string[];
    fields?: string;
    fresh?: boolean;
    strict?: boolean;
    port?: string;
    agent?: string;
    help?: boolean;
    version?: boolean;
  };
  if (help) {
    console.log(cmd === "init" ? INIT_USAGE : cmd === "serve" ? SERVE_USAGE : USAGE);
    return 0;
  }
  if (versionFlag || cmd === "version") {
    console.log(cliVersion());
    return 0;
  }
  if (cmd === "init") {
    try {
      const code = await runInit({
        subtrkDir: deps.dirs?.subtrk,
        agent,
        agentsDir: deps.dirs?.agentsDir,
      });
      return code ?? 0;
    } catch (err) {
      console.error(`subtrk: ${errorMessage(err)}`);
      return 1;
    }
  }
  if (cmd === "serve") {
    if (port !== undefined && !/^\d+$/.test(port)) {
      console.error("subtrk: --port must be a non-negative integer");
      return 2;
    }
    const portNum = port === undefined ? 0 : Number(port); // 0 = random ephemeral
    if (portNum > 65535) {
      console.error("subtrk: --port must be at most 65535");
      return 2;
    }
    try {
      await runServe({ providers: deps.providers, subtrkDir: deps.dirs?.subtrk, port: portNum });
      return 0;
    } catch (err) {
      console.error(`subtrk: ${errorMessage(err)}`);
      return 1;
    }
  }
  if (cmd === "auth refresh") return authRefresh(provider, deps);
  if (cmd !== "status") {
    console.error(`subtrk: unknown command '${cmd}' – try subtrk --help`);
    return 2;
  }

  let fieldSet: Set<StatusField> | null = null;
  if (fields !== undefined) {
    fieldSet = new Set();
    for (const f of fields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!(STATUS_FIELDS as readonly string[]).includes(f)) {
        console.error(`subtrk: unknown field '${f}' – valid: ${STATUS_FIELDS.join(",")}`);
        return 2;
      }
      fieldSet.add(f as StatusField);
    }
  }

  const badProvider = provider.find((id) => !(ALL_PROVIDER_IDS as readonly string[]).includes(id));
  if (badProvider) {
    console.error(`subtrk: unknown provider '${badProvider}'`);
    return 2;
  }

  let collected: Awaited<ReturnType<typeof collectStatus>>;
  try {
    collected = await collectStatus({
      subtrkDir: deps.dirs?.subtrk,
      providers: deps.providers,
      requested: provider,
      fresh: fresh === true,
    });
  } catch (err) {
    console.error(`subtrk: ${errorMessage(err)}`);
    return 1;
  }
  const { out, ttlById } = collected;

  if (json) console.log(JSON.stringify(scrubValue(out)));
  else for (const line of renderText(out, fieldSet, Date.now(), ttlById)) console.log(line);

  return strict === true && out.providers.some((r) => !r.ok) ? 3 : 0;
}

// ---------- auth refresh ----------

// `subtrk auth refresh --provider <id>` – runs the provider module's interactive
// refresh (init stays the only other interactive command) and drops the cache
// entry on success so the next status re-probes. Result messages are fixed
// literals from the provider modules; subprocess output is never printed.
async function authRefresh(providerIds: string[], deps: CliDeps): Promise<number> {
  const registry = deps.providers ?? (await import("./providers/index.ts")).allProviders;
  if (providerIds.length !== 1) {
    for (const m of registry) {
      const supported = typeof m.refresh === "function" ? "interactive refresh supported" : "no interactive refresh";
      console.error(`${m.id} – ${supported}`);
    }
    if (providerIds.length > 1) console.error("subtrk: auth refresh takes exactly one --provider");
    console.error("usage: subtrk auth refresh --provider <id>");
    return 2;
  }
  const id = providerIds[0];
  const mod = (ALL_PROVIDER_IDS as readonly string[]).includes(id) ? registry.find((m) => m.id === id) : undefined;
  if (!mod) {
    console.error(`subtrk: unknown provider '${id}'`);
    return 2;
  }
  if (typeof mod.refresh !== "function") {
    // Name the remedy when the provider's cached error carries one, else the generic line.
    const cached = readCacheEntry(join(deps.dirs?.subtrk ?? SUBTRK_DIR, "cache.json"), id);
    const remedy = cached?.data.error?.remedy ?? "re-run subtrk init";
    console.log(scrub(`${id} – no interactive refresh; ${remedy}`));
    return 1;
  }
  try {
    const r = await mod.refresh();
    if (r.ok) removeCachedProvider(deps.dirs?.subtrk ?? SUBTRK_DIR, id);
    console.log(scrub(`${id} – ${r.message}`));
    return r.ok ? 0 : 1;
  } catch (err) {
    console.error(`subtrk: ${errorMessage(err)}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`subtrk: ${errorMessage(err)}`);
      process.exitCode = 1;
    },
  );
}
