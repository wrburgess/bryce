<!-- parity:native source=AGENTS.md -->

# GitHub Copilot — instruction discovery

Copilot's PR-relevant surfaces read the [Canonical Source](../AGENTS.md) **natively** by filename:
the coding agent (since 2025-08-28), code review (since 2026-06-18), and VS Code in-editor (via
`chat.useAgentsMdFile`). There is nothing to duplicate here — `AGENTS.md` **is** the instruction set
Copilot uses ([ADR 0002](../docs/adr/0002-agents-md-canonical-pointer-projection.md)).

This file is a **discovery marker**, not a copy. It exists so the presence of Copilot instructions is
explicit and so the parity check can confirm the Adapter's shape (the `parity:native` comment above).
It is **intentionally not a full render** of `AGENTS.md` (Generic Baseline uses the native-discovery
option).

## Opt-in full render (legacy in-editor Copilot only)

A narrow tail of legacy in-editor IDEs (JetBrains, Visual Studio, Xcode, Eclipse) reads only
`.github/copilot-instructions.md` and follows no pointer. A Host App that drives work through one of
those can opt into a **full render**: replace the marker above with a
`<!-- parity:render source=AGENTS.md -->` … `<!-- parity:endrender -->` block whose content is a
byte-for-byte copy of `AGENTS.md`. The parity check enforces that the rendered region matches
`AGENTS.md` exactly, so it will catch any drift. See
[`PROJECT.md`](../PROJECT.md) → *Lifecycle Host* for the toggle.
