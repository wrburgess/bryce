---
name: devise
description: Stage 2 of the deuce lifecycle. An option has been chosen at the Direction gate; work out how it gets built and post the Plan — the ordered steps Implement runs from.
---

# devise — Stage 2 of the lifecycle

The packaged procedure for
[Chapter 1 → Stage 2 — Devise](../../sds/01-lifecycle-and-skills.md#stage-2--devise). This body
carries the verbs and links the variables; the stage itself — trigger, work, terminal artifact,
exit — is canon and is not restated here.

## When it is invoked

- An option is chosen at the Direction gate —
  [the Stage 2 trigger](../../sds/01-lifecycle-and-skills.md#stage-2--devise).
- Or Implement discovers the Plan was wrong —
  [Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops), trigger 2.

## Procedure

1. **Read the issue from the tracker** — title, body, labels, and every existing comment; the
   Assessment and the recorded choice are among the comments.
2. **Read the stage's routing** — which model and effort runs this stage is
   [`config/models.md`](../../config/models.md); what may be offloaded, and in what shape, is
   [`config/delegation.md`](../../config/delegation.md).
3. **Right-size the Plan to what is actually known.** The tell that a Plan is being written
   against unknowns: steps that cannot be made concrete without guessing. The move is canon's —
   stop, and recommend a `SPIKE:`
   ([Chapter 1 → Binding to the Work Tracking System](../../sds/01-lifecycle-and-skills.md#binding-to-the-work-tracking-system))
   carrying the **single named question** the work must answer, and write the real Plan after its
   Readout answers it. A full ordered plan over a guess is a guess in a Plan's shape.
4. **Decide the testing strategy before the Plan is written** — its content per
   [Stage 2](../../sds/01-lifecycle-and-skills.md#stage-2--devise). Name the **scenarios**, not
   just the test types: the happy path **and** the sad paths, and the standing edge classes —
   invalid input, duplicates, boundary values, concurrent operations — each covered or ruled out
   by name. A fixture or helper the strategy needs is **part of the work**, never a reason to skip
   the test.
5. **Read [`rules/authoring.md`](../../rules/authoring.md)** at the moment of writing.
6. **Draft the Plan as a Readout** — content per
   [Stage 2](../../sds/01-lifecycle-and-skills.md#stage-2--devise), shape per
   [Chapter 1 → The Readout](../../sds/01-lifecycle-and-skills.md#the-readout).
7. **Hold the draft to the pre-post pass before it leaves.** Is every step executable without
   re-deciding anything ([Stage 2](../../sds/01-lifecycle-and-skills.md#stage-2--devise))? Does
   the strategy carry the sad paths, not only the happy one? What scenario or risk would a
   critical reviewer find missing? Fix it now — once posted, the Plan is what Implement runs from.
8. **Post the Plan on the issue and proceed to Implement** —
   [Stage 2](../../sds/01-lifecycle-and-skills.md#stage-2--devise), the exit.

## Terminal artifact

The Plan, posted on the issue
([Stage 2](../../sds/01-lifecycle-and-skills.md#stage-2--devise)).

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops). The question and its answer are
recorded on the issue before the answer is acted on.

## Prior art

Re-authored from a reading of
[ace's `devise`](https://github.com/wrburgess/ace/blob/main/skills/devise/SKILL.md), per
[ADR 0006](../../adr/0006-skills-self-contained.md) — read and attributed, never vendored.
The right-sizing tell, the scenario specifics, and the pre-post pass are MPIAS-era craft,
re-authored from a reading of markaz's `/cplan` and ace's spike-then-re-plan pattern, restored on
the HC's direction of 2026-08-04, recorded on #64. The spike *mechanism* stays canon's `SPIKE:`;
only the detection craft lives here.
