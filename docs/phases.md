# subtrk – Phases

## M1 – CLI (done)

`subtrk status` + `subtrk init`, six providers, TTL cache, tests.

## M2 – Web console (done)

`subtrk serve`: loopback-only server (random port + per-run token auth – see
`docs/spec.md` §`subtrk serve`), static dashboard + `/api/status` from the same
cache. One page per provider: windows, credits,
staleness, reset timeline and countdowns.

## M3 – Combined usage views (done)

Per-model workload analytics on top of provider history endpoints: OpenRouter
`/api/v1/activity` + `/api/v1/analytics/query`, GLM usage-detail,
Alibaba token-plan telemetry, OpenAI daily breakdown + Codex rollouts, Claude
local JSONL transcripts, zcode bundle ledger. Local usage store
(`~/.subtrk/usage.json`) with idempotent harvests, `subtrk usage` CLI, and
console usage pages (clickable cards, month-to-date token/value cards,
day/hour charts, per-model cost tables, window-% history, and an
all-providers usage page with per-provider stacked spend + token charts).
Design and sourcing decisions in `docs/decisions.md` (D12–D17).

## M4 – Task-level usage accounting (M4a/M4b shipped in v0.1.18; M4d agent tiers + hooks in v0.1.19; M4c pending)

Track what a task actually costs, from the harnesses' own local stores, so
agents can answer "is my remaining window enough?" from history.

- **M4a (PR #35)**: `subtrk track start/stop/status/list/prune`, the
  `~/.subtrk/track.json` store, window harvesters (zcode `db.sqlite`
  per-request rows, claude transcripts, codex rollouts) normalized to the
  house `in`/`cr`/`cw`/`out` convention, pending-harvest retry,
  contested/nested detection, open-marker warnings. Decisions in
  `docs/decisions.md` (D18).
- **M4b (PR #37, stacked on M4a)**: `track stats` + `track estimate`
  (distributions per provider × complexity with a fallback chain; the verdict
  calibrates percent-remaining into tokens from observed window usage), the
  dashboard Tasks strip + `/track` view + `GET /api/track` (records enriched
  at read time, `?live=1` so-far harvest for open markers), the logo→home
  link, and the agents.ts blurb (housekeeping first).
- **M4d (v0.1.19)**: two-tier agent instructions – status-only default,
  opt-in `--track` with the rewritten first-actions trigger and the
  350-bytes-vs-unrecoverable asymmetry – plus `subtrk track hook`: lifecycle
  nudges installed by init for claude, zcode and codex (session-start +
  turn-end, state-change throttled, read-only, never blocking; `--no-track`
  removes them again, tagged handlers only). Decisions in
  `docs/decisions.md` (D19).
- **M4c**: qwen usage-log + opencode session-table harvesters, `--session`
  pinning polish, store compaction (records >365d collapse into aggregates).

## Parked (deliberately out of scope)

- cedar_ember reset grants – API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) – payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs – defaults are the policy.
- Non-Windows keyring reads (macOS Keychain / libsecret) for agy tokens.
