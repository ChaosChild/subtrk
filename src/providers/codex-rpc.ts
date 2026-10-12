// codex-rpc – read-only fallback lane for the openai provider: asks the local
// Codex CLI (`codex -s read-only -a never app-server`, JSON-RPC over stdio) for
// the stored login's rate limits when the HTTP usage read fails. Never sends a
// prompt, never touches auth.json; every failure resolves to null.
// codex window mapping / cli-rpc fallback after quota-axi (MIT).

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const RPC_TIMEOUT_MS = 8_000;
const MAX_STDOUT_CHARS = 1_000_000;
export const CODEX_ARGS: readonly string[] = ["-s", "read-only", "-a", "never", "app-server"];

// Windows candidates for the bare name, in PATHEXT discipline with the shims
// excluded: a real PE image (.exe) first, then an extensionless file. .cmd/
// .bat/.ps1 shims need a shell and are skipped outright (the no-shell rule).
const WIN_DEFAULT_CANDIDATES: readonly string[] = ["codex.exe", "codex"];

// The DEFAULT binary resolves against the PATH DIRECTORIES ONLY, never the
// current directory: on Windows libuv's spawn search checks the CWD before
// PATH, so a bare "codex" would let a planted codex.exe in an untrusted CWD
// execute when the fallback triggers. RELATIVE PATH entries ("." or "bin")
// resolve against the CWD too – the same vector – so they are skipped
// outright; a PATH holding only relative entries means unavailable. Not on
// PATH -> the fallback is unavailable, the same clean degrade as a missing
// binary.
function resolveCodexFromPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((d) => d.trim() !== "" && isAbsolute(d));
  const names = platform === "win32" ? WIN_DEFAULT_CANDIDATES : (["codex"] as const);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return { file: candidate, args: [...CODEX_ARGS] };
      } catch {
        /* not here – keep scanning */
      }
    }
  }
  return null;
}

// Pure-ish (stat only): the argv to spawn, or null when the binary is
// unavailable – fail closed, never a shell. A .js/.mjs/.cjs SUBTRK_CODEX_BINARY
// override runs under this node (npm's codex.js entry, test fixtures); any
// other override must be an absolute existing file. Default: `codex` resolved
// from the PATH entries only (never the CWD – see resolveCodexFromPath), which
// on Windows finds codex.exe but not the npm .cmd shim.
export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | null {
  const override = env.SUBTRK_CODEX_BINARY;
  if (override === undefined) return resolveCodexFromPath(env, platform);
  const path = override.trim();
  if (path === "" || !isAbsolute(path)) return null;
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  if (/\.[cm]?js$/i.test(path)) return { file: execPath, args: [path, ...CODEX_ARGS] };
  return { file: path, args: [...CODEX_ARGS] };
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// Pure: one camelCase RPC window -> the wham/usage snake_case window shape.
function rpcWindow(raw: unknown): Record<string, unknown> | null {
  const w = obj(raw);
  if (!w) return null;
  const out: Record<string, unknown> = { used_percent: w.usedPercent ?? w.used_percent };
  const mins = w.windowDurationMins;
  if (typeof mins === "number" && Number.isFinite(mins)) out.limit_window_seconds = mins * 60;
  else if (w.limit_window_seconds !== undefined) out.limit_window_seconds = w.limit_window_seconds;
  const r = w.resetsAt ?? w.reset_at;
  if (typeof r === "number") out.reset_at = r;
  else if (typeof r === "string" && Number.isFinite(Date.parse(r))) out.reset_at = Date.parse(r) / 1000;
  if (w.reset_after_seconds !== undefined) out.reset_after_seconds = w.reset_after_seconds;
  return out;
}

function rpcPair(raw: unknown): Record<string, unknown> | null {
  const c = obj(raw);
  if (!c) return null;
  return { primary_window: rpcWindow(c.primary), secondary_window: rpcWindow(c.secondary) };
}

// Pure: account/read + account/rateLimits/read results -> a wham/usage-shaped
// body, so parseOpenaiUsage owns the one window mapping. Named entries of
// rateLimitsByLimitId are model-scoped extras; the unnamed one is the base.
export function rpcToUsageBody(account: unknown, limits: unknown): Record<string, unknown> {
  const acct = obj(obj(account)?.account) ?? {};
  const l = obj(limits) ?? {};
  const additional: unknown[] = [];
  for (const [id, v] of Object.entries(obj(l.rateLimitsByLimitId) ?? {})) {
    const item = obj(v);
    const name = item?.limitName;
    if (typeof name === "string" && name !== "")
      additional.push({ limit_name: name, metered_feature: id, rate_limit: rpcPair(item) });
  }
  return {
    plan_type: acct.planType ?? acct.plan_type,
    rate_limit: rpcPair(l.rateLimits),
    additional_rate_limits: additional,
  };
}

// Spawn codex app-server, run initialize -> account/read + account/rateLimits/read,
// return the usage-shaped body; null on any failure (missing binary, bad
// override, timeout, RPC error, signed-out account). Never throws.
// opts.deadlineMs caps the WHOLE lane: each RPC call's timeout shrinks to
// whatever budget remains, so a caller can fit the fallback inside its own
// probe budget instead of the per-call 8s default stacking past it.
export interface CodexRpcOptions {
  deadlineMs?: number;
}

export function readCodexRpcUsage(
  env: NodeJS.ProcessEnv = process.env,
  opts: CodexRpcOptions = {},
): Promise<Record<string, unknown> | null> {
  const cmd = resolveCodexCommand(env);
  if (!cmd) return Promise.resolve(null);
  if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();
    const waiters = new Map<number, (v: unknown) => void>();
    let child: ReturnType<typeof spawn>;
    const finish = (v: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      child?.kill();
      resolve(v);
    };
    try {
      child = spawn(cmd.file, cmd.args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...env, NO_COLOR: "1", TERM: "dumb" },
      });
    } catch {
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin?.on("error", () => finish(null));
    let buf = "";
    let seen = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > MAX_STDOUT_CHARS) return finish(null);
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // banners / non-JSON startup output
        }
        const waiter = typeof msg.id === "number" ? waiters.get(msg.id) : undefined;
        if (!waiter) continue; // notifications, unknown ids
        waiters.delete(msg.id as number);
        if (msg.error !== undefined) finish(null);
        else waiter(msg.result);
      }
    });
    let nextId = 1;
    const call = (method: string, params: unknown = {}): Promise<unknown> =>
      new Promise((res) => {
        const id = nextId++;
        const budget = opts.deadlineMs !== undefined ? opts.deadlineMs - Date.now() : RPC_TIMEOUT_MS;
        if (!(budget > 0)) {
          finish(null);
          return;
        }
        const t = setTimeout(() => finish(null), budget);
        timers.add(t);
        waiters.set(id, (v) => {
          clearTimeout(t);
          res(v);
        });
        child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    (async () => {
      await call("initialize", { clientInfo: { name: "subtrk", version: "1" } });
      const [account, limits] = await Promise.all([call("account/read"), call("account/rateLimits/read")]);
      // signed out (account null) or an API-key login: no plan usage to read.
      const acct = obj(account);
      if (acct && "account" in acct) {
        const type = obj(acct.account)?.type;
        if (acct.account === null || (type !== undefined && type !== "chatgpt")) return finish(null);
      }
      finish(rpcToUsageBody(account, limits));
    })().catch(() => finish(null));
  });
}
