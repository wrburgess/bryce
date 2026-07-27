# ADR 0054 — Parse markdown to find links; a link inside code is not a node

**Status:** Accepted
**Date:** 2026-07-27
**Context:** [#159](https://github.com/wrburgess/bryce/issues/159) (deferred from
[#154](https://github.com/wrburgess/bryce/issues/154) / PR #155)

## Context

`checkLinks` in [`scripts/parity-check.ts`](../../scripts/parity-check.ts) resolved markdown links for
twelve hardcoded paths. `rules/*.md` was not among them, so every link in every Tier-1 rule file went
unresolved for the whole life of the Rules Layer — a coverage gap that announced itself to nobody, which
is the exact failure mode [`rules/scripting.md`](../../rules/scripting.md) warns about. The nine skill
bodies (128 links) and nine command shims (27) were unchecked for the same reason.

The seven rule files could not simply be added. `rules/security.md` teaches output escaping by writing
`` `![x](url)` `` — prose *about* markdown inside an inline code span — and the link scanner was a plain
regex with no notion of code. Adding the files reported a dead link to `url`, which is not a link at all.
The same holds for [`docs/rules/README.md`](../rules/README.md), which shows `[text](path)` four times
while teaching the deep-doc form rule.

So the widening was blocked on the scanner's inability to tell a link from prose about one.

## Decision

**Find links with a CommonMark parser rather than a regex.** `markdownLinks(source)` parses once and
walks the AST, returning each `link` and `image` node's rendered label and destination. Both scanners —
`checkLinks` and `checkAdrLinkNumbers` — consume that.

A link inside a code span or a fenced block is not reported **because it is not a node**. The question
that blocked this issue stops being a question, rather than being answered.

`commonmark` is a devDependency used by tooling only, never by the app, under the host opt-in in
[`rules/scripting.md`](../../rules/scripting.md) that scopes `scripts/*.ts` to the app's own toolchain
([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)).

`checkRulesPointers` and `ruleBullets` deliberately do **not** use it: they exist to read *backticked*
deep-doc paths as text, and an AST walk would not see the very substring they search for.

## Why a parser, and not the masker that was written first

The first implementation hand-rolled it: blank every code span and fenced block, then run the old regex
over the masked text, preserving offsets. It was rejected after **five independent review rounds each
found a silent false green in it** — a link the CommonMark reference parser renders live that the masker
hid. Two of the five were introduced *while fixing the round before*.

| Round | Bound tried | What a differential fuzzer found it missed |
|---|---|---|
| 1 | blank lines only | a fence in a blockquote or list item; a lazy continuation |
| 2 | + the fence's own container | a *declined* fence delimiter, pairing as an inline span |
| 3 | + hide declined delimiters' runs | pairing is not local: an earlier opener reached a **farther** partner and masked **more** |
| 4 | + `RULE_BLOCK_OPENER`'s spellings | thematic breaks (`***`, `___`, `---`), setext underlines, `1)` lists, HTML blocks |
| 5 | + a line bound (a *property*, not a list) | the fence closer check was directionally blind — and two real files mis-paired backticks anyway |

Round 5's second half is what settled it. The line-bounded design was the smallest and the only one whose
bound was a property rather than an enumeration, and it **still** mis-paired backticks in
`docs/api/README.md` and `docs/mcp/README.md`, because both wrap a JSON example across a line break
inside one code span. A parser does not have that class of bug.

The masker was ~180 lines encoding a subset of CommonMark. The replacement is ~40 lines and one
dependency. **The trade is: carry a dependency, or carry a markdown parser you wrote by accident.**

### What the migration cost and gained

- **Nothing lost.** Every link the previous checker resolved is still resolved, verified file-by-file
  across all 39 in-scope files: 0 lost.
- **Coverage gained the regex never had.** Reference links (`[text][ref]`) resolve through their
  definitions; link **titles** (`[text](path "title")`) no longer corrupt the path, removing a documented
  limitation; angle-bracket destinations work. Two of these turned up real, previously invisible ADR
  citation mismatches in the self-test fixtures — which is the point.
- **One behaviour difference to know about.** CommonMark normalizes a destination for rendering, so
  `[t](<a path.md>)` comes back percent-encoded. `decodeDestination` undoes that before resolution,
  attempting rather than assuming: a malformed escape keeps the raw text.

## Consequences

- The dead-link scope is **derived**, not hand-kept: the authored seed plus every Tier-1 rule, every
  `skills/<name>/SKILL.md`, and every `.claude/commands/*.md`. A tenth Skill is link-checked the day it
  lands. Coverage went from **12 files** to **39** (189 resolved internal links to 364, at merge; the
  file count is the durable figure, a link total drifts with the tree).
- **`RENDER_SCANNED` is split from the link scope.** A `parity:render` marker is an Adapter concern;
  folding it into the wider set would silently scan ~30 more files for a marker with no business
  appearing in them.
- The parity check now has a **runtime dependency**. It is a devDependency, installed by `npm ci` before
  the parity job, covered by `npm run audit` in the gate. For a Host App vendoring this baseline that is
  a real cost, recorded in the ai-config ledger rather than left to be discovered.
- `docs/adr/*.md` stays **out** of the scope. It carries two genuinely dead links whose repair means
  editing accepted ADRs — a records decision rather than a validator one.

## The reasoning errors worth remembering

The five rounds are more instructive than the outcome, because each defect survived a self-review that
believed it was rigorous.

1. **A bound is not a filter.** Round 3's fix removed candidate backtick runs from the search on the
   reasoning that "suppressing candidates can only mask less." Run-length pairing is not local: delete a
   run-3 candidate from the middle of a search and an *earlier* opener reaches a *farther* partner,
   masking strictly **more**. Fuzzing falsified the claim in 373 of 4,000 cases; re-reading the diff
   never would have.
2. **Prefer a bound you can state as a property over one you have to enumerate.** Rounds 1–4 each bounded
   the search by *listing* what ends a paragraph, and a fuzzer found a missing entry every time.
3. **A fuzzer's silence is not a statement about the repository.** The claim that no checked file had a
   multi-line code span came from 33,000 green synthetic documents, not from the files. Two files had
   one. Generated coverage and real coverage answer different questions.
4. **A guard nobody mutated is a guard nobody tested.** Twice in this work a guard was load-bearing and
   had no failing test without it; once a fuzzer reported clean against a version already known to be
   broken. Mutate the guard, confirm a test dies, and validate the validator before trusting it.

The standing rule this leaves for structural checkers in this repo: **do not reimplement a format's
grammar to check something about that format.** Parse it, or check something that does not require
parsing it.
