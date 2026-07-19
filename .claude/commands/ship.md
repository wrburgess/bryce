---
description: The hands-off orchestrator — sequence the six lifecycle skills (assess → devise → invoke → verify → listen → final) for one issue, delegating output-heavy work and honoring the host's gate policy (in this host, one stop at merge).
---

Read and follow the canonical skill body at
[`skills/ship/SKILL.md`](../../skills/ship/SKILL.md), then execute its procedure for the issue named
in the invocation.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
