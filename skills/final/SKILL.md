---
name: final
description: Stage 5 (Deliver) of the development lifecycle. Re-verify an existing PR is green with no open must-fix findings, post a Statement of Work on it, and link it from the issue. Use when review response is complete. It never creates a PR and never self-merges — merge is the HC's gate.
---

<what-to-do>

Finalize the existing PR named in the invocation and prepare it for merge. This is **Stage 5
(Deliver)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the quality-check commands from [`PROJECT.md`](../../PROJECT.md) →
*Quality Checks*, the review severities from *Review Severity Framework*, the branch/PR/issue-linking
policy from *Branch & PR Policy*, the lifecycle host from *Lifecycle Host*, the attribution/model from
*Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the PR that already exists — it never opens one, and it never self-merges.**
Merge is the second mandatory human gate. If there is no PR, a prior stage's terminal artifact was
skipped: stop and recheck.

</what-to-do>

<procedure>

1. **Dispose of Rules Layer / config improvements** learned during implementation — a convention that
   isn't documented, a gap a Reviewer finding revealed, a new anti-pattern worth capturing — per
   [`PROJECT.md`](../../PROJECT.md) → *Human Gates* → *Rule-suggestion disposition*. **Do this before
   the verification and SOW below**, so a folded change is part of the diff those steps check and
   record — never edited in after the SOW is posted:
   - Under **`autonomous-fold`** (this host's shipped default): **fold** the well-scoped, low-risk ones
     into **this PR** — the same PR a human merges, so the merge gate stays their backstop — and
     **defer** the large or contentious ones to a tracked follow-up issue. The discretion bar is
     *well-scoped **and** low-risk → fold; large **or** contentious → defer.* **Commit and push the
     folds** so Step 2's checks run on the folded diff, and record BOTH — what was folded and what was
     deferred (with the follow-up link) — in the SOW's *Folded Rule/Config Changes* section (Step 5).
     The `create-skill` review-PR gate is **out of scope** — never auto-dispose it.
   - Under **`present-to-hc`**: **present** the suggestions to the HC and wait; **do not edit the Rules
     Layer or config without approval** (nothing is folded, so the diff is unchanged).
2. **Verify the PR is ready:**
   - Integrate the latest base branch (merge it in — do not rebase if the branch-protection guardrails
     refuse a mid-rebase detached HEAD; see [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy*).
   - Run every check in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* and confirm the host's CI
     is green.
   - Confirm all review threads have been addressed.
   - Verify the PR's closing references match intent — a leaf sub-PR closes its issue; an
     umbrella/epic sub-PR must close **nothing** (only the final phase closes the umbrella; see
     [`AGENTS.md`](../../AGENTS.md) → *Umbrella sub-PRs and closing keywords*). If wrong, reword the
     body/commits and re-check.
3. **Resolve remaining Reviewer findings** by the [`PROJECT.md`](../../PROJECT.md) → *Review Severity
   Framework*: **all Critical and High findings must be resolved before the SOW.** Don't argue a
   finding unless it is factually incorrect — if the Reviewer flagged it, treat it as a real gap.
4. **Confirm the faithfulness backstop covers the CURRENT diff.** Read the reviewed commit SHA that
   [`verify`](../../skills/verify/SKILL.md) recorded on the PR, and compare it to `HEAD`:
   - **Equal** → the PR-gate review stands; record the reviewer identity, disposition, and reviewed SHA
     in the SOW's *Reviewer Backstop* line and continue.
   - **Different** (Step 1 folded something after `verify`) → **re-summon the Reviewer on the delta**
     (`--mode work --base <reviewed_sha>`, per [`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host* →
     *Reviewer*) so only the folded diff is re-reviewed. If that re-review makes you fold a new must-fix
     fix, that fold moves `HEAD` again — so **repeat this step** (re-anchor: reviewed SHA ← the newly
     reviewed commit, compare to `HEAD`) until `HEAD` equals the last reviewed SHA. No commit reaches
     the SOW that some Reviewer pass did not see.
   - **The chain is exhausted** (no Reviewer answers, through the whole fallback order) → the
     [`PROJECT.md`](../../PROJECT.md) *Reviewer degradation floor* applies: it is `stop-and-ask` and is
     **not configurable**, so an unreviewed PR does **not** reach a SOW. Stop and ask the HC instead of
     delivering with a footnote. Reaching this step with no reviewer response at all means `verify`'s
     floor was skipped: stop and recheck.
5. **Generate the Statement of Work** and post it as a PR comment via the lifecycle host:
   ```markdown
   ## Statement of Work

   ### Issue
   [Link to issue] — [one-line summary of the problem]

   ### Option Chosen
   [Which assessment option was selected and why]

   ### Technical Decisions
   - [Non-obvious choices and their reasoning; alternatives rejected]

   ### What Changed
   | File | Action | Purpose |
   |------|--------|---------|
   | path/to/file | Created/Modified/Deleted | What changed and why |

   ### Folded Rule/Config Changes
   - [Well-scoped, low-risk Rules-Layer/config improvements folded into THIS PR under `autonomous-fold` — or "None"]
   - Deferred (follow-up): [link to the follow-up issue for large/contentious suggestions — or "None"]

   ### Testing Coverage
   - [Coverage by test type, notable scenarios, and edge cases]
   - Results: [each check from PROJECT.md → Quality Checks and its outcome]

   ### Reviewer Backstop
   - [Reviewer identity · disposition · reviewed SHA · HEAD — confirming the review covered the delivered diff, or the floor was hit]

   ### Reviewer Findings
   | Finding | Severity | Resolution |
   |---------|----------|------------|
   | [What was flagged] | [severity] | [How it was resolved] |

   ### Known Limitations
   - [Anything intentionally deferred or out of scope]

   ### Follow-Up Items
   - [Issues filed for future work, with links]

   ### Linked Issue
   [`Closes #N` for a leaf issue; `Part of #N` with NO adjacent closing keyword for an umbrella sub-PR]
   ```
6. **Post a reference link on the original issue** pointing to the SOW on the PR (for an umbrella
   sub-PR whose closing references are empty, post on the `Part of #N` umbrella issue).
7. **Notify the HC** the PR is ready for final review and merge.

Sign every lifecycle-host comment with the attribution footer from [`PROJECT.md`](../../PROJECT.md) →
*Attribution & Model Declaration*.

**Do NOT merge the PR yourself — wait for the HC to merge.**

**Terminal artifact:** the SOW on the PR + the reference link on the issue.

</procedure>
