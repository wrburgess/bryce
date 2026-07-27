# 2026-07-27 — the file that documents the link-promotion rule has its own links validated by nothing (bryce issue #160)

## F16 — `docs/rules/README.md` is outside every link validator, and the reason is unstated

**Disposition: `upstream` · Status: recorded**

[`docs/rules/README.md`](../rules/README.md) is the repo's authority on how to write a path reference —
*Convention: reference a not-yet-existing path as a backticked path, never a markdown link*, and the
**Promotion** rule that issue #154 pinned ("write the link the way Markdown resolves it: relative to the
file you are writing in, not to the repo root"). **Its own markdown links are checked by nothing.**

**Checked rather than assumed**, since that is the claim this entry rests on:

| Validator | Covers `docs/rules/README.md`? | Why not |
|---|---|---|
| `checkLinks` (dead-link resolution) | **No** | Resolves links only in the explicit `LINK_CHECKED` list (`scripts/parity-check.ts:40-53`); the file is absent from it |
| Repo-wide ADR-number scan | **No** | `ADR_LINK_TARGET = /^(\d{4})-[^/]+\.md$/` matches a **bare sibling filename only** — any target containing `/` (`../adr/0053-….md`, `docs/adr/0053-….md`) is not matched at all, so only links written *from inside* `docs/adr/` are checked |
| `checkRulesPointers` | **No** | Scoped to `rules/*.md`, not `docs/rules/` |

Demonstrated on the #160 change: writing this file's new ADR reference in the **repo-root spelling** —
`[ADR 0053](docs/adr/0053-….md)`, the exact form the file's own *Promotion* rule rejects because it
"names a real file yet renders as a 404" — left `npx tsx scripts/parity-check.ts` **green**. The negative
check written to prove the gate could go red instead proved it could not.

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
- **Widen `ADR_LINK_TARGET` to traversal forms.** `[ADR NNNN](../adr/NNNN-….md)` is the spelling the
  *Promotion* rule tells contributors to use from a sibling directory, and it is precisely the spelling
  the scan cannot see. Matching it repo-wide would have caught the #160 case in any file, not just this
  one. Narrower than link-checking the whole file, and it targets the exact form the docs promote.

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
