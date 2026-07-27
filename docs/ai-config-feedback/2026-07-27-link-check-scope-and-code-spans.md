# 2026-07-27 — The baseline's dead-link scope silently excluded its own Rules Layer (bryce issue #159)

## F17 — `checkLinks` had a hardcoded file list, and `rules/*.md` was never on it

**Disposition: `upstream` · Status: recorded**

> **Same root cause as [F16](2026-07-27-rules-readme-links-unvalidated.md), reached from the other end,
> and the two were filed within a day of each other by sessions that did not see one another.** F16 came
> at it through `docs/rules/README.md` and issue #160; this came through `rules/*.md` and issue #159.
> Both found a prose-heavy document that no link validator covers, both found the naive
> `LINK_CHECKED` addition reddens on illustrative examples, and both landed on the same underlying fact:
> **the checker had no notion of code.** F16 priced a fencing pass over the prose as too large and
> deferred; #159 changed what the validator considers a link instead, which fixes both files and costs no
> prose edit. That two independent sessions hit the identical wall in two days is the pattern the ledger
> exists to promote — this is not one anecdote, it is two.

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

**Both halves are baseline-generic.** Neither the parsing rule (a link inside code is not a link) nor
the derivation (every Tier-1 rule, every Skill body, every shim — from the same constants the
checker already has) contains one byte of stack or domain. A host with a Rails app, a Go service, or no
application code at all vendors the identical `rules/` and `skills/` layout and inherits the identical
gap. This clears the ledger's upstream test — *"would a project with a completely different stack and
domain hit the same thing?"* — without qualification.

**The fix as shipped here** (bryce PR for issue #159), all of it in baseline files:

- `markdownLinks(source)` — parse with `commonmark` and walk the AST for `link`/`image` nodes, instead
  of matching a regex. A link inside a code span is not reported **because it is not a node**. Consumed
  by `checkLinks` and `checkAdrLinkNumbers`; deliberately **not** by `checkRulesPointers` / `ruleBullets`,
  which exist to read backticked text.
- `linkCheckedFiles(root)` — the dead-link scope **derived** rather than hand-kept, so a tenth Skill is
  covered the day it lands. **12 files → 39** (189 resolved internal links → 364, measured at merge).
- `RENDER_SCANNED` split out of `LINK_CHECKED`, because a `parity:render` marker is an Adapter concern
  and should not follow the link scope.
- Decisions recorded in [ADR 0054](../adr/0054-code-spans-are-not-links.md).

**The recommendation changed during implementation, and the reason is the most useful thing here.** The
first implementation hand-rolled the code-awareness: mask every code span and fenced block, then run the
existing regex over the masked text. It was written, reviewed, and **failed five independent review
rounds** — each one found a silent false green, a link the CommonMark reference parser renders live that
the masker hid, and two of the five were introduced while fixing the round before. The full table is in
[ADR 0054](../adr/0054-code-spans-are-not-links.md).

So the upstream recommendation is **not** "add a masker to the baseline's parity check." It is: *do not
reimplement a format's grammar to check something about that format.* A structural checker that needs to
know what markdown means should parse markdown. The masker was ~180 lines encoding a subset of CommonMark
badly; the replacement is ~40 lines and a devDependency.

**That dependency is the real cost a vendoring Host App must weigh**, and it is why this is recorded
rather than assumed: the Generic Baseline's parity check has been dependency-free, and `rules/scripting.md`
only permits `scripts/*.ts` deps as a *host opt-in* (ADR 0039). Upstream has to decide whether the
baseline takes the dependency, ships the (defective) regex behaviour with the scope narrow, or makes the
link scanner pluggable. This host's evidence says the dependency is worth it; that is one data point, not
a decision for the baseline.

**A second-order note.** Two Tier-1 anti-patterns in `rules/scripting.md` — *"never widen a guard's
matching rule without asking which way the new failure points"* and *"never build a guard around the
shape the current files happen to have"* — were the load-bearing constraints throughout, and every round
that ignored them produced a defect. The baseline's own rules did the work they were written to do.

**Scope deliberately left behind:** `docs/adr/*.md` is still unchecked. It carries two genuinely dead
links whose repair means editing accepted ADRs — a records decision, not a validator one. Any host will
face the same question the moment it widens the scope, so the *reasoning* is worth upstreaming even
though the *exclusion* is host data.
