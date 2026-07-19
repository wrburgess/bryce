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

1. **Verify the PR is ready:**
   - Integrate the latest base branch (merge it in — do not rebase if the branch-protection guardrails
     refuse a mid-rebase detached HEAD; see [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy*).
   - Run every check in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* and confirm the host's CI
     is green.
   - Confirm all review threads have been addressed.
   - Verify the PR's closing references match intent — a leaf sub-PR closes its issue; an
     umbrella/epic sub-PR must close **nothing** (only the final phase closes the umbrella; see
     [`AGENTS.md`](../../AGENTS.md) → *Umbrella sub-PRs and closing keywords*). If wrong, reword the
     body/commits and re-check.
2. **Resolve remaining Reviewer findings** by the [`PROJECT.md`](../../PROJECT.md) → *Review Severity
   Framework*: **all Critical and High findings must be resolved before the SOW.** Don't argue a
   finding unless it is factually incorrect — if the Reviewer flagged it, treat it as a real gap.
3. **Generate the Statement of Work** and post it as a PR comment via the lifecycle host:
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

   ### Testing Coverage
   - [Coverage by test type, notable scenarios, and edge cases]
   - Results: [each check from PROJECT.md → Quality Checks and its outcome]

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
4. **Post a reference link on the original issue** pointing to the SOW on the PR (for an umbrella
   sub-PR whose closing references are empty, post on the `Part of #N` umbrella issue).
5. **Suggest Rules Layer / config improvements** learned during implementation — a convention that
   isn't documented, a gap a Reviewer finding revealed, a new anti-pattern worth capturing. Present
   the suggestions to the HC; **do not edit the Rules Layer or config without approval.**
6. **Notify the HC** the PR is ready for final review and merge.

Sign every lifecycle-host comment with the attribution footer from [`PROJECT.md`](../../PROJECT.md) →
*Attribution & Model Declaration*.

**Do NOT merge the PR yourself — wait for the HC to merge.**

**Terminal artifact:** the SOW on the PR + the reference link on the issue.

</procedure>
