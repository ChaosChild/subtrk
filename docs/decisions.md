# subtrk – Design Decisions

Rationale for the choices that shape the tool. Provider facts referenced here
were verified against vendor source code or live endpoints.

## D1 · OpenCode Zen PAYG – no balance tracking

No balance or usage API exists for Zen pay-as-you-go: PAYG keys receive
`403 EntitlementError` on the usage endpoint, and the dollar balance is served
only to the web console session (verified against sst/opencode source). subtrk
reports a constant signals-only note; the real signals (401 `CreditsError`,
429 window metadata) surface during inference. Revisit if Zen ships an API.

## D2 · Alibaba – official `bl` CLI with console login, raw gateway reads

`bl usage token-plan` and the harness-quota commands need a **console access
token**, resolved strictly from `~/.bailian/config.json`.

Setup order matters:

```bash
bl auth login --api-key sk-sp-<plan key>   # first – prevents the console flow
                                           # from auto-creating a pay-as-you-go key
bl auth login --console [--console-site international]   # browser login
```

`--open-api` (Aliyun AK/SK, least-privilege RAM sub-account) is the fallback if
the console page rejects the account. Console sessions have no auto-refresh:
bl stores a bare access token (no refresh material) and sessions expire
server-side within hours (measured ~5h) – when that happens, re-run only the
console step; the stored plan key persists.

Quota reads go through bl's raw passthrough
(`bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/…`)
because `bl usage token-plan` drops the monthly fields (formatter bug in
bl 2.0.1 – international plans are monthly-only) and `harness-quota` returns
empty for personal plans. DashScope API keys cannot read usage at all. The
sk-sp- inference endpoint (`token-plan.*.maas.aliyuncs.com`) has no quota
surface. Direct AK-signed OpenAPI calls are the future upgrade if the `bl`
dependency is ever dropped.

## D3 · CLI name – `subtrk`

`subtrk status [--json] [--provider X]`, and bare `subtrk` = status (AXI
content-first). Short, because agents type it often.

## D4 · Claude polling – hard 300s floor, claude-code UA, shared cache

The usage endpoint (`api.anthropic.com/api/oauth/usage`) sorts clients into
User-Agent-keyed rate-limit buckets; non-claude-code UAs get persistent 429s.
Poll at most every 5 minutes, always through the one shared cache. Headers on
every request: `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`,
`anthropic-version: 2023-06-01`, `User-Agent: claude-code/<version>`.

## D5 · TypeScript on Node ≥22.18, zero dependencies

Node ≥22.18 executes erasable-syntax TypeScript directly – no build step, no
tsc, no dependencies: builtin `fetch`, `node:util parseArgs`, `node:fs`,
`node:child_process`, `node:http` (dashboard), `node:test`. Provider parsers
are the churn surface, and TS iterates fastest there. Go and Rust were
considered and declined: new toolchain, no shared ecosystem with the Node CLIs
around the tool, slower iteration.

## D6 · Keys in `~/.subtrk/env`, written by `subtrk init`

API keys are project/task-specific and do not belong in global environment
variables. subtrk's own values live in `~/.subtrk/env` (dotenv format, tiny builtin
parser; real process env still wins as an override):

- `OPENROUTER_API_KEY`, `OPENROUTER_MANAGEMENT_KEY` – prompted (hidden input)
- optional `OPENCODE_API_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTIGRAVITY_CLIENT_ID`,
  `ANTIGRAVITY_CLIENT_SECRET` – public installed-app constants, fetched from
  upstream sources by init (no literals in this repo, so secret scanners stay
  quiet)

`subtrk init` runs the Alibaba login flow, prompts for the keys above, checks
every provider's credential presence, and reports what is missing with honest
per-step results. It is the only interactive command; everything agents call
is non-interactive. Accepted trade-off: plaintext values inside the user
profile – the same trust envelope as the vendor credential files subtrk reads;
the profile's per-user ACL is the boundary.

## D7 · Google – read agy's keyring token (plus legacy files), self-refresh read-only

Consumer Gemini CLI service ended 2026-06-18; consumer accounts authenticate
through the closed-source `agy` binary, which holds an Antigravity OAuth login.
subtrk reads the first credential it finds: agy's plaintext JSON blob in Windows
Credential Manager (target `gemini:antigravity`, read zero-dependency via a
fixed-literal PowerShell `CredReadW` script spawned with `execFile`), then the
legacy `~/.gemini/*` files. No third-party credential store is read or written.

The keyring store keeps a long-lived refresh token, and Google's refresh tokens
are **non-rotating** (verified live 2026-09-25). subtrk therefore mints access
tokens itself – `POST oauth2.googleapis.com/token` with the PUBLIC Antigravity
client constants (fetched by init into `~/.subtrk/env` from a public reference
implementation: CLIProxyAPI's MIT source is merely where the values are
published – constants sourcing only, no CLIProxyAPI install, file or process is
used). The minted token stays a local variable for the quota call and **nothing
is ever written back to the keyring** – read-only refresh, and `agy` does not
need to be running. The legacy gemini lineage keeps its write-back refresh; the
legacy antigravity file refreshes without write-back.

Quota call: `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
with `User-Agent: antigravity` and body `{}` – no `ideType`, no project, no
`loadCodeAssist` (that recipe belongs to the legacy `retrieveUserQuota`
endpoint). The response carries per-family buckets (e.g. `gemini-models`,
`claude-and-gpt-models`). On 403/404 retry once against
`daily-cloudcode-pa.googleapis.com`, then degrade to `not-readable-remotely`
with a `run agy /usage` hint. The `implicit/*.pb` files under
`~/.gemini/antigravity-cli/` are encrypted trajectory data – never tokens.

## D8 · Claude OAuth self-refresh

Claude Code refreshes `~/.claude/.credentials.json` only while running, so the
stored token is routinely expired when a headless agent reads it. When the
access token is expired but the refresh token is live, subtrk refreshes via
`console.anthropic.com/v1/oauth/token` with Claude Code's public client id and
writes the merged credential back atomically. The refresh **rotates the
refresh token** – the new one must be persisted or the file goes stale for
Claude Code itself; in-memory use continues if write-back fails. On failure,
degrade to `expired-token` with a "start Claude Code once" hint.

## D9 · Interactive re-auth – `subtrk auth refresh` and `POST /api/refresh`

Console sessions without self-refresh (alibaba's bl console login) need a
human in a browser. `subtrk auth refresh --provider <id>` runs the provider
module's `refresh()`: the provider's own interactive login as a fixed-literal
spawn with a generous timeout, whose stdout/stderr are never captured – the
result is a fixed-literal message, never subprocess output and never a
secret. The web console exposes the same action as
`POST /api/refresh?provider=<id>` behind the same per-run Bearer token as
`/api/status`.

This amends the GET-only posture of the serve decision: the dashboard is no
longer strictly read-only. Accepted trade-off: the token holder can trigger a
browser login on the host. No credential is exposed in return – the endpoint
answers only fixed literals, the provider allowlist rejects non-refreshable
ids with 400, single-flight per provider returns 409 on overlap, and the
loopback binding, host allowlist, CSP and no-CORS posture are unchanged. A
successful refresh drops the provider's cache entry so the next status
re-probes. Google is refreshable too (D7): its refresh re-mints the access
token read-only from the stored non-rotating refresh token. Providers without
interactive refresh emit errors that carry a `remedy` line naming the fix
instead.

## D10 · OpenAI – the Codex CLI's stored ChatGPT login, read-only

subtrk reads `~/.codex/auth.json` (read-only) and calls the usage endpoint the
vendor's own open-source Codex client uses: `GET
chatgpt.com/backend-api/wham/usage` with the stored access token, the account
id and `User-Agent: codex-cli`. The endpoint is undocumented but vendor-owned
and contract-tested in the client's Apache-2.0 source – the same trust level
as the other CLIs' own calls, and it can change.

Codex owns the login: it refreshes its ~10-day access token itself while it
runs. subtrk therefore never refreshes – on 401 it re-reads the credential
file once and retries with a changed token, and the module deliberately has no
`refresh()` (rotation behavior untested), so openai is not refreshable.
Nothing is ever written to the credential file; the auth file's API-key mode
(OPENAI_API_KEY, no ChatGPT tokens) reports `no-credentials` honestly instead
of pretending to read a plan.

## D11 · Agent instructions – opt-in via `subtrk init --agent`

Teaching an agent how to call subtrk is opt-in and per-harness: `subtrk init
--agent <harness>` appends a short instruction section to that harness's
GLOBAL agents file (five targets, paths verified against official
docs/source on 2026-09-26: claude, zcode, codex, opencode, agy). The section
uses conda-init-style sentinels (`<!-- subtrk:begin -->` / `<!-- subtrk:end -->`)
so a re-run replaces only subtrk's own block – idempotent – and removal is a
clean delete of the block between the markers.

The file belongs to the user: subtrk only ever adds or replaces its own marked
block, never rewrites anything else – text outside the markers is preserved,
an unterminated marker is healed (replace to EOF), and a failed write is
reported rather than silently dropped. The blurb carries the status contract
an agent needs (windows, `nextEvent.at` wake-ups instead of polling,
`recheckAfter`, `error.kind`/`error.remedy`, exit codes, cache politeness) and
tells the agent to ask the operator before any browser-opening remedy, since
only the operator can consent to that.

## D12 · Kimi – the Kimi Desktop key or the Kimi Code CLI login

subtrk reads the first credential it finds: the Kimi Desktop app's scoped API
key (`%APPDATA%\kimi-desktop\daimon-share\daimon\kimi-code-key.json`, Windows
only) or the Kimi Code CLI's OAuth login
(`~/.kimi-code/credentials/kimi-code.json`). Both files belong to their owning
apps. With the desktop key it calls the app's own gateway
(`GET agent-gw.kimi.com/coding/v1/usages`) for the plan level and the quota
window; with the CLI login it calls the endpoint the vendor's open-source
client uses for its `/usage` command (`GET api.kimi.com/coding/v1/usages`,
5h/7d/monthly windows). Neither endpoint is a documented public API – the
first is the desktop app's own host (validated live, can change), the second
is contract-stable in the client's MIT source – the same trust level as the
Codex login (D10). Requests carry an honest `User-Agent: subtrk`; vendor
client identifiers are never spoofed.

CLI access tokens live 15 minutes, so the probe refreshes a stale one via the
vendor's device-flow token endpoint with the public OAuth client id. That id
is a published constant of the vendor's open-source client, but it is kept
out of this repo: `subtrk init` fetches it from upstream into
`~/.subtrk/env` (`KIMI_CLIENT_ID`), the same pattern as the Google constants
(D7). Refresh tokens may rotate, so the full updated bundle is written back
atomically – best effort, and the probe keeps using the fresh token even if
the write fails. A grant rejected on both auth hosts points at the owning
tool for re-login: the module has no `refresh()` and never runs an
interactive login. The free plan's quota numbers are unitless strings with an
undocumented reset cycle, so they are treated as ratio inputs and the window
kind is derived from the reset distance.

## D13 · Console persistence – config.json is the single source

The dashboard's provider selection and card order live in
`~/.subtrk/config.json` (`{ enabled, order }`) – the same file `subtrk init`
writes – not in browser storage: `subtrk serve` binds a random port each run,
so a page's localStorage would not survive a restart. The console applies
changes through `POST /api/config` behind the same per-run Bearer token as
`/api/status` and `/api/refresh`; the endpoint accepts only validated
`enabled`/`order` patches (known provider ids, at least one enabled, fixed
literal responses) and persists them atomically. `subtrk init` and the server
share one merge-preserving writer, so neither drops the other's keys.

Ordering is a display hint only: ids missing from `order` keep registry order
after the listed ones, so a newly added provider always appears. The console
refuses to disable the last enabled provider (the server rejects an empty
list with 400 as backstop).
