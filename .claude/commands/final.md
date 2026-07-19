---
description: Stage 5 (Deliver) — re-verify the existing PR is green, post the Statement of Work, and link it from the issue. Never self-merges.
---

Read and follow the canonical skill body at
[`skills/final/SKILL.md`](../../skills/final/SKILL.md), then execute its procedure for the PR named in
the invocation.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body is the single source of truth; the same skill is invoked by every
other tool via native `AGENTS.md` discovery.
