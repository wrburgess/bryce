---
name: deliver
description: Stage 5 of the deuce lifecycle. The Verification carries no open must-fix finding; re-confirm the checks are green on the current head, write the Delivery Record on the pull request with its reference on the issue, then act on the Ship gate at its declared setting.
---

# deliver — Stage 5 of the lifecycle

The packaged procedure for
[Chapter 1 → Stage 5 — Deliver](../../sds/01-lifecycle-and-skills.md#stage-5--deliver). This body
carries the verbs and links the variables; the stage itself — trigger, work, terminal artifact,
exit — is canon and is not restated here.

## When it is invoked

The Verification on the pull request carries no open must-fix finding —
[the Stage 5 trigger](../../sds/01-lifecycle-and-skills.md#stage-5--deliver).

## Procedure

1. **Read the pull request from the tracker** — description, labels, the current head, the whole
   diff, the Verification, and every comment and thread
   ([Stage 5](../../sds/01-lifecycle-and-skills.md#stage-5--deliver)).
2. **Read the issue the pull request links** — title, body, labels, and every existing comment;
   the Assessment, the gate record, and the latest posted Plan are among the comments, and the
   record is written from them
   ([Chapter 1 → Stages communicate only through terminal artifacts](../../sds/01-lifecycle-and-skills.md#stages-communicate-only-through-terminal-artifacts)).
3. **Read the stage's routing** — which model and effort runs this stage is
   [`config/models.md`](../../config/models.md); what may be offloaded, and in what shape, is
   [`config/delegation.md`](../../config/delegation.md).
4. **Re-confirm the checks are green on the current head** — green is confirmed here, never
   produced here; a red check re-enters [Verify](../verify/SKILL.md), where the fix loop lives,
   and this stage runs again from its trigger
   ([Stage 5](../../sds/01-lifecycle-and-skills.md#stage-5--deliver);
   [ADR 0009](../../adr/0009-review-response-folded-into-verify.md)).
5. **Read [`rules/authoring.md`](../../rules/authoring.md)** at the moment of writing.
6. **Write the three prose fields first** — why the other options were rejected; what was tried
   and abandoned, so it is not re-proposed; what is fragile, and what the AC was unsure about at
   the end — each carrying only what the repository cannot reconstruct
   ([Chapter 1 → The Delivery Record](../../sds/01-lifecycle-and-skills.md#the-delivery-record)).
7. **Assemble the Record in its declared shape** — Summary (HC) with Problem then Solution;
   Changes grouped by the architectural map the HC reads the repository through, empty groups
   omitted; Findings with the four health measures; Description (AC + HC) carrying the prose
   fields and the limitations — content and shape per
   [The Delivery Record](../../sds/01-lifecycle-and-skills.md#the-delivery-record), the four
   health measures per
   [Chapter 1 → Where the health measures live](../../sds/01-lifecycle-and-skills.md#where-the-health-measures-live),
   the scannable half's rules per [Chapter 1 → The Readout](../../sds/01-lifecycle-and-skills.md#the-readout).
8. **Post the Delivery Record on the pull request and set `status:done-pending-merge` on
   posting**
   ([Stage 5](../../sds/01-lifecycle-and-skills.md#stage-5--deliver);
   [Chapter 1 → Binding to the Work Tracking System](../../sds/01-lifecycle-and-skills.md#binding-to-the-work-tracking-system)).
9. **Post the reference on the issue** — a link to the Record — then **act on the Ship gate per its
   current setting** ([`config/gates.md`](../../config/gates.md)). The setting is read there, never
   from this file; the floor no setting reaches is canon
   ([Chapter 0 → Governance](../../sds/00-identity-and-governance.md#governance) → *Merge
   authority*; [Stage 5](../../sds/01-lifecycle-and-skills.md#stage-5--deliver)).

## Terminal artifact

The Delivery Record on the pull request, plus the reference on the issue
([Stage 5](../../sds/01-lifecycle-and-skills.md#stage-5--deliver)).

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops). The question and its answer are
recorded on the pull request before the answer is acted on.

## Prior art

Re-authored from a reading of
[ace's `final`](https://github.com/wrburgess/ace/blob/main/skills/final/SKILL.md), per
[ADR 0006](../../adr/0006-skills-self-contained.md) — read and attributed, never vendored.
