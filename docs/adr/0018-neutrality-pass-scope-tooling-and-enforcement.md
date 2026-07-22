# The stack-neutrality pass leaves the repo's own Ruby tooling and neutrality enforcement out of scope

> Note (#73): skill names below predate the six-skill rename (grill-with-docs→distill, cplan→devise, impl→invoke, rtr→listen, drop→clip, voice→follow). This ADR records the decision as of its date; the names here are historical.

**Status:** accepted — part (i) (don't rewrite the Ruby tooling) is superseded by [ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md) (issue #64, the "separate follow-up issue" this ADR anticipated); part (ii) (rules-neutrality stays author-owned) stands unchanged.

Abstracting the bundle to stack-neutral ([ADR 0017](0017-stack-neutral-baseline-with-stack-overlays.md),
issue #48) raised two "do we touch the quality-gate tooling?" questions. We deliberately answer **no**
to both and record the scope boundary here, so a future reader does not mistake the untouched Ruby
tooling — or the absence of a neutrality check — for an oversight.

## (i) The repo's own Ruby tooling is not rewritten

`scripts/parity_check.rb`, `test/*.rb`, and the `bin/` scripts are stdlib-Ruby. A reader still *sees*
Ruby, but this is **the bundle's own infrastructure, not guidance handed to a host** — every project's
tooling is in *some* language, and ai-config's being Ruby leaks no Rails assumption into the rules. A
rewrite would change the quality-gate command itself (`ruby scripts/parity_check.rb`), carry real
regression risk, and is disproportionate to a content-neutrality pass. If a host ever wants it,
that is a **separate follow-up issue**, not part of #48.

> **Superseded ([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md), issue #64):** that
> follow-up issue arrived. Bryce is now a committed Node/TS app, so the tooling is ported from Ruby to
> TypeScript (run via `tsx`) and the quality-gate command changes accordingly. Part (ii) below is
> unaffected.

## (ii) Rules-neutrality stays author-owned, not machine-enforced

The parity check's `HOST_SPECIFIC_TOKENS` denylist is scoped to **skill bodies only**
(`skills/<name>/SKILL.md`); `rules/*.md` neutrality is currently author-owned. We decline to extend the
denylist to `rules/`:

- **Self-reference false-positive.** The baseline's own overlay pointer *contains the string*
  `ai-config-rails` — a naive "no rails token" scan would flag the baseline's own pointers, forcing
  brittle context-allowlisting.
- **Precedent.** [ADR 0011](0011-ascii-safe-stdout-stays-doc-only.md) already established that some
  rules stay author-owned / doc-only because a token/byte scan is the wrong instrument. Rules-neutrality
  fits that pattern exactly.
- **It is the same tooling-change category as (i)**, which we are deferring.

Neutrality is guarded by the `verify` / `rtr` stages and human review instead.

## Consequences

- The parity harness stays focused on structural invariants ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)); no new content check is added.
- The quality bar is unchanged — only the *enforcement mechanism* is a deliberate no-op here, by
  cost-benefit, consistent with [ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md)
  and ADR 0011.
- If a host later wants a mechanical backstop for rules-neutrality, the correct scope is a
  context-aware check (allowlisting the overlay pointers), filed separately.
