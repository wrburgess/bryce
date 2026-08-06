---
name: assess
description: Stage 1 of the deuce lifecycle. The HC has pointed the AC at an issue; research it and post the Assessment — the options the HC chooses between at the Direction gate. Nothing is planned or built until that gate has an Assessment in front of it.
---

# assess — Stage 1 of the lifecycle

The packaged procedure for
[Chapter 1 → Stage 1 — Assess](../../sds/01-lifecycle-and-skills.md#stage-1--assess). This body
carries the verbs and links the variables; the stage itself — trigger, work, terminal artifact,
exit — is canon and is not restated here.

## When it is invoked

The HC points the AC at an issue —
[the Stage 1 trigger](../../sds/01-lifecycle-and-skills.md#stage-1--assess).

## Procedure

1. **Read the issue from the tracker** — title, body, labels, and every existing comment.
2. **Set `status:in-progress`**
   ([Chapter 1 → Binding to the Work Tracking System](../../sds/01-lifecycle-and-skills.md#binding-to-the-work-tracking-system)).
3. **Read the stage's routing** — which model and effort runs this stage is
   [`config/models.md`](../../config/models.md); what may be offloaded, and in what shape, is
   [`config/delegation.md`](../../config/delegation.md).
4. **Search the tracker for duplicates and related work** — open and closed issues and pull
   requests, on the issue's key terms. Overlap or superseding work found goes into the Assessment
   as an open question — proceed-or-consolidate is the HC's call, never a silent proceed.
5. **Research what the change would touch** — the repository as it is, not as the issue describes
   it. While there, **read what already covers the affected area**: the tests over it show what is
   protected and what gap the change would open, and a gap the change would widen is a risk the
   Assessment names.
6. **Check what already exists before any option proposes custom construction** — the platform's
   built-ins first, then an established, maintained library. List what was considered in the
   Assessment even when rejected: "I couldn't find a fit" is acceptable; "I didn't look" is not.
7. **Read [`rules/authoring.md`](../../rules/authoring.md)** at the moment of writing.
8. **Draft the Assessment as a Readout** — content per
   [Stage 1](../../sds/01-lifecycle-and-skills.md#stage-1--assess), shape per
   [Chapter 1 → The Readout](../../sds/01-lifecycle-and-skills.md#the-readout).
9. **Hold the draft to the pre-post pass before it leaves.** Researched, or guessed from the issue
   text? Do the options genuinely differ
   ([Stage 1](../../sds/01-lifecycle-and-skills.md#stage-1--assess))? Are the named risks the ones
   that would waste implementation time? What would a critical reviewer flag in this analysis?
   Fix it now — once posted, the Assessment is the record.
10. **Post the Assessment on the issue before proceeding on it**, carrying the rejected options and
   why they were rejected —
   [the Direction gate's floor](../../sds/01-lifecycle-and-skills.md#the-direction-gate-graduated),
   clauses 1 and 2.
11. **Hold at the Direction gate per its current setting**
   ([`config/gates.md`](../../config/gates.md)). The setting is read there, never from this file;
   the floor no setting reaches is canon
   ([Chapter 1 → The Direction gate, graduated](../../sds/01-lifecycle-and-skills.md#the-direction-gate-graduated)).

## Terminal artifact

The Assessment, posted on the issue
([Stage 1](../../sds/01-lifecycle-and-skills.md#stage-1--assess)).

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops). The question and its answer are
recorded on the issue before the answer is acted on.

## Prior art

Re-authored from a reading of
[ace's `assess`](https://github.com/wrburgess/ace/blob/main/skills/assess/SKILL.md), per
[ADR 0006](../../adr/0006-skills-self-contained.md) — read and attributed, never vendored.
Steps 4–6 and the pre-post pass are MPIAS-era craft, re-authored from a reading of markaz's
`/assess` and restored on the HC's direction of 2026-08-04, recorded on #64.
