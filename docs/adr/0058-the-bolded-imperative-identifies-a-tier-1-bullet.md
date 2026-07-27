# The bolded imperative identifies a Tier-1 bullet

**Status:** accepted

A bullet's **bolded imperative** — the `**…**` run opening a `rules/*.md` bullet — is its **identifier**,
and an identifier must name one thing. No imperative may occur twice across the Tier-1 tree.

Equality is **exact**: case-sensitive, whitespace-significant, and Unicode-**unnormalized**. There is
**no allowlist**; the remedy for a collision is to reword one imperative.

This is enforced by `checkRulesDuplicateKeys` in `scripts/parity-check.ts`
([issue #179](https://github.com/wrburgess/bryce/issues/179)).

## Why this was asked

[ADR 0051](0051-tier-1-per-bullet-narrative-budget.md) built the per-bullet narrative budget on a
`NARRATIVE_ALLOWLIST` **keyed by the bolded imperative**, deliberately rather than by line number: a line
number silently re-points at whatever bullet later occupies that line, which is the false green that
guard exists to prevent. Keying on the imperative buys a ratchet a human can audit in a diff — an entry
that no longer matches a bullet is itself an error, so the backlog cannot quietly stop shrinking.

That design rests entirely on the imperative being **unique**, and nothing enforced it.

`checkRulesNarrative` does report an ambiguous key — *"matches N bullets - an ambiguous key cannot exempt
one bullet"* — but that report lives inside `for (const key of allowed)`. It fires only for a key already
**in** the allowlist. Two non-allowlisted bullets could share an imperative, in one file or across two,
and the gate stayed green while the identifier property it depends on was silently broken.

The Reviewer caught this at the plan stage of [#166](https://github.com/wrburgess/bryce/issues/166), when
the plan proposed using that very error as a general duplicate check. It looks like one and is not.
[PR #174](https://github.com/wrburgess/bryce/pull/174) answered it by hand — a one-shot scan finding 95
bullets and 0 duplicates. That is a **measurement, not a guard**: it does not run again tomorrow. The
corpus was 102 bullets by the time this ADR was written, which is also why the number was re-measured
rather than inherited.

## The decision, and the three parts that needed deciding

### Scope is the tree, not the file

Per-file uniqueness is all the allowlist's lookup strictly needs — `NARRATIVE_ALLOWLIST` is keyed by file
first. The tree-wide rule was chosen anyway, because the claim being made is that the imperative **names**
a bullet, and a name that identifies two things is not a name. A guard closing only the provable half
would be named `checkRulesDuplicateKeys` while enforcing something narrower, which is the shape of
false-green this issue was about.

It costs nothing measurable today: **102 bullets, 102 distinct imperatives**, measured on the
implementing branch. If it ever costs a reword, the reword is the right outcome.

### No allowlist

Every other ratchet in this checker carries a grandfathering table. This one deliberately does not. An
exemption table for a *uniqueness* guard would key its entries by the very string whose ambiguity it is
exempting — the defect wearing the remedy's clothes. A collision is resolved by rewording, always.

### Exact equality

Case-sensitive, whitespace-significant, Unicode-unnormalized. This is not a default inherited by
accident; it is the only rule that **matches the property being protected**. Allowlist lookup is
`allowed.includes(key)` — exact. Two imperatives differing only by NFD/NFC composition are two distinct
keys, an allowlist entry matches exactly one of them, and there is no ambiguity to report. A guard
stricter than the property it guards would invent collisions that break nothing.

## Relationship to ADR 0053 — the ordering trap

[ADR 0053](0053-mirrored-pattern-anti-pattern-pairs-are-the-tier-1-convention.md) **permits** one
invariant stated in both moods: a Pattern and its mirrored Anti-Pattern. That is the Tier-1 convention,
not accretion, and this ADR does not touch it.

The two coexist because they are about different things. ADR 0053's unit is the **failure mode**; this
one's unit is the **imperative text**. A mirrored pair is two bullets carrying two *different*
imperatives — "Construct the environment a test claims to cover" and "Never assert an invariant with a
comparison that normalizes away the difference it exists to catch" are not the same string — so a pair
never collides here.

**This rule must therefore never be restated as "one bullet per invariant."** That phrasing forbids
exactly what ADR 0053 requires. The risk is not hypothetical: it is what a contributor would infer from a
bare "duplicate" error, so the error message states the carve-out **in-line** rather than leaving it to
be looked up. This follows `rules/scripting.md` — *never ship a guard without first running its own
governing convention through it* — and the mirrored-pair case is a test, not a comment.

## Consequences

- **Standing cost.** Two domains that genuinely want the same imperative must word one of them
  differently. Accepted: distinguishing them is information a reader wants anyway.
- **The narrative allowlist's ambiguity error becomes unreachable in practice**, since a duplicate is now
  caught upstream. It is kept: it guards the allowlist's own contract, and a check that can only fire
  when another check is broken is a backstop, not dead code. The duplicate pass runs **first** in
  `run()`, so the cause is reported before the symptom.
- **No effect on `docs/rules/*-postmortems.md`.** Tier-2 prose has no bullet-identifier convention; only
  `REQUIRED_RULES` is scanned.
- **A shared fence rule fell out of it.** Both raw-text walks over `rules/*.md` carried their own
  `` /^\s*```/ `` toggle, so CommonMark's `~~~` fence was invisible to both and a bullet parked in one
  would have been read as live prose. Rather than teach two toggles a second character — a naive
  both-characters toggle is *worse*, closing a backtick block early — the fenced-line question now goes
  to the parser this file already depends on, authored once as `fencedCodeLines`. That is
  [ADR 0054](0054-code-spans-are-not-links.md)'s answer applied to block structure, and
  `rules/scripting.md`'s standing instruction to run the format's own parser. Verified
  behavior-preserving on the real tree: the same 102 bullets and the same 30 deep-doc pointers, in the
  same positions, before and after.

  **The exemption is deliberately narrower than the node type: fenced blocks only.** The first cut
  exempted every CommonMark `code_block`, which swept in *indented* ones the toggles never covered, and
  justified it by measuring today's corpus. The PR #188 Reviewer refuted that with a reproduction: one
  stray indent on a section's first bullet — no enclosing list to absorb it — makes CommonMark read real
  content as an indented code block, and both the pointer check and this new duplicate check went silent
  on it. A fenced example is content an author **marked** as code; four accidental spaces are a typo, and
  a guard whose entire subject is silent false greens must not ship one of its own. The corpus
  measurement was the tell rather than the defense — "no such indent exists today" is a snapshot, and
  `rules/testing.md` already says a corpus's silence is not a statement about tomorrow's. Both halves of
  the reproduction are now permanent regression tests.

  **Fenced-ness is decided structurally, and the second attempt was wrong too.** The first repair read
  the opening line the parser pointed at; the delta Reviewer refuted that as well — CommonMark reports
  `sourcepos` at the first *content* character for both node types, so an indented block whose content
  begins `` ``` `` reads as fenced to any text test, and the same false-green path reopened one layer
  down. Reading the text was still modelling the format. What ships instead is a property: a fenced
  block's source span includes delimiter lines that are not part of its content, an indented block's span
  is exactly its content, so **`span > content lines` is `fenced`** — a comparison that never inspects a
  character. It is checked against the parser's private `_isFenced` over 21 constructions and agrees on
  all of them; `fencedCodeLines` is exported so that table is a test rather than a claim in a comment.
  The private field itself is deliberately *not* used: no public accessor exposes it, so a minor
  `commonmark` bump could rename it and this guard would silently classify every block as indented.

  Two Reviewer rounds found the same defect class in two different disguises. That is the shape
  `rules/scripting.md` predicts — *enumerating harder does not converge, and thinning the candidate set
  is not a safe simplification either* — and the exit was to stop describing the format and compare a
  property instead.
