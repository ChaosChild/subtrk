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

## Parked (deliberately out of scope)

- cedar_ember reset grants – API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) – payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs – defaults are the policy.
- Non-Windows keyring reads (macOS Keychain / libsecret) for agy tokens.
