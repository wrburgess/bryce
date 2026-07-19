# create-skill: an authoring front door for conforming Skills

## Context

Adding a Skill to this bundle means satisfying a stricter architecture than the portable `SKILL.md`
format alone implies: a canonical body **plus** a thin per-tool Invocation Shim
([ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](0010-repo-layout-canonical-skills-at-root.md)), business- and stack-neutral prose with host
values routed through `PROJECT.md`, an `AGENTS.md` reference the parity check enforces, and several
unenforced sync points that drift silently (the written skill count in `AGENTS.md`/`README.md`/
`docs/guides/usage.md`, and the upstream-attribution convention). That knowledge already lives — as
*passive* guidance in [`rules/skills.md`](../../rules/skills.md) and
[`docs/guides/authoring-the-bundle.md`](../../docs/guides/authoring-the-bundle.md) — but nothing turns it
into a guided, conforming scaffold, so a hand-authored Skill can pass CI while missing a count flip or a
credit.

## Decision

Add `create-skill` as the baseline's authoring front door — the eleventh Skill — following the same
canonical-body + thin-shim shape as every other. It **loads the repo context first** (`AGENTS.md`,
`rules/skills.md`, every existing `skills/*/SKILL.md` as exemplars, `PROJECT.md`, and
`authoring-the-bundle.md`), interviews for the new Skill's shape, emits the paired artifacts, wires the
bookkeeping (the `AGENTS.md` reference, the count prose, and — for a baseline member — a `REQUIRED_SKILLS`
floor entry with its matching self-test), and opens a review PR with the parity gate green.

It is **adapted from Anthropic's `skill-creator`** and credits that upstream per the same source-attribution
discipline the bundle already applies to an adapted Skill. Crucially, `create-skill` **references**
`rules/skills.md` and `authoring-the-bundle.md` for the invariants rather than restating them — a copy
would fork the single source and drift; the front door owns only the loading, interviewing, emitting,
wiring, and gating.

## Consequences

- The authoring conventions stay single-sourced: `create-skill` composes the existing rule and guide docs
  rather than duplicating them, so an edit to either flows through without a second copy to update.
- The unenforced sync points (count prose, `## Provenance` credit) are handled by the Skill's procedure
  and re-checked at `verify`, not left to memory — but they remain unenforced by parity, so the Skill's
  discipline, not a gate, is what keeps them honest.
- `create-skill` is created-only for v1; editing/refactoring an existing Skill toward conformance is a
  possible follow-up.
