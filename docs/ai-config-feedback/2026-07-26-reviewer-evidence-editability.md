# 2026-07-26 — `verify`'s evidence block assumes the AC can edit a posted comment (bryce issue #154)

## F15 — The Reviewer Evidence block has no path when the harness cannot edit comments

**Disposition: `upstream` · Status: recorded**

[`skills/verify/SKILL.md`](../../skills/verify/SKILL.md) instructs the AC to post the `## Self-Review
Complete` comment with a Reviewer Evidence block whose `reviewer`, `reviewer-model`, `disposition`, and
`artifact-url` fields are literal `pending`, and then — after the summon returns — to *"**edit** this
block with the actual `reviewer`, `reviewer-model`, and disposition `ok`"*.

[`skills/final/SKILL.md:64`](../../skills/final/SKILL.md) depends on the same capability from the other
end — *"Each re-summon **replaces** the evidence block with a new request marker, its delta baseline,
and the new artifact URL"* — so the requirement is not incidental to one step; it is how the block is
designed to work across re-anchors.

That procedure has a hard prerequisite neither skill names: **the acting harness must be able to edit a
comment it already posted.**

**The mechanisms actually available in the bryce #154 session, checked rather than assumed** (this is
the claim the entry rests on, so it is stated as evidence, not asserted):

| Mechanism | Available? | Can it edit a posted comment? |
|---|---|---|
| `gh` CLI | **No** — `which gh` exits non-zero; the session's operating instructions state outright that `gh`, `hub`, and direct GitHub API access are unavailable and that GitHub work goes through the MCP server | — |
| `mcp__github__add_issue_comment` | Yes | No — creates a comment (or adds a reaction) |
| `mcp__github__add_reply_to_pull_request_comment` | Yes | No — creates a *reply* |
| `mcp__github__issue_write` | Yes | No — writes an **issue**, not a comment |
| `mcp__github__update_pull_request` | Yes | Only the **PR body**/title/state — not a comment |

So the gap is real for this harness, and note the shape of it: the one editable surface on the PR is the
**PR body**, which is not where the skill puts the block.

This matters for the upstream framing. `rules/self-review.md:12,35` does reference `gh pr diff N`, and
`gh` *can* edit a comment (`gh api -X PATCH /repos/{o}/{r}/issues/comments/{id}`) — so on a harness where
`gh` is present, the skill's edit step works fine and there is no gap. The baseline problem is that the
skill assumes that harness without saying so. The claim here is **not** "editing a comment is
impossible"; it is "the skill has an unstated prerequisite and no degraded path when it is unmet."

With no edit verb, the AC is forced to choose between two bad options:

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
- **Or: move the block to the PR body.** On this harness the PR body *is* editable
  (`mcp__github__update_pull_request`) even though comments are not, and a single canonical location
  per PR is exactly what "one compact, machine-locatable block" wants. Costs the block its position in
  the comment timeline, which is where its audit value currently comes from.

Either way the skill should name the prerequisite out loud ("this step requires a comment-edit verb; if
your harness lacks one, do X"), the way it already names the sub-agent degradation path.

This belongs upstream rather than in an overlay because it is a property of the **harness/lifecycle-host
toolset**, not of a stack or a domain: any Host App on any stack whose agent posts through a
create-only comment API hits it identically.

### What bryce #154 did in the meantime

Took shape (1): the completed block lives in **its own, later comment**, and that comment states in
prose that the `pending` block in the earlier self-review comment is superseded. The `reviewed-sha`
recorded is the delivered HEAD.

**The two blocks are deliberately in two separate comments, and that detail is load-bearing.**
`parseReviewerEvidenceBlock` takes a single markdown string and `EVIDENCE_BLOCK` carries no `g` flag,
so `.match()` returns the **first** block in whatever body it is handed. Appending a second block to
the *same* comment would therefore parse the stale `pending` one, fail `nonEmpty()`
(`scripts/reviewer-evidence.ts:47`), and be rejected — the opposite of what "the trailing block wins"
would imply. With two comments the validator is simply pointed at the authoritative one. Anyone
replicating this workaround should not collapse it into one comment.

Recorded here rather than papered over, because the choice was the AC's improvisation and not something
the baseline sanctioned.
