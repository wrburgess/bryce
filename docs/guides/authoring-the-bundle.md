# Authoring the Config Bundle

Conventions for **developing this repo** (adding skills, adapters, rules, and parity checks) — distinct
from the host-facing [`rules/`](../../rules) Lean Core, which is guidance for a Host App's own agents.
These are lessons captured as they were learned; extend as the bundle grows.

## Parity checks: gate on the tree, assert a floor, then check every present member

New structural checks in [`scripts/parity-check.ts`](../../scripts/parity-check.ts) follow one shape,
established by `checkRules`, `checkGuardrails`, and `checkSkills`:

1. **Gate on the surface existing.** `if (!this.dirExists(SURFACE_DIR)) return;` (or gate on the presence
   of a signalling file, e.g. the guardrail sidecar). A bundle that does not ship the surface must **no-op**,
   so minimal / partial fixtures and downstream bundles are never reddened by a check for something they
   deliberately omit.
2. **Assert a `REQUIRED_*` floor.** A small hardcoded list (e.g. `REQUIRED_RULES`, `REQUIRED_SKILLS`)
   proves the expected members ship. This is the **only** part that grows per issue — usually one line.
3. **Apply the structural (shape) checks to every _present_ member**, discovered from disk — not to a
   hardcoded per-member list. Because the shape is enforced on whatever is present, members a later issue
   adds are **covered by construction**, with no edit to the check.

Keep the checker lean — Node built-ins plus the shared `scripts/protected-branches.ts` module, run via
`tsx` ([ADR 0039](../adr/0039-repo-tooling-unifies-on-typescript-remove-ruby.md); the structural-not-model
stance of [ADR 0008](../adr/0008-structural-parity-check-not-model-in-the-loop.md) is unchanged) — assert
**section/heading presence, not content**, so a host freely extends a file's body without reddening CI,
and keep all stdout/stderr output **ASCII** (`rules/scripting.md`). Every new check needs a matching
self-test — a fixture bundle driven through `--root` (one happy path plus one case per failure mode, each
asserting **both** the non-zero exit **and** the specific error string) — so the check can never become a
silent false green.

### Content checks: match forbidden tokens on word boundaries, not raw substrings

A check that scans a file's *content* for forbidden tokens — as the skills content-neutrality check
does (every lifecycle body must reference `PROJECT.md`, and no host-specific proper noun may appear in
any body) — must **not** use a naive `String.includes`. A pure-alphabetic token like `rspec` is a
substring of the innocent word `underspecified`, so raw-substring matching is a false positive waiting
to happen. Split the matcher by token shape:

- **Pure-alphabetic tokens** (`Searchkick`, `rspec`) match only on ASCII-letter word boundaries —
  `/(?<![A-Za-z])TOKEN(?![A-Za-z])/` — so the token matches as a standalone word but not inside a
  larger one.
- **Tokens carrying punctuation** (`bundler-audit`, `.claude/rules/`, `admin_root_path`) match as plain
  substrings; no benign word contains them, and a boundary rule would misfire on the trailing `/`.

Test **both** branches — a positive case per branch **and** a case proving the innocent superword
(`underspecified`) stays green, so the boundary rule itself can't silently regress.

## Porting a template of record: copy byte-identical, verify with `diff -q`

When porting an artifact that is **already business- and tool-neutral** (e.g. a skill body from the
template-of-record repo), copy it **verbatim** and prove it:

```
diff -q <source>/SKILL.md skills/<name>/SKILL.md   # must report nothing
```

Do **not** "improve," reformat, or re-word it in transit. A verbatim port is trivially reviewable (the
diff is provably the source), avoids silent drift from the template of record, and keeps the reason the
artifact was chosen — that it needed no de-coupling — actually true. If a source file *does* carry
host/domain coupling, that de-coupling is real work: call it out in the assessment and plan, and do it as
a visible, reviewed edit — never fold it silently into a "port."

**Worked example — a non-byte-neutral port.** The six lifecycle skills (`assess` … `final`, issue #9)
were the opposite of `distill`: their source bodies carried heavy host/domain coupling —
hardcoded quality-check commands, `Searchkick`/`Pundit`, model names, `admin_root_path`, `P0`/`P1`
severities. The de-coupling was done as visible, reviewed edits (each value re-routed to `PROJECT.md`)
and, crucially, made **enforceable** rather than merely reviewed: the content-neutrality check above
reddens CI if any lifecycle body reintroduces a host token or stops referencing `PROJECT.md`. The
lesson: when a port is **not** byte-neutral, pair the reviewed de-coupling with a parity check that
keeps it de-coupled for the next author — a `diff -q` proves a verbatim port, and a content check
proves a de-coupled one stays de-coupled.
