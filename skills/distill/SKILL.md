---
name: distill
description: Runs before the deuce lifecycle. The HC brings a raw problem or a chapter to ratify; one question at a time, each with a recommendation, until it is an epic brief with children an AC with no history could start planning from — Glossary entries and decision records captured as they settle.
---

# distill — before the lifecycle

The packaged procedure for the job [the audit](../../sds/01-lifecycle-and-skills.md#the-audit)
ports as `distill`, run before the lifecycle begins. What it produces, and the bar each output
clears, is canon and is not restated here — the epic brief and its exit test
([Chapter 0 → Work Tracking System](../../sds/00-identity-and-governance.md#work-tracking-system)),
Glossary entries ([Chapter 0 → Vocabulary](../../sds/00-identity-and-governance.md#vocabulary)),
decision records
([Chapter 0 → Decision records](../../sds/00-identity-and-governance.md#decision-records)), and
the ratification session
([Chapter 0 → Ratification](../../sds/00-identity-and-governance.md#ratification)). The loop
itself is this body's own content, re-authored from the families attributed below: canon fixes
what lands; this file fixes how the session gets there.

## When it is invoked

- The HC brings a raw problem — work with no epic behind it yet.
- Or the HC brings a chapter to ratify — this session is how the ratification session settles its
  open questions ([Chapter 0 → Ratification](../../sds/00-identity-and-governance.md#ratification)).

## Procedure

1. **Read what the HC brought** — the raw problem as stated, or the chapter draft on its pull
   request — and every artifact it names.
2. **Explore before asking** — canon, [`GLOSSARY.md`](../../GLOSSARY.md), the live decision
   records, and whatever the problem touches, as the repository actually is. A question the
   repository can answer is never put to the HC.
3. **Read the session's routing** — which model and effort runs it is
   [`config/models.md`](../../config/models.md); what may be offloaded, and in what shape, is
   [`config/delegation.md`](../../config/delegation.md).
4. **Read [`rules/authoring.md`](../../rules/authoring.md) before the first question** — every
   question and capture is written for the HC to read.
5. **Open the landing surfaces at the first settlement, not at the end.** On a raw problem:
   restate the problem, agree it with the HC, and open the `EPIC:` with its Problem field — the
   remaining fields fill as answers land
   ([Chapter 0 → Work Tracking System](../../sds/00-identity-and-governance.md#work-tracking-system)).
   Ratifying: the chapter's pull request is the surface, amended in place. File-side captures —
   Glossary entries, decision records — ride the chapter's pull request when ratifying; otherwise
   one session, one branch, one pull request, opened at the first capture and merged alongside the
   brief at the Ship gate's current setting ([`config/gates.md`](../../config/gates.md)).
6. **Put one question, with a recommendation and its reasoning** — settling first what other
   questions hang on. Shape every proposal against the SDS as it forms; work no chapter sanctions
   is a request for a chapter, never a workaround
   ([Chapter 0 → The bootstrap exception](../../sds/00-identity-and-governance.md#the-bootstrap-exception)).
7. **Wait.** Never a second question before the answer. An answer stated plainly stands — it is
   not re-asked.
8. **Land the answer before asking the next question:** a rejected path into the brief's punted
   paths now, with its reason; a settled term into [`GLOSSARY.md`](../../GLOSSARY.md) now; a
   settled decision into the brief or the chapter, where it stays — a decision record exists only
   by clearing the three-part bar, cited from the brief, and not writing one is the default
   ([Chapter 0 → Decision records](../../sds/00-identity-and-governance.md#decision-records)).
9. **Close the round with the count of branches still open**, and return to step 6 until it
   reaches zero. The count may rise before it falls — an answer can open more than it closes.
10. **Prove the brief by decomposition** — cut the children as `TASK:` / `SPIKE:` issues, each
    one branch and one pull request, each writing `Part of #N` with no closing keyword near the
    epic reference, each born `status:ready`; the set covers the brief with nothing left implicit
    ([Chapter 0 → Work Tracking System](../../sds/00-identity-and-governance.md#work-tracking-system)).
    Ratifying, the close-out is Ratification's own and is not run from this file
    ([Chapter 0 → Ratification](../../sds/00-identity-and-governance.md#ratification)).
11. **Run the exit test** — could an AC with no history start planning from the brief alone? The
    session is not finished until the answer is yes
    ([Chapter 0 → Work Tracking System](../../sds/00-identity-and-governance.md#work-tracking-system)).

## Terminal artifact

Plural, landing where each output lives: the epic brief on the `EPIC:` with its children, plus
the Glossary entries and decision records captured during the session on its pull request — or,
ratifying, the settled chapter on its own pull request
([Chapter 0 → Ratification](../../sds/00-identity-and-governance.md#ratification)).

## When it stops and asks

On any of the four standing triggers —
[Chapter 1 → Stops](../../sds/01-lifecycle-and-skills.md#stops). The loop's questions are the
work of this Skill, not stops; a stop is the session itself blocked. The question and its answer
are recorded on the epic once it exists — before that, on the session's pull request — before the
answer is acted on.

## Prior art

Re-authored from a reading of four families, per
[ADR 0006](../../adr/0006-skills-self-contained.md) — read and attributed, never vendored:

- [ace's `distill`](https://github.com/wrburgess/ace/blob/main/skills/distill/SKILL.md), itself
  adapted from Matt Pocock's `grill-with-docs` — an upstream attribution carried here rather than
  dropped in translation;
- [Matt Pocock's `grill-with-docs`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md),
  with the
  [`grilling`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)
  and
  [`domain-modeling`](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md)
  bodies it invokes;
- [obra/superpowers' `brainstorming`](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md);
- [mattpocock's `wayfinder`](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md).
