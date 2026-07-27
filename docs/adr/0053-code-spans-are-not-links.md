# ADR 0053 — A markdown link inside code is not a link

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
- A fence is closed by a delimiter of the same character, at least as long, alone on its line. An
  unclosed fence masks to EOF.

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

Consuming these as fences **removes** the hazard rather than documenting it, and it costs nothing: a
fence run inside a blockquote *is* a fence, and a line indented ≥ 4 outside a list is an indented code
block. Already code, either way. It also brings this file's third fence walker into agreement with the
two already in it.

**2. Indented (4-space) code blocks are NOT masked.**

At this altitude a four-space indent cannot be told apart from a wrapped continuation under a nested
list item, and `rules/*.md` and the skill bodies are made of those. Masking them would blank real links.

Both choices follow the same asymmetry. Under-masking is a false **red**: loud, cheap, and it names
itself. Over-masking is a false **green**: real dead links stop being reported and the gate says fine.
Where the two trade off, take the red.

## Consequences

- The dead-link scope is **derived**, not hand-kept: the authored seed plus every Tier-1 rule, every
  `skills/<name>/SKILL.md`, and every `.claude/commands/*.md`. A tenth Skill is link-checked the day it
  lands. Coverage went from 12 files to 39, and from ~200 resolved links to 386.
- A fence's **container** is not tracked, so a fence opened inside a list item or blockquote is closed
  by the next matching delimiter anywhere. Consistent with the existing walkers; no file in the tree
  depends on the difference.
- Links inside fenced blocks — including the output templates in the skill bodies — are no longer
  resolved. That is a deliberate consequence of treating a fence as code, and it removes nothing that
  was previously checked: none of these files were in scope before.
- `docs/adr/*.md` stays **out** of the scope. It carries two genuinely dead links whose repair means
  editing accepted ADRs, which is a records decision rather than a validator one.
- A CommonMark link **title** — `[text](path "title")` — is still mis-parsed by `MARKDOWN_LINK`. No file
  uses the syntax; handling it half-way risks a target that resolves by accident, which is the wrong
  side of the asymmetry above.
