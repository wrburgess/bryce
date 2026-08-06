---
name: implement
description: Stage 3 of the deuce lifecycle. The Plan is posted on the issue; carry it out and open the pull request linked to the issue.
---

# implement — Stage 3 of the lifecycle

The packaged procedure for
[Chapter 1 → Stage 3 — Implement](../../sds/01-lifecycle-and-skills.md#stage-3--implement). This
body carries the verbs and links the variables; the stage itself — trigger, work, terminal
artifact, exit — is canon and is not restated here.

## When it is invoked

The Plan is posted on the issue —
[the Stage 3 trigger](../../sds/01-lifecycle-and-skills.md#stage-3--implement).

## Procedure

1. **Re-read the posted Plan from the issue** — title, body, labels, and every existing comment;
   the Plan and the gate record are among the comments
   ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).
2. **Read the stage's routing** — which model and effort runs this stage is
   [`config/models.md`](../../config/models.md); what may be offloaded, and in what shape, is
   [`config/delegation.md`](../../config/delegation.md).
3. **Create the feature branch**
   ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).
4. **Implement the Plan's steps in order**
   ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)). **Read the surrounding
   code before writing any** — the area's existing patterns are the spec for how new code should
   look, and matching them now is cheaper than matching them as a finding later.
5. **Write the tests the Plan's strategy defined** — **for a fix, the test is seen failing before
   the fix exists** ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).
6. **Run the checks; fix and re-run until green**
   ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).
7. **Self-review the diff before anything is committed** — the cheap pass, minutes over the whole
   diff: every Plan step present; every test the strategy named, written; each assertion answering
   *if this test passed but the change were broken, would I know?*; no debug residue, no
   deferred-work marker (a TODO, a "needs manual testing"). Fix it now — the same defect found in
   [Verify](../verify/SKILL.md) costs
   a recorded finding and the fix wave. This pass narrows Verify's noise; it never replaces it.
8. **Read [`rules/authoring.md`](../../rules/authoring.md)** at the moment of writing.
9. **Commit and push the feature branch**
   ([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).
10. **Open the pull request linked to the issue, its body per
   [the body contract](../../sds/00-identity-and-governance.md#work-tracking-system), and set
   `status:review` on opening**
   ([the Stage 3 exit](../../sds/01-lifecycle-and-skills.md#stage-3--implement);
   [Chapter 1 → Binding to the Work Tracking System](../../sds/01-lifecycle-and-skills.md#binding-to-the-work-tracking-system)).

## Terminal artifact

The open pull request, linked to the issue
([Stage 3](../../sds/01-lifecycle-and-skills.md#stage-3--implement)).

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops). The question and its answer are
recorded on the issue before the answer is acted on.

**Work the Plan did not anticipate goes back to [Devise](../devise/SKILL.md)** — the resolution is
a superseding Plan, never improvising past the one that exists
([Stops](../../sds/01-lifecycle-and-skills.md#stops), trigger 2).

## Prior art

Re-authored from a reading of
[ace's `invoke`](https://github.com/wrburgess/ace/blob/main/skills/invoke/SKILL.md), per
[ADR 0006](../../adr/0006-skills-self-contained.md) — read and attributed, never vendored.
Read-before-write and the pre-commit self-review pass are MPIAS-era craft, re-authored from a
reading of markaz's `/impl` and restored on the HC's direction of 2026-08-04, recorded on #64.
What a pre-artifact pass buys is measured: run at full strength ahead of review, it cut
contractor findings by roughly 80% (#62).
