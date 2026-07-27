# A Tier-1 invariant may be stated in both moods, keyed on the failure mode

**Status:** accepted

A `rules/*.md` invariant **may** appear in both `## Patterns` and `## Anti-Patterns`. The mirrored pair
is the Tier-1 Lean Core's **convention**, not accretion, and consolidating one was **rejected**.

The unit that earns a bullet is the **failure mode**, not the principle: one Pattern may be mirrored by
as many Anti-Patterns as there are distinct ways to get it wrong, each carrying its own mechanism and
consequence. What is forbidden is a second bullet for the *same* failure mode, or a pair whose halves
are written in the same mood.

This refines [ADR 0004](0004-two-tier-rules-layer-progressive-context.md) — which makes Anti-Patterns a
required, first-class section — by saying when a Pattern may state the same invariant. It does not
supersede it.

## Why this was asked

[Issue #160](https://github.com/wrburgess/bryce/issues/160) observed that `rules/backend.md` states the
`issue #54 / PR #62` lesson twice: once as a Pattern ("Confirm an external source's actual fields before
coding around an assumed absence") and once as an Anti-Pattern ("Never infer that an external source
lacks a field by reading the adapter's mapping table alone"). It asked whether the mirroring is
deliberate redundancy or accretion, proposed keeping the Anti-Pattern alone, and — decisively — asked
that the other Tier-1 files be audited **before** generalizing, on the grounds that "a one-off merge that
contradicts `rules/testing.md`'s shape would be worse than the duplication."

The context was a leanness push: [#152](https://github.com/wrburgess/bryce/issues/152) →
[#151](https://github.com/wrburgess/bryce/issues/151) →
[PR #156](https://github.com/wrburgess/bryce/pull/156), the last of which set out to slim
`rules/backend.md` and finished **+192 characters** larger, concluding that the file's weight is
instruction density rather than accreted narrative. This pair was the largest single-lesson cost left.

**The audit inverted the premise.** `rules/backend.md` is the *least*-mirrored Tier-1 file, not an
outlier for having a pair.

## The audit

Mirrored pairs — a Pattern and an Anti-Pattern stating one invariant in opposite moods — across all
seven Tier-1 files. Every pair was checked against the bar, not merely counted:

| File | Patterns | Mirrored pairs | What earns each pair its two bullets |
|---|---|---|---|
| `rules/frontend.md` | 4 | **3** | Native-first ↔ **two** anti-patterns; named units ↔ untestable inline scripting; design system ↔ inline styles (the Anti-Pattern uniquely carries the mailer exception) |
| `rules/skills.md` | 4 | **3** | The Pattern carries the action; the Anti-Pattern carries the drift mechanism ("forks the single source of truth, and the copy silently drifts") |
| `rules/security.md` | 5 | **3** | The Anti-Pattern carries the **threat model** the Pattern has no room for — who repoints a mutable tag, and what `"   "` or `["", nil]` does to a presence check |
| `rules/testing.md` | 8 | **4** | Includes a **same-provenance pair** (issue #25) — structurally identical to the one #160 proposed to remove |
| `rules/scripting.md` | 3 | **3** | Each Anti-Pattern is a specific failure mode of a general Pattern, carrying host opt-ins and ADR references |
| `rules/self-review.md` | 5 | **4** | Quality gate ↔ never declare done on a red check; worktree base ↔ never diff against a worktree's local `main`; planned-item tests ↔ never ship minimal assertions; cite what states the claim ↔ never cite a source that doesn't support it |
| `rules/backend.md` | 8 | **1** | The `#54 / PR #62` pair |

**21 pairs across seven files. `rules/backend.md` mirrors one invariant in eight; every other file
mirrors at least three.** Five of the seven mirror a *majority* of their Patterns
(`scripting.md` 3/3, `self-review.md` 4/5, `frontend.md` 3/4, `skills.md` 3/4, `security.md` 3/5);
`testing.md` mirrors exactly half (4/8); `backend.md` is alone at 1/8.

Three findings decided it:

- **Consolidating `rules/backend.md`'s single pair would make it the one file that does not follow the
  convention** — the opposite of the consistency the change was reaching for.
- **`rules/testing.md` already carries a same-provenance pair.** Issue #25 appears in both moods there:
  "Enforce the offline-test invariant fail-closed" and "Never construct a default/real provider client in
  a default-suite test, or reach a live service." Consolidating one and not the other is exactly the
  contradiction #160's own step 3 forbids; consolidating both is a Rules-Layer-wide rewrite that removes
  roughly fifteen Anti-Pattern bullets and hollows out a section ADR 0004 makes required.
- **The disputed lesson's own provenance is already mirrored in a second file.**
  `rules/self-review.md` pairs "In a git worktree, base your diff and any reviewer-summon on
  `origin/main`" with "Never diff, self-review, or summon a reviewer against a git worktree's local
  `main`" — and the Anti-Pattern carries `(Provenance: issue #54 / PR #62)`, **the same issue and PR as
  the `rules/backend.md` pair #160 asked about.** The same piece of work produced a mirrored pair in two
  different rule files. Whatever else the mirroring is, it is not a one-off accident in `backend.md`.

**This last finding was missed on the first pass and caught by the independent Reviewer**, which is
worth recording because the error was structural rather than careless. `docs/rules/README.md`'s trigger
table lists `rules/self-review.md`'s deep doc as *"(none — the checklist is the whole rule)"*, and that
phrase was carried over as though it meant the file had no pairs to count. It has `## Patterns` and
`## Anti-Patterns` sections like every other Tier-1 file, and four pairs — the second-highest ratio in
the tree.

The first draft's own measurement table contradicted it: the verbatim-overlap ranking below places
`rules/self-review.md` **first**, at 39 characters, and the text it ranks
(``on `origin/main` (after `git fetch`)``) is precisely the pair the audit table had scored as zero. Two
tables in one document disagreeing is a harder failure than a debatable judgment call, and it survived
authoring, a self-review, and an adversarial pass before an independent model caught it.

**The count is a judgment under the stated definition, not a mechanical tally.** A pair is counted when
one invariant appears in both moods; reasonable readers could score one or two differently, and the
argument does not rest on the exact number — it rests on the shape being the norm in six of seven files
while `rules/backend.md` carries one.

**The bar is not a rubber stamp, and the thinnest pair is worth naming rather than leaving for a
reviewer to find.** `rules/frontend.md`'s "Behavior in named, testable units" ↔ "Never write untestable
inline behavior scripting in a template/view" is the marginal case: the Anti-Pattern's remedy ("move it
into a named, testable behavior unit") restates the Pattern almost exactly, and what the Pattern
uniquely adds — *discoverable*, easy to **find** — is thin. It passes, because the Anti-Pattern still
carries a mechanism the Pattern does not ("it can't be reused or tested") and the Pattern still names
the positive action. But it passes narrowly, and it is the pair to revisit first if this convention is
ever tightened. Every other pair clears the bar with room.

## The audit corrected the bar — the case that shaped it

The bar was first drafted as "an invariant gets at most two bullets, one per mood." Applying it to the
other files, rather than only to the pair under discussion, **found that clause wrong before it shipped.**

`rules/frontend.md` maps one Pattern to **two** Anti-Patterns. "Native / server-driven interactivity
first" is mirrored by both "Never run a second, parallel UI rendering paradigm" (mechanism: fractures the
established model, doubles the rendering stack) and "Never add a parallel DOM-manipulation idiom"
(mechanism: a second idiom reintroduces a parallel, untested path). Those are two genuinely different
ways to violate one principle.

A convention forbidding a third bullet would have declared that pair non-conforming **the day it was
written** — a rule whose first act is to condemn an existing, correct file. That is the same class of
error #160's step 3 exists to prevent, reached from the opposite direction, and it is the argument for
keying the bar on the **failure mode** rather than the principle.

It is also why the audit is recorded here rather than summarized as a count. A count would not have
caught this.

## Why the redundancy is deliberate — and the rationale that was rejected

**The rejected rationale, stated because it is the intuitive one and it is wrong:** that the two sections
are consumed at different moments by different readers — a Pattern read by an author before the code
exists, an Anti-Pattern read at review time against code that already exists — so each section must
stand alone.

The repo contradicts this. Nothing loads `## Anti-Patterns` alone: [`AGENTS.md`](../../AGENTS.md)'s
trigger table binds a *file* to a working context, not a section, and
[`skills/create-skill/SKILL.md`](../../skills/create-skill/SKILL.md) cites "the Patterns and
Anti-Patterns" together as a single surface. **Every consumer reads a rule file whole.** The
separate-consumption argument is not merely unevidenced; it is false here, and building the convention on
it would have made the convention unfalsifiable in the wrong direction.

**The rationale that survives** is the one ADR 0004 already recorded: the two moods are not two
audiences, they are **two framings of one invariant**, and the imperative-negative form "has proven
effective at steering agents away from choices we never want" — which is why 0004 makes it a *required*
section rather than an optional one. The redundancy is an **instructional** choice, not an access-path
one.

That is a weaker claim than the rejected one, and it carries a consequence taken rather than hidden:
because the file is read whole, duplicated prose is a real context cost with **no** offsetting
access-path benefit. Restating the shared invariant and the remedy in both moods is therefore
**tolerated** — five files do it — not *justified*. What must not be tolerated is a bullet that spends
its length re-explaining the other mood's job.

## No mechanical guard, and the measurement that says so

[ADR 0051](0051-tier-1-per-bullet-narrative-budget.md) set the precedent that a Tier-1 convention gets a
checker, and `rules/scripting.md` warns against shipping prose a guard does not enforce. A guard was
considered here and **rejected on measurement.**

The obvious candidate is a verbatim-overlap check between bullets in one file. Longest common substring
between every pair of bullets within each Tier-1 file, with `*(…)*` parentheticals stripped:

| Rank | File | Longest shared run | Text |
|---|---|---|---|
| 1 | `rules/self-review.md` | 39 | ``on `origin/main` (after `git fetch`)`` |
| 2 | `rules/security.md` | 33 | "into the required workflow so a" |
| 3 | `rules/scripting.md` | 29 | host opt-in boilerplate |
| 4 | `rules/skills.md` | 28 | ``at `skills/<name>/skill.md` `` |
| 5–6 | `rules/testing.md`, `rules/skills.md` | 27 | — |
| **7** | **`rules/backend.md`** | **26** | **"fixture or a live sample"** |

**The pair this issue was filed about is a paraphrase, not a copy-paste** — 26 characters of verbatim
overlap, ranking *seventh*, behind six unrelated pairs. A threshold low enough to catch it reddens on
ordinary shared vocabulary across all six files. There is no threshold that separates signal from noise,
so no such guard is built.

The convention is therefore **prose-only, deliberately.** The bar it sets — "each bullet carries content
the other lacks" — is a semantic judgment a structural checker cannot make without false reds on every
legitimate pair in five files. The mechanically checkable part of Tier-1 bloat already has its guard:
ADR 0051's per-bullet narrative budget. This is recorded so the next leanness pass does not re-propose a
checker that was measured and rejected rather than overlooked.

## What changed in `rules/backend.md`

Both bullets of the `#54 / PR #62` pair **pass the bar and are kept.** The Pattern uniquely carries the
"factual claim, owed the same citation discipline as any other" framing and its `rules/self-review.md`
cross-reference; the Anti-Pattern uniquely carries the consequence — an unmapped-but-present field reads
as "missing" and any fail-closed path built on it silently drops real data.

One tightening: the Pattern re-explained *why* the mapping table misleads ("which shows only the fields
you chose to read"), which is the Anti-Pattern's because-clause doing its job. The Pattern needs to name
the wrong source, not diagnose it. That clause is removed; "not the adapter's own mapping table" stays,
so the Pattern still reads on its own.

**This is a small change and is not oversold.** The bullets were **592** and **526** characters and the
Pattern is now **545** — a 47-character saving. It was already eight under the 600 cap, and exempt at any
length in any case because it carries its deep-doc pointer. #160 sketched a 906 → ~450 reduction; the
evidence does not support one, and the honest deliverable is the convention plus a modest trim.

The unit is worth pinning, because it was got wrong once during review and the wrong number is the
plausible one: `checkRulesNarrative` measures the **raw line including the `- ` list marker**, exactly as
[ADR 0051](0051-tier-1-per-bullet-narrative-budget.md) specifies ("syntax included — `- **`, backticks,
emphasis and link markup all count", because the Lean Core is loaded verbatim into every session). A
review pass reported 590, i.e. the marker stripped; forcing the guard to fail on a deliberately oversized
copy of this bullet had it report **839** against a raw line of 839, which settles it. Measure what the
checker measures.

## Consequences

- **Documented for contributors in [`docs/rules/README.md`](../rules/README.md) → _Convention: an
  invariant may be stated in both moods_**, alongside the two conventions already there. As with
  ADR 0051, it is deliberately **not** added as a `rules/*.md` bullet — a Tier-1 bullet about how to
  write Tier-1 bullets is the shape the Lean Core exists to avoid.
- **The convention is permissive, so its deletion clause is load-bearing.** "An invariant may appear in
  both moods" invites bullets added in pairs by default. The bar contains it only if the negative case is
  stated as an instruction: a bullet carrying **only** the other mood's content is accretion and gets
  **deleted**, not kept for symmetry. Written without that clause, this becomes a licence.
- **The Anti-Patterns section is protected.** ADR 0004 makes it required; a consolidation rule that
  removes an Anti-Pattern whenever a Pattern covers the same ground would shrink it as the Patterns
  section grows, degrading the steering effect 0004 credits to the imperative-negative form — a
  regression with no test to catch it.
- **Net-negative on bytes, deliberately.** This ADR plus the convention section cost far more than the
  47 characters trimmed from `rules/backend.md`. The justification is not leanness: it is that the
  question had been rediscovered four times (#152 → #151 → #156 → #160) because the answer had never been
  written down. The next pass reads the convention instead of re-litigating it.
- **`PR #156`'s conclusion stands and is narrowed.** Relocation to Tier 2 has nothing left to take from
  `rules/backend.md`, and consolidation — the remaining lever it named — is now closed as a general
  strategy. Tier-1 leanness from here comes from writing tighter bullets, not from removing moods.
