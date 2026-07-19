---
description: Stage 1 (Assess) — research a tracked issue and post an assessment with 2-3 options for the HC.
---

Read and follow the canonical skill body at
[`skills/assess/SKILL.md`](../../skills/assess/SKILL.md), then execute its procedure for the issue
named in the invocation.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
