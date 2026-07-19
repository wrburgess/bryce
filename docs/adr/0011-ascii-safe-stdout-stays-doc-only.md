# The ASCII-safe-stdout scripting anti-pattern stays doc-only, not machine-enforced

**Status:** accepted

The Tier-1 scripting rule ([`rules/scripting.md`](../../rules/scripting.md)) carries the anti-pattern
*"never emit non-ASCII bytes from a bundled script's stdout/stderr"* (provenance: issue #5 / PR #14,
where a `→` glyph in `bin/ai-config-sync`'s output crashed on a US-ASCII-locale runner). A follow-up
(#18) proposed **machine-enforcing** it with a parity check that fails when any `bin/*` or `scripts/*`
**source file** contains a non-ASCII byte. We decline that enforcement and keep the rule doc-only.

## Why a source-byte scan is the wrong instrument

- **The sources contain intentional non-ASCII bytes.** Every bundled `bin/`/`scripts/` file uses em
  dashes (`—`) in comments, and [`scripts/protected_branches.rb`](../../scripts/protected_branches.rb)
  defines a **functional** `EM_DASH = "—"` constant — it exists to parse the ` — ` separator in
  `PROJECT.md`'s Branch & PR Policy, the source of the protected-branch list. A source scan would
  redden CI immediately and fight a load-bearing constant.
- **The rule targets runtime output, not source bytes.** The failure mode is a non-ASCII byte reaching
  a pipe under a non-UTF-8 locale. Whether a given source byte is *emitted* cannot be decided by
  scanning the file — a comment em dash is harmless; an em dash in a string passed to `puts` is not.
- **The faithful proxies cost more than the bug.** A static approximation (scan non-comment source
  plus an allowlist/pragma for `EM_DASH`) adds a new convention and a per-language comment parser that
  both over- and under-reaches; a runtime check (execute each script under a `C` locale and inspect
  output) needs a guaranteed side-effect-free entrypoint per script (`bin/setup`,
  `bin/install-git-hooks` mutate state). Both are disproportionate to a stdout-formatting rule.

## Decision

The anti-pattern remains **resident documented guidance**, obeyed by authors and caught in practice by
tests that assert a script's captured output (the mechanism that caught the original #5 bug). The rule
text is marked author-owned / not machine-enforced. This resolves #18.

## Consequences

- No new parity check is added for this rule; the parity harness stays focused on structural
  invariants (ADR 0008).
- If a host later wants a mechanical backstop, the correct scope is a **runtime-output** check over an
  explicit side-effect-free entrypoint per script — filed separately, not bolted onto the structural
  checker.
- Consistent with ADR 0003: the quality bar (ASCII-safe output) is unchanged; only the enforcement
  *mechanism* is a deliberate no-op here, by cost-benefit, not by lowering the bar.
