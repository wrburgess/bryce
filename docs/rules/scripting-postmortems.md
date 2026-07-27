# Scripting — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/scripting.md`](../../rules/scripting.md). Heavy,
subsystem-specific case studies for bundled and CLI scripts — **not** auto-loaded; read on demand when
the trigger in [`docs/rules/README.md`](README.md) fires (working in bundled/CLI scripts). Each entry
ends with a `(Reference: #NNNN)` pointer to the issue/PR that produced it.

## Do not reimplement a format's grammar to check something about that format (Reference: PR #162)

**The case.** Issue #159 set out to close a coverage gap that had announced itself to nobody: `checkLinks`
in [`scripts/parity-check.ts`](../../scripts/parity-check.ts) resolved markdown links for twelve
hardcoded paths, and `rules/*.md` was not among them — every link in every Tier-1 rule file had gone
unresolved for the whole life of the Rules Layer, as had 128 links in the nine skill bodies and 27 in the
command shims. The seven rule files could not simply be added to the list. `rules/security.md` teaches
output escaping by writing `` `![x](url)` `` — prose *about* markdown, inside an inline code span — and
the scanner was a plain regex with no notion of code, so widening the scope reported a dead link to
`url`, which is not a link at all. The widening was therefore blocked on a prior question: **can this
checker tell a link from prose about one?**

**What shipped and was caught in review.** The first implementation answered that question by hand: blank
every code span and fenced block, run the old regex over the masked text, preserve offsets. It went
through **eight independent Reviewer rounds** — numbered 1 through 8 in PR #162's own review thread,
which is the source for that count; ADR 0054 tables only the five that mattered. Those **five each found
a silent false green** — a link the CommonMark reference parser renders live that the masker hid — and
**two of the five were introduced while fixing the round before**:

| Round | The bound it tried | What a differential fuzzer found it missed |
|---|---|---|
| 1 | blank lines only | a fence inside a blockquote or a list item; a lazy continuation |
| 2 | + the fence's own container | a *declined* fence delimiter, pairing instead as an inline span |
| 3 | + hide the declined delimiters' runs | pairing is not local — an earlier opener reached a **farther** partner and masked **more** |
| 4 | + `RULE_BLOCK_OPENER`'s spellings | thematic breaks (`***`, `___`, `---`), setext underlines, `1)` lists, HTML blocks |
| 5 | + a line bound (a *property*, not a list) | the fence-closer check was directionally blind — and two real files mis-paired backticks anyway |

Round 3 is the sharpest of them. Its fix removed candidate backtick runs from the search on the reasoning
that *suppressing candidates can only mask less*. Run-length pairing is not local: delete a run-3
candidate from the middle of a search and an **earlier** opener reaches a **farther** partner, masking
strictly **more**. Fuzzing falsified the claim in **373 of 4,000** cases. Re-reading the diff never would
have — the reasoning is locally correct and globally false.

Round 5 settled it. The line-bounded design was the smallest of the five and the only one whose bound was
a *property* rather than an enumeration, and it **still** mis-paired backticks in `docs/api/README.md`
and `docs/mcp/README.md`, because both wrap a JSON example across a line break inside one code span. The
masker was ~180 lines encoding an accidental subset of CommonMark. It was deleted and replaced with
`markdownLinks(source)`: parse once with the `commonmark` package, walk the AST, return each `link` and
`image` node's label and destination. **~40 lines and one devDependency.** A link inside a code span is
not reported *because it is not a node* — the question that blocked the issue stopped being a question
rather than being answered. Coverage went from 12 files to 39, nothing previously resolved was lost, and
reference links, link titles and angle-bracket destinations started resolving for the first time —
immediately surfacing two real, previously invisible ADR citation mismatches.

**The rule it yields.** **Do not reimplement a format's grammar to check something about that format.**
Parse it, or check something that does not require parsing it. Two corollaries, both earned here:

- **Prefer a bound you can state as a *property* over one you have to enumerate.** Rounds 1–4 each
  bounded the search by *listing* what ends a paragraph — each list more faithful to the spec than the
  last — and a fuzzer found a missing entry every time. "Encode what the format permits" is not a
  convergent strategy; a guard that enumerates a grammar is wrong at every construct it did not list, and
  silently.
- **A bound is not a filter.** Narrowing a *search* is monotone; thinning the *candidate set* a matcher
  pairs over is not. Confirm the direction of the new failure before assuming a simplification can only
  match less.

The dependency this buys is real and is not free everywhere. `commonmark` is a devDependency used by
tooling only, under the host opt-in in `rules/scripting.md` that scopes `scripts/*.ts` to the app's own
toolchain ([ADR 0039](../adr/0039-repo-tooling-unifies-on-typescript-remove-ruby.md)). A genuinely
portable bundled script has no such opt-in, and for it the surviving half of the rule is the operative
one: **ask something that does not require parsing the format at all.** The trade this case records is
narrow — *carry a dependency, or carry a markdown parser you wrote by accident.*

Note also what deliberately did **not** migrate. `checkRulesPointers` and `ruleBullets` still read text,
not an AST, because they exist to find **backticked** deep-doc paths — which an AST walk does not surface
as links at all. Using the parser there would have made them go blind. "Parse the format" is a rule about
questions that are *about* the grammar, not a mandate to route every string through a parser.

**Symptom to watch for.** A checker whose fix history is a growing list of special cases, each added
after an example was found; a review round whose remedy is "add the spelling we missed"; a guard whose
correctness argument is a claim about what *cannot* happen rather than a property the input satisfies;
any comment in a validator that begins "this is a subset of".

_(Reference: issue #159 / PR #162, deferred from issue #154 / PR #155. The decision, the five-round table
and the reasoning errors are recorded in [ADR 0054](../adr/0054-code-spans-are-not-links.md); the count of
**eight** Reviewer rounds comes from PR #162's review thread, whose artifacts are numbered round 1
through round 8, not from the ADR. The Tier-1 lesson was folded in issue #166.)_
