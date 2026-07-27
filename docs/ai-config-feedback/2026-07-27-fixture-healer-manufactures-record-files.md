# 2026-07-27 — the self-test fixture's dead-link healer manufactures record files, masking the defect it heals (bryce issue #163)

## F18 — `healDeadLinks` stubs into a numbered-records directory and turns a dead link into a duplicate-number error

**Disposition: `upstream` · Status: recorded**

`healDeadLinks` in [`test/tooling/parity-fixture.ts`](../../test/tooling/parity-fixture.ts) writes a stub
file for every unresolved link it finds, so a bundle copy is green before a self-test mutates it. That is
sound while the link scope holds only prose. It stops being sound the moment the scope includes a
directory whose **filenames carry meaning** — and the baseline ships exactly one such directory,
`docs/adr/`, whose `NNNN-` prefix is validated for uniqueness by `checkAdrNumbers`.

Widening the scope to `docs/adr/` exposed the interaction. Probed directly, before any fix, with the
tree's then-real dead link (`docs/adr/0040-…md` → `0029-per-game-stat-line-identity.md`, whose actual
filename is `0029-stat-lines-per-game-keyed-by-game-id.md`):

```
STUB CREATED: true
ALL ERRORS: [
  "Duplicate ADR number 0029: [\"0029-per-game-stat-line-identity.md\",
   \"0029-stat-lines-per-game-keyed-by-game-id.md\"] share it - renumber all but one…"
]
```

The healer created an ADR that nobody wrote, `checkAdrNumbers` correctly reported the collision it caused,
and **the dead-link error disappeared from the output entirely**. A one-line link typo presents as a
numbering conflict between two files, one of which does not exist in the repository. The advice in the
error — "renumber all but one" — is actively wrong.

**Why no existing test caught it.** Both parity self-test suites filter `runParityCheck().errors` to their
own category (`/^Dead link /`, `/^Rules pointer /`, …) before asserting. An error moving *between*
categories is invisible to every one of them. The probe above had to dump the unfiltered array to see it.

**And why it is latent on `main` right now.** Issue #164 (PR #172) landed the scope widening — putting
`docs/adr/` in the healer's reach — and repaired both of the tree's dead ADR links in the same change. The
healer therefore has nothing to stub today, and the defect is invisible: it arms itself again the moment
anyone writes the next dead ADR citation, which is precisely what a link checker exists to catch. The
widening and this guard belong together; they shipped apart, which is itself the thing worth recording.

## Why this is `upstream`, not host-only

Nothing here is specific to bryce's stack or domain. The three ingredients — a fixture that heals dead
links, a validator that derives meaning from filenames, and a link scope that grows over time — are all
baseline mechanisms, shipped together. Any Host App vendoring the bundle inherits the latent defect and
will hit it the same way: the first time it link-checks its own ADR directory. It is also a *general*
shape worth naming, not a one-off — a fixture that synthesizes files to satisfy one check can violate
another, and the failure surfaces as a confident, well-formed error about the wrong thing.

## The fix applied here

`healDeadLinks` refuses to synthesize anything whose **resolved** path lands under `docs/adr/`. Tested on
the resolved path rather than a filename pattern, so `../adr/x`, `./0001-y.md`, and a bare name all land
in the same rule; an earlier draft matched the ADR filename pattern and would have stubbed a traversal,
non-`.md` target. A dead ADR link now surfaces *as a dead link* in fixture copies too, which is the honest
outcome — the bundle copy is a test fixture, not a place to invent records.

Four regression tests cover it. Measured, not assumed: removing the containment line fails **three** of
them — the duplicate-number case, the traversal/non-ADR-shaped case, and the case-fold case. The fourth
("leaves `docs/adr` byte-for-byte identical to the real repository's listing") does **not** fail, because
`main` currently has no dead ADR link for the healer to stub, so a pristine bundle copy is unpolluted
either way. It is a forward-looking detector — it catches pollution from a link shape nobody predicted,
once one exists — not a guard against this containment being reverted. The other three are that guard.

## Suggested upstream shape

Narrower than "never stub anywhere": the rule the baseline wants is *do not synthesize a file into a
directory whose contents are themselves validated by name*. Today that is `docs/adr/` alone, so a single
containment test is enough. If a future baseline check derives meaning from filenames elsewhere, the
exclusion set is the place that grows — worth a named constant rather than an inline path so the next such
directory is one line, and worth stating in the healer's contract that it heals *prose targets only*.

Worth considering alongside it: the self-tests' habit of filtering errors by category is what let this hide.
A single assertion somewhere that a fixture copy produces **no errors at all** — rather than none in one
category — would have caught it on the first run.
