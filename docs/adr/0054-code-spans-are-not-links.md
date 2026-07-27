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
- A span may cross a line break but not a blank line.
- A backslash-escaped backtick opens nothing.
- A fence is closed by a delimiter of the same character, at least as long, alone on its line — and the
  closer must be **reachable inside the opener's own container** (see below). An opener with no such
  closer is not a fence and masks nothing.

`checkRulesPointers` and `ruleBullets` deliberately do **not** adopt the masker: they exist to read
*backticked* deep-doc paths, and masked input would blank the very substring they search for.

## The two decisions a future reader will want to re-litigate

**1. Fence delimiters are recognized after any whitespace and/or `>`, not CommonMark's
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

**2. Indented (4-space) code blocks are NOT masked.**

At this altitude a four-space indent cannot be told apart from a wrapped continuation under a nested
list item, and `rules/*.md` and the skill bodies are made of those. Masking them would blank real links.

Both choices follow the same asymmetry. Under-masking is a false **red**: loud, cheap, and it names
itself. Over-masking is a false **green**: real dead links stop being reported and the gate says fine.
Where the two trade off, take the red.

## Consequences

- The dead-link scope is **derived**, not hand-kept: the authored seed plus every Tier-1 rule, every
  `skills/<name>/SKILL.md`, and every `.claude/commands/*.md`. A tenth Skill is link-checked the day it
  lands. Coverage went from **12 files / 189 resolved internal links** to **39 files / 361**.
- An **unclosed fence is not a fence.** Its content stays visible to the link checker, so a malformed
  document produces dead-link errors rather than silent coverage loss.
- The masker is **cross-checked against the CommonMark reference parser** (`commonmark` npm), not merely
  against today's files: over all 39 in-scope files it misses **0** of the 361 links a real parser calls
  live. That cross-check is the evidence behind every claim above, and it is how the container bug was
  proved rather than argued.
- Links inside fenced blocks — including the output templates in the skill bodies — are no longer
  resolved. That is a deliberate consequence of treating a fence as code, and it removes nothing that
  was previously checked: none of these files were in scope before.
- `docs/adr/*.md` stays **out** of the scope. It carries two genuinely dead links whose repair means
  editing accepted ADRs, which is a records decision rather than a validator one.
- A CommonMark link **title** — `[text](path "title")` — is still mis-parsed by `MARKDOWN_LINK`. No file
  uses the syntax; handling it half-way risks a target that resolves by accident, which is the wrong
  side of the asymmetry above.
