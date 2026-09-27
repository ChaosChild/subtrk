// init.ts – `subtrk init`: one-time interactive setup (spec §subtrk init).
// Checks every tracked provider, offers installs/logins, writes new secrets to
// ~/.subtrk/env (mode 0600 on POSIX). Secrets are never echoed. `--agent <id>`
// skips all interaction: it only writes the agent instructions section.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AgentTarget } from "./agents.ts";
import { AGENT_SECTION, agentTargets, applyAgentSection, printAgentListing } from "./agents.ts";
import type { ProviderId } from "./core.ts";
import { ALL_PROVIDER_IDS, getSecret, loadConfig, registerSecret, SUBTRK_DIR, scrub } from "./core.ts";
import { claudeAuth } from "./providers/claude.ts";
import { desktopKeyPath, kimiTokenStale, parseDesktopKeyFile, parseKimiCliCredentials } from "./providers/kimi.ts";
import { parseOpenaiAuth } from "./providers/openai.ts";

export interface InitOpts {
  subtrkDir?: string;
  agentsDir?: string; // base for agent instruction files (replaces homedir; tests)
  agent?: string; // --agent <harness>: only the agent step, then exit
}

// ---------- prompts ----------

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function askHidden(prompt: string, stdin: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const tty = stdin as NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (m: boolean) => void };
  if (!tty.isTTY) {
    console.log("  (stdin is not a TTY – skipped)");
    return "";
  }
  process.stdout.write(prompt);
  tty.setRawMode?.(true);
  return await new Promise<string>((resolve) => {
    let value = "";
    const done = (v: string) => {
      // pause, never destroy: later prompts reuse this same stdin stream
      tty.setRawMode?.(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stdout.write("\n");
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(value);
        if (ch === "\u0003") {
          // Ctrl-C: restore the terminal, then die like a well-behaved CLI.
          tty.setRawMode?.(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f") {
          value = value.slice(0, -1); // backspace
          continue;
        }
        if (ch === "\u0004") return done(value); // Ctrl-D
        value += ch;
      }
    };
    stdin.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

// ---------- provider selection (first init step) ----------

// Invalid input re-prompts with the same listing this many times, then the
// current selection stands – the same one-shot-with-default spirit as the
// other init prompts, just bounded.
const SELECTION_ATTEMPTS = 3;

// Pure: turn a selection answer into provider ids. Tokens are 1-based numbers
// into ALL_PROVIDER_IDS and/or literal ids, comma or space separated; empty
// input keeps the current selection; any invalid token returns null (the
// caller's re-prompt signal). The result follows the canonical provider order.
export function parseProviderSelection(input: string, current: readonly ProviderId[]): ProviderId[] | null {
  const trimmed = input.trim();
  if (trimmed === "") return [...current];
  const picked = new Set<ProviderId>();
  for (const token of trimmed.split(/[,\s]+/).filter((t) => t !== "")) {
    let id: ProviderId | null = null;
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n >= 1 && n <= ALL_PROVIDER_IDS.length) id = ALL_PROVIDER_IDS[n - 1];
    } else if ((ALL_PROVIDER_IDS as readonly string[]).includes(token)) {
      id = token as ProviderId;
    }
    if (!id) return null; // invalid token
    picked.add(id);
  }
  return ALL_PROVIDER_IDS.filter((id) => picked.has(id));
}

// The numbered listing shown before the selection prompt – [x] marks a
// currently selected provider. Reprinted verbatim after invalid input.
function selectionListing(current: readonly ProviderId[]): string[] {
  const rows = ALL_PROVIDER_IDS.map((id, i) => `  [${current.includes(id) ? "x" : " "}] ${i + 1} ${id}`);
  return ["Which providers does subtrk track?", ...rows];
}

// First init step: pick which providers this machine tracks. Uses the shared
// raw-mode reader, so a non-TTY stdin prints its skip note and resolves to the
// current selection; invalid input re-prompts with the same listing. Null
// means "no change" (skip or attempts exhausted).
export async function askProviderSelection(
  current: readonly ProviderId[],
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<ProviderId[] | null> {
  for (let attempt = 0; attempt < SELECTION_ATTEMPTS; attempt++) {
    for (const line of selectionListing(current)) console.log(line);
    const answer = await askHidden(
      "Providers to track (numbers or ids, e.g. `1 3 5`; empty keeps the current selection): ",
      stdin,
    );
    const parsed = parseProviderSelection(answer, current);
    if (parsed) return parsed;
    console.log(`  invalid entry – use 1-${ALL_PROVIDER_IDS.length} or ids: ${ALL_PROVIDER_IDS.join(", ")}`);
  }
  return null;
}

// The selection persists as config.json `{ enabled: [...] }` – the same file
// loadConfig/collectStatus read. Plain stringify + newline, best effort: a
// lost write costs a re-run of init, never an error. Deleting the file
// restores "all providers".
export function saveProviderSelection(subtrkDir: string, enabled: readonly ProviderId[]): boolean {
  try {
    writeFileSync(join(subtrkDir, "config.json"), `${JSON.stringify({ enabled: [...enabled] }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------- env file ----------

function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, `${out.join("\n").replace(/\n+$/, "")}\n`);
  if (process.platform !== "win32") {
    try {
      chmodSync(envPath, 0o600);
    } catch {
      /* best effort */
    }
  }
}

// ---------- checks ----------

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findOnPath(name: string): boolean {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}

// Fixed literal command through the shell, stdio passthrough. Never interpolated.
function runShellLiteral(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// ---------- bl (alibaba) helpers ----------

const BL_TIMEOUT_MS = 10_000;

// User-typed secrets go in as ONE argv element; this charset (letters, digits,
// . _ : -) keeps every quoting/shell layer inert.
function safeArg(v: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(v);
}

// Run `bl` with a fixed argv array via execFile. On Windows `bl` is a .cmd
// shim, so the call routes through `cmd.exe /d /s /c` – still argv-driven:
// Node quotes each element into the child command line, and user-typed secrets
// pass safeArg first, so no command string is ever assembled here.
function runBl(
  args: string[],
  opts: { stdio?: "inherit" } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const win = process.platform === "win32";
  const file = win ? "cmd.exe" : "bl";
  const argv = win ? ["/d", "/s", "/c", "bl", ...args] : args;
  return new Promise((resolve) => {
    if (opts.stdio === "inherit") {
      // Interactive (browser login) – no timeout: the user finishes in the browser.
      const child = spawn(file, argv, { stdio: "inherit", windowsHide: false });
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "spawn failed" }));
      child.on("exit", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
      return;
    }
    execFile(file, argv, { timeout: BL_TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// Pure: verdict for `bl usage token-plan --output json` – exit 0 AND non-empty
// plan data means usage is readable; exit 0 with empty JSON ({} / empty items)
// means the console session is on the wrong site or account.
export function classifyBlVerify(
  exitCode: number,
  stderr: string,
  scrubFn: (s: string) => string = (s) => s,
  stdout = "",
): { ok: true } | { ok: false; message: string } {
  if (exitCode === 0) {
    const trimmed = stdout.trim();
    const looksEmpty =
      trimmed === "" ||
      trimmed === "{}" ||
      /"items"\s*:\s*\[\s*\]/.test(trimmed) ||
      /"data"\s*:\s*\{\s*\}/.test(trimmed);
    if (looksEmpty) {
      return {
        ok: false,
        message:
          "console login works but returned no plan data – wrong console site or account? (bl auth login --console)",
      };
    }
    return { ok: true };
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const last = lines[lines.length - 1] ?? `bl usage token-plan exited with code ${exitCode}`;
  return { ok: false, message: scrubFn(last).slice(-200) };
}

// Pure: bl's own config (~/.bailian/config.json) carries a non-empty Token Plan
// API key? init skips its secret prompt when it does – the stored key is reused.
export function blHasPlanKey(configObj: unknown): boolean {
  const tp = (configObj as { "token-plan"?: unknown } | null)?.["token-plan"];
  if (typeof tp !== "object" || tp === null) return false;
  const key = (tp as { api_key?: unknown }).api_key;
  return typeof key === "string" && key !== "";
}

async function askConsoleSite(): Promise<"international" | "domestic"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (
      await rl.question(
        "alibaba – Console site? [1] international (modelstudio.alibabacloud.com) [2] domestic CN (bailian.console.aliyun.com) [1] ",
      )
    ).trim();
    return a === "2" ? "domestic" : "international";
  } finally {
    rl.close();
  }
}

// win32 only: does agy's Credential Manager target exist? cmdkey /list prints
// found entries (names only, never secrets); fixed literal, nothing interpolated.
function hasAgyKeyring(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "cmdkey /list:gemini:antigravity"],
      { timeout: 10_000, encoding: "utf8", windowsHide: true },
      (err, stdout) => {
        resolve(!err && /gemini:antigravity/i.test(stdout));
      },
    );
  });
}

// The Google OAuth client values are PUBLIC constants – Google publishes the
// gemini pair in gemini-cli's Apache-2.0 source, and the Antigravity pair is
// published in CLIProxyAPI's MIT source. CLIProxyAPI is used only as that public
// reference implementation where the constants live – no CLIProxyAPI install,
// file or process is ever used. Fetch from upstream so no literal lives in this
// repo – secret scanners stay quiet and values stay current.
async function fetchGoogleClientConstants(): Promise<Record<string, string> | null> {
  const get = async (url: string): Promise<string> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) return "";
      return await res.text();
    } catch {
      return "";
    } finally {
      clearTimeout(t);
    }
  };
  const geminiSrc = await get(
    "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/code_assist/oauth2.ts",
  );
  const id = geminiSrc.match(/\d{6,}-[a-z0-9.-]+\.apps\.googleusercontent\.com/)?.[0];
  const secret = geminiSrc.match(/GOCSPX-[A-Za-z0-9_-]+/)?.[0];
  const agySrc = await get(
    "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/auth/antigravity/constants.go",
  );
  const agyId = agySrc.match(/\d{6,}-[a-z0-9.-]+\.apps\.googleusercontent\.com/)?.[0];
  const agySecret = agySrc.match(/GOCSPX-[A-Za-z0-9_-]+/)?.[0];
  // Sanity: the antigravity pair must be complete and differ from the gemini client
  // (the quota-exporter id this check replaces turned out to be the wrong client).
  if (!id || !secret || !agyId || !agySecret || agyId === id) return null;
  return {
    GOOGLE_CLIENT_ID: id,
    GOOGLE_CLIENT_SECRET: secret,
    ANTIGRAVITY_CLIENT_ID: agyId,
    ANTIGRAVITY_CLIENT_SECRET: agySecret,
  };
}

// Kimi's OAuth client id is a PUBLIC constant, published in the vendor's own
// open-source client (MoonshotAI/kimi-code). Fetch from upstream so no literal
// lives in this repo – secret scanners stay quiet and the value stays current.
async function fetchKimiClientId(): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/packages/oauth/src/constants.ts",
      { signal: ac.signal },
    );
    if (!res.ok) return null;
    const src = await res.text();
    return src.match(/\bclientId:\s*["']([0-9a-fA-F-]{36})["']/)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// `subtrk init --agent <harness>`: write the instructions section, print one
// line, exit – no provider selection, no checks. Unknown name prints the
// supported listing on stderr and exits 2.
function agentStep(name: string, base?: string): number {
  const targets: Record<string, AgentTarget> = agentTargets(base);
  const target = targets[name];
  if (!target) {
    console.error(`subtrk: unknown agent '${name}' – supported:`);
    printAgentListing(base);
    return 2;
  }
  const { status } = applyAgentSection(target.file, AGENT_SECTION);
  console.log(`${name} – ${status} ${target.file}`);
  return 0;
}

export async function runInit(opts: InitOpts = {}): Promise<number | undefined> {
  if (opts.agent !== undefined) return agentStep(opts.agent, opts.agentsDir);
  const subtrkDir = opts.subtrkDir ?? SUBTRK_DIR;
  const envPath = join(subtrkDir, "env");
  mkdirSync(subtrkDir, { recursive: true });
  const missing: string[] = [];

  console.log("subtrk init – checking providers\n");

  // 0. Provider selection: which of the eight does this machine actually use?
  //    Stored as ~/.subtrk/config.json `{ enabled: [...] }` – the same gate
  //    collectStatus reads – and honored by every step below. Re-run init (or
  //    edit the file) to change it; deleting the file restores all providers.
  let enabled: ProviderId[];
  try {
    enabled = loadConfig(subtrkDir).enabled;
  } catch {
    console.log("[note]    ~/.subtrk/config.json is unreadable – defaulting to all providers");
    enabled = [...ALL_PROVIDER_IDS];
  }
  const picked = await askProviderSelection(enabled);
  const selected = new Set<ProviderId>(picked ?? enabled);
  if (picked && (picked.length !== enabled.length || picked.some((id) => !enabled.includes(id)))) {
    if (saveProviderSelection(subtrkDir, picked)) {
      console.log(`[ok]      selection saved to ~/.subtrk/config.json – tracking: ${picked.join(", ")}`);
    } else {
      console.log("[note]    could not write ~/.subtrk/config.json – selection applies to this run only");
    }
  }

  // 1. Claude: token present AND (unexpired OR refreshable). Selected only.
  if (selected.has("claude")) {
    const cred = readJson(join(homedir(), ".claude", ".credentials.json"));
    const claude = claudeAuth(cred, Date.now());
    if (claude.ok) {
      console.log("[ok]      claude – token present, unexpired");
    } else if (claude.refreshToken) {
      console.log("[ok]      claude – token expired, subtrk will self-refresh on next status");
    } else {
      missing.push("claude – run `claude /login`");
      console.log("[missing] claude – no readable unexpired token in ~/.claude/.credentials.json");
    }
  }

  // 2. GLM: ZCode config key present. Selected only.
  if (selected.has("glm")) {
    const zcfg = readJson(join(homedir(), ".zcode", "cli", "config.json")) as {
      provider?: { zai?: { apiKey?: unknown } };
    } | null;
    if (typeof zcfg?.provider?.zai?.apiKey === "string" && zcfg.provider.zai.apiKey.length > 0) {
      console.log("[ok]      glm – ZCode config key present");
    } else {
      missing.push("glm – log in via ZCode, then re-run subtrk init");
      console.log("[missing] glm – no provider.zai.apiKey in ~/.zcode/cli/config.json");
    }
  }

  // 3. Alibaba: `bl` on PATH? offer install, then the verified bl 2.0.1 flow:
  //    Token Plan API key, console browser login (AK fallback), then a usage
  //    read-back so [ok] is only ever printed when usage is actually readable.
  //    Selected only – no prompts or nagging otherwise.
  if (selected.has("alibaba")) {
    let bl = findOnPath("bl");
    if (!bl && (await askYesNo("alibaba – `bl` not found on PATH. Install bailian-cli now?"))) {
      await runShellLiteral("npm i -g bailian-cli");
      bl = findOnPath("bl");
    }
    if (bl) {
      // bl stores the plan key from any past `bl auth login --api-key` – when it is
      // already there, skip the secret prompt entirely and reuse it.
      if (blHasPlanKey(readJson(join(homedir(), ".bailian", "config.json")))) {
        console.log("[ok]      alibaba – Token Plan API key already stored in bl config – reusing it");
      } else {
        const key = await askHidden(
          "alibaba – Store your Token Plan API key now? (sk-sp-... from the subscription overview page; hidden, empty to skip): ",
        );
        if (key && safeArg(key)) {
          registerSecret(key);
          const r = await runBl(["auth", "login", "--api-key", key]);
          console.log(
            r.code === 0
              ? "[ok]      alibaba – API key login succeeded"
              : "[failed]  alibaba – API key login failed (bl exited non-zero)",
          );
        } else if (key) {
          console.log(
            "[failed]  alibaba – API key login skipped: key contains characters outside the expected sk-sp key set",
          );
        }
      }
      const site = await askConsoleSite();
      const consoleArgs =
        site === "international"
          ? ["auth", "login", "--console", "--console-site", "international"]
          : ["auth", "login", "--console"];
      const consoleRes = await runBl(consoleArgs, { stdio: "inherit" });
      if (consoleRes.code === 0) {
        console.log("[ok]      alibaba – console login succeeded");
      } else {
        console.log(`[failed]  alibaba – console login failed (exit ${consoleRes.code})`);
        const akId = await askHidden("alibaba – AccessKey ID (hidden, empty to skip fallback): ");
        const akSecret = akId ? await askHidden("alibaba – AccessKey Secret (hidden): ") : "";
        if (akId && akSecret && safeArg(akId) && safeArg(akSecret)) {
          registerSecret(akId);
          registerSecret(akSecret);
          const r = await runBl([
            "auth",
            "login",
            "--open-api",
            "--access-key-id",
            akId,
            "--access-key-secret",
            akSecret,
          ]);
          console.log(
            r.code === 0
              ? "[ok]      alibaba – access-key login succeeded"
              : "[failed]  alibaba – access-key login failed (bl exited non-zero)",
          );
        } else if (akId && akSecret) {
          console.log(
            "[failed]  alibaba – access-key login skipped: value contains characters outside the expected key set",
          );
        }
      }
      // Verify via the raw gateway passthrough (bl usage token-plan drops the
      // monthly fields – formatter bug as of bl 2.0.1).
      const verify = await runBl([
        "console",
        "call",
        "--api",
        "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
        "--data",
        "{}",
        "--output",
        "json",
      ]);
      const verdict = classifyBlVerify(verify.code, verify.stderr, scrub, verify.stdout);
      if (verdict.ok) {
        console.log("[ok]      alibaba – logged in, usage readable");
      } else {
        missing.push(
          "alibaba – log in: `bl auth login --api-key <sk-sp-key>` or `bl auth login --console`, then re-run subtrk init",
        );
        console.log(`[failed]  alibaba – ${verdict.message}`);
      }
    } else {
      missing.push("alibaba – npm i -g bailian-cli, then subtrk init");
      console.log("[missing] alibaba – bl not installed");
    }
  }

  // 4. Google: legacy file lineages, else (win32) agy's keyring target via cmdkey.
  //    Only presence is checked here – the same first-match order the probe uses
  //    decides which source wins. Selected only (constants fetch included).
  if (selected.has("google")) {
    const googleFile =
      existsSync(join(homedir(), ".gemini", "oauth_creds.json")) ||
      existsSync(join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"));
    let googleKeyring = false;
    if (!googleFile && process.platform === "win32") googleKeyring = await hasAgyKeyring();
    if (googleFile || googleKeyring) {
      console.log("[ok]      google – credential found (agy keyring or legacy gemini files)");
    } else {
      missing.push("google – log in once with agy, then re-run subtrk init");
      console.log("[missing] google – no credential found");
      console.log(
        "          install agy: irm https://antigravity.google/cli/install.ps1 | iex – then launch it once to log in",
      );
    }
    // Google token refresh needs the public OAuth client constants; they live in
    // ~/.subtrk/env (not in the repo). The Antigravity pair powers the keyring
    // lineage's self-refresh and the legacy antigravity refresh so it is always
    // written; the gemini pair only matters when a legacy gemini file credential exists.
    const have = {
      id: getSecret("GOOGLE_CLIENT_ID", envPath),
      secret: getSecret("GOOGLE_CLIENT_SECRET", envPath),
      agyId: getSecret("ANTIGRAVITY_CLIENT_ID", envPath),
      agySecret: getSecret("ANTIGRAVITY_CLIENT_SECRET", envPath),
    };
    if ((googleFile && (!have.id || !have.secret)) || !have.agyId || !have.agySecret) {
      const fetched = await fetchGoogleClientConstants();
      if (fetched) {
        updateEnvFile(envPath, fetched);
        console.log("[ok]      google – OAuth client constants fetched from upstream into ~/.subtrk/env");
      } else {
        console.log("[note]    google – could not fetch OAuth client constants");
        console.log(
          "          token refresh needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET in ~/.subtrk/env",
        );
        console.log(
          "          (public values – gemini-cli's packages/core/src/code_assist/oauth2.ts and CLIProxyAPI's internal/auth/antigravity/constants.go)",
        );
      }
    }
  }

  // 5. opencode: key in env/~/.subtrk/env, or auth.json. Selected only.
  if (selected.has("opencode")) {
    const ocKey = getSecret("OPENCODE_API_KEY", envPath);
    if (ocKey || existsSync(join(homedir(), ".local", "share", "opencode", "auth.json"))) {
      console.log("[ok]      opencode – key or auth.json present");
    } else if (await askYesNo("opencode – no key found. Store OPENCODE_API_KEY in ~/.subtrk/env?")) {
      const key = await askHidden("OPENCODE_API_KEY (hidden): ");
      if (key) {
        registerSecret(key);
        updateEnvFile(envPath, { OPENCODE_API_KEY: key });
        console.log("[ok]      opencode – key stored in ~/.subtrk/env");
      } else {
        missing.push("opencode – no key entered (run subtrk init or opencode auth login)");
        console.log("[missing] opencode – no key entered");
      }
    } else {
      missing.push("opencode – run subtrk init or opencode auth login");
      console.log("[missing] opencode – no key or auth.json");
    }
  }

  // 6. OpenRouter: hidden-input prompts, written to ~/.subtrk/env. Selected only.
  if (selected.has("openrouter")) {
    const updates: Record<string, string> = {};
    if (getSecret("OPENROUTER_API_KEY", envPath)) {
      console.log("[ok]      openrouter – OPENROUTER_API_KEY already stored");
    } else {
      const key = await askHidden("OPENROUTER_API_KEY (hidden, empty to skip): ");
      if (key) {
        registerSecret(key);
        updates.OPENROUTER_API_KEY = key;
        console.log("[ok]      openrouter – OPENROUTER_API_KEY stored in ~/.subtrk/env");
      } else {
        missing.push("openrouter – run subtrk init to store OPENROUTER_API_KEY");
        console.log("[missing] openrouter – no key entered");
      }
    }
    if (!getSecret("OPENROUTER_MANAGEMENT_KEY", envPath)) {
      const mgmt = await askHidden("OPENROUTER_MANAGEMENT_KEY (hidden, optional, empty to skip): ");
      if (mgmt) {
        registerSecret(mgmt);
        updates.OPENROUTER_MANAGEMENT_KEY = mgmt;
        console.log("[ok]      openrouter – OPENROUTER_MANAGEMENT_KEY stored in ~/.subtrk/env");
      }
    }
    if (Object.keys(updates).length > 0) updateEnvFile(envPath, updates);
  }

  // 7. OpenAI: check-only – the Codex CLI owns ~/.codex/auth.json, nothing to
  //    collect. Selected only.
  if (selected.has("openai")) {
    const codex = readJson(join(homedir(), ".codex", "auth.json"));
    const auth = codex ? parseOpenaiAuth(codex) : null;
    if (auth?.ok) {
      console.log("[ok]      openai – codex credential found (ChatGPT login)");
    } else {
      missing.push("openai – run `codex login`, then re-run subtrk init");
      console.log(`[missing] openai – ${auth ? auth.error.message : "no Codex credentials at ~/.codex/auth.json"}`);
    }
  }

  // 8. Kimi: check-only for credentials – Kimi Desktop and the Kimi Code CLI own
  //    their files. When the CLI OAuth credential exists, the PUBLIC OAuth client
  //    id is fetched into ~/.subtrk/env (the probe's token refresh needs it).
  //    Selected only.
  if (selected.has("kimi")) {
    const keyPath = desktopKeyPath();
    const desktopKey = keyPath ? parseDesktopKeyFile(readJson(keyPath)) : null;
    const cliCreds = parseKimiCliCredentials(readJson(join(homedir(), ".kimi-code", "credentials", "kimi-code.json")));
    if (desktopKey) {
      console.log("[ok]      kimi – Kimi Desktop key found");
    } else if (cliCreds) {
      const expiry =
        cliCreds.expiresAtSec === undefined
          ? "expiry unknown"
          : `${kimiTokenStale(cliCreds.expiresAtSec, Date.now()) ? "expired" : "expires"} ${new Date(
              cliCreds.expiresAtSec * 1000,
            )
              .toISOString()
              .slice(0, 10)}`;
      console.log(`[ok]      kimi – Kimi Code CLI credential found (${expiry} – subtrk refreshes it on next status)`);
    } else {
      missing.push("kimi – launch Kimi Desktop once or log in with the Kimi Code CLI, then re-run subtrk init");
      console.log("[missing] kimi – no Kimi Desktop key or Kimi Code CLI credential");
    }
    if (cliCreds && !getSecret("KIMI_CLIENT_ID", envPath)) {
      const fetched = await fetchKimiClientId();
      if (fetched) {
        updateEnvFile(envPath, { KIMI_CLIENT_ID: fetched });
        console.log("[ok]      kimi – OAuth client id fetched from upstream into ~/.subtrk/env");
      } else {
        console.log("[note]    kimi – could not fetch the OAuth client id");
        console.log(
          "          token refresh needs KIMI_CLIENT_ID in ~/.subtrk/env (public value – MoonshotAI/kimi-code's packages/oauth/src/constants.ts)",
        );
      }
    }
  }

  console.log(`\n${missing.length === 0 ? "all providers ready" : "still missing:"}`);
  for (const item of missing) console.log(`  - ${item}`);
}
