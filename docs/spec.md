# subtrk – Specification

Version 1.1

`subtrk` is a zero-dependency CLI (TypeScript on Node ≥22.18, executed directly via type
stripping – no build step) that reports remaining quota across the provider plans it tracks,
designed first for AI agents and second for humans. One process per invocation, one
shared cache so concurrent agents never hammer provider endpoints.

## Commands

| Command | Behavior |
|---|---|
| `subtrk` (no args) | Same as `subtrk status` – live data, never a help screen (AXI: content first) |
| `subtrk status` | Probe all enabled providers, render compact text |
| `subtrk status --json` | Full structured output (schema below) |
| `subtrk status --provider <id>` | Restrict to one provider (repeatable) |
| `subtrk status --fields a,b` | Text mode: opt-in extras (`hints`); `windows`/`credits`/`errors` are default segments |
| `subtrk status --fresh` | Bypass cache TTLs once (Claude's 300s floor still applies – warns) |
| `subtrk status --strict` | Exit 3 if any provider failed |
| `subtrk init` | One-time interactive setup (the only interactive command) |
| `subtrk init --agent <harness>` | Non-interactive: write subtrk's instructions into a harness's global agent file (see §`subtrk init`) |
| `subtrk auth refresh` | Re-run one provider's interactive credential refresh (`--provider <id>`, see §`subtrk auth refresh`) |
| `subtrk serve` | Local web console on 127.0.0.1 (see §`subtrk serve`) |

Every subcommand supports `--help`; unknown flags exit 2 (fail loud).

## Output contract

### Text format (default)

```
claude     5h 13% (reset 18:04) · 7d 89% !
glm        5h 4% (reset 19:47) · 7d 61%
alibaba    credits 31,240/45,000 · cycle ends 2026-10-12
google     5h 62% left · 7d 81% left   [stale]
opencode   PAYG · no usage API (signals only)
openrouter $74.75 left · key today $1.20
next: claude 5h at 18:09 (4h 49m)
help: subtrk status --json | subtrk status --provider <id> | subtrk init
```

- One line per provider, always – including failures:
  `google     error: no-credentials – no Google/Antigravity credential found (log in once with agy)`.
  On a bare error line the `hint` is appended in parentheses, so the line is always
  actionable on its own; with other segments present, hints render via `--fields hints`.
- `!` marks a window ≥95% used; `[stale]` marks cached-past-TTL or error-fallback data.
- The `help:` line is contextual disclosure (AXI): parameterized next-step templates.
- Line-oriented; composes with `grep` / `head`.

### JSON schema (`--json`)

```jsonc
{
  "schemaVersion": 1,
  "checkedAt": "2026-09-23T10:15:00Z",          // ISO-8601 UTC, always Z
  "recheckAfter": "2026-09-23T10:16:00Z",       // heartbeat: now + clamp(min TTL of ok providers, 60s, 300s)
  "providers": [ ProviderResult ],              // one per enabled provider, always present
  "nextEvent": {                                 // null when no ok provider has windows
    "providerId": "claude",
    "type": "window-reset",
    "at": "2026-09-23T18:09:00Z",               // max(resetsAt, fetchedAt + ttlMs), clamped >= now+1s
    "atMs": 1789501740000                        // epoch-ms duplicate for schedulers
  }
}
```

`nextEvent.at` means **the earliest time new information can exist** (a reset we can
actually observe, given the cache), not the raw reset instant. Schedulers wake there.

### ProviderResult

```ts
type ProviderId = "claude" | "glm" | "alibaba" | "google" | "opencode" | "openrouter" | "openai" | "kimi";

type ErrorKind =
  | "no-credentials"      // credential file/env/key absent
  | "expired-token"       // token present but past expiry (with 60s clock skew)
  | "tool-missing"        // external CLI absent (bl)
  | "rate-limited"        // 429; carries retryAfterMs
  | "forbidden"           // plan-shape signal (e.g. Zen PAYG 403 EntitlementError)
  | "not-readable-remotely" // google degrade: 403/free-tier-shaped response
  | "parse-failure"       // endpoint reachable, shape unrecognized
  | "subprocess-failed"   // bl exited non-zero
  | "timeout"             // per-provider 10s budget exceeded
  | "http-error";         // other non-2xx (carries status)

interface ProviderError {
  kind: ErrorKind;
  message: string;        // one line, redacted
  hint?: string;          // next step, e.g. "run subtrk init"
  remedy?: string;        // exact CLI line an agent/operator can run (fixed literal, no prose)
  retryAfterMs?: number;  // rate-limited only
  status?: number;        // http-error only
}

interface Window {
  kind: string;                 // "5h" | "7d" | provider-specific
  scope?: string;               // grouping, e.g. "gemini-models"
  usedPercent?: number;         // 0–100 when natively percent-based
  remainingFraction?: number;   // 0–1 when natively fraction-based
  resetsAt: string;             // ISO-8601 UTC
}

interface Credits {
  total?: number;
  remaining: number;
  unit: "credits" | "usd";
  cycleEndsAt?: string;
  source: "api" | "derived";
}

interface ProviderResult {
  id: ProviderId;
  ok: boolean;                  // true iff a probe produced fresh data; error-fallback keeps ok:false
  stale: boolean;               // served past TTL or via error-fallback
  fetchedAt: string;            // ISO
  plan?: string;                // "Claude Pro", "GLM Legacy 2 Max", …
  windows?: Window[];           // on error-fallback these are the cached values
  credits?: Credits;            // ditto
  note?: string;                // e.g. opencode's constant PAYG note
  refreshable?: true;           // module supports interactive refresh (additive, schemaVersion stays 1)
  error?: ProviderError;        // present iff ok === false
}
```

Agent rule: **branch on `error.kind`, never on `message` text.** When an error
carries `remedy`, that line is the fix – run it as-is. When a failed provider
carries `refreshable: true`, an agent can re-authorise it without a human
editor: `subtrk auth refresh --provider <id>` (or `POST /api/refresh` on a
running console).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Ran; per-provider errors live in the output |
| 1 | CLI/runtime failure – config unreadable, or zero providers resolvable |
| 2 | Usage error (unknown flag, bad `--provider`) |
| 3 | `--strict` and at least one provider failed |

Streams: machine-readable output and structured errors → stdout. Debug/warnings → stderr.

## Cache

File `~/.subtrk/cache.json` (via `os.homedir()` – never manual `~` expansion):

```jsonc
{ "schemaVersion": 1,
  "claude": { "data": <ProviderResult>, "fetchedAt": 1789500000, "ttlMs": 300000 } }
```

- **Reads:** fresh (age < ttl) → serve. Expired < 2×ttl and the refresh lock is held by
  another live process → serve with `stale: true` (stale-while-revalidate). Otherwise probe.
- **Lock:** existence-only file `cache.json.lock` containing `{pid, startedAt}`, created
  with exclusive create, fd closed immediately (existence is the lock), released in
  `finally`. **No stealing.** GC by any process when `process.kill(pid, 0)` says the
  holder is dead or age > 60s; ignore EPERM/ENOENT during GC. Contenders that cannot
  serve stale wait ~750ms, re-check the cache once, then probe anyway – worst case is
  one bounded duplicate probe per fan-out, never endpoint abuse.
- **Writes:** temp file + rename, up to 4 retries with 25–100ms backoff, then **silent
  give-up** – on Windows, rename over an open reader fails with EPERM (even
  between Node processes). A lost write costs one future re-probe; it is never
  an error.
- **Stale-on-error:** a failed probe serves cached data < 24h old with `stale: true`
  **and** the structured error alongside.
- **Hygiene:** corrupt JSON → treat as miss and delete. `schemaVersion` mismatch →
  discard the file. The cache stores normalized quota data only – **never secrets**.

Default TTLs (the policy – no user knobs in v0):

| Provider | TTL | Rationale |
|---|---|---|
| claude | 300 000 | hard floor: usage endpoint has UA-keyed 429 buckets |
| glm | 60 000 | generous monitor route |
| google | 60 000 | be politer than gemini-cli's own 30s |
| alibaba | 300 000 | bl subprocess is slow; don't spam |
| openrouter | 60 000 | official API, cheap |
| openai | 60 000 | vendor's own client endpoint, cheap |
| kimi | 300 000 | vendor client endpoints, cheap |
| opencode | 0 | local presence check only – bypasses cache entirely |

## Configuration & secrets

- `~/.subtrk/config.json` – `{ "enabled": ["claude", "glm", …], "order": ["kimi",
  "claude", …] }`. `enabled` gates which providers are tracked (absent ⇒ all
  enabled); `order` is the optional display order – listed ids come first in
  their given order (unknown ids and duplicates dropped on read), unlisted ids
  keep registry order after them. Both keys are written by `subtrk init` and by
  the web console (`POST /api/config`) through one shared `saveConfig`: a
  read-modify-write that preserves unknown pre-existing keys and lands
  atomically (temp file + rename). That is the entire config in v0 (no knobs).
- `~/.subtrk/env` – dotenv format (`KEY=VALUE`, `#` comments), parsed by a ~20-line
  reader. Holds subtrk's own keys: `OPENROUTER_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`,
  optionally `OPENCODE_API_KEY`. Real process env wins over the file. Written by
  `subtrk init` (hidden-input prompts), never logged, never echoed. Created mode
  `0600` on POSIX; on Windows the profile's default ACLs apply.

**security:** plaintext API keys in `~/.subtrk/env` – any process running as this user can
read them; accepted because it is the same trust envelope as every vendor credential
file we already read (`~/.claude/.credentials.json`, `~/.zcode/cli/config.json`, …)
and the profile's per-user ACL is the boundary. Escalation path if ever needed: OS
secret store.

**security:** subtrk concentrates read access to every tracked vendor's live tokens in one binary –
the mechanical redaction layer and the secret-free cache are load-bearing, not
nice-to-have. Both have tests.

### Redaction (mechanical)

After credentials load, every rendered string – including `--json` output – is
scrubbed by replacing each loaded secret value with `***`. Config/credential objects
are never stringified wholesale. No secret ever appears in a URL query, a subprocess
argument, or a log line. `test/redaction.test.ts` asserts a fixture secret cannot
appear in any output mode.

## Provider integrations

All providers implement:

```ts
interface ProviderModule {
  id: ProviderId;
  ttlMs: number;
  probe(): Promise<ProviderResult>; // NEVER throws – errors become ProviderResult.error
  refresh?(): Promise<{ ok: boolean; message: string }>; // interactive re-auth;
  // runs the provider's own login flow, resolves with a fixed-literal message –
  // subprocess stdout/stderr are never captured into the result
}
```

Probes run under `Promise.allSettled` with a 10s per-provider timeout (AbortController
where fetch is used).

### claude – Claude Pro (personal)

- Credential: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`, `expiresAt`
  (ms), `refreshToken`, `refreshTokenExpiresAt`. Past expiry (60s skew) with a live
  refresh token → **subtrk self-refreshes** via `POST
  https://console.anthropic.com/v1/oauth/token` `{grant_type:"refresh_token",
  refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}` (Claude Code's
  public client), then best-effort atomic write-back of the merged credential
  (refresh rotates the refresh token – the new one must be persisted or the file
  goes stale; in-memory use continues even if write-back fails). Refresh failure →
  `expired-token`, hint `start Claude Code once so it refreshes the token, or run
  claude /login`.
- `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`, `User-Agent: claude-code/2.1.11`
  (non-claude-code UAs land in persistent 429 buckets).
- Parse: `five_hour.utilization` (whole percent 0–100) + `five_hour.resets_at` (ISO);
  same for `seven_day`. → windows `[{kind:"5h",usedPercent},{kind:"7d",usedPercent}]`.
- 429 → `rate-limited`. JSON without those keys → `parse-failure`.

### glm – GLM Coding Plan (Legacy 2 Max)

- Credential: `~/.zcode/cli/config.json` → `provider.zai.apiKey`; fallback env
  `ANTHROPIC_AUTH_TOKEN`. Host from `provider.zai.options.baseURL` (scheme+host only),
  default `https://api.z.ai`.
- `GET {host}/api/monitor/usage/quota/limit` with `Authorization: <key>` – **raw
  token, no Bearer prefix**.
- Parse `data.limits[]`: `TOKENS_LIMIT` entries where `unit` 3 = hours (window length
  `number`×hours, i.e. the 5h window) and `unit` 6 = weeks (weekly window).
  `percentage` = used %, `nextResetTime` = Unix **ms** → `resetsAt`. `data.level`
  → plan label. `TIME_LIMIT` entries are built-in-tool quota – ignored in v0.
- Empty state: a 200 body with no `data.limits` (data missing/null or no limits
  array) is the **post-reset idle window**, not an error – limits appear after the
  first query. Probe reports ok with `windows: []` and note "no usage reported yet
  in the current window – appears after the first GLM query". Only a body that is
  not a JSON object at all stays a `parse-failure`.
- 401 → `no-credentials` (hint `check ZCode login`).

### alibaba – Model Studio Token Plan (international, credits)

Terminology per official docs: **Token Plan** is the Credits-based subscription
(个人/Personal or Team; "Subscription Plan" is not a distinct product – Token Plan
is simply where the console's *My Subscriptions* section lives). International
personal plans are **monthly-only** since 2026-09-22 (weekly removed); the plan's
inference endpoint (`token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`)
has no usage surface of its own.

- `bl usage token-plan` is **unusable as of bl 2.0.1** – its formatter drops the
  monthly fields (`per1Month*`) and prints `{}`. We use bl's raw passthrough
  instead, with fixed literal commands (Windows `.cmd` shim through the shell,
  never interpolated): `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/{usage|subscription|quota-config} --data "{}" --output json`.
  ENOENT/9009/"not recognized" → `tool-missing`; "No console access token" /
  "session … expired" → `no-credentials`.
- Envelope: bl double-nests the zelda payload
  (`data.DataV2.data.{msg,code,data:{…}}`) – `dataOf()` unwraps both that and the
  bare zelda shape. JSON extraction is first-`{`-to-last-`}` of stdout.
- `v2/usage` → window `30d`: `per1MonthPercentage` is a **ratio** of monthly
  credits (×100 for percent), `per1MonthResetTime` is epoch ms. Legacy
  `per5Hour*`/`per1Week*` percent families still parse when present. Known gateway
  flakiness (200-Success with empty data) → retry up to 2 extra attempts.
- `v2/subscription` → `specCode` ("standard"), `remainingDays`, `status`;
  `v2/quota-config` → per-spec monthly totals (standard = 45,000).
- Credits are **derived**: `remaining = total − usedPercent/100 × total`,
  `cycleEndsAt = per1MonthResetTime`, `source: "derived"`. Secondary-call failures
  degrade to fewer fields (windows without credits), never a provider error.
- Auth (see D2): `bl auth login --api-key sk-sp-…` once – it prevents the console
  flow from auto-creating a pay-as-you-go key, and the stored plan key persists.
  Then `bl auth login --console --console-site international` (browser). The
  console leg is **not** one-time: sessions are short-lived server-side (measured
  at roughly five hours; bl stores a bare access token with no refresh material)
  and bl has no auto-refresh – when subtrk reports `no-credentials` for alibaba
  (that error carries `remedy: subtrk auth refresh --provider alibaba`),
  re-run only the console step: `subtrk auth refresh --provider alibaba` (the
  fixed-literal `bl auth login --console --console-site international`, 300s
  budget) or the same step inside `subtrk init`.

### google – Google AI Pro (via the Antigravity desktop app and agy)

Google sunset consumer Gemini CLI service on 2026-06-18; consumer accounts
authenticate through the closed-source `agy` binary, which holds an Antigravity
OAuth login. Google keeps separate quota domains per surface (the Gemini app
web dashboard, Antigravity agent usage, the Code Assist REST view), so the
probe reads two sources in order:

1. **Local language server (primary, win32)** – the Antigravity desktop app's
   `language_server.exe` serves the same `RetrieveUserQuotaSummary` payload its
   Model Quota panel renders: the authoritative numbers. Discovery is a
   fixed-literal PowerShell script (argument-vector spawn, ~4s budget) reading
   the process command line (`--app_data_dir antigravity`, `--csrf_token`) and
   its 127.0.0.1 listeners via `Get-NetTCPConnection`; the RPC is a loopback
   Connect call over plain HTTP (`X-Codeium-Csrf-Token` header, body `{}`) and
   needs no OAuth material. The process serves plain HTTP on one listener and
   TLS on the other; the probe tries each discovered listener over plain HTTP
   (loopback + CSRF token are the local boundary – no certificate handling).
   Response `groups[].displayName` → scope (e.g. `gemini-models`,
   `claude-and-gpt-models`), `buckets[].{window, remainingFraction, resetTime}`
   → windows; `disabled: true` buckets (e.g. the 5h bucket while the weekly
   limit is hit) are skipped.
2. **Remote REST fallback (any platform, any running state)** – credential
   discovery, first match wins:

   a. Windows Credential Manager target `gemini:antigravity` (agy's OAuth blob):
      a fixed-literal PowerShell `CredReadW` P/Invoke snippet (spawned via
      `execFile`, ~5s budget, win32 only) returns a plaintext JSON blob
      `{token:{access_token, refresh_token, expiry}, auth_method, id_token}`.
   b. `~/.gemini/oauth_creds.json` (legacy gemini).
   c. `~/.gemini/antigravity-cli/antigravity-oauth-token` (legacy antigravity).

The `implicit/*.pb` files are encrypted trajectory data – never read.

- Quota call (fallback, verified against agy 1.2.11): `POST
  https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` with
  `Authorization: Bearer <token>`, `User-Agent: antigravity`, body **`{}`** – no
  `ideType`, no project, no `loadCodeAssist` (that recipe belongs to the legacy
  `retrieveUserQuota` endpoint). Same response parsing as the local source.
  Live-verified 2026-09-28: this REST view answers from the Code Assist quota
  domain with synthetic resets (fetch time +5h/+7d to the second) that do not
  reflect Antigravity usage, so ok results carry a note that the numbers may
  not match the Antigravity dashboard. On 403/404, one retry against
  `daily-cloudcode-pa.googleapis.com`, then `not-readable-remotely`, hint
  `run agy /usage`.
- Self-refresh (keyring lineage): a missing access token or an expiry inside a
  5-minute safety window **mints instead of failing**: `POST
  https://oauth2.googleapis.com/token`
  `{grant_type:"refresh_token", refresh_token, client_id, client_secret}` with the
  PUBLIC Antigravity client constants (`ANTIGRAVITY_CLIENT_ID`,
  `ANTIGRAVITY_CLIENT_SECRET`) from `~/.subtrk/env`, fetched by `subtrk init` from
  a public reference implementation – CLIProxyAPI's MIT source is merely where the
  constants are published (constants sourcing only; no CLIProxyAPI install, file
  or process is used). Google's refresh tokens are **non-rotating** (verified
  2026-09-25): the minted token lives in a local variable for the quota call only
  and **nothing is ever written back** to the keyring – read-only refresh, `agy`
  does not need to be running. Missing constants → `no-credentials`
  (remedy `subtrk init`); grant answered 400/401/`invalid_grant` → `expired-token`,
  remedy `re-login inside agy`.
- On quota 401: re-read the credential once (agy refreshes its store in place
  while running) and retry; still 401 → `expired-token`, remedy
  `re-login inside agy`.
- Legacy file lineages keep their own refresh when expired (60s skew): gemini
  writes back to the same file using the gemini client constants
  (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`); antigravity refreshes without
  write-back. Missing constants → `no-credentials` with the init hint.
- Text mode prefixes each window with its scope when a provider has more than one
  scope (google does: two model families).

### opencode – Zen pay-as-you-go (signals only)

No usage or balance API exists for PAYG (decided D1). Presence check only: key from
`~/.subtrk/env`/env `OPENCODE_API_KEY`, else `~/.local/share/opencode/auth.json`
(`opencode.key`). Result: `ok: true` with constant note
`"PAYG – no usage/balance API; inference errors are the only signal"` (401
CreditsError = out of credits, 429 metadata = window limits, surface during
inference). Absent everywhere → `no-credentials`, hint `run subtrk init or opencode auth login`.
`ttlMs: 0` – bypasses the cache.

### openrouter – pay-as-you-go

- `GET https://openrouter.ai/api/v1/key` (Bearer `OPENROUTER_API_KEY`) →
  `data.usage_daily` (USD) surfaced as `note`/key line.
- If `OPENROUTER_MANAGEMENT_KEY` present: `GET /api/v1/credits` →
  `credits {remaining: total_credits − total_usage, unit:"usd", source:"api"}`.
  **Never** attempt /credits with the inference key (guaranteed 403).
- Missing key → `no-credentials`, hint `run subtrk init`.

### openai – ChatGPT plan via the Codex CLI

- Credential: `~/.codex/auth.json`, read-only, never written. Used only when
  `auth_mode` is `"chatgpt"` with a non-empty string `tokens.access_token`.
  Account id: `tokens.account_id`, else `chatgpt_account_id` decoded from the
  `id_token` JWT payload (base64url middle segment). A file with no tokens but
  an `OPENAI_API_KEY` → `no-credentials` ("auth.json holds an API key, not a
  ChatGPT login", hint `run codex login (plan usage needs a ChatGPT account)`);
  no file / unparseable → `no-credentials` ("no Codex credentials at
  ~/.codex/auth.json", hint `run codex login`).
- `GET https://chatgpt.com/backend-api/wham/usage` – the endpoint the vendor's
  own open-source Codex client uses (contract-tested in its Apache-2.0 source;
  not a documented public API) – with headers `Authorization: Bearer
  <access_token>`, `ChatGPT-Account-Id: <account_id>`, `User-Agent: codex-cli`.
- Parse: `rate_limit.primary_window` plus optional `secondary_window` (null →
  skipped, like claude's inactive windows) → windows. `used_percent` is a used
  % (claude/glm convention); `limit_window_seconds` names the kind (18000 →
  `5h`, 604800 → `7d`, 2592000 → `30d`, then whole days/hours, else a rounded
  hour estimate) – the payload is self-describing: free = one monthly window,
  paid = 5h + weekly. `reset_at` is epoch **seconds** → ISO (fallback
  `now + reset_after_seconds`); neither → parse-failure. `plan_type` → plan
  label `ChatGPT <plan_type>`. Strict, claude-style: a missing/absent primary
  window (or missing `rate_limit`, or non-object body) is a parse-failure,
  never an empty state – every observed response carries a primary window.
  credits, spend_control, promo, additional_rate_limits and
  code_review_rate_limit are not surfaced in v1.
- 401: codex owns its login (access tokens live ~10 days; codex refreshes them
  itself while it runs), so subtrk never refreshes – on 401 the credential file
  is re-read once and the call retried with a changed token; still 401 →
  `expired-token`, hint `launch codex once so it refreshes its login, or run
  codex login`. No `refresh()` on the module (rotation behavior deliberately
  untested) – openai is not refreshable.

### kimi – Kimi coding plans (Kimi Desktop / Kimi Code CLI)

Credential discovery, first match wins:

1. The Kimi Desktop app's scoped API key:
   `%APPDATA%\kimi-desktop\daimon-share\daimon\kimi-code-key.json` →
   `keys[0].apiKey` (`sk-kimi-…`). Windows only – the path is the Desktop app's
   own, resolved via `process.env.APPDATA`; elsewhere this source does not apply.
2. The Kimi Code CLI's OAuth login: `~/.kimi-code/credentials/kimi-code.json`
   (`access_token`, `refresh_token`, `expires_at` unix **seconds**; access
   tokens live 15 minutes).

Neither file → `no-credentials`, hint naming both paths.

- Desktop key: `GET https://agent-gw.kimi.com/coding/v1/usages` → plan label
  from `user.membership.level` (`LEVEL_` prefix stripped, title-cased –
  "Kimi Free"; unknown levels keep their title-cased raw text) and one window
  from `totalQuota`: the wire carries `limit`/`remaining` as STRINGS, used % =
  (limit − remaining)/limit clamped 0–100 (limit ≤ 0 or unparseable → no
  window), `resetTime` (RFC3339) names both the window kind (via the shared
  seconds mapping, §openai) and `resetsAt`. Unusable quota numbers or resetTime
  degrade to the empty state: ok with no window and note "no quota data
  reported yet" – the shape and plan label still parse.
- CLI OAuth: a stale access token is refreshed via `POST
  https://auth.kimi.com/api/oauth/token` with form body
  `grant_type=refresh_token&client_id=$KIMI_CLIENT_ID&refresh_token=…`; a
  400/401 `invalid_grant` retries ONCE against
  `https://auth.kimi.ai/api/oauth/token`. Success rewrites the FULL bundle back
  to the file (temp + rename, untouched fields preserved, the old refresh token
  kept when the response carries none) – best effort: the probe keeps using the
  fresh token even when the write fails. `KIMI_CLIENT_ID` is a PUBLIC vendor
  constant (MoonshotAI/kimi-code's `packages/oauth/src/constants.ts`) kept in
  `~/.subtrk/env`, fetched by `subtrk init` – no literal lives in this repo;
  missing at probe time → `no-credentials` (remedy `subtrk init`). A grant that
  dies on both hosts → `expired-token`, hint `launch the Kimi Code CLI (or Kimi
  Desktop) once to re-login` – subtrk never runs an interactive login, so kimi
  has no `refresh()`.
- Usage read (CLI OAuth): `GET https://api.kimi.com/coding/v1/usages` →
  `usages.limit_5h` / `limit_7d` / `limit_month_total` / `limit_month_code`
  with `used_ratio` (0–1, ×100) and optional `reset_time` → windows `5h`, `7d`,
  `30d` and `30d` scoped `code`; absent fields are skipped (the shape is
  degradable by design), present-but-malformed ones fail the parse;
  `boosterWallet` exists but is not surfaced in v1. The simple
  `{"usage":{limit, remaining, resetTime}}` shape (API-key auth on this host)
  parses through the same function.
- Headers: `Authorization: Bearer <key-or-access-token>`, honest
  `User-Agent: subtrk` – vendor client UAs are never spoofed. Errors map like
  openai's (429 → `rate-limited` with retryAfterMs, other non-2xx →
  `http-error`, 10s AbortController timeout); 401/403 on the API-key path fall
  through to the CLI OAuth source once before erroring.

## `subtrk init` (one-time interactive setup)

First, init asks which providers to track: a numbered listing of all eight,
answered with numbers and/or ids (`1 3 5`, `claude, google`); empty input keeps
the current selection, invalid input re-prompts (bounded), and non-TTY stdin
skips the question. The answer is stored as `~/.subtrk/config.json`
`{ "enabled": [...] }` via the shared `saveConfig` (any saved `order` and
unknown keys survive) – the same gate `subtrk status` applies – and the checks
below only cover selected providers; edit the file, use the console's provider
menu, or re-run init to change it, deleting it restores all.

Checks, in order, printing a checklist with pass/fail per provider:
1. Claude: `~/.claude/.credentials.json` readable + unexpired → else instruct `claude /login`.
2. GLM: ZCode config key present → else instruct ZCode login.
3. Alibaba (bl 2.0.1 flow): install offer if missing → when bl's own config
   (`~/.bailian/config.json`) already stores `token-plan.api_key`, that key is
   reused and the prompt is skipped; otherwise a hidden prompt for the Token
   Plan API key (`sk-sp-…`, passed as a single argv element via execFile) →
   `bl auth login --api-key <key>` → console-site question (default international)
   → `bl auth login --console [--console-site international]` interactively
   (browser, stdio inherit, no timeout) → on non-zero exit, hidden AK/SK fallback →
   `bl auth login --open-api --access-key-id … --access-key-secret …` → verify with
   `bl usage token-plan --output json`; `[ok]` only when verification passes,
   `[failed]` with a scrubbed stderr line otherwise. Key order matters: the API key
   first prevents the console flow from auto-creating an ordinary pay-as-you-go key.
4. Google: credential found (a legacy `~/.gemini` file, or – win32 – the
   Credential Manager target `gemini:antigravity`, checked via a literal
   `cmdkey /list:gemini:antigravity` probe) → `[ok]`; else print the agy login
   one-liner (`irm https://antigravity.google/cli/install.ps1 | iex`, then launch
   once). The PUBLIC OAuth client constants are fetched from a public reference
   implementation (CLIProxyAPI's MIT source – constants sourcing only; no
   CLIProxyAPI install, file or process is used) whenever the Antigravity pair is
   missing (the keyring lineage self-refreshes with it) or a legacy file
   credential exists without the gemini pair – all four into `~/.subtrk/env`.
5. opencode: `auth.json` or key present → else offer to store one in `~/.subtrk/env`.
6. OpenRouter: hidden-input prompts for `OPENROUTER_API_KEY` and optional
   `OPENROUTER_MANAGEMENT_KEY`, written to `~/.subtrk/env` (created if absent).
7. OpenAI: check-only, nothing to collect – `~/.codex/auth.json` parses as a
   ChatGPT login → `[ok]`; else `[missing]` with the honest message (API-key
   mode included) and `codex login` as the fix.
8. Kimi: check-only for credentials – the Kimi Desktop key file or the Kimi
   Code CLI credential (reported with its expiry status) → `[ok]`; else
   `[missing]` with both paths. When the CLI credential exists and
   `KIMI_CLIENT_ID` is not yet stored, the PUBLIC OAuth client id is fetched
   from MoonshotAI/kimi-code's published source into `~/.subtrk/env` (the
   probe's token refresh needs it).

`subtrk init` never sends a secret anywhere except the owning provider's endpoint, and
never writes secrets anywhere except `~/.subtrk/env` and vendor-owned files.

### `--agent <harness>` – install agent instructions

With `--agent`, init runs no provider selection and no checks: it writes
subtrk's instruction section into the harness's GLOBAL agent instructions
file, prints `<harness> – created|updated <file>`, and exits. Targets (global
paths derived from `os.homedir()`, never manual `~` expansion; verified
2026-09-26 against each harness's official docs/source):

| Harness | Global file |
|---|---|
| `claude` | `~/.claude/CLAUDE.md` (Claude Code global memory) |
| `zcode` | `~/.zcode/AGENTS.md` |
| `codex` | `~/.codex/AGENTS.md` |
| `opencode` | `~/.config/opencode/AGENTS.md` (this exact path on Windows too) |
| `agy` | `~/.gemini/AGENTS.md` (Antigravity global rules; `~/.gemini` by convention) |

The section is delimited by `<!-- subtrk:begin -->` / `<!-- subtrk:end -->`
sentinels (conda-init convention). Upsert rules: a file without markers gets
the section appended with one blank line before; with markers, only the block
between the first begin/end pair is replaced – everything outside is preserved;
an unterminated begin marker (no end) is treated as replace-from-marker-to-EOF.
Re-running is therefore idempotent, and removal is a clean delete of the block
between the markers. Writes go through a temp file + rename in the target
directory (two attempts); a failed write is reported, never silently dropped –
the file belongs to the user.

Exit codes: 0 written · 2 unknown or missing harness name – stderr then lists
every supported harness with its file and whether the section is present right
now, followed by
`usage: subtrk init --agent <claude|zcode|codex|opencode|agy>`.

## `subtrk auth refresh` – interactive re-auth for one provider

Providers whose module has `refresh` (today: claude, alibaba, google) can be
re-authorised without re-running `subtrk init`. `subtrk init` remains the only
other interactive command; this one re-runs the provider's own login flow:

- claude: a probe – the OAuth self-refresh path already rotates the token pair
  and writes it back.
- alibaba: the fixed-literal console re-login `bl auth login --console
  --console-site international` (Windows `.cmd` shim through the shell; 300s
  budget – bl blocks on the browser callback and has its own idle timeout).
- google: a probe – the self-refresh path mints a fresh access token from the
  stored non-rotating refresh token (read-only, no write-back to the keyring).

Contract:

- `subtrk auth refresh --provider <id>` exits 0 on success; the provider's
  cache entry is dropped so the next `subtrk status` re-probes.
- Exit 1 when the refresh reports failure (fixed-literal message on stdout) or
  the provider has no interactive refresh – the line names the error's
  `remedy`, or `re-run subtrk init`.
- Exit 2 on usage errors: a missing `--provider` prints every provider id with
  whether interactive refresh is supported plus the usage line (stderr); an
  unknown id prints `unknown provider '<id>'`.

Subprocess output is never captured or printed – the result message is always
a fixed literal, and a printed line can never contain a token.

## AXI conformance summary

Token-efficient default output (compact lines; TOON serializer deferred – payload is
~200 tokens, the serializer would cost more than it saves) · minimal default schema
with `--fields` · pre-computed aggregates (`nextEvent`, `recheckAfter`, per-window
percent) · definitive empty states (every enabled provider always emits a state) · structured
errors + exit codes, agent commands never prompt · content-first (bare `subtrk` = status)
· contextual `help:` line · consistent `--help` · secrets redacted by default ·
`--confirm` gating reserved for any future state-changing operation (e.g. grant
redemption, if ever un-parked) · interactive re-auth (`subtrk auth refresh` /
`POST /api/refresh`) and the console's config writes (`POST /api/config`) are
the two deliberate state-changing exceptions – D9.

## `subtrk serve` – local web console

One page for every enabled provider, served from the same cache the CLI reads.

- Binds **127.0.0.1 only**, on a random port (`--port N` to pin one). Startup
  prints a single URL: `http://127.0.0.1:<port>/#<token>` – the token is a
  fresh 32-byte random value per run, carried in the URL **fragment** so it
  never reaches server logs or `Referer`. The browser is not auto-opened (the
  URL contains the token, and tokens never go into argv).
- `GET /` → the static shell (`src/console.html`), served without auth (it
  contains no data) with `Content-Security-Policy: default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'
  data:; connect-src 'self'`. The shell reads the token from the fragment and
  sends it as `Authorization: Bearer <token>` on every API call; on 401 it
  tells the user to restart `subtrk serve` and open the fresh URL.
- `GET /api/status` → the identical scrubbed StatusOutput JSON that
  `subtrk status --json` prints, refreshed through the same cache (TTLs
  honored). The Bearer compare is timing-safe; missing/wrong token → 401.
- `POST /api/refresh?provider=<id>` → re-authorises one provider, behind the
  same Bearer token as `/api/status` (401 on failure). The id must belong to a
  refresh-capable provider (400 `unknown or non-refreshable provider`
  otherwise). Single-flight per provider: while one refresh for an id is in
  flight, another request for the same id gets 409 `refresh already running`;
  other providers are unaffected. A completed refresh always answers 200 –
  the body carries `{"ok": boolean, "message": string}` and `ok:false` means
  the action ran and reported failure (the endpoint itself worked; the HTTP
  status never encodes the action's outcome). `message` is a fixed literal –
  subprocess output is never forwarded to the client. On success the
  provider's cache entry is dropped so the next `/api/status` re-probes.
  Non-POST → 405 with `allow: POST`. No request body – the provider id comes
  from the query string only.
- `POST /api/config` → persists the console's provider selection and card order
  to `config.json` via `saveConfig` (atomic temp+rename; unknown pre-existing
  keys are preserved), behind the same Bearer token as `/api/status` (401 on
  failure). The body is a JSON object carrying at least one of the two keys
  (a body with neither → 400, so a typo'd key cannot silently no-op):
  `enabled` must be a non-empty array of known provider ids (unknown or empty
  → 400); `order` must be an array of known ids (unknown → 400, duplicates
  dropped, currently-disabled ids allowed). Unknown extra body keys are
  ignored; a body over the 10KB cap, or one that is not valid JSON / not a
  plain object, → 400. Success answers 200 `{"ok": true}` – fixed literals
  only, the file itself is never echoed (read it back through `/api/status`).
  Non-POST → 405 with `allow: POST`.
- Hardening: the Host header must be `127.0.0.1[:port]` or
  `localhost[:port]` (403 otherwise – DNS-rebinding defense); no CORS headers
  are ever emitted, so cross-site pages can neither read responses nor pass
  the preflight a custom header requires; `/` and `/api/status` stay
  GET-only, `/api/refresh` and `/api/config` stay POST-only (405 otherwise);
  handlers never throw. Ctrl-C shuts down cleanly.
- The dashboard: per-provider cards (usage bars per window with ≥80%/≥95%
  warning levels, credits with a used-percentage bar, staleness, error kinds
  with hints and remedies – providers marked `refreshable` get a Refresh now
  button that calls `POST /api/refresh`), a 7-day reset timeline, an
  upcoming-resets table, an agent-view terminal panel, and auto-refresh at
  `recheckAfter`. A plus-icon menu in the header toggles providers on/off (the
  last enabled provider locks) and each card carries a drag handle for
  reordering – both persist through `/api/config` and survive restarts, and the
  saved `order` also governs `subtrk status` output order.

## Not in v0 (parked)

cedar_ember reset grants (read+redeem API exists; un-park when wanted) ·
TOON serializer · statusline/agent-skill ambient context (post-M2) ·
TTL/threshold config knobs.
