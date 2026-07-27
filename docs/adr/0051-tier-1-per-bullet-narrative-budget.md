# Tier-1 accretion is guarded per bullet, not per file

**Status:** accepted

The Tier-1 Lean Core (`rules/*.md`) is guarded against accretion by a **per-bullet** check in
`scripts/parity-check.ts` (`checkRulesNarrative`): a bullet longer than **600 characters** that does not
carry its own domain's case-study pointer fails the parity gate. A **per-file byte budget was considered
and rejected.**

This makes [ADR 0004](0004-two-tier-rules-layer-progressive-context.md)'s consequence — *"a rule that
grows heavy is a signal to push detail down to Tier 2, not to bloat the core"* — mechanically enforced
rather than merely stated.

## Why a guard at all

PR #149 (issue #148) trimmed `rules/testing.md` from 6,712 to 5,906 bytes and moved its case narrative
to Tier 2. Nothing mechanically prevented the accretion from resuming, and **it resumed in the very next
merged PR**: `7856eda` added three bullets, taking `rules/testing.md` to 6,964 bytes — larger than
before the trim — and `rules/backend.md` from 8,799 to 9,630.

Crucially, **those three bullets were good.** Each stated a genuine, transferable invariant. The failure
was not inattention or low quality, so more review attention would not have prevented it; nothing in the
process asked the author whether the *narrative* inside those bullets belonged in Tier 2. That is the
gap this ADR closes.

## Why per bullet and not per file

A per-file byte budget is the obvious mechanism — the repo already runs exactly that shape for coverage
(`scripts/coverage-floors.ts` + a pinned manifest). It was rejected on evidence, not taste:

- **It measures a proxy.** The real invariant is "Tier 1 carries the lesson, Tier 2 carries the
  narrative." A long bullet that is all imperative is fine; a short one that hides its rationale behind
  a link is not (`rules/skills.md` forbids the latter outright). Byte count cannot encode that
  distinction.
- **It gets the actual cases backwards.** Calibrated post-#149, a byte budget would have reddened on
  `7856eda`'s three good bullets while staying silent on `rules/scripting.md`'s 1,454-character inline
  narrative — the worst offender in the tree, sitting in a file the budget blessed.
- **Its ratchet turns the wrong way.** The predictable response to a red budget on a defensible lesson
  is to raise the budget. A ceiling that only ever rises launders accretion as approved, which is worse
  than no ceiling: it makes the status quo look endorsed.
- **Calibrating it endorses today's sizes.** A budget set at current numbers blesses `rules/backend.md`
  at 9,630 bytes — a file [#151](https://github.com/wrburgess/bryce/issues/151) exists to shrink.

The per-bullet check has none of these properties. A file may grow without limit in well-shaped lessons;
what fails is the specific act of writing a case study inline.

## The threshold, and what it is not

`NARRATIVE_MAX_CHARS = 600`, measured in JavaScript `String.length` — **characters, not bytes**. These
files are dense with em dashes (one character, three UTF-8 bytes), and characters are the honest unit
for "how much must a reader take in".

Calibrated against the tree at the time it landed: 90 Tier-1 bullets, of which **8** trip at 600
(1454 / 943 / 909 / 824 / 686 / 619 / 618 / 607). The 9th-longest bullet overall is 604 characters
(`rules/skills.md`) but is **exempt** — it already carries its case-study pointer; the longest
*non-exempt* bullet below the threshold is 589.

**600 is not a claim about how long a good bullet may be.** A bullet carrying its pointer is exempt at
any length, so the number never asks more of a bullet that has already been trimmed. It is the length
above which an un-pointered bullet is worth a second look.

Five of the eight grandfathered bullets were `rules/backend.md` bullets that #151 independently targets —
the check rediscovered that list from shape alone, which is the evidence that it tracks the real
invariant rather than a proxy.

**The ratchet was exercised for real before this ever merged.** While the guard was in review, #151
landed on `main` and trimmed exactly those five bullets. Merging `main` in turned parity **red**, with
five "no longer needed — remove the entry" errors, and stayed red until they were deleted. In the same
window two *other* bullets grew past the limit on `main` — `rules/scripting.md` (1,078 chars) and
`rules/skills.md` (753, up from 390) — and were grandfathered in turn. The delivered baseline is
therefore **five**, not eight, with `rules/backend.md` cleared entirely.

That churn is worth stating plainly, because it is the argument: in the days it took to review a guard
against Tier-1 accretion, Tier-1 accreted twice more and was trimmed once. The premise of issue #152
restated itself three times during the fix.

**The measurement is wrap-invariant, and the marker is matched as CommonMark defines it.** Both of
these were wrong in the first implementation, and both were false greens of the worst kind — reachable
by accident, invisible in the rendered document:

- A bullet is measured across its wrapped continuation lines, joined the way markdown renders them,
  **including CommonMark's *lazy* continuation at column zero**. Measuring only the first line meant any
  prose-wrapper — an editor reflow, `gq`, a formatter with `proseWrap` on — would have silently disabled
  the guard for the **entire tree at once**. Requiring the continuation to be *indented* (the first fix)
  still left the plain hard-wrap flavor wide open while looking closed.
- The marker is `/^\s*[-*+][ \t]+/`, not the literal four bytes `- **` today's files use. CommonMark
  treats one-to-four spaces or a tab after any of `-`/`*`/`+` as identical padding, so `-  **Never …**`
  — one accidental keystroke — rendered as an ordinary bullet while being wholly invisible to the check.
  The set that *terminates* a bullet is kept in lockstep with the set that *starts* one, or a
  star-marked bullet gets absorbed as prose by its dash-marked neighbour.

- The set of line shapes that **end** a bullet demands exactly the padding CommonMark demands. The ATX
  heading rule is the one that bites: `#` *not* followed by a space, tab, or end-of-line is literal
  text, not a heading — and these files are made of `#152`-style issue references, so treating a bare
  `#` as a block opener ended the bullet at any wrap that happened to break before one, and counted the
  remainder toward nothing at all.

Today's rule files happen to write one bullet per line with one marker spelling, which is precisely what
made these assumptions dangerous to encode. The first was caught by the Stage-4 adversarial pass; the
lazy-continuation flavor and the marker spelling by the independent Reviewer; the ATX-padding gap by the
Reviewer again, on the delta that answered its own first review.

**Length is measured over the raw source, syntax included** — `- **`, backticks, emphasis and link
markup all count. That is deliberate and not an oversight: the Lean Core is loaded **verbatim into every
agent session**, so raw characters are the actual context cost this guard exists to bound. Rendered
reading length is the wrong unit for the thing being protected.

## Rejected sub-decisions

- **Requiring a `(Provenance: …)` tag** (as issue #152 originally proposed: over N chars *and* tagged
  *and* un-pointered). Measured, the tag clause exempts nothing at N = 600 — the trip set is identical
  with or without it — while leaving a one-token bypass: delete the tag, silence the check. Dropped.
  This *widens* what counts as a violation, which can only add errors; the guard-widening anti-pattern
  in `rules/scripting.md` warns about the opposite direction (widening what a guard *accepts*, which
  can mask a real violation).
- **Exempting on any `docs/rules/*-postmortems.md` pointer.** A `rules/backend.md` bullet could then be
  silenced by appending an unrelated domain's path. A bullet is exempted only by **its own** domain's
  deep doc.
- **Keying the allowlist by line number.** A line number silently re-points at whatever bullet later
  occupies that line — the exact false green the guard exists to prevent. Entries are keyed by the
  bullet's exact bolded imperative.

## The allowlist only shrinks

The eight bullets already over the limit are grandfathered in `NARRATIVE_ALLOWLIST`. Deleting an entry
(by trimming its bullet) is welcome and needs no other edit; **adding** one is a deliberate, reviewable
act. The allowlist is checked as strictly as the bullets: an entry naming a non-Tier-1 file, matching no
bullet, matching more than one, or covering a bullet that no longer trips is itself a parity failure.

That last case is what makes this a ratchet rather than a wish — trimming a bullet turns the gate **red**
until its now-pointless entry is removed, so the backlog cannot quietly stop shrinking. It is the
fail-closed discipline `scripts/coverage-floors.ts` applies to a floored path missing from the report,
transplanted.

## The remedy is read from disk, in three states

Three of the six domain deep docs do not exist yet — `docs/rules/README.md` says they stay *"absent
until a host has a real postmortem to record"* — and pointing at an absent one fails
`checkRulesPointers`. A message advising "just add a pointer" would therefore march a contributor
straight into a second, differently-worded failure. So the error text is chosen from the deep doc's
state on disk: **none by design** (`self-review`) → shorten; **present** → point at it or shorten;
**declared but absent** → author it first, then point at it, or shorten. Reading disk rather than a
hardcoded list also means the advice updates itself the day a host writes its first postmortem for a
domain.

## Consequences

- The check rides `scripts/parity-check.ts`, already row 1 of `PROJECT.md` → *Quality Checks* and
  already run in CI. **No new gate row and no new call site** was introduced, so there is no new
  invocation that could be deleted to silently disable it (`rules/testing.md`).
- **Known limitation, stated rather than papered over:** a bullet can be exempted by a pointer to a deep
  doc that carries no matching entry. Neither this check nor `checkRulesPointers` notices — the latter
  verifies the *file* exists, not that it holds the case. Closing it would mean inferring which entry
  belongs to which bullet, which is a heuristic on a heuristic; the deep doc's own structural test
  (`test/tooling/parity-rules-pointers.test.ts` does this for `testing-postmortems.md`) is the better
  place for that pressure.
- **Known limitation, inherited:** an unclosed or length-mismatched code fence leaves the scanner inside
  a fence for the remainder of the file, so every later bullet is skipped. This is `checkRulesPointers`'s
  fence handling, mirrored deliberately so the two checks agree on what is code; fixing it belongs in one
  place, for both. It is loud rather than silent — an unclosed fence renders visibly wrong.
- **The exemption accepts both sanctioned pointer spellings, and requires each to resolve.** This
  reversed during the PR, and the reversal is instructive. The Reviewer first asked for `../`-relative
  pointers to be accepted; that was declined, correctly at the time, because `checkRulesPointers` then
  *ignored* traversal forms and so never verified such a target existed — accepting one would have been
  an exemption backed by a path nothing validates. Then issue #154 landed on `main` and **changed that
  premise**: `resolvesFrom` now resolves and validates a promoted link, and `docs/rules/README.md` now
  instructs contributors to promote a pointer to `[…](../docs/rules/x-postmortems.md)` once its target
  exists. Holding the original position past that point would have meant one check telling a
  contributor to promote a pointer and another telling them to un-promote it. So the guard now accepts
  a backticked repo-root path **or** a promoted link, each validated against the same base
  `checkRulesPointers` uses for that form. Resolution is still required: presence alone exempts
  nothing, and a resolving pointer to *another* domain's deep doc still exempts nothing.

  The two checks share those bases but not their input — `checkRulesPointers` reads one physical line,
  this guard reads the bullet's joined text — so a link broken across a wrap reads as adjacent here and
  not there. That divergence only ever *grants* an exemption, and only for a path `resolvesFrom`
  actually finds on disk, so it cannot produce a false green; it is why the claim here is "the same
  bases", not "identical behavior".
- Completing #151 becomes a **measurable** ratchet step: five allowlist entries must be deleted, and the
  gate enforces it.
- Documented for contributors in `docs/rules/README.md` → *Convention: a Tier-1 bullet carries the
  lesson, not the case study*. Deliberately **not** added as a `rules/*.md` bullet — a long Tier-1
  bullet about not writing long Tier-1 bullets is the shape this ADR exists to prevent.
