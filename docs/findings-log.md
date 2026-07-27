# Findings Log

Outcome 3 of the four-outcome rule-suggestion disposition
([`PROJECT.md`](../PROJECT.md) → *Human Gates* → *Rule-suggestion disposition*, shipped in
[#187](https://github.com/wrburgess/bryce/pull/187)): a lesson real enough to record, but not yet
earning a Tier-1 bullet or a guard.

**Deliberately one append-only file, not one issue per finding** — an issue per finding is the
accretion that section exists to stop. Following this repository's absent-until-needed convention, it
was created when the first finding was recorded, never as an empty placeholder.

Each entry carries: normalized failure class · severity and blast radius · enforcement status ·
recurrence count · the PR or issue that surfaced it · date recorded · **review date** (absolute,
= recorded + 90 days).

**How an entry ends.** [`final`](../skills/final/SKILL.md) sweeps this log at the start of its
disposition step and processes every **active** entry whose review date has passed. Recurrence `0` and
nothing having cited it → **archive**. Recurrence `≥ 1` → eligible for *enforce* or *retain a concise
rule*, entering that run's disposition. **The default at expiry is archival, never promotion.** An entry
is *active* until it sits under `## Archived` and *archived* once it does; that heading is the entire
boundary. A later recurrence opens a **new** entry citing the archived one rather than reviving it,
carrying the recurrence count forward.

---

## Active

### F001 — A measurement of today's corpus was used to license a behavior widening

- **Normalized failure class:** measurement-as-guard — treating "this does not occur in the corpus
  today" as sufficient justification for *widening* what a checker exempts, rather than as the
  snapshot it is.
- **Severity and blast radius:** **High** as it occurred. Two Tier-1 checks (`checkRulesPointers`,
  `checkRulesDuplicateKeys`) went silent on any bullet carrying a stray four-space indent — a typo, not
  a marked-up code example. Blast radius is the whole Tier-1 tree, and the failure is silent: the gate
  stays green while enforcing nothing on the affected lines.
- **Enforcement status:** **the specific defect is enforced** — narrowed to fenced-only, with
  regression tests in `test/tooling/parity-rules-pointers.test.ts` and
  `test/tooling/parity-rules-duplicate-keys.test.ts` that redden when it is re-introduced
  (mutation-verified). **The general lesson is not enforceable** — "is this justification a snapshot?"
  is a judgment about an argument, not a property of the code.
- **Recurrence count:** 0 (first occurrence).
- **Surfaced by:** [PR #188](https://github.com/wrburgess/bryce/pull/188) (issue
  [#179](https://github.com/wrburgess/bryce/issues/179)), Stage-4 Reviewer, High finding.
- **Date recorded:** 2026-07-27
- **Review date:** 2026-10-25

**Why outcome 3 rather than 2.** The nearest existing Tier-1 bullet is `rules/testing.md`'s *"Never read
a generated corpus's silence as a statement about the real one"* — which is the **mirror** of this, not
this. That bullet says a *generated* corpus cannot speak for the real one, and its remedy is "run the
guard over the actual corpus." Here the guard **was** run over the actual corpus, all 102 bullets and 30
pointers, and the measurement was correct — it just did not license the widening it was offered for. The
gap is adjacent and narrow.

Outcome 2 is unavailable regardless: the **minting freeze** is in force until the bounded corpus review
dispositions the 45 loop-added bullets measured in
[#185](https://github.com/wrburgess/bryce/issues/185). Recording it here keeps the observation without
growing Tier 1 during the freeze, and lets recurrence — not an author's conviction in the moment it was
learned — decide whether it earns a bullet.

**If it recurs:** promote toward *enforce* first. The mechanically checkable form, if one exists, is a
check that any widening of a checker's exemption set ships with a test proving the newly-exempted shape
is one an author marked deliberately, rather than one a formatting accident produces.

---

## Archived

_None yet._
