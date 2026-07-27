# ADR 0057 — A dead link in an accepted ADR: repair identity, annotate loss

**Status:** Accepted
**Date:** 2026-07-27
**Context:** [#164](https://github.com/wrburgess/bryce/issues/164) (deferred from
[#159](https://github.com/wrburgess/bryce/issues/159) / PR #162)

## Context

Widening the dead-link scope to `docs/adr/*.md` ([ADR 0054](0054-code-spans-are-not-links.md) left it
out) is a one-line change to `linkCheckedFiles()`. What blocked it for a whole issue cycle was not the
code: two of this directory's ADRs carry dead links, and repairing a link inside an **accepted** ADR is a records
decision. Nobody had ever had to make it, so every occurrence would have been argued from scratch.

The two cases are not the same kind of problem, and that is the whole insight:

| ADR | Link | What happened to the target |
|---|---|---|
| [0040](0040-exclude-in-progress-games-from-ingestion.md) | `0029-per-game-stat-line-identity.md` | The file was **renamed** to `0029-stat-lines-per-game-keyed-by-game-id.md`. Same ADR, same number, same decision. |
| [0011](0011-ascii-safe-stdout-stays-doc-only.md) | `../../scripts/protected_branches.rb` | The file was **deleted** by [ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)'s TypeScript port. Nothing at that path, ever again. |

Treating both the same way is what goes wrong. Repair both and ADR 0011 ends up citing
`scripts/protected-branches.ts` — a file that did not exist when 0011 was accepted — inside a paragraph
arguing from that file's contents. Refuse both and a reader following 0040's citation gets a 404 on a
rename, which protects nothing.

## Decision

**An ADR is a dated record of a decision, not living documentation. A link inside one is repaired when
the target's *identity* survived, and de-linked with an annotation when the target *ceased to exist*.**

- **Identity survived — repair the link.** A rename, a typo, a moved file that is still the same
  document. The citation's referent is unambiguous and unchanged, so fixing the path restores what the
  author wrote rather than revising it. Applied to 0040: repointed at the real filename, label `ADR 0029`
  untouched.
- **Target ceased to exist — de-link and annotate.** Demote the path to backticked prose (it was true on
  the date of acceptance) and add a dated **Records note** naming what replaced it. Never silently
  repoint at a successor: that makes an accepted decision assert something that was not true when it was
  accepted, and it does so invisibly. Applied to 0011.
- **Annotations are additive and dated.** The original argument keeps its tense and its subject; only the
  annotation speaks in the present, and it says which issue occasioned it.
- **A superseded claim is annotated on the Status line**, in the form ADRs
  [0008](0008-structural-parity-check-not-model-in-the-loop.md) and
  [0018](0018-neutrality-pass-scope-tooling-and-enforcement.md) already use, naming what is superseded and
  affirming that the rest stands.

This writes down a convention the repo was already practicing without stating: 0002 carries
`verified & amended 2026-07-04`, 0008 and 0018 carry supersession notes from that same TypeScript port.
The gap was never the practice — it was that the practice had no name, so the first dead link became a
deferred issue instead of a lookup.

## Consequences

- **`docs/adr/*.md` is inside the dead-link scope.** The last unchecked markdown surface in the
  repository is checked, and it is checked by *derivation* — this ADR was link-resolved the moment it
  landed, and so is every one after it. This supersedes the `docs/adr` exclusion in ADR 0054's
  *Consequences*; nothing else in 0054 changes.
- **Renaming a file an ADR cites now reddens the gate.** That is a real, standing cost and it is the
  point: today it is paid by whoever does the rename, loudly and at rename time, instead of by a reader
  who follows a citation into a 404 some months later. The rule above tells them which of the two
  repairs applies.
- **A de-linked citation is not clickable.** Accepted deliberately. A reader who wants the successor
  finds it in the Records note, one line away, correctly framed as later history rather than as what the
  ADR claimed.
- **The checker cannot enforce this rule, only the absence of dead links.** Which repair an author chose
  is a judgment about identity; `checkLinks` sees only whether a path resolves. A repoint and a de-link
  are both green. The rule is author-owned, in the sense
  [`rules/self-review.md`](../../rules/self-review.md) already means: *a structural link-check confirms a
  URL resolves, never that it supports the claim.*
- **Nothing here applies outside `docs/adr/`.** Rules, skills, guides, and READMEs are living
  documentation: their links are repaired to whatever is currently true, with no annotation ceremony.
