# What

<!-- One or two sentences: what changes and why. If this alters documented behavior, the docs update belongs in this PR (docs/spec.md, docs/decisions.md for new rationale, README where user-facing). -->

# How it was tested

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Verified against the real endpoint where the change touches one – fixtures captured from the live wire, fake values only, no keys or tokens in anything committed

# For provider PRs

- [ ] Followed the recipe in `docs/implementation-plan.md` (module with pure parsers, fixtures, parser + redaction tests, init step if setup is needed, spec/README rows)
- [ ] Vendor calls are read-only, secrets are registered for redaction, and no credential material appears anywhere in the diff
