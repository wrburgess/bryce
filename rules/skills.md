# Skills Rules

**Applies to:** `skills/` (canonical Skill bodies) and their Invocation Shims (`.claude/commands/*.md`)
**Deep doc:** `docs/rules/skills-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

A Skill is authored **once** as a canonical body at `skills/<name>/SKILL.md` and reached through thin per-tool shims ([ADR 0003](../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md), [ADR 0010](../docs/adr/0010-repo-layout-canonical-skills-at-root.md)). These rules keep every skill body generic, single-sourced, and portable.

## Patterns

- **Read host values from `PROJECT.md`.** Quality-check commands, attribution/model, branch policy, review severities, and the lifecycle host all live in the Project Config. A skill body names the lifecycle *verb* ("post the assessment to the issue"), not a platform command.
- **Reference, don't restate.** A skill that composes others (e.g. an orchestrator) points at each phase's canonical body for its procedure; it never copies those steps. The procedure lives in exactly one place so an edit can't leave two copies to drift.
- **Keep the shim thin.** An Invocation Shim carries no procedure — it points at `skills/<name>/SKILL.md`, the single source of truth. Only tool-specific *execution enhancements* degrade across tools; the procedure and quality gates never do.
- **Use the portable Skill format.** YAML frontmatter with a `name` and `description`, a markdown body, and optional bundled files — so every configured tool can discover and run it.

## Anti-Patterns

- **Never restate another skill's procedure inside a skill body** — because it forks the single source of truth, and the copy silently drifts the next time the original changes. Reference the canonical body instead. *(Extend per host.)*
- **Never hardcode a host value in a skill body** — a stack command, an attribution string, or a platform verb — because the body must stay generic across every Host App; read it from `PROJECT.md`. *(Extend per host.)*
- **Never let a shim carry procedure or quality gates** — because a shim that duplicates the body becomes a second, drifting source; it must only point at `skills/<name>/SKILL.md`. *(Extend per host.)*
- **Never let a scoped or partial invocation record shared progress it didn't make** — when a sweep/scan-style skill gains a narrower mode (an inbox-only run, a single-item hand-off), any high-water state it advances — a last-swept marker, a cursor, a dedupe cache — must be gated on the *full-scope* path; a partial run that stamps progress it skipped makes the next full run silently skip that window. Audit the **quality-gate / checklist** for the invariant too, not just the numbered steps — a stale "always advance" assertion hides there. See `docs/rules/skills-postmortems.md`. *(Extend per host.)*
- **Never size the always-loaded instruction files per-file** — `@AGENTS.md` expands into `CLAUDE.md` at launch, so Claude re-reads the *combined* surface every session; it is that combined payload (~200 lines), not either file alone, that must stay lean. Represent the Skills roster in `AGENTS.md` as a compact `name → purpose → body` table, not a paragraph per skill — the detail already lives in each `SKILL.md` ([ADR 0022](../docs/adr/0022-instruction-file-line-allowance.md)). *(Extend per host.)*
- **Never trim length by moving a load-bearing instruction behind a link** — Copilot does not follow external links, so an instruction relocated to a pointer is lost to it. Relocate only *reference* content (descriptions, history) to save space; keep instructions (the umbrella closing-keyword rule, the invocation distinction, the quality gate) resident in the file. *(Extend per host.)*
