---
name: listen
description: Review-response step of the Deliver stage. Fetch every review thread on an existing PR, classify findings by severity, summarize for the HC, and — after the HC chooses which to address — fix, re-check, and reply. Use when a Reviewer (human or AI) has left feedback on the PR.
---

<what-to-do>

Read and respond to the review comments on the existing PR named in the invocation. This supports
**Stage 5 (Deliver)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the review severities from [`PROJECT.md`](../../PROJECT.md) → *Review
Severity Framework*, the quality-check commands from *Quality Checks*, the lifecycle host from
*Lifecycle Host*, the attribution/model from *Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the existing PR — it never opens one.** It is **human-in-the-loop**: you
summarize and propose, but you change nothing until the HC chooses which findings to address.

</what-to-do>

<procedure>

1. **Fetch every review thread** via the lifecycle host ([`PROJECT.md`](../../PROJECT.md) → *Lifecycle
   Host*). Capture **all** thread kinds, not just top-level PR comments: issue-level PR comments,
   **inline diff-thread comments**, and **review bodies**. A common trap is reading only the
   issue-level comments — an inline review (e.g. from an automated code-review tool) is then invisible.
   Pull whichever surfaces your host exposes so no reviewer is missed.
2. **Classify each finding by severity** using [`PROJECT.md`](../../PROJECT.md) → *Review Severity
   Framework* (Critical / High / Medium / Low), plus a **Discussion** bucket for architectural
   questions, alternatives, or clarification requests that aren't defects.
3. **Summarize for the HC** as a table:
   ```markdown
   | # | Comment | Severity | Proposed Resolution |
   |---|---------|----------|---------------------|
   | 1 | [summary] | Critical | [specific fix] |
   | 2 | [summary] | Medium | [fix or explain why not] |
   | 3 | [summary] | Discussion | [recommendation with reasoning] |
   ```
4. **Present options** to the HC:
   - **A** — Address all findings (recommended if straightforward).
   - **B** — Address Critical + High, respond to the rest with rationale.
   - **C** — Custom selection: the HC chooses which to address.
5. **Wait for the HC to choose before making any change.**

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* the
output-heavy fetch-and-fix churn may be offloaded to a sub-agent, but the severity classification and
the stop-and-ask judgment stay with the orchestrator. On a tool without sub-agents, run it all inline.

## After the HC chooses

1. Make the requested changes.
2. Run every check in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* and get them green.
3. Self-review the changes against [`rules/self-review.md`](../../rules/self-review.md) — don't
   introduce new problems while fixing old ones.
4. Commit with a message referencing the review feedback (attribution trailer per
   [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*), and push to the PR branch.
5. **Reply to each addressed thread** explaining what changed:
   ```markdown
   Fixed in [commit] — [brief description of the change].
   ```
6. For findings intentionally **not** addressed, reply with rationale (or a link to a follow-up issue):
   ```markdown
   Acknowledged — [why this was not changed, or deferred to follow-up #N].
   ```
7. Post a summary comment on the PR:
   ```markdown
   ## Review Response Summary

   | # | Finding | Severity | Action |
   |---|---------|----------|--------|
   | 1 | [summary] | High | Fixed in [commit] |
   | 2 | [summary] | Low | Deferred — [reason] |

   All quality checks pass. Ready for the deliver skill (`final`).
   ```
   Sign every lifecycle-host comment with the attribution footer from
   [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*.

**Terminal artifact:** replies on the addressed review threads + the summary comment on the PR.

**Next step:** after all chosen findings are addressed, the HC runs the deliver skill (`final`) to
generate the SOW and prepare for merge.

</procedure>
