---
name: invoke
description: Stage 3 of the development lifecycle. Execute the approved plan on a feature branch, run the host's quality checks to green, and open the PR. Use once the plan is posted and approved per the host's gate policy (PROJECT.md → Lifecycle Host → Human gates; auto-approved on posting in this host). This is the only stage that creates a PR; commit is not done — the open PR is.
---

<what-to-do>

Execute the approved implementation plan for the tracked issue named in the invocation. This is
**Stage 3 (Implement)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the **quality-check commands** from [`PROJECT.md`](../../PROJECT.md) →
*Quality Checks*, the branch/PR/issue-linking policy from *Branch & PR Policy*, the attribution/model
from *Attribution & Model Declaration*, and the lifecycle host / artifact map from *Lifecycle Host*.
Never hardcode a stack's commands, branch names, or platform verbs here.

**Terminal artifact: the open PR.** `invoke` creates the PR here and nowhere else — commit ≠ done.

`invoke` executes a **final approved** plan. An **exploratory spike-then-plan** issue is not yet at
Implement: the spike is a Plan-stage activity ([`devise`](../../skills/devise/SKILL.md)) that opens **no**
PR and exits at the re-plan checkpoint — `invoke` runs only once the post-spike production plan is
re-approved, then opens the single production PR as usual.

</what-to-do>

<how-to-run>

Writing the code and running the check/fix loop is the heaviest context sink in the lifecycle, so it
may be **offloaded to a sub-agent working in the same branch/worktree**; the orchestrator keeps only a
compact **check-result** and never reloads the diff. The orchestrator owns branch setup and **all**
lifecycle-host I/O — commit, push, open PR — because the issue-linking judgment and PR authorship need
its context; the sub-agent only writes code and runs the checks.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* on a
tool without sub-agents, run Steps 3–5 **inline** in the orchestrator. The checks run **once** either
way — inside the sub-agent when offloaded, inline when not — and are never re-run by the orchestrator
(re-running would reintroduce the context sink; the host's CI is the authoritative re-run).

**Orchestrator preconditions (before any offload):**
- Create the feature branch from the correct base (the plan's branch; for a stacked/umbrella phase,
  branch from an up-to-date default branch). The branch-protection guardrails block writes on a
  protected branch, so the branch must exist first.
- Confirm a **clean tree** (no pending changes) and capture `base_sha` (the current HEAD). A dirty
  tree means the sub-agent's changes can't be isolated — stop and clean first.

### check-result (sub-agent → orchestrator)
The `checks` array carries **one entry per row of [`PROJECT.md`](../../PROJECT.md) → *Quality Checks***
— the schema is driven by the host's declared checks, never a fixed stack-specific set:
```
{ checks: [ { purpose, command, status: "pass"|"fail"|"not_run",
              exit_code, summary, failure_details: [str] } ],
  git_state: { branch, base_sha, status_short, untracked: [str], diff_stat,
               checks_ran_after_last_edit: bool },
  commit_message: { subject, body_bullets: [str] },
  pr_body: { summary, changes, technical_approach, testing, checklist, known_limitations },
  verdict: "green" | "failing" }
```
`not_run` means the check's command **ran but had nothing applicable to inspect** (e.g. a doc-only
change with no code to lint) — checks are **not applicable, not skipped**; state the reason in
`summary`, so rigor is unchanged. `verdict` is `green` only when every check is `pass`/`not_run` and
`checks_ran_after_last_edit` is true.

</how-to-run>

<procedure>

**Steps 3–5 are what the sub-agent runs (or you, inline); 1–2 and 6–9 are the orchestrator's.**

1. **Read the issue, plan, and agent strategy.**
2. **Check the current branch** — if on a protected branch, create the plan's feature branch first
   (the guardrails will block writes otherwise).
3. **Execute each task in the planned order:**
   - Read existing code in the area before writing — discover and match the codebase's patterns.
   - Follow the matching [Rules Layer](../../rules/) file for each subsystem you touch
     (`rules/backend.md`, `rules/frontend.md`, `rules/testing.md`, `rules/security.md`,
     `rules/scripting.md`) — authorization, model/soft-delete conventions, enumeration patterns, UI
     conventions, and the host's anti-patterns.
   - Write the tests the plan's testing strategy defined, at full strength.
4. **Run the quality checks** — every command in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* —
   and **iterate to green**, fixing failures before proceeding.
5. **Self-review before the PR** — apply [`rules/self-review.md`](../../rules/self-review.md): every
   plan item implemented and tested; assertions meaningful ("if this test passed but the feature were
   broken, would I know?"); edge cases covered; no debug code, no "TODO"/"needs manual testing"
   residue (if something seems untestable, research the stack before claiming it); all checks green.
6. **Commit** — after reconciling the reported git state (see below), commit exactly the reported
   files with a detailed message + the `Co-Authored-By` trailer from [`PROJECT.md`](../../PROJECT.md)
   → *Attribution & Model Declaration*.
7. **Push and open the PR** via the lifecycle host ([`PROJECT.md`](../../PROJECT.md) → *Lifecycle
   Host*). Link the issue per *Branch & PR Policy*: `Closes #N` for a leaf issue; `Part of #N` with
   **no** closing keyword (even negated) for an umbrella/epic sub-PR — see
   [`AGENTS.md`](../../AGENTS.md) → *Umbrella sub-PRs and closing keywords*. Verify the PR's closing
   references match intent before moving on. The PR body uses `pr_body`'s Summary / Changes /
   Technical Approach / Testing / Checklist / Known Limitations sections.
8. **Post implementation notes on the PR** — what was done, decisions made during implementation, and
   anything the Reviewer should focus on.
9. **Post a brief update on the issue** linking to the PR.

**Orchestrator, after an offloaded return:**
1. **Reconcile git state** — re-check `status_short` **and** the diff stat against `git_state` (the
   diff-stat comparison catches same-path content drift an unchanged status line would hide), confirm
   HEAD still equals `base_sha` (the sub-agent committed nothing), the branch matches, and the
   `untracked` set is expected. Commit immediately after reconciling, with no intervening writes. Any
   mismatch → **abort and inspect, never blind-commit**.
2. **Gate on `verdict`** — `failing` → if the fix is obvious, re-dispatch with the `failure_details`;
   otherwise stop and ask the HC. Proceed only on `green` with `checks_ran_after_last_edit: true`.
3. **Commit → push → open PR → post notes → post the issue update** from the returned `commit_message`
   / `pr_body` without reloading the diff.

</procedure>

<quality-gate>

Do **not** open the PR until: every check in [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* is
green; all planned tasks are complete; the self-review checklist is done; the commit message follows
the host's attribution format; and the PR body has Summary, Changes, Technical Approach, Testing, and
Checklist sections.

**Next step:** the HC runs the verify skill (`verify`) on the PR number that this stage opened (it
differs from the issue number). Sign any lifecycle-host comment with the footer from
[`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration*.

</quality-gate>
