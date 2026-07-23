---
name: verify
description: Stage 4 of the development lifecycle. Self-review an existing PR against its approved plan for drift, test quality, cleanliness, and description completeness before the Reviewer sees it. Use on the PR that invoke opened. It operates on the existing PR and never creates one.
---

<what-to-do>

Self-review the existing PR named in the invocation against its approved implementation plan, so that
when the Reviewer sees it they find nothing. This is **Stage 4 (Verify)** of the
[development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the review severities from [`PROJECT.md`](../../PROJECT.md) → *Review
Severity Framework*, the quality-check commands from *Quality Checks*, the lifecycle host from
*Lifecycle Host*, the attribution/model from *Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the PR `invoke` already opened — it never opens one.** If there is no PR, a
prior stage's terminal artifact was skipped: stop and recheck, don't reinterpret the lifecycle.

</what-to-do>

<how-to-run>

To keep the orchestrator's context lean, `verify` may be **offloaded to a read-only sub-agent** that
reads the whole PR diff and the plan in its discarded context and returns a compact **drift-report**;
the orchestrator supplies only pointers (the PR id, the linked issue id, and — when available —
`invoke`'s returned check-result so the checks aren't re-run) and consumes the report.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* on a
tool without sub-agents, run Steps 1–6 **inline**. The sub-agent (or you, inline) never posts to the
lifecycle host — the orchestrator owns that I/O and the attribution.

### drift-report (sub-agent → orchestrator)
```
{ plan_alignment:   { all_implemented: bool, missing_items: [str], scope_creep_files: [str] },
  test_quality:     { meaningful: bool, false_greens: [str], gaps: [str] },
  test_coverage_summary: { by_type: str, edge_cases: str },
  quality_checks:   [ { purpose, status: "pass"|"fail"|"not_run" } ],
  quality_checks_source: "invoke_check_result" | "ran_here",
  cleanliness:      { debug_code: [str], commented_code: [str], todos: [str] },
  pr_description:   { complete: bool, missing_sections: [str] },
  findings:         [ { severity, file, line, summary } ],   # severity per PROJECT.md → Review Severity Framework
  self_review_comment_markdown: str,   # ready-to-post `## Self-Review Complete` body
  verdict:          "ready" | "needs_fixes" }
```
`quality_checks` carries one entry per [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* row. When
`invoke` already ran them, copy its check-result (`quality_checks_source: invoke_check_result`) rather than
re-running; standalone, run them here (`ran_here`). `not_run` = ran-but-nothing-applicable, not
skipped. `findings[]` is where the **adversarial pass** (procedure Step 4) records the defects it
surfaces, each with a *Review Severity Framework* severity; the schema is unchanged, so the report
still composes with `ship`'s verify handoff.

</how-to-run>

<procedure>

1. **Read the PR** — its description and full diff.
2. **Read the approved plan** from the linked issue — find the linked issue via the PR's closing
   references, falling back to the bare issue number in the PR body (`Closes #N` leaf preferred, then
   `Part of #N`), and fetch the plan comment specifically. If the plan was revised through a
   **sanctioned re-plan** — a Reviewer plan review, or a mid-`invoke` loop-back that re-entered plan
   approval (e.g. a spike's re-plan checkpoint) — check against the *final, approved* plan.
3. **Check plan alignment** — every plan task has a corresponding change in the diff; no plan item
   missing. Divergence from the plan splits two ways: a **sanctioned re-plan** (it went back through
   plan approval — check against that final plan, it is not drift) versus **unsanctioned scope creep**
   (files or behavior that never went back through the gate — that is a finding, regardless of the
   "revisable plan" framing).
4. **Adversarial pass — try to break your own change.** This is the heart of the review: don't just
   confirm each plan item has a change — actively hunt the defect an independent second-model Reviewer
   would flag, and fix it now so their review *confirms* rather than *corrects*.
   - **Refute the change** — construct the input or state where it breaks: off-by-one, `nil`/empty,
     boundary value, duplicate, concurrent operation, unauthorized path. If you can build the failing
     case, that is a finding.
   - **Attack the tests, don't count them** — apply [`rules/testing.md`](../../rules/testing.md)'s
     definition of done and hunt the **false green**: a test that would still pass if the feature were
     reverted, a missing sad path, or an assertion that checks "it ran" instead of "it's correct." For
     each test ask, "if this passed but the feature were broken, would I know?"
   - **Assume the Reviewer's posture** — ask "what is the single most likely thing an independent
     Reviewer flags here?" (incomplete coverage — the most frequent; missing error/edge-case handling;
     a requirement from the issue not fully addressed; naming/structure/duplication) — and address it
     before they see it.
   - **Default skeptical** — an unproven concern is surfaced as a finding, not waved off.

   Record each finding in the `drift-report` `findings[]` with a severity from
   [`PROJECT.md`](../../PROJECT.md) → *Review Severity Framework* — the same contract as before, no new
   schema. This pass runs at full strength whether offloaded to a read-only sub-agent or run inline.
5. **Check cleanliness** — no debug code, no commented-out code, no "TODO"/"needs manual testing"
   comments, no unrelated changes.
6. **Review the PR description** — Summary, Changes, Technical Approach, Testing, and Checklist present
   and accurate.

**Fix drift now, don't document it for later.** `verdict: needs_fixes` → fix the drift (inline, or by
re-running the implement loop), then re-verify. `verdict: ready` → post the self-review comment.

</procedure>

<output>

On `verdict: ready`, post this comment on the PR via the lifecycle host, filling the bracketed parts
from the drift-report:

```markdown
## Self-Review Complete

### Plan Alignment
- [x] All plan items implemented
- [x] No scope creep — only files in the final approved plan changed
- [Any deviations and why]

### Adversarial Pass
- [x] Tried to refute the change (off-by-one, nil/empty, boundary, duplicate, concurrent, unauthorized) — [what was attempted]
- [x] Attacked the tests for false greens and missing sad paths — [what was found / confirmed]
- [Findings surfaced and their resolution, or "none"]

### Test Coverage Verified
- [x] By test type: [summary]
- [x] Edge cases: [summary]

### Reviewer Readiness
- [x] No debug code, no TODOs, no commented-out code
- [x] PR description complete
- [x] All quality checks pass (from PROJECT.md → Quality Checks)
- [x] Self-review complete — summoning the Reviewer for an independent second-model review

### Reviewer Backstop Evidence
- Reviewed commit: `[git rev-parse HEAD at summon time]`
- Reviewer: _summon pending_
- Disposition: _summon pending_

Reviewer summoned; their findings will be answered on this PR.
```

Record the **reviewed commit SHA** (`git rev-parse HEAD` at the moment you summon) in that block —
this is known *before* the summon and is the load-bearing field: it is durable, machine-locatable
evidence that survives context loss, and the deliver skill (`final`) compares it against `HEAD` to
prove the PR-gate review covered the *delivered* diff. If a later `autonomous-fold` in `final` changes
the diff, that mismatch is what triggers `final`'s delta re-summons
([`PROJECT.md`](../../PROJECT.md) → *Human Gates* → *Rule-suggestion disposition*).

The **Reviewer** and **Disposition** fields are *not* yet known when this comment is posted (it is
posted **before** the summon, so the Reviewer reads a PR the AC has already attacked). Leave them
`_summon pending_`, then **once the failure ladder completes, edit this comment** to record which
harness actually answered (primary or a fallback) and the disposition (`ok` / fell back to `<harness>`
/ floor hit) — never guess the reviewer before the summon returns, since a fallback would make a
pre-filled value wrong and `final` relies on it.

Sign with the attribution footer from [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model
Declaration*.

**Then summon the Reviewer — the AC does this, not the HC.** With the self-review comment posted,
request the independent second-model review of the PR using the Reviewer declared in
[`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host* → *Reviewer*, which names the mechanism, its
invocation, and the fallback order. In this host that summon is a bundled script,
`scripts/summon-reviewer.ts` (work mode); read the Project Config for how to invoke it and never
hardcode a command here. The order matters: the self-review comment is posted **first**, so the
Reviewer reads a PR the AC has already attacked and confirms rather than corrects.

If the summon fails, follow the *Reviewer* failure ladder in the Project Config: fall back to the
declared fallback Reviewer. If the **whole chain is exhausted** and no Reviewer returns a review, the
[`PROJECT.md`](../../PROJECT.md) *Reviewer degradation floor* applies — it is `stop-and-ask` and is
**not configurable**: **stop and ask the HC.** A run that cannot obtain an independent review must not
certify itself, so the lifecycle does not proceed to `final` with an unreviewed PR. The gate is never
silently skipped — a review that never arrived must never look like a review that found nothing.

Once the Reviewer's findings land, run the review-response skill (`listen`), then the deliver skill
(`final`). The HC's remaining gate is the merge.

**Terminal artifact:** the self-review comment on the PR, with the Reviewer summoned against it.

</output>
