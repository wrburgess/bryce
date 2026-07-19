---
description: Review-response — fetch every review thread on the PR, classify by severity, and (after HC chooses) fix, re-check, and reply.
---

Read and follow the canonical skill body at
[`skills/listen/SKILL.md`](../../skills/listen/SKILL.md), then execute its procedure for the PR named in the
invocation.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
