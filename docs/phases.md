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

## M4 – Task-level usage accounting (in progress)

Track what a task actually costs, from the harnesses' own local stores, so
agents can answer "is my remaining window enough?" from history.

- **M4a (this PR)**: `subtrk track start/stop/status/list/prune`, the
  `~/.subtrk/track.json` store, window harvesters (zcode `db.sqlite`
  per-request rows, claude transcripts, codex rollouts) normalized to the
  house `in`/`cr`/`cw`/`out` convention, pending-harvest retry,
  contested/nested detection, open-marker warnings. Decisions in
  `docs/decisions.md` (D18).
- **M4b**: `track stats` + `track estimate` (history p50/p90 vs calibrated
  window remaining), dashboard Tasks section + `/track` drill-down +
  `/api/track`, the agents.ts blurb (housekeeping first: check status, stop or
  prune your own open markers).
- **M4c**: qwen usage-log + opencode session-table harvesters, `--session`
  pinning polish, store compaction (records >365d collapse into aggregates).

## Parked (deliberately out of scope)

- cedar_ember reset grants – API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) – payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs – defaults are the policy.
- Non-Windows keyring reads (macOS Keychain / libsecret) for agy tokens.
