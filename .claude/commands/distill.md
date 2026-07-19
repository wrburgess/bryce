---
description: Grill a plan against the domain model one question at a time, sharpen terminology, and capture decisions inline as a CONTEXT.md glossary + ADRs.
---

Read and follow the canonical skill body at
[`skills/distill/SKILL.md`](../../skills/distill/SKILL.md), then execute its
procedure for the current plan or topic.

This file is a thin **Invocation Shim** ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md)) — it carries **no procedure
of its own**. The canonical body and its sibling format specs
(`skills/distill/CONTEXT-FORMAT.md`, `skills/distill/ADR-FORMAT.md`) are the single
source of truth; the same skill is invoked by every other tool via native `AGENTS.md` discovery.

> **Upstream:** adapted from Matt Pocock's `grill-with-docs`
> (<https://www.aihero.dev/grill-with-docs>) — see the canonical body's *Provenance* note.
