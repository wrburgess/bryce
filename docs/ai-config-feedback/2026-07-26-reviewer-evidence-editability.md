# 2026-07-26 — `verify`'s evidence block assumes the AC can edit a posted comment (bryce issue #154)

## F15 — The Reviewer Evidence block has no path when the harness cannot edit comments

**Disposition: `upstream` · Status: recorded**

[`skills/verify/SKILL.md`](../../skills/verify/SKILL.md) instructs the AC to post the `## Self-Review
Complete` comment with a Reviewer Evidence block whose `reviewer`, `reviewer-model`, `disposition`, and
`artifact-url` fields are literal `pending`, and then — after the summon returns — to *"**edit** this
block with the actual `reviewer`, `reviewer-model`, and disposition `ok`"*.

That procedure has a hard prerequisite the skill never names: **the acting harness must be able to edit
a comment it already posted.** During bryce #154 the AC was a Claude Code session whose lifecycle-host
toolset exposes `add_issue_comment` but **no update/edit-comment verb**. There is no degraded path in
the skill body for that case, so the AC is forced to choose between two bad options:

1. Leave the `pending` block as posted and put the completed evidence in a *second* comment — which
   makes the PR contain **two** `reviewer-evidence` blocks. [`PROJECT.md`](../../PROJECT.md) → *Lifecycle
   Host* requires *"one compact, machine-locatable `Reviewer Evidence` block"*, and `final` is told to
   reject evidence that is *"missing, malformed, or stale"* — duplication is exactly the ambiguity that
   requirement exists to prevent.
2. Delay posting the self-review comment until after the summon returns, so the block can be written
   complete in one shot — but the skill is explicit that the ordering is load-bearing: *"the self-review
   comment is posted **first**, so the Reviewer reads a PR the AC has already attacked and confirms
   rather than corrects."*

Note that `scripts/reviewer-evidence.ts` does not resolve the ambiguity either: `EVIDENCE_BLOCK`
(`scripts/reviewer-evidence.ts:109`) is a non-global regex applied to a **single** markdown string, so
it parses whichever comment body it is handed and has no notion of "the PR's one authoritative block".
Whoever hands it a body is making the disambiguation decision silently.

The same friction recurs on any post-review commit — a `listen` fix or `final`'s `autonomous-fold` —
since re-anchoring the backstop produces a *new* reviewed SHA that also has to land in the block.

### What the baseline should say

A harness without a comment-edit verb is not exotic, so the skill should carry the degraded path
explicitly rather than leaving each AC to improvise. Two candidate shapes, both business- and
stack-neutral:

- **Supersession is declared, not implied.** Allow more than one block, and make the *last* block on the
  PR authoritative, with earlier ones required to be marked (e.g. `disposition: superseded`). This also
  gives the re-anchor case a natural home — each summon appends its own block, and the PR reads as an
  audit trail instead of a single overwritten cell.
- **Or: the block is posted once, complete.** Keep the self-review comment first and evidence-free, and
  put the block in the Reviewer-artifact comment that follows the summon. Preserves the
  self-review-before-review ordering *and* the one-block rule, at the cost of the evidence not being
  co-located with the self-review.

Either way the skill should name the prerequisite out loud ("this step requires a comment-edit verb; if
your harness lacks one, do X"), the way it already names the sub-agent degradation path.

This belongs upstream rather than in an overlay because it is a property of the **harness/lifecycle-host
toolset**, not of a stack or a domain: any Host App on any stack whose agent posts through a
create-only comment API hits it identically.

### What bryce #154 did in the meantime

Took shape (1) and made the supersession explicit in prose: the trailing evidence block is the
authoritative one, the earlier `pending` block is named as superseded in the same comment, and the
`reviewed-sha` recorded is the delivered HEAD. Recorded here rather than papered over, because the
choice was the AC's improvisation and not something the baseline sanctioned.
