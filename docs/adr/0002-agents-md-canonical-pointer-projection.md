# `AGENTS.md` is the Canonical Source; per-tool files are thin pointers

**Status:** accepted — verified & amended 2026-07-04 (see [Verification](#verification-2026-07-04--issue-3) and `docs/research/tool-config-discovery.md`)

The full, model-neutral instruction content lives in **one** file — `AGENTS.md` (the emerging cross-tool standard). Each other tool's native config surface is an **Adapter** that resolves to it, rather than a full copy. Verification (2026-07-04) established that "resolves to it" takes one of two concrete forms — **import-expansion** (`@AGENTS.md`, inlined at load time) or **native discovery** (the tool reads `AGENTS.md` by filename) — and that a free-text "see AGENTS.md" pointer is **not** a mechanism any tool follows:

- `CLAUDE.md` — imports `AGENTS.md` (`@AGENTS.md`, expanded at launch; 4-hop recursion limit; one-time import-approval dialog) plus Claude-only `.claude/` notes
- `GEMINI.md` — imports `AGENTS.md` (`@AGENTS.md`) or names it directly via the `context.fileName` setting
- Codex — **no Adapter needed**: reads `AGENTS.md` natively by filename
- `.github/copilot-instructions.md` — **not a pointer** (see amendment #4 below): Copilot's PR surfaces read `AGENTS.md` natively; this file is only a *rendered* (inlined) Adapter for legacy in-editor IDEs that read nothing else

We reject the generator/render model (inline the full content into all four files via a build step) as the *default* because it multiplies the number of places content lives and pays generator complexity for all four tools up front. The pointer model keeps content in one place, so a Host App customizes `AGENTS.md` once and every tool inherits.

## Motivating context — tool role tiers

The tools are not co-equal daily drivers, which makes the pointer model low-risk:

- **Claude** — primary developer (full `.claude/` config; unquestionably follows its own config)
- **Codex** — primary reviewer (reads `AGENTS.md` natively)
- **Copilot** — chimes in with PR comments (its **coding agent** reads `AGENTS.md` natively since 2025-08-28 and **code review** since 2026-06-18; its backing model is not something we control or assume)
- **Gemini** — not yet in use, under consideration (keep its Adapter present but minimal)

The two heaviest users already look exactly where the Canonical Source lives.

## Consequences

- **Hybrid fallback:** if per-tool verification (see the parity phase) shows a tool won't reliably *follow* a pointer, we render *that one tool's* file with inlined content — pointer where it works, render where it doesn't. Generator complexity stays proportional to the actual problem.
- A CI parity check must confirm each Adapter still resolves to the Canonical Source (guards against a pointer going stale). Verification refined this: the check covers **two** Adapter shapes — import Adapters (`CLAUDE.md`/`GEMINI.md`) must carry a resolvable `@AGENTS.md`, and any *rendered* Adapter (a hybrid-render `copilot-instructions.md`) must match `AGENTS.md` byte-for-byte in its rendered region (a rendered copy is the real drift risk).
- Attribution and instructions must not assume any tool's backing model (Copilot's especially is unknown/variable).

## Verification (2026-07-04 — issue #3)

Per-tool config-discovery was verified against each vendor's primary docs; full findings, dated citations, and re-verification cadence live in [`docs/research/tool-config-discovery.md`](../research/tool-config-discovery.md). The core decision (one Canonical Source; Adapters resolve to it) **stands**. Amendments folded in above:

1. **Confirmed — Claude:** `CLAUDE.md` → `@AGENTS.md` is the officially documented import (expanded at launch; 4-hop limit; one-time approval dialog). **POINTER WORKS.**
2. **Confirmed — Codex:** reads `AGENTS.md` natively by filename (nested + global, concatenated, 32 KiB cap); no Adapter. **NATIVE-CANONICAL.**
3. **Confirmed — Gemini:** `GEMINI.md` → `@AGENTS.md` import (5-hop) or `context.fileName` naming `AGENTS.md`. **POINTER WORKS** (CLI); Code Assist IDE favors native `GEMINI.md`/`AGENT.md`.
4. **Amended — Copilot:** the original "`.github/copilot-instructions.md` — short pointer" is wrong; **no Copilot surface follows a pointer** ("Copilot won't follow [external links]"). Its relevant surfaces read `AGENTS.md` **natively** (coding agent 2025-08-28, code review 2026-06-18, VS Code in-editor via `chat.useAgentsMdFile`). A **rendered/inlined** `copilot-instructions.md` (Graceful Degradation) is reserved only for legacy in-editor IDEs (JetBrains/Visual Studio/Xcode/Eclipse) that read nothing else. **NATIVE-CANONICAL** on the surfaces we depend on; **HYBRID-RENDER** only on that narrow tail.

**No scaffold-blocking surprise** — the two heaviest agents (Claude dev, Codex review) and Copilot's PR surfaces all look where the Canonical Source lives. Scaffolding may proceed on ADR 0002 as amended.
