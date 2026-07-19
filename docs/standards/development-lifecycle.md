# Development Lifecycle

The full stage spec the [Canonical Source](../../AGENTS.md) summarizes under *Development lifecycle*.
It is **business-neutral**: it names no company, product, stack, or domain. A Host App reads its
host-specific values — quality-check commands, attribution, review severities, the lifecycle host and
its artifact map — from [`PROJECT.md`](../../PROJECT.md), never from this file.

## Purpose

Defines how an AI Contributor (AC) works from problem definition through delivery. It is
**model-agnostic** and **tool-agnostic**: the stages and quality gates stay the same as AC
capabilities improve and across every configured agent (Claude, Codex, Copilot, Antigravity, Grok Build). What changes
over time is which gates require external review vs. self-review; what changes across tools is only the
*mechanism* of a stage's optional execution enhancement, never the *bar*
([ADR 0003](../adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)).

## Roles

- **HC** — Human Contributor. Makes decisions, approves gates, owns the product.
- **AC** — AI Contributor. Does the work, self-reviews, responds to feedback.
- **Reviewer** — an **independent second model** that gives unbiased critique at the plan and PR
  gates. The Host App names its reviewer tool (and wires it into CI if desired); this lifecycle only
  requires that it is *a different model from the AC*. If no second model is reachable, the gate
  **degrades to "stop and ask the HC"** — it is never silently dropped.

## The lifecycle host

The lifecycle is issue/PR-shaped. Which platform hosts those artifacts, and the **artifact map**
(where each stage posts its output), are set in [`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host*
([ADR 0006](../adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)). GitHub is the
default: assessments/plans → issue comments; implementation → a PR; SOW → a PR comment. A Host App on
another platform remaps the targets there without rewriting any skill body — the skills name the
lifecycle *verb* ("post the assessment to the issue", "open a PR"), not a platform command.

## The stages

The lifecycle is **Assess → Plan → Implement → Verify → Deliver**, plus a review-response step. The
**issue-scoped** stages take the issue id — `assess`, `devise`, `invoke`; the **PR-scoped** stages take
the PR id that `invoke` opens — `verify`, `final`, and review-response `listen` (the PR id differs from the
issue id).

**Stage exit-criteria (terminal artifacts) are load-bearing invariants.** A stage is *not done* until
its terminal artifact exists. Do not infer an artifact's existence from a compaction summary — re-read
the stage's canonical body (`skills/<name>/SKILL.md`) on resume. If a tool or skill assumes an
artifact that does not exist yet (e.g. `verify` finds no PR), a prior stage's terminal artifact was
skipped — **stop and recheck, don't invent a stage split to explain it away**.

### Stage 1: Assess (`assess`)

**Trigger:** HC assigns an issue or asks the AC to review one.

**AC produces:** a problem summary; codebase research (relevant files, existing patterns,
dependencies); 2–3 genuinely different options with trade-offs and per-option risk; questions for the
HC where requirements are ambiguous (ask, don't guess). For any non-trivial issue the open-ended
codebase trace is offloaded to a read-only sub-agent that returns a compact **exploration-summary**
(ADR 0005) — degrading to inline reads on tools without sub-agents.

**Quality gate:** HC sends the assessment to the Reviewer (missing options, incorrect codebase
assumptions, requirements gaps, architectural concerns).

**Terminal artifact:** the assessment posted on the issue. **Exit:** HC picks an option; the AC does
not proceed without a chosen option.

### Stage 2: Plan (`devise`)

**Trigger:** HC picks an option.

**AC produces:** a plan **right-sized to the task** — a step-by-step plan with specific file paths when
the change is well understood, or, for an HC-elected **exploratory/discovery issue**, a thin hypothesis
+ a spike/prototype step + an explicit re-plan checkpoint (a *plan to learn*, still posted and still
approved); a **testing strategy decided now, not during implementation** (which test types, which
scenarios, which edge cases) — for an exploratory plan the production-code strategy is decided in the
post-spike re-plan, deferred in detail but **never skipped**; any data/schema-change plan; the list of
files to create/modify (used to size single-agent vs. parallel work). For an exploratory plan the spike
is run *to learn* — its terminal artifact is the re-planned, re-approved production plan, **not a PR**;
Implement (Stage 3) and its PR follow only once that final plan clears this gate.

**Quality gate:** HC sends the plan to the Reviewer (steps too vague to implement, missing edge cases,
patterns that don't match the codebase, unaddressed requirements).

**Terminal artifact:** the plan posted on the issue. **This is gate 1 (plan approval) — auto-approved
in this host** ([`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host* → *Human gates*).
**Exit:** the plan is posted and deemed approved; the HC can comment at any time to revise direction.
The AC does not write code without a posted plan. An approved plan is **revisable direction, not a
frozen contract** — a mid-`invoke` discovery that it was wrong loops back through this gate to re-plan
(post the revised plan, proceed), an expected outcome rather than a failure
([ADR 0020](../adr/0020-right-size-plan-revisable-direction.md)).

### Stage 3: Implement (`invoke`)

**Trigger:** the plan is posted (auto-approved per host gate policy).

**AC does:** creates the feature branch (the branch-protection guardrails block writes on a protected
branch — see [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy*); implements the plan step by
step; writes the tests the plan's strategy defined, following [`rules/testing.md`](../../rules/testing.md);
runs the Host App's checks from [`PROJECT.md`](../../PROJECT.md) → *Quality Checks* and iterates to
green. The code + check + fix loop is the heaviest context sink, so it may be offloaded to a sub-agent
that returns a compact **check-result** while the orchestrator owns branch setup and all lifecycle-host
I/O (commit, push, open PR).

**Quality gate:** AC self-review ([`rules/self-review.md`](../../rules/self-review.md)) before
requesting any review — every plan item implemented and tested, meaningful assertions, edge cases
covered, no debug/TODO residue, all *Quality Checks* green.

**Terminal artifact:** the open PR. **`invoke` creates the PR here and nowhere else; commit ≠ done.**
Implement always executes a **final approved** plan; an exploratory spike is a Plan-stage activity that
opens no PR (its exit is the re-plan), so Stage 3 is reached only once the production plan is approved —
the invariant is unconditional. **Exit:** checks pass, self-review complete, PR opened and linked to the
issue.

### Stage 4: Verify (`verify`)

**Trigger:** the PR exists.

**AC does:** reviews its own PR diff against the approved plan for drift (anything implemented that
wasn't planned; anything planned that's missing), then runs an explicit **adversarial pass** — it
actively tries to *refute* the change (off-by-one, nil/empty, boundary, duplicate, concurrent,
unauthorized) and to break its own tests (hunting the false green that would still pass if the feature
were reverted), assuming the Reviewer's posture and defaulting skeptical so the external review
confirms rather than corrects; and confirms the PR description is complete. The full-diff review may
be offloaded to a read-only sub-agent that returns a **drift-report**; findings (including the
adversarial ones) are classified by the [`PROJECT.md`](../../PROJECT.md) → *Review Severity Framework*.

**Operates on the existing PR — it never opens one.** **Terminal artifact:** the self-review comment
on the PR. **Exit:** self-review passes; HC is notified the PR is ready for the Reviewer.

### Stage 5: Deliver (`final`) + review-response (`listen`)

**Trigger:** HC sends the PR to the Reviewer.

**AC responds to Reviewer feedback (`listen`):** fetches all review threads via the lifecycle host,
classifies each by the *Review Severity Framework*, summarizes for the HC, and — **after the HC
chooses** which findings to address — fixes them, re-runs the *Quality Checks*, and replies on each
thread. The fetch-and-fix churn may be offloaded; the severity and stop-and-ask judgment stays with
the orchestrator (ADR 0005).

**AC delivers (`final`):** re-verifies the PR is green with no open must-fix findings, then posts a
**Statement of Work** on the PR (issue link; option chosen; technical decisions; what changed; testing
coverage; Reviewer findings + resolutions; known limitations; follow-ups) and a reference link on the
issue.

**Both operate on the existing PR — they never open one. `final` does not self-merge.** **Terminal
artifact:** the SOW on the PR + the reference link on the issue. **This is the second mandatory human
gate.** **Exit:** no open must-fix findings, SOW posted; **HC merges.**

## The human gates (host policy)

The Generic Baseline defines two mandatory human gates; this host tunes them in
[`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host* → *Human gates*:

1. **Plan approval — auto-approved.** After `devise`, the posted plan is deemed approved on posting;
   work proceeds without a human pause. The plan artifact and its rigor are unchanged.
2. **Merge — mandatory, never bypassed**, on any tool or track. After `final` posts the SOW with a
   green gate and no open must-fix findings, the HC merges. The AC never merges.

An **approved plan is revisable direction, not a frozen contract.** When an Implement-stage discovery
shows the plan was wrong — including a `ship` emergency stop for core logic the plan didn't anticipate
— the sanctioned resolution is to **loop back through gate 1** (re-plan: post the revised plan, then
proceed per the same policy), never to improvise past it. Re-planning *upholds* the gate, it does not
weaken or bypass it ([ADR 0020](../adr/0020-right-size-plan-revisable-direction.md)).

## When to skip or compress stages

| Scenario | Approach |
|----------|----------|
| Trivial fix (typo, config change, dependency bump) | Assess → Implement → Deliver (skip Plan; compress self-review) |
| Bug fix with an obvious cause | Assess → Plan (brief) → Implement → Deliver |
| Exploratory / discovery issue (outcome uncertain) | Assess → Plan (thin hypothesis + spike run to learn → re-Plan checkpoint) → Implement → Deliver — the spike is a Plan-stage activity (no PR); Implement and its PR run once, on the re-approved plan |
| Large change (many files / independent subsystems) | Full lifecycle, parallel agents if the host supports them |
| Documentation-only change | Implement → Deliver |

**The HC decides when to compress. The AC does not self-select a compressed workflow.**

## Automated / streamlined track (`ship`)

A Host App can run the whole lifecycle hands-off with the [`ship`](../../skills/ship/SKILL.md)
orchestrator skill that sequences
`assess → devise → invoke → verify → listen → final`, replacing the per-stage "wait for HC" pauses with
the **host gate policy** above (in this host: one stop, at merge), plus unconditional emergency stops (a check that can't be
auto-resolved; a discovery that the change touches core logic the plan didn't anticipate; an
architectural or ambiguous review comment).

Its design **offloads output-heavy work and protects judgment**
([ADR 0005](../adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)): the `assess`
exploration, the `invoke` code+check+fix loop, the `verify` full-diff review, and the `listen` fetch-and-fix
churn are delegated to sub-agents whose context is discarded (each returns a compact handoff contract —
`exploration-summary`, `check-result`, `drift-report`); assessment synthesis, plan authoring, `listen`
severity calls, and the `final` merge-readiness call stay in a clean orchestrator context. The plan
gate doubles as a session boundary; state is externalized to the issue/PR so a fresh phase re-reads it.
On tools without sub-agent fan-out the same phases run inline with a "compact between phases" fallback
(ADR 0003) — mechanism degrades, bar does not.

> The `ship` skill is the eighth baseline skill (ADR 0006). It sequences the six lifecycle skills and
> is where the delegation policy and the gate policy concretely live. The six lifecycle skills emit the
> handoff contracts it consumes; `ship` defines the one for the `listen` fetch-and-fix phase inline.

## Skill mapping

| Stage | Skill | Terminal artifact |
|-------|-------|-------------------|
| Assess | `assess` | Assessment on the issue |
| Plan | `devise` | Plan on the issue (gate 1: plan approval — auto-approved in this host) |
| Implement | `invoke` | Open PR |
| Verify | `verify` | Self-review comment on the PR |
| Review response | `listen` | Replies on the PR review threads |
| Deliver | `final` | SOW on the PR + reference on the issue (gate 2: merge) |
| Full hands-off run | `ship` | Sequences all stages with the host's gate policy (stop at merge only) |

Each skill's canonical body is `skills/<name>/SKILL.md`; how each tool invokes it is documented in
[`AGENTS.md`](../../AGENTS.md) → *Skills → Invoking a Skill*.

## Measuring improvement

Track over time: Reviewer must-fix findings per PR (goal: trending to zero); passes per stage (goal: 1
pass — the Reviewer confirms, not corrects); HC interventions (goal: the HC makes decisions, not
corrections). When the Reviewer consistently finds nothing at a stage, the HC can experiment with
dropping that external review and relying on self-review alone.
