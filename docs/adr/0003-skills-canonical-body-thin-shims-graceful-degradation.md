# Skills = one canonical body + thin per-tool shims + graceful degradation

**Status:** accepted

A Skill is authored **once** as a canonical body in a tool-neutral directory (`skills/<name>/SKILL.md`, using Anthropic's portable Skill format: YAML frontmatter `name`/`description` + markdown body + optional bundled files — the closest thing to a cross-tool standard). Each tool reaches it through a **thin Invocation Shim** (Claude: `.claude/commands/<name>.md` and/or a `.claude/skills/` entry; others: a named, documented procedure in `AGENTS.md` plus a native prompt/command file where the tool supports one).

**Skills do not behave identically on every tool — and that is deliberate.** The *procedure and quality gates are identical everywhere*; only *tool-specific execution enhancements degrade gracefully*. The motivating case is `ship`: its sub-agent-per-phase context offloading is a Claude-native capability (the `Task`/sub-agent tool). On a tool without that fan-out, the same phase sequence runs inline with a documented "compact between phases" fallback.

We reject the "lowest common denominator" alternative (build every skill only to what all four tools can do identically) because it would discard Claude's sub-agent offloading — the exact capability requested for `ship`.

## Consequences

- Each Skill body must separate the **invariant procedure + gates** (universal) from **execution optimizations** (tool-specific, degradable) so a shim can honestly advertise what its tool does and doesn't do.
- Capability varies by tool tier (Claude richest → Gemini minimal); a skill must never *lower a quality gate* to accommodate a weaker tool — it degrades the *mechanism*, never the *bar*.
