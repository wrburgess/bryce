# 2026-07-27 — the file that documents the link-promotion rule has its own links validated by nothing (bryce issue #160)

## F16 — `docs/rules/README.md` is outside every link validator, and the reason is unstated

**Disposition: `upstream` · Status: resolved in-repo by [#159](https://github.com/wrburgess/bryce/issues/159) / PR #162 — still to be filed upstream**

> **Resolution note (added by #159).** This entry deferred the fix as "neither well-scoped nor low-risk…
> needs either a fencing pass over the prose or a change to what the validator considers a link." Issue
> #159 — filed independently, from the same root cause reached via `rules/*.md` — took the second path.
>
> `checkLinks` now finds links by PARSING with `commonmark` rather than matching a regex
> ([ADR 0054](../adr/0054-code-spans-are-not-links.md)), so every illustrative `[text](path)` in this file
> is prose again — it is not a link node — and the file joined the checked set with **no prose edit at
> all**, so the cost this entry priced into the fencing option is not paid. The five failures quoted
> below are exactly the five that stop being links. The scope was derived rather than listed, so the
> skill bodies and command shims came with it.
>
> That makes this entry's third suggestion — resolve the path in the ADR-number scan — unnecessary as a
> narrower substitute; that scan is parsed too, and gained reference-link and percent-encoded coverage
> in the process.
>
> The one thing #159 did **not** do is this entry's first suggestion, and it is worth keeping: the
> *reason* the naive `LINK_CHECKED` addition fails is now encoded in a validator instead of stated in
> prose. A contributor still learns it only by reading ADR 0054. See F17 in
> [`2026-07-27-link-check-scope-and-code-spans.md`](2026-07-27-link-check-scope-and-code-spans.md).

[`docs/rules/README.md`](../rules/README.md) is the repo's authority on how to write a path reference —
*Convention: reference a not-yet-existing path as a backticked path, never a markdown link*, and the
**Promotion** rule that issue #154 pinned ("write the link the way Markdown resolves it: relative to the
file you are writing in, not to the repo root"). **Its own markdown links are checked by nothing.**

**Checked rather than assumed**, since that is the claim this entry rests on:

| Validator | Covers `docs/rules/README.md`? | Why not |
|---|---|---|
| `checkLinks` (dead-link resolution) | **No** | Resolves links only in the explicit `LINK_CHECKED` list (`scripts/parity-check.ts:40-53`); the file is absent from it |
| Repo-wide ADR-number scan | **Partly — and not in the way that matters** | It *does* see the link: `ADR_LINK_TARGET.exec(basename(target))` (`scripts/parity-check.ts:915`) strips the directory first, so `docs/adr/0053-….md` and `../adr/0053-….md` both match. But it only compares the **displayed number against the target's number**. It never resolves the path, so both spellings agree with `ADR 0053` and both pass |
| `checkRulesPointers` | **No** | Scoped to `rules/*.md`, not `docs/rules/` |

Demonstrated on the #160 change: writing this file's new ADR reference in the **repo-root spelling** —
`[ADR 0053](docs/adr/0053-….md)`, the exact form the file's own *Promotion* rule rejects because it
"names a real file yet renders as a 404" — left `npx tsx scripts/parity-check.ts` **green**. The negative
check written to prove the gate could go red instead proved it could not.

The precise shape is worth stating, because the intuitive explanation is wrong (this entry asserted it
before an independent review corrected it): the gap is **not** that the scan cannot see traversal or
repo-root paths. It sees them — `basename()` runs first. The gap is that **no validator resolves a link
in this file at all**: the ADR scan checks number agreement and stops, and `checkLinks`, the only
validator that resolves, never looks here.

### The exclusion is correct, which is the point

The obvious remedy — add the file to `LINK_CHECKED` — was tried and **fails, for a good reason.** The
file teaches by example, and its examples are *deliberately* non-resolving:

```
parity_check: FAILED (5 problems)
  - Dead link in docs/rules/README.md: `path` does not resolve
  - Dead link in docs/rules/README.md: `MMMM-...md` does not resolve
  - Dead link in docs/rules/README.md: `../docs/rules/x-postmortems.md` does not resolve
  - Dead link in docs/rules/README.md: `docs/rules/x-postmortems.md` does not resolve
```

Every one is an illustrative `[text](path)` / `[ADR NNNN](MMMM-...md)` / `x-postmortems.md` placeholder
that exists to *show* a form. A file whose subject is link syntax cannot be link-checked naively, and
that is a general property of documentation-about-syntax, not a quirk of this repo.

So this is not a bug to fix by adding a list entry. It is an **unstated trade-off**: the file is excluded
for a sound reason, and the consequence — its real links are unguarded, including every ADR reference a
future convention section adds — is written down nowhere. A contributor reading the *Promotion* rule
reasonably infers the repo enforces it. It does not, least of all here.

### What the baseline should say

Any of these would close it; the first is the cheapest and the least clever:

- **State the exclusion where the rule is taught.** One sentence in `docs/rules/README.md` noting that
  this file is deliberately outside `LINK_CHECKED` because its examples are illustrative, so its own real
  links are **author-verified**. This is the same "author-owned, not machine-enforced" framing
  `rules/scripting.md` already uses for the ASCII-output rule, and it is honest rather than aspirational.
- **Fence the examples.** `checkLinks` already skips fenced code, so moving each illustrative link into a
  fence would let the file join `LINK_CHECKED` with real links checked and examples ignored. Costs the
  examples their inline rendering, and is a larger edit than it looks — the examples are woven into prose.

  > **Correction (issue #163).** "`checkLinks` already skips fenced code" was **false when this entry was
  > written.** `checkLinks` matched `MARKDOWN_LINK` over raw text; only `checkRulesPointers` and
  > `ruleBullets` tracked a `fenced` toggle. Reproduced on the tree as it then stood: appending a fenced
  > dead link to `docs/mcp/README.md`, a `LINK_CHECKED` file, reddened the gate. So fencing the examples
  > would not have worked at the time, and this option was unavailable rather than merely awkward — which
  > is a further reason the deferral was right, on top of the ones stated. PR #162 has since made the
  > claim true by parsing markdown instead of matching it
  > ([ADR 0054](../adr/0054-code-spans-are-not-links.md)); see the resolution note at the top.
  >
  > The option below carries a second error worth flagging, since both misdescribe the checker a reader
  > might go on to modify: its caveat that the illustrative `[ADR NNNN](MMMM-...md)` example "would need
  > excluding" was **never true**. `ADR_LINK_LABEL` is `/^ADR (\d{4})$/`, so the label `ADR NNNN` has
  > never matched and the example was always skipped. The entry's conclusion — defer, do not fold — is
  > unaffected by either correction.
- **Make the ADR-number scan resolve the path it already matched.** It sees every `[ADR NNNN](…NNNN-….md)`
  link repo-wide and checks number agreement; adding a resolution check for that one link shape would
  have caught the #160 case in **any** file, not just this one, without link-checking whole documents.
  Narrower than the fencing pass, and it targets exactly the form the *Promotion* rule tells contributors
  to write. The caveat is this file again: its illustrative `[ADR NNNN](MMMM-...md)` example would need
  excluding, which is an argument for fencing the examples first.

This belongs upstream rather than in an overlay: `scripts/parity-check.ts`, `LINK_CHECKED`, and
`docs/rules/README.md` are all vendored baseline files, and any Host App vendoring them inherits the same
silent gap.

### What bryce #160 did in the meantime

Verified the two new ADR links by hand — resolving `../adr/0053-….md` from `docs/rules/` against the
filesystem — and recorded here that a green parity run is **not** evidence for them. No baseline file was
forked and no check was left red; the gap is reported, not worked around.

The fold-vs-defer call was made on this evidence: under `PROJECT.md` → *Rule-suggestion disposition*
(`autonomous-fold`), a change is folded only when **well-scoped and low-risk**. Adding the file to
`LINK_CHECKED` is neither — it reddens the gate on five deliberate examples and needs either a fencing
pass over the prose or a change to what the validator considers a link. Deferred to this entry rather
than attempted inside a convention PR.
