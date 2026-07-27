# ADR 0057 — An ADR's argument is immutable; the paths it cites are maintained

**Status:** Accepted
**Date:** 2026-07-27
**Context:** [#163](https://github.com/wrburgess/bryce/issues/163) (deferred from
[#159](https://github.com/wrburgess/bryce/issues/159) / PR #162)

## Context

[ADR 0054](0054-code-spans-are-not-links.md) widened the dead-link scope from twelve files to
thirty-nine. `docs/adr/*.md` was deliberately left out, and the reason was recorded at the time in
[`scripts/parity-check.ts`](../../scripts/parity-check.ts):

> `docs/adr/*.md` is deliberately absent: it carries two dead links whose repair means editing accepted
> ADRs, which is a records decision rather than a validator one.

The two links, both rendering as 404s on the default branch until this change:

| File | Link | What happened |
|---|---|---|
| `0011-ascii-safe-stdout-stays-doc-only.md:14` | `../../scripts/protected_branches.rb` | The file was deleted by the TypeScript port ([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)) |
| `0040-exclude-in-progress-games-from-ingestion.md:6` | `0029-per-game-stat-line-identity.md` | ADR 0029's real filename is `0029-stat-lines-per-game-keyed-by-game-id.md` |

Neither was ever going to be caught. `checkLinks` resolves paths but never looked here; the repo-wide
ADR-citation scan looks here but only compares the **displayed** number against the **target's** number
and never resolves the path. So `[ADR 0029](0029-anything-at-all.md)` passed, and did.

The blocking question is not technical. It is what an accepted ADR *is*: if it is an immutable record,
a citation that has rotted must stay rotted and be annotated; if the record is the argument rather than
its bytes, the citation is maintenance.

## Decision

**An ADR's argument is immutable. The paths it cites are maintained.**

Repointing a citation whose target was renamed or moved is a **correction**, not an amendment, and
requires no superseding ADR. Three conditions bound it:

1. **The claim the citation supports must still be true of the new target**, verified before repointing —
   not assumed from the filename. For ADR 0011 that meant confirming
   [`scripts/protected-branches.ts`](../../scripts/protected-branches.ts) still defines the *functional*
   `EM_DASH` constant the bullet's argument rests on. It does (`scripts/protected-branches.ts:22`), so
   the argument is untouched. **Had it not, the repair would have been out of scope for a correction**
   and would need an ADR of its own.
2. **The historical name is preserved in prose** where a reader needs it to follow the record. ADR 0011
   now carries a closing note that the file was `scripts/protected_branches.rb` when the decision was
   made, with a pointer to the port.
3. **No argument, decision, or consequence text changes.** If repairing a link requires rewriting the
   reasoning, it is not a repair.

`docs/adr/*.md` therefore joins the dead-link scope, **top-level only** — matching `checkAdrNumbers`,
which reads the same directory non-recursively and is what defines an ADR here.

## Why not the alternatives

**Leave the dead links and add an errata block.** The strictest reading of immutability, and it was the
serious contender. Rejected because it optimizes for the wrong artifact: an errata note preserves the
*bytes* of a citation whose only job was to point at something. A reader following `protected_branches.rb`
gets a 404 either way; with errata they get a 404 plus an explanation of why nobody fixed it. It also
scales badly — every future rename adds a note to every ADR that cited the old path — and it leaves
`docs/adr/` permanently un-checkable, since the errata'd links stay dead.

**Repair the links, but keep `docs/adr/` out of the validator.** Fixes today's two 404s and guarantees a
third. The rot is not a one-time event; it is what happens to paths in a moving tree, which is precisely
the case for machine-checking them.

**Recursive scope over `docs/adr/**`.** Rejected as an inconsistency: `checkAdrNumbers` is top-level, so
a nested `docs/adr/archive/0056-*.md` is already outside the numbering authority. A link scope wider than
the numbering scope would imply nested files are ADRs, which nothing else in the repo believes. Pinned by
a test rather than left to drift.

## Consequences

- **The bar for authoring an ADR rises, deliberately.** A new ADR citing a path that does not exist yet
  reddens CI. The repo's existing convention already covers this — a backticked path is prose naming a
  repo-root path; a link is a link, and is promoted only once the target lands
  ([`docs/rules/README.md`](../rules/README.md)) — so this is the convention gaining teeth in one more
  directory, not a new rule. Stated here so it is a chosen cost.
- **A rename that breaks an ADR citation now fails the gate**, in the PR that does the renaming, where the
  author has the context to repair it. That is the whole return on this decision.
- **Coverage: 39 link-checked files → 86**, all 47 ADRs included.
- **The self-test fixture had to stop healing these.** `healDeadLinks` stubs any unresolved target into
  the bundle copy so a happy path can assert exit 0. Under the widened scope, a dead ADR link produced
  `0029-<name>.md` beside the real ADR 0029 and turned a link typo into a **`Duplicate ADR number`** error
  naming a file nobody wrote — with the dead link gone from the output. The healer now refuses to
  synthesize anything under `docs/adr/`, tested on the resolved path so no equivalent spelling slips past.
  A fixture that manufactures record files was never the honest outcome.
- **`docs/ai-config-feedback/` and `docs/research/` stay out of scope**, and this ADR does not reach them.
  They are dated records that quote broken and hypothetical paths *on purpose*; a citation there is
  evidence of what was true when written, so repairing one would destroy the thing it records. That is the
  distinction this ADR turns on: an ADR cites a path to support a live argument, a ledger entry cites one
  to preserve a moment.
