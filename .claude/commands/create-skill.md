---
description: Authoring front door — scaffold a new, conforming Skill (canonical body + thin shim) with full repo + skill-set context, then open a review PR.
---

Read and follow the canonical skill body at
[`skills/create-skill/SKILL.md`](../../skills/create-skill/SKILL.md), then execute its procedure for the
new Skill named in the invocation.

> **Upstream:** adapted from Anthropic's `skill-creator` (<https://github.com/anthropics/skills>) — see
> the canonical body's *Provenance* note.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
