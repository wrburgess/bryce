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
  to the parser this file already depends on, authored once as `codeBlockLines`. That is
  [ADR 0054](0054-code-spans-are-not-links.md)'s answer applied to block structure, and
  `rules/scripting.md`'s standing instruction to run the format's own parser. Verified behavior-preserving
  on the real tree: the same 102 bullets, before and after.
