# Contributing to subtrk

Thanks for considering a contribution. subtrk is deliberately small – please
keep it that way: zero runtime dependencies, TypeScript that Node runs
directly, no build step. Bugs and provider requests use the issue templates;
PRs have a short template too.

## Setup

```bash
git clone https://github.com/ChaosChild/subtrk.git
cd subtrk
npm install        # dev-only toolchain (typescript, biome)
npm link           # puts `subtrk` on PATH
```

## Before you open a PR

```bash
npm run typecheck  # tsc --noEmit (erasable-syntax TS only)
npm run lint       # biome check .
npm test           # node:test, fixtures only – tests never touch the network
```

All three must pass; CI runs them on ubuntu and windows for every PR.

## Where things live and the rules they follow

Read [`docs/implementation-plan.md`](docs/implementation-plan.md) first – it
covers the layout, the provider-module contract, the secure-coding rules (the
non-negotiables: fixed-literal subprocess commands, secrets registered for
redaction, secret-free cache, fail-soft per provider), and a step-by-step
recipe for adding a provider.

The specification is [`docs/spec.md`](docs/spec.md); design rationale lives in
[`docs/decisions.md`](docs/decisions.md). If your change alters a documented
behavior, update the docs in the same PR.

## Adding a provider

Follow the checklist in the implementation guide: provider module with pure
parsers, fixtures captured from the real endpoint, parser + redaction tests,
an init step if setup is needed, and spec/README rows.

## Releases

A tag is the entire release ritual: pushing `v*` runs CI, publishes to npm
with provenance, and opens the GitHub Release. Don't bump versions by hand
except in the same change that ships the feature.
