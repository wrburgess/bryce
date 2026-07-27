---
name: final
description: Stage 5 (Deliver) of the development lifecycle. Re-verify an existing PR is green with no open must-fix findings, post a Statement of Work on it, and link it from the issue. Use when review response is complete. It never creates a PR and never self-merges — merge is the HC's gate.
---

<what-to-do>

Finalize the existing PR named in the invocation and prepare it for merge. This is **Stage 5
(Deliver)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the quality-check commands from [`PROJECT.md`](../../PROJECT.md) →
*Quality Checks*, the review severities from *Review Severity Framework*, the branch/PR/issue-linking
policy from *Branch & PR Policy*, the lifecycle host from *Lifecycle Host*, the attribution format and identity email from
*Attribution & Model Declaration*. Never hardcode them.

**This stage operates on the PR that already exists — it never opens one, and it never self-merges.**
Merge is the second mandatory human gate. If there is no PR, a prior stage's terminal artifact was
skipped: stop and recheck.

</what-to-do>

<procedure>

1. **Dispose of Rules Layer / config improvements** learned during implementation — a convention that
   isn't documented, a gap a Reviewer finding revealed, a new anti-pattern worth capturing — per
   [`PROJECT.md`](../../PROJECT.md) → *Human Gates* → *Rule-suggestion disposition*, **read at execution
   time** (a run that started under one setting finishes under whatever the branch now declares). **Do
   this before the verification and SOW below**, so any change it produces is part of the diff those
   steps check and record — never edited in after the SOW is posted.

   **Every suggestion resolves to exactly one of the four outcomes the Project Config defines** —
   *enforce* · *retain a concise rule* · *record as an expiring finding* · *do nothing* — carrying the
   evidence that outcome requires. Two of them need no approval under **either** setting, because
   neither produces a Rules Layer or config artifact: *enforce* (the guard and its regression test) and
   *do nothing*. A **high-severity first occurrence takes *enforce* immediately** — Step 3's
   requirement that every Critical and High finding be resolved outranks this setting.
   - Under **`autonomous-fold`**: pick the outcome and act on it — **fold** the well-scoped, low-risk
     ones into **this PR** (the same PR a human merges, so the merge gate stays their backstop) and
     **defer** the large or contentious ones to a tracked follow-up. The discretion bar is *well-scoped
     **and** low-risk → fold; large **or** contentious → defer.* **Commit and push the folds** so Step
     2's checks run on the folded diff.
   - Under **`present-to-hc`** (this host's shipped default): pick a **recommended** outcome and
     **present** it — record the recommendation plus `pending HC decision` per suggestion, and **edit no
     Rules Layer or config without approval**. A `pending` row does **not** block the SOW; presenting it
     is what this setting delivers. The HC replies on the PR; an approved outcome is then applied in
     this PR — which moves `HEAD`, so re-enter Step 4 — unless the HC elects to defer it.

   Record **every** suggestion and its outcome in the SOW's *Rule/Config Disposition* section (Step 5),
   including the ones that resolved to *do nothing*: an invisible outcome is indistinguishable from a
   suggestion never considered. An expiring finding goes in the findings log the Project Config names.
   The `create-skill` review-PR gate is **out of scope** — never auto-dispose it.

   **Sweep the findings log first**, before disposing of anything new. Read the findings log the Project
   Config names — absent is fine, and means nothing is due. An entry is **active** until it sits under the
   log's `## Archived` heading and **archived** once it does; that heading is the entire boundary. Stop at
   it: process every **active** entry whose **review date has passed**, and read nothing beneath it.
   Without this sweep an entry recorded once and never met again would sit in the log forever, which is
   the accretion *record as an expiring finding* exists to avoid, in a slower form.

   Apply the rule the Project Config declares — no recurrence and nothing having cited it → archive;
   recurrence → eligible for a real outcome, entering this step's disposition beside the new suggestions.
   Then close the entry out **before this run ends**, because **a due entry never survives its own sweep
   as active, whichever branch it took**: archived on no recurrence; archived **with a pointer to what it
   became** once a promoted outcome is applied; archived as *presented; outcome 4 unless a resumed pass
   records otherwise* while a `pending HC decision` row is still open — the **same wording** the paragraph
   below requires, because two spellings of one disposition is two dispositions, and the looser one wins
   whenever a reader stops at the first. Bounding only the archived side leaves the promotion side
   unbounded: an
   entry presented, never answered, and defaulted to *do nothing* would still be active with the same past
   review date, and every later run would re-present it identically.

   **Archive the pending one here — do not wait for the merge.** Merge is the last event in the lifecycle;
   no stage runs after it, so a step that deferred the archival to it would simply never run. Record the
   disposition as *presented; outcome 4 unless a resumed pass records otherwise* — a line that is already
   correct if no answer ever comes, so nothing is left reading as stale. Archival records that an entry was
   **considered**, never how it resolved, so archiving ahead of the answer misfiles nothing. A later
   recurrence opens a **new** entry citing the archived one rather than reviving it, carrying its
   recurrence count forward.

   **An HC decision that arrives after the SOW re-opens `final`.** This stage posts its SOW and ends, and a
   `pending` row deliberately does not block that — so an approval lands with no run in flight to apply it.
   It is therefore **a new `final` pass, not an edit**: re-enter this step to apply the approved outcome,
   then Step 2's checks, then **Step 4 on the resulting commit** — it moved `HEAD` past the reviewed SHA
   like any other late change — and finally Step 5 to repost the SOW with the entry's pointer updated.
   **No approved post-SOW change reaches merge without Reviewer evidence covering it**; that invariant is
   Step 4's and this is simply its entry point. If no decision ever arrives, nothing resumes: the row
   inherits outcome 4 at merge and the archived line already says so.

   **Archiving by the declared rule is executing the policy, not proposing one**, so the setting does not
   gate it; promoting an entry to a retained rule **is** a suggestion, and does. Report the sweep in the
   same SOW section — including **"no entries due"**, so a sweep that found nothing is distinguishable
   from a sweep that never ran.
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
4. **Confirm the faithfulness backstop covers the CURRENT diff.** Read the `reviewed-sha` recorded in
   the PR comment carrying the `Reviewer Evidence` block and **compare it to `HEAD` first** — the
   validator below is the last step of this gate, not its entry point, because a fold in Step 1
   legitimately makes those SHAs differ and that mismatch must route to a re-summon rather than to a
   stop:
   - **Equal** (`reviewed-sha` = `HEAD`) → the PR-gate review stands; validate the evidence below, then
     record the reviewer identity, model, disposition, artifact URL, and reviewed SHA in the SOW's
     *Reviewer Backstop* line and continue.
   - **Different** (something moved `HEAD` after `verify` — a fold, an HC-approved fold under
     `present-to-hc`, a review-response fix, or a high-severity containment fix) → **re-summon the
     Reviewer on the delta**
     (`--mode work --base <reviewed_sha>`, per [`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host* →
     *Reviewer*) so only the delta is re-reviewed. Resolving a new must-fix finding moves `HEAD` again —
     so **repeat this step** (re-anchor: reviewed SHA ← the newly
     reviewed commit, compare to `HEAD`) until `HEAD` equals the last reviewed SHA. Each re-summon
     replaces the evidence block with a new request marker, its delta baseline, and the new artifact
     URL. **Treat every delta review like the first one:** take its findings back through Step 3's
     severity resolution — in place, without a new human gate, since merge remains the sole one
     ([`PROJECT.md`](../../PROJECT.md) → *Human Gates*) — and resolve all Critical and High findings
     before its evidence is accepted. Resolve each one the way [`listen`](../../skills/listen/SKILL.md)
     resolves a review thread, minus its human pause: fix it, re-run every
     [`PROJECT.md`](../../PROJECT.md) → *Quality Check* to green, commit and **push** to the PR branch,
     and answer the finding on the PR — a fix that lives only in a local `HEAD` is not resolved, and
     the SHA the next summon reviews must be the one the PR carries. `disposition: ok` attests that the
     summon *returned a review*, never that the review was clean, so a validated block is not by itself
     a resolved one. No commit reaches the SOW that some Reviewer pass did not see, and no finding
     reaches it unresolved.

     **The recursion bound** ([`PROJECT.md`](../../PROJECT.md) → *Rule-suggestion disposition*): a **rule
     suggestion** arising from a delta review may not be resolved by *retain a concise rule* — it
     resolves to *enforce*, *record as an expiring finding*, or *do nothing* only. Defect fixes are
     unaffected; every Critical and High delta finding is still resolved above. Without this, fold →
     delta review → fold still runs even with four outcomes available. Record, per delta review, the
     commit that triggered it and the reviewed SHA it was based on, so the chain is reconstructable from
     the PR alone.
   - **The chain is exhausted** (no Reviewer answers, through the whole fallback order) → the
     [`PROJECT.md`](../../PROJECT.md) *Reviewer degradation floor* applies: it is `stop-and-ask` and is
     **not configurable**, so an unreviewed PR does **not** reach a SOW. Stop and ask the HC instead of
     delivering with a footnote. Reaching this step with no reviewer response at all means `verify`'s
     floor was skipped: stop and recheck.

   Once the evidence block names the current `HEAD`, fetch or save the exact markdown body of that PR
   comment as `REVIEWER_EVIDENCE_FILE` and run this required, fail-closed validation before preparing
   the SOW (use the actual repository and PR number):
   ```sh
   npx tsx scripts/reviewer-evidence.ts --evidence REVIEWER_EVIDENCE_FILE --head "$(git rev-parse HEAD)" --repo OWNER/REPO --pr PR_NUMBER
   ```
   A non-zero result rejects the evidence and **blocks the SOW**. The validator requires all seven
   non-pending fields — `request-marker`, `reviewed-sha`, `baseline`, `reviewer`, `reviewer-model`,
   `disposition`, and `artifact-url` — and requires `artifact-url` to be the HTTPS GitHub PR-comment
   URL for that exact repository and PR. Also confirm the URL resolves to the distinct Reviewer's
   posted body, the marker identifies that request, and `disposition` is `ok`. A `stale reviewed SHA`
   failure means the diff moved again after the evidence was written — return to the re-summon path
   above rather than stopping. A local output file, a request without an artifact, an unverifiable
   asynchronous result, or any other malformed evidence is no evidence: stop and ask the HC.
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

   ### Rule/Config Disposition
   Every suggestion Step 1 considered, including the ones that resolved to *do nothing* — or "None considered".
   Findings-log sweep: [entries archived / promoted this run — or "no entries due"].

   | Suggestion | Outcome | State | Where it landed |
   |------------|---------|-------|-----------------|
   | [what was learned] | [enforce \| retain a concise rule \| expiring finding \| do nothing] | [applied \| deferred \| `pending HC decision`] | [commit, findings-log entry, follow-up link, or "—"] |

   ### Testing Coverage
   - [Coverage by test type, notable scenarios, and edge cases]
   - Results: [each check from PROJECT.md → Quality Checks and its outcome]

   ### Reviewer Backstop
   - [Reviewer identity/model · disposition · request marker · baseline · artifact URL · reviewed SHA · HEAD — confirming the review covered the delivered diff]

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
*Attribution & Model Declaration*, using the runtime-actual model or literal `unknown`.

**Do NOT merge the PR yourself — wait for the HC to merge.**

**Terminal artifact:** the SOW on the PR + the reference link on the issue.

</procedure>
