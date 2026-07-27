# ADR 0054 — A markdown link inside code is not a link

**Status:** Accepted
**Date:** 2026-07-27
**Context:** [#159](https://github.com/wrburgess/bryce/issues/159) (deferred from
[#154](https://github.com/wrburgess/bryce/issues/154) / PR #155)

## Context

`checkLinks` in [`scripts/parity-check.ts`](../../scripts/parity-check.ts) resolved markdown links for
twelve hardcoded paths. `rules/*.md` was not among them, so every link in every Tier-1 rule file went
unresolved for the whole life of the Rules Layer — a coverage gap that announced itself to nobody, which
is the exact failure mode [`rules/scripting.md`](../../rules/scripting.md) warns about.

The seven files could not simply be added. `rules/security.md` teaches output escaping by writing
`` `![x](url)` `` — prose *about* markdown inside an inline code span — and `MARKDOWN_LINK` is a plain
regex with no notion of code. Adding the files would have reported a dead link to `url`, which is not a
link at all. The same holds for [`docs/rules/README.md`](../rules/README.md), which shows `[text](path)` four
times while teaching the deep-doc form rule.

So the widening was blocked on a shared validator, which is why #154 deferred it: the fix changes what
*every* link-checked file means by "a link".

## Decision

Blank code before matching links. `maskCode` returns a string of **identical length** — code content
becomes spaces, newlines are preserved — so every caller keeps matching the same regexes at the same
offsets and keeps reporting the raw href a contributor typed. Both link scanners (`checkLinks` and
`checkAdrLinkNumbers`) consume masked text.

The rules encoded are CommonMark's, not the shape today's files happen to have
([`rules/scripting.md`](../../rules/scripting.md)):

- A run of *N* backticks opens an inline span and only a run of exactly *N* closes it. An **unmatched
  run is literal text** and scanning resumes immediately after it.
- A span **must open and close on one line** — a deliberate narrowing of CommonMark, argued below.
- A backslash-escaped backtick opens nothing.
- A fence is closed by a delimiter of the same character, at least as long, alone on its line — and the
  closer must be **reachable inside the opener's own container** (see below). An opener with no such
  closer is not a fence and masks nothing.

`checkRulesPointers` and `ruleBullets` deliberately do **not** adopt the masker: they exist to read
*backticked* deep-doc paths, and masked input would blank the very substring they search for.

## The three decisions a future reader will want to re-litigate

**1. An inline code span may not cross a line break — the bound that ended a four-round loop.**

CommonMark lets a span cross a line break within its paragraph, so the honest implementation of "stop at
the paragraph edge" is to detect where paragraphs end. Four review rounds of PR #162 tried exactly that,
and each attempt shipped a **silent false green** that a differential fuzzer then found:

| Round | The bound tried | What a fuzzer found it missed |
|---|---|---|
| 1 | blank lines only | a fence in a blockquote/list; a lazy continuation |
| 2 | + the fence's own container | a *declined* fence delimiter, pairing as an inline span |
| 3 | + hide declined delimiters' runs | run-length pairing is not local: an earlier opener reached a **farther** partner and masked **more** |
| 4 | + `RULE_BLOCK_OPENER`'s spellings | thematic breaks (`***`, `___`, `---`), setext underlines, `1)` lists, HTML blocks — 835/25,000 |

The pattern, not any one miss, is the finding: **enumerating CommonMark's block starts by regex is a game
this file cannot win**, and every loss is invisible — a run of backticks in one block pairing with a run
in a later one, blanking every real link between them, with a green gate.

A span that cannot leave its line cannot leave its block, whatever a block turns out to be. The property
holds without knowing the enumeration, so it cannot be defeated by an entry missing from one. Two fuzzers
over 33,000 generated documents now report **0** false greens, where the round-4 code reports 161–835.

The cost is a genuine multi-line span going unmasked. An earlier draft of this ADR claimed no file in the
checked set contained one; **that was false**, and the delta review proved it —
`docs/api/README.md:74-75` and `docs/mcp/README.md:21-22` each wrap a JSON example across a line break
inside one span. The claim was made from a fuzzer's silence rather than from the files, which is the same
mistake, one level up, as the ones below.

What actually happens there is worth stating exactly, because it is the residual limitation this design
accepts: the opening backtick is left orphaned, and on a line carrying other spans that orphan pairs with
the next run, so a stretch of **prose is masked as if it were code**. No link sits in either stretch
today, so nothing is lost — but "no link sits there today" is an accident, not an invariant, and it is
pinned by a test rather than trusted.

That is a **false red waiting to become a false green**, which is a weaker guarantee than the rest of
this design offers, and it is the one place a real CommonMark parser would do strictly better. It is
recorded here rather than fixed because switching `checkLinks` to a parser is an architecture change this
issue's plan did not contemplate — see *Follow-up* below.

**2. Fence delimiters are recognized after any whitespace and/or `>`, not CommonMark's
container-relative `` {0,3}``.**

CommonMark measures a fence's indentation from its container's content column, so a flat per-line
`^ {0,3}` misses a fence under a wide list marker (`10. `, a nested sub-list) or inside a blockquote.
The consequence is not merely a missed fence: the unrecognized delimiter's backticks fall through to the
**inline** scanner as an ordinary run, free to pair with some distant run and blank every real link in
between — a silent false green.

This is not hypothetical. `> ``` … > ``` ` reached the correct answer only because its two three-backtick
runs happened to match as an inline span; a closer written one backtick longer — still a valid fence
close — sends the scanner hunting into the prose that follows.

Consuming these as fences **removes** that hazard rather than documenting it. But recognizing a fence
that loosely needs two bounds, or it trades one silent failure for a worse one. The PR #162 review found
both, cross-checked against the CommonMark reference parser:

- **A fence must CLOSE to mask anything.** CommonMark runs an unclosed fence to end of document, which
  is right for a renderer and catastrophic for a guard: one dropped ` ``` ` line disables dead-link
  checking for the rest of the file, silently. Declining to mask reports the links inside instead —
  wrong *out loud*. An unclosed fence in a shipped document is a defect worth surfacing anyway.
- **The closer must be reachable inside the opener's container.** A blockquote ends at a blank line and
  a list item ends where the indentation drops, so a line carrying fewer `>` markers or less indentation
  than the opener has left the block the fence lives in, and the search stops there. Without this,
  `> ``` ` followed by a blank line and an ordinary paragraph masked that paragraph — which CommonMark
  renders with a live link in it.

The original draft of this ADR claimed "a line indented ≥ 4 outside a list is an indented code block:
already code." That is **false**: CommonMark requires a preceding blank line, so an indented fence-look
line directly under a paragraph is a lazy continuation of it, and masking from there ran to EOF. The
claim is struck; the container bound is what makes the loose recognition safe.

Both bounds fail toward the red. A legitimate fence whose content dedents below its opener stops being
recognized and its links get reported — loud, and fixable by indenting the content.

**3. Indented (4-space) code blocks are NOT masked.**

At this altitude a four-space indent cannot be told apart from a wrapped continuation under a nested
list item, and `rules/*.md` and the skill bodies are made of those. Masking them would blank real links.

All three choices follow the same asymmetry. Under-masking is a false **red**: loud, cheap, and it names
itself. Over-masking is a false **green**: real dead links stop being reported and the gate says fine.
Where the two trade off, take the red.

## Consequences

- The dead-link scope is **derived**, not hand-kept: the authored seed plus every Tier-1 rule, every
  `skills/<name>/SKILL.md`, and every `.claude/commands/*.md`. A tenth Skill is link-checked the day it
  lands. Coverage went from **12 files** to **39** — measured at this ADR's merge, 189 resolved internal
  links to 364. (The file count is the durable figure; a link total goes stale on any commit that adds a
  link, including the two documents this change brought with it.)
- An **unclosed fence is not a fence.** Its content stays visible to the link checker, so a malformed
  document produces dead-link errors rather than silent coverage loss.
- A **multi-line inline code span is not masked**, and two files in the checked set have one
  (`docs/api/README.md`, `docs/mcp/README.md`). The orphaned opening backtick can pair with a later run
  on its own line, masking prose as code. No link falls in either stretch today; a test pins that, so the
  day one does, the gate reddens instead of going quiet. This is the design's weakest guarantee.
- The **fence closer must match the opener's container in both directions.** `leavesContainer` answers
  only "have we left?", so a *deeper* line — more blockquote markers — was accepted as a closer, which
  made the masker mistake the real closer for a new opener and blank a following paragraph.
- The masker is **cross-checked against the CommonMark reference parser** (`commonmark` npm), not merely
  against today's files: over all 39 in-scope files it misses **0** of the links a real parser calls live
  (364 at merge), and **0** across 33,000 generated documents from two independently written fuzzers.
  **Zero missed is the invariant worth holding**; the totals around it drift with the tree.
- Links inside fenced blocks — including the output templates in the skill bodies — are no longer
  resolved. That is a deliberate consequence of treating a fence as code, and it removes nothing that
  was previously checked: none of these files were in scope before.
- `docs/adr/*.md` stays **out** of the scope. It carries two genuinely dead links whose repair means
  editing accepted ADRs, which is a records decision rather than a validator one.
- A CommonMark link **title** — `[text](path "title")` — is still mis-parsed by `MARKDOWN_LINK`. No file
  uses the syntax; handling it half-way risks a target that resolves by accident, which is the wrong
  side of the asymmetry above.

## The reasoning error worth remembering

Every bug in this masker was introduced by the *fix* for the one before it, and the first three were
defended with the same shape of argument: *"this change can only mask less."* Each time that was asserted
from the local edit, and each time it was false.

The clearest case: suppressing a fence delimiter's backtick run so it could not pair as an inline span.
Locally, removing a candidate can only remove pairings. But run-length pairing is **not local** — delete
a run-3 candidate from the middle of a search and an *earlier* run-3 opener skips past it and reaches a
*farther* partner, masking strictly **more** than before. Differential fuzzing against the reference
parser falsified the claim in 373 of 4,000 cases; no amount of re-reading the diff would have.

Two lessons, in the order they were learned:

1. **A bound is not a filter.** Thinning the candidate set changes which pairs form and can grow a span;
   stopping the search cannot. Prefer the bound.
2. **Prefer a bound you can state as a property over one you have to enumerate.** Rounds 1–4 each bounded
   the search by *listing* what ends a paragraph, and a fuzzer found a missing entry every time. "A span
   may not leave its line" needs no list, and no round-5 entry can be missing from it.

So the standing rule for this code: a claim about what masking can and cannot do is not reviewable by
reading it. Fuzz it against a real parser, and mutate the guard to confirm a test actually fails without
it — twice in this PR a guard was load-bearing and had no test, and once a fuzzer reported clean against
a version already known to be broken.

And a third, learned last: **a fuzzer's silence is not a statement about the repository.** The claim that
no checked file had a multi-line span came from 33,000 green synthetic documents, not from the files; two
files had one. Generated coverage and real coverage answer different questions.

## Follow-up: should this parse instead of mask?

Five review rounds found a silent defect in this masker, two of them introduced while fixing the round
before. The final design is the smallest and the only one whose bound is a property rather than a list —
but it still mis-pairs backticks in two real files, and a CommonMark parser would not.

`commonmark` (npm) is already used to *verify* this code, and `rules/scripting.md`'s no-dependency
anti-pattern carries an explicit host opt-in for `scripts/*.ts`
([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)), so the option is open. What stops
it being folded in here is scope: rewriting `checkLinks` and `checkAdrLinkNumbers` to walk a parsed AST
is an architecture change issue #159's plan never contemplated, and `ship`'s emergency stop covers
exactly that. It is raised with the HC rather than decided by the AC.
