# Right-size the plan to the task, and treat an approved plan as revisable direction — the two gates unchanged

> Note (#73): the `/cplan` skill was renamed to `/devise`.

**Status:** accepted

## Context

The [development lifecycle](../standards/development-lifecycle.md) is **Assess → Plan → Implement →
Verify → Deliver** with two mandatory human gates (plan approval, merge). Stage 2 (`cplan`) told the AC
to produce "a step-by-step plan with specific file paths" and "a testing strategy decided **now**, not
during implementation." That wording is right for a well-understood change, but it reads as *one plan
altitude for every task*.

The upstream ai-config intake sweep surfaced Thorsten Ball's "Building Software Is Learning"
(upstream Learnings-Log entry 2026-07-07; PR #55, stance `challenges`): building software is a
discovery process, so heavy up-front plans for
uncertain work don't survive contact with reality. Issue #58 asked us to act on the *narrow, valid*
core of that critique without touching the gates:

1. **Over-planning a discovery task** — writing a full ordered plan against unknowns, when the
   right-sized artifact is a thin hypothesis + a spike + a re-plan checkpoint.
2. **The plan-as-contract fallacy** — treating an approved plan as frozen and discouraging mid-`impl`
   course-correction, when discovering the plan was wrong is a normal, expected outcome.

Two constraints bound any change. It must not contradict
[ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md) (*preserves the two human
gates*) or [ADR 0003](0003-skills-canonical-body-thin-shims-graceful-degradation.md) (*degrade the
mechanism, never the bar*). And it collides with two existing invariants that had to be reconciled, not
overwritten: `cplan`'s "testing strategy decided now," and `verify`'s posture that any divergence from
the plan is drift/scope-creep to fix.

## Decision

- **Right-size the plan to the task.** `cplan` matches the plan's *altitude* to how much is known. A
  well-understood change still gets the full ordered plan. An **exploratory/discovery issue** gets a
  thin hypothesis + a spike/prototype step + an explicit **re-plan checkpoint** — *a plan to learn*. It
  is still posted and still approved: right-sizing is plan altitude, **not a lighter gate**. The AC
  *surfaces* the exploratory path; the **HC elects it** — the AC never self-selects (the lifecycle's
  "HC decides when to compress" rule is unchanged). A new "Exploratory / discovery issue" row joins the
  compress/skip table.
- **"Testing strategy decided now" is reconciled, not weakened.** For an exploratory plan the
  production-code testing strategy is decided in the **post-spike re-plan, before any production code**;
  the spike step names only what it must *learn*. "Now" means *when the plan for the production work is
  authored* — for discovery work, after the spike. Test planning is deferred in detail, **never
  skipped**.
- **An approved plan is revisable direction, not a frozen contract.** A mid-`impl` discovery that the
  plan was wrong — including a `ship` emergency stop for core logic the plan didn't anticipate — loops
  **back through gate 1** (re-plan, re-approve). Re-planning *upholds* the plan-approval gate (whose job
  is a human checkpoint against confidently building the wrong thing at scale), it does not bypass or
  weaken it.
- **`verify` distinguishes a sanctioned re-plan from scope creep.** Divergence that went back through
  plan approval is checked against the *final* plan and is not drift; divergence that never went back
  through the gate is scope creep and a finding — so the "revisable plan" framing cannot be used to wave
  off silent scope creep, and the adversarial pass stays sharp.
- **The two human gates are unchanged.** Their near-verbatim restatements across `AGENTS.md`,
  `README.md`, `docs/guides/usage.md`, `skills/ship`, and `skills/final` are left untouched.

## Considered options

- **A — edit only the two named files (`cplan`, `development-lifecycle.md`), no ADR, no `verify` edit.**
  Rejected: leaves `verify`'s drift-vs-re-plan ambiguity unresolved (the "revisable plan" framing could
  muddy scope-creep findings), and leaves a genuinely new framing decision unrecorded, out of step with
  this repo's ADR discipline.
- **B — reconcile-and-record (chosen).** The two file edits **plus** a `verify` clause drawing the
  sanctioned-re-plan / scope-creep line, **plus** this ADR. Records the surprising rationale (why
  lightening the plan for discovery work does *not* weaken the gate) where a future reader will look for
  it, and keeps the system internally consistent.
- **C — a first-class "plan altitude" refactor** unifying `assess`'s Small/Medium/Large complexity, the
  compress/skip table, and the new spike path into one named concept spanning `assess` + `cplan` + the
  lifecycle doc, with CONTEXT.md glossary terms. Rejected as over-reach for a targeted refinement:
  larger surface, higher drift/review cost, more than issue #58 framed.

## Consequences

- Right-sizing and the revisable-direction framing are documented, first-class behaviors; the two gates
  and their restatements are untouched, so **no gate is lowered** (consistent with ADR 0005 / ADR 0003).
- `verify`'s drift semantics are **refined, not broken**: a sanctioned re-plan is checked against the
  final plan; unsanctioned scope creep remains a finding.
- The reconciliation is **not machine-checked** — the parity check is structural
  ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)), so consistency of the new wording
  with the ~7 gate-restatement files is upheld by the skill bodies and human review, not by a test.
