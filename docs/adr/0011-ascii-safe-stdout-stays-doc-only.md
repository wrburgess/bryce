# The ASCII-safe-stdout scripting anti-pattern stays doc-only, not machine-enforced

**Status:** accepted — the Ruby script cited below was later removed by
[ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md); see
[Records note](#records-note-2026-07-27--issue-164). The decision stands unchanged.

The Tier-1 scripting rule ([`rules/scripting.md`](../../rules/scripting.md)) carries the anti-pattern
*"never emit non-ASCII bytes from a bundled script's stdout/stderr"* (provenance: issue #5 / PR #14,
where a `→` glyph in `bin/ai-config-sync`'s output crashed on a US-ASCII-locale runner). A follow-up
(#18) proposed **machine-enforcing** it with a parity check that fails when any `bin/*` or `scripts/*`
**source file** contains a non-ASCII byte. We decline that enforcement and keep the rule doc-only.

## Why a source-byte scan is the wrong instrument

- **The sources contain intentional non-ASCII bytes.** Every bundled `bin/`/`scripts/` file uses em
  dashes (`—`) in comments, and `scripts/protected_branches.rb` defines a **functional**
  `EM_DASH = "—"` constant — it exists to parse the ` — ` separator in `PROJECT.md`'s Branch & PR
  Policy, the source of the protected-branch list. A source scan would redden CI immediately and fight
  a load-bearing constant.
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

## Records note (2026-07-27 — issue #164)

`scripts/protected_branches.rb`, cited above as evidence that the sources carry intentional non-ASCII
bytes, no longer exists: [ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md) replaced the
Ruby tooling with TypeScript. Its link is therefore **de-linked to backticked prose rather than repointed
at the successor** — the file was real when this decision was accepted, and an ADR records what was
decided, not what the tree looks like today
([ADR 0057](0057-adr-links-repair-identity-annotate-loss.md)).

The argument itself did **not** rot. The successor, `scripts/protected-branches.ts`, still declares the
same load-bearing `const EM_DASH = "—";` and still splits `PROJECT.md`'s Branch & PR Policy line on it, so
a source-byte scan would fight a functional constant today exactly as it would have then. The decision
above stands on its own terms; only the filename moved.
