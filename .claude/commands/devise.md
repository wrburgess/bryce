---
description: Stage 2 (Plan) — turn the chosen assessment option into an ordered plan with an up-front testing strategy, posted on the issue.
---

Read and follow the canonical skill body at
[`skills/devise/SKILL.md`](../../skills/devise/SKILL.md), then execute its procedure for the issue named
in the invocation.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
