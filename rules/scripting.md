# Scripting Rules

**Applies to:** Bundled and CLI scripts shipped in the Config Bundle or a Host App
**Deep doc:** `docs/rules/scripting-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Dependency-free by default.** A bundled script must run on a bare runtime in an unknown CI — use the standard library only (no third-party packages, no package manager) unless the host explicitly opts in.
- **Deterministic, greppable output.** Emit stable, parseable lines and exit non-zero on failure, so a Host App or CI can assert on the result.
- **Assume an unknown environment.** Locale, terminal encoding, and redirected pipes vary across hosts and CI runners; write for the least-capable one.

## Anti-Patterns

- **Never emit non-ASCII bytes from a bundled script's stdout/stderr** — because a Host App or CI runner on a non-UTF-8 locale raises `invalid byte sequence` the moment it reads or matches the output. Use ASCII (`->`, not a unicode arrow), or explicitly set the stream encoding. This rule is **author-owned, not machine-enforced**: it governs *runtime output*, whereas the sources deliberately carry non-ASCII bytes elsewhere (em dashes in comments; the functional `EM_DASH` separator constant), so a source-byte scan is the wrong instrument — see [ADR 0011](../docs/adr/0011-ascii-safe-stdout-stays-doc-only.md). The natural catch point is a test that asserts a script's captured output. *(Provenance: issue #5 / PR #14; extend per host.)*
- **Never add a third-party dependency to a bundled script** — because the bundle must run without a package manager on a bare runtime; reach for the standard library instead. *(Extend per host.)*
