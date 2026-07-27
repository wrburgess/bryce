# 2026-07-27 — The baseline's dead-link scope silently excluded its own Rules Layer (bryce issue #159)

## F16 — `checkLinks` had a hardcoded file list, and `rules/*.md` was never on it

**Disposition: `upstream` · Status: recorded**

`scripts/parity-check.ts` — a Generic Baseline file — resolved markdown links only for a hardcoded list
of twelve paths. Every Tier-1 rule file in `rules/` carried links from the day the Rules Layer shipped,
and **not one of them was ever resolved**. So did every `skills/<name>/SKILL.md` (128 links in this
host's nine skills) and every Claude Invocation Shim (27 more).

Nothing announced the gap. The gate printed
`parity_check: OK - … and links all resolve.` while resolving none of them, which is the failure mode
[`rules/scripting.md`](../../rules/scripting.md) names in its own words: *nothing tells you it isn't
checking.*

**Why it could not simply be fixed by extending the list.** Both files that most needed the coverage are
prose that *teaches markdown*. [`rules/security.md`](../../rules/security.md) writes `` `![x](url)` ``
while explaining output escaping; [`docs/rules/README.md`](../rules/README.md) writes `[text](path)` four
times while explaining the deep-doc form rule. `MARKDOWN_LINK` is a plain regex with no notion of a code
span, so adding the files reported dead links to `url` and `path` — targets that are not links at all.
That is why upstream ADR 0051's own worked example, and the deep-doc convention itself, are written
around the checker rather than checked by it.

**Both halves are baseline-generic.** Neither the masking rule (CommonMark: a link inside code is not a
link) nor the derivation (every Tier-1 rule, every Skill body, every shim — from the same constants the
checker already has) contains one byte of stack or domain. A host with a Rails app, a Go service, or no
application code at all vendors the identical `rules/` and `skills/` layout and inherits the identical
gap. This clears the ledger's upstream test — *"would a project with a completely different stack and
domain hit the same thing?"* — without qualification.

**The fix as shipped here** (bryce PR for issue #159), all of it in baseline files:

- `maskCode(text)` — an offset-preserving mask for fenced blocks and inline code spans, so every caller
  keeps matching the same regexes at the same offsets and keeps reporting the raw href a contributor
  typed. Consumed by `checkLinks` and `checkAdrLinkNumbers`; deliberately **not** by
  `checkRulesPointers` / `ruleBullets`, which exist to read backticked text.
- `linkCheckedFiles(root)` — the dead-link scope **derived** rather than hand-kept, so a tenth Skill is
  covered the day it lands. **12 files / 189 resolved internal links → 39 files / 361.**
- `RENDER_SCANNED` split out of `LINK_CHECKED`, because a `parity:render` marker is an Adapter concern
  and should not follow the link scope.
- Decisions recorded in [ADR 0053](../adr/0053-code-spans-are-not-links.md).

**A second-order note worth carrying upstream with it.** Two Tier-1 anti-patterns in
`rules/scripting.md` — *"never widen a guard's matching rule without asking which way the new failure
points"* and *"never build a guard around the shape the current files happen to have"* — were the
load-bearing constraints on the design, and an independent plan critique found a real over-masking
hazard by applying exactly those. The baseline's own rules did the work they were written to do. That is
a data point for the Rules Layer's value, not a friction, and it is recorded here so it is not read as
one.

**Scope deliberately left behind:** `docs/adr/*.md` is still unchecked. It carries two genuinely dead
links whose repair means editing accepted ADRs — a records decision, not a validator one. Any host will
face the same question the moment it widens the scope, so the *reasoning* is worth upstreaming even
though the *exclusion* is host data.
