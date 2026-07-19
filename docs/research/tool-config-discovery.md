# Per-Tool Config-Discovery Verification

Verifies how each of the five coding agents — **Claude Code, Codex, GitHub Copilot,
Gemini, Grok Build** — discovers its instruction/context files, and whether each reliably
**follows a pointer/`@import` to `AGENTS.md`** (the core assumption of
[ADR 0002](../adr/0002-agents-md-canonical-pointer-projection.md)) or requires the
canonical content to be **inlined**.

- **Issue:** wrburgess/ai-config#3 (`Part of #1`); Gemini re-verification #56.
- **As-of:** 2026-07-10 (Grok Build row added and verified 2026-07-10, issue #89; Gemini row re-verified against the 2026-05-19 Gemini CLI →
  Antigravity CLI transition, issue #56; all other rows as-of 2026-07-04). These
  behaviors drift fast (Copilot added three relevant capabilities across 2025-08 →
  2026-06; Google renamed its CLI surface mid-2026); **re-verify before each scaffold
  change** and update the date + citations below.
- **Method:** live fetch of each vendor's primary docs (not recollection); every
  verdict is backed by a dated URL + direct quote in its section. One research pass
  per tool.

## TL;DR — impact on ADR 0002

**ADR 0002's premise holds, but its "thin pointer everywhere" framing was too broad
and is amended.** The mechanism that makes the Canonical Source (`AGENTS.md`) work
splits cleanly into two kinds, and *neither* is a free-text "see AGENTS.md" pointer:

- **Import-expansion** (Claude, Gemini/Antigravity CLI) — the Adapter file contains an `@AGENTS.md`
  directive that the tool *expands and inlines at load time*. Deterministic, not
  fragile pointer-following. **Pointer works.**
- **Native discovery** (Codex, Copilot's relevant surfaces, Grok Build) — the tool reads
  `AGENTS.md` *directly by filename*; no Adapter is needed at all. **Native-canonical.**

The one place the fallback ADR 0002 designed actually fires is **Copilot's older
in-editor IDEs** (JetBrains / Visual Studio / Xcode / Eclipse) that read only
`.github/copilot-instructions.md` and **do not follow a pointer** — there the content
must be **rendered/inlined** (Graceful-Degradation hybrid render). That surface is
outside the Copilot role ADR 0002 actually depends on (PR review + coding agent),
both of which now read `AGENTS.md` natively.

## Summary

| Tool | Relevant surface (per ADR 0002 role) | Native file(s) | `AGENTS.md`? | `@import` a pointer? | Verdict |
|------|--------------------------------------|----------------|--------------|----------------------|---------|
| **Claude Code** | primary developer (CLI/IDE) | `CLAUDE.md` (+ `.claude/`) | not native; via import | **Yes** — `@AGENTS.md`, expands at launch, 4-hop max | **POINTER WORKS** |
| **Codex** | primary reviewer (CLI/cloud) | `AGENTS.md` | **native, by filename** | n/a (reads it directly) | **NATIVE-CANONICAL** |
| **Copilot — coding agent** | opens PRs | `AGENTS.md`, `copilot-instructions.md`, `*.instructions.md` | **native** (since 2025-08-28) | No — pointers not followed | **NATIVE-CANONICAL** |
| **Copilot — code review** | PR comments | `AGENTS.md` (root), `copilot-instructions.md` | **native** (since 2026-06-18) | No — pointers not followed | **NATIVE-CANONICAL** |
| **Copilot — VS Code in-editor** | in-editor chat | `AGENTS.md` (auto), `copilot-instructions.md`, `*.instructions.md` | **native** (gated by `chat.useAgentsMdFile`) | No — links not a guaranteed load | **NATIVE-CANONICAL** |
| **Copilot — other IDEs** (JetBrains/VS/Xcode/Eclipse) | in-editor chat | `.github/copilot-instructions.md` only | not documented | **No** | **HYBRID-RENDER NEEDED** |
| **Gemini** | Antigravity CLI (was Gemini CLI) | `GEMINI.md` (configurable) | via import or `context.fileName` | **Yes** — `@AGENTS.md`, 5-hop max | **POINTER WORKS** |
| **Grok Build** | terminal coding agent (CLI) | `AGENTS.md` | **native, by filename** | n/a (reads it directly) | **NATIVE-CANONICAL** |

Classifications: **POINTER WORKS** (an `@import` in the Adapter reliably inlines the
Canonical Source) · **NATIVE-CANONICAL** (the tool reads `AGENTS.md` directly, no
Adapter needed) · **HYBRID-RENDER NEEDED** (no pointer is followed and `AGENTS.md`
isn't read — the canonical content must be rendered into the tool's file).

---

## Claude Code (Anthropic) — POINTER WORKS

- **Native files & precedence.** Reads `CLAUDE.md` at four scopes — managed-policy,
  user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), and
  local (`./CLAUDE.local.md`, gitignored) — plus `.claude/rules/*.md`. Discovered
  files are **concatenated, not overridden**, loaded broadest-scope → most-specific.
- **Import/pointer (the key).** `CLAUDE.md` supports `@path/to/import` syntax;
  imported files are **expanded and loaded into context at launch**. So `@AGENTS.md`
  loads AGENTS.md's full contents. Recursion is capped at **4 hops**; imports inside
  Markdown code spans are treated as literal text.
- **Native `AGENTS.md`.** Not read natively — the docs state plainly that Claude Code
  "reads `CLAUDE.md`, not `AGENTS.md`," and **officially prescribe the import bridge**
  (`@AGENTS.md`) or a symlink. This is exactly ADR 0002's Claude Adapter.
- **Caveats.** First use of external imports in a project shows a one-time approval
  dialog (decline ⇒ imports disabled). Surface note: findings are from the Claude Code
  CLI docs; IDE-extension / Agent-SDK memory loading was not separately documented
  (UNVERIFIED, not assumed).
- **Verdict:** **POINTER WORKS** — a thin `CLAUDE.md` importing `@AGENTS.md` is the
  documented pattern; content lives once in `AGENTS.md`.

**Citations** (fetched 2026-07-04)
- <https://code.claude.com/docs/en/memory> — "CLAUDE.md files can import additional files using `@path/to/import` syntax. Imported files are expanded and loaded into context at launch."
- <https://code.claude.com/docs/en/memory> — "Imported files can recursively import other files, with a maximum depth of four hops."
- <https://code.claude.com/docs/en/memory> — "Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If your repository already uses `AGENTS.md`… create a `CLAUDE.md` that imports it."
- <https://code.claude.com/docs/en/memory> — "All discovered files are concatenated into context rather than overriding each other."
- Native-support feature request (background, open): <https://github.com/anthropics/claude-code/issues/6235>

---

## Codex (OpenAI) — NATIVE-CANONICAL

- **Native files.** Codex "reads `AGENTS.md` files before doing any work" — it is the
  native canonical instruction file, discovered automatically by filename. It also
  reads nested `AGENTS.md` down the tree and a global `~/.codex/AGENTS.md`
  (`AGENTS.override.md` wins at any level; `CODEX_HOME` relocates the global).
- **Precedence / merge.** Files are **concatenated root-down**, joined by blank lines;
  files closer to the working directory appear later and thus **override earlier
  guidance** (most-specific-wins). Combined size capped at `project_doc_max_bytes`
  (32 KiB default); empty files skipped.
- **Standard.** `AGENTS.md` is the cross-vendor open standard (agents.md); Codex is a
  first-party adopter. **No in-file `@import` directive** exists — modularization is
  via nested `AGENTS.md` files, not imports.
- **Verdict:** **NATIVE-CANONICAL** — the Canonical Source *is* Codex's native file;
  no Adapter, no pointer, no inlining. (Surface note: the guide describes one unified
  discovery model; CLI vs cloud vs IDE differences beyond it are UNVERIFIED.)

**Citations** (fetched 2026-07-04)
- <https://developers.openai.com/codex/guides/agents-md> — "Codex reads `AGENTS.md` files before doing any work."
- <https://developers.openai.com/codex/guides/agents-md> — "Codex concatenates files from the root down… Files closer to your current directory override earlier guidance because they appear later in the combined prompt."
- <https://developers.openai.com/codex/guides/agents-md> — global `~/.codex/AGENTS.md`; cap "`project_doc_max_bytes` (32 KiB by default)"; "at most one file per directory" (no import mechanism).
- <https://agents.md/> — "A simple, open format for guiding coding agents"; adopters include Codex, Gemini CLI, GitHub Copilot coding agent, Cursor, Jules, and others.

---

## GitHub Copilot — NATIVE-CANONICAL (relevant surfaces) / HYBRID-RENDER (legacy IDEs)

This is the highest-uncertainty tool and the one that amends ADR 0002; verdicts are
**per surface**.

- **Native files.** `.github/copilot-instructions.md` (single repo-wide file, read by
  essentially every surface); `.github/instructions/**/*.instructions.md` with
  `applyTo:` glob frontmatter (coding agent, code review, VS Code/Visual Studio);
  agent files `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`; plus personal- and org-level
  instructions on GitHub.com surfaces.
- **`AGENTS.md` support — dated.** **Coding agent** since **2025-08-28** (root +
  nested; nearest wins). **Code review** since **2026-06-18** (root file, used
  "automatically"). **VS Code in-editor** auto-detects a workspace-root `AGENTS.md`,
  gated by the `chat.useAgentsMdFile` setting (default state UNVERIFIED).
- **Pointer/import — the key.** Copilot does **not** follow a pointer to another file
  on GitHub-hosted surfaces — it uses only the **literal, inlined** content of the
  instructions file. GitHub's own guidance: external links — "Copilot won't follow
  them. You should copy relevant info into your instructions files instead." VS Code
  permits Markdown *links* in instructions, but reliable auto-loading of a linked
  file's full content is **not a documented guarantee** (UNVERIFIED).
- **Verdicts (per surface).**
  - Coding agent → **NATIVE-CANONICAL** (reads `AGENTS.md` itself).
  - Code review → **NATIVE-CANONICAL** (reads root `AGENTS.md`).
  - VS Code in-editor → **NATIVE-CANONICAL** (auto-detects `AGENTS.md`).
  - Other IDEs reading only `copilot-instructions.md` (JetBrains/Visual Studio/Xcode/
    Eclipse) → **HYBRID-RENDER NEEDED** — `AGENTS.md` isn't documented as read and
    pointers aren't followed, so the Canonical Source must be inlined there.
  - **No surface is "pointer works."** Either `AGENTS.md` is read natively, or you inline.

**Citations** (fetched 2026-07-04)
- <https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/> — "You can create a single `AGENTS.md` file in the root of your repository. You can also create nested `AGENTS.md` files…" (dated 2025-08-28).
- <https://github.blog/changelog/2026-06-18-copilot-code-review-agents-md-support-and-ui-improvements/> — "You can now add an `AGENTS.md` file at the root of your repository to help shape Copilot code review feedback." (dated 2026-06-18).
- <https://github.blog/ai-and-ml/github-copilot/unlocking-the-full-power-of-copilot-code-review-master-your-instructions-files/> — external links: "Copilot won't follow them. You should copy relevant info into your instructions files instead."
- <https://code.visualstudio.com/docs/copilot/customization/custom-instructions> — "VS Code automatically detects an `AGENTS.md` … file in the root of your workspace … To enable or disable support …, configure the `chat.useAgentsMdFile` setting."
- <https://docs.github.com/en/copilot/concepts/response-customization> — surface/precedence: "path-specific custom instructions are only supported for Copilot cloud agent and Copilot code review"; "the nearest `AGENTS.md` file in the directory tree will take precedence."

---

## Gemini (Google) — POINTER WORKS

- **Native files & precedence.** Gemini CLI's default context file is `GEMINI.md`,
  loaded hierarchically (global `~/.gemini/GEMINI.md`, then workspace/parent dirs, then
  just-in-time subdir files) and **concatenated**. The filename is **configurable** via
  the `context.fileName` setting (accepts a string *or array*).
- **Import/pointer (the key).** The Memory Import Processor supports `@path` imports
  inside a context file — "Use the `@` symbol followed by the path to the file you want
  to import" — with relative and absolute paths, a **default depth of 5**, and circular-
  import detection. So `GEMINI.md` containing `@AGENTS.md` inlines AGENTS.md.
- **`AGENTS.md` two ways.** (a) Set `context.fileName` to include `AGENTS.md` — the
  official example literally lists `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`, making
  it a first-class native context file; or (b) keep default `GEMINI.md` and `@AGENTS.md`
  it. Out of the box (no config), the CLI looks for `GEMINI.md`, not `AGENTS.md`.
- **Surface caveat.** Gemini **Code Assist** (IDE agent mode) natively accepts a root
  `GEMINI.md` or `AGENT.md` (singular) and manual `@FILENAME` inclusion, but does not
  document the import processor or `context.fileName` — there, prefer native
  `GEMINI.md`/`AGENT.md` over a thin pointer.
- **Antigravity CLI transition (announced 2026-05-19).** At Google I/O 2026 Google
  announced that **Gemini CLI is superseded by Antigravity CLI**; consumer Gemini CLI +
  Gemini Code Assist IDE extensions stopped serving requests on **2026-06-18**
  (enterprise Code Assist Standard/Enterprise access is **unchanged**). This is a
  *surface rename, not a mechanism change*: the context-file layer carries over — the
  default `GEMINI.md`, the `context.fileName` setting, and the `@file.md` memory import
  all persist (the context-file citation below still applies) — and Antigravity **added
  native `AGENTS.md` reading** in v1.20.3 (2026-03-05), which on its own keeps the
  Canonical Source resolvable even independent of the `@`-import. The Adapter
  (`GEMINI.md` → `@AGENTS.md`) and the structural parity check therefore need **no
  corrective change** — though this PR does additionally teach the check to accept the
  native-`AGENTS.md` resolution the transition makes first-class (a hardening, not a fix).
- **Verdict:** **POINTER WORKS** — unchanged by the Antigravity CLI transition (import or
  `context.fileName` on the CLI; IDE Code Assist favors native `GEMINI.md`/`AGENT.md`).

**Citations** (fetched 2026-07-04)
- <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md> — "While `GEMINI.md` is the default filename, you can configure this in your `settings.json`"; example `"context": { "fileName": ["AGENTS.md", "CONTEXT.md", "GEMINI.md"] }`; "loads various context files … concatenates the contents … and sends them to the model with every prompt."
- <https://geminicli.com/docs/reference/memport/> — "Use the `@` symbol followed by the path to the file you want to import"; "a configurable maximum import depth (default: 5 levels)"; "automatically detects and prevents circular imports."
- <https://developers.google.com/gemini-code-assist/docs/use-agentic-chat-pair-programmer> — Code Assist: create "a file named either GEMINI.md or AGENT.md at the root of your project"; "add context by including a file manually with the @FILENAME syntax."
- <https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/> — (fetched 2026-07-07) I/O 2026 developer highlights (2026-05-19): "We encourage Gemini CLI users to migrate to Antigravity CLI."
- <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/> — (fetched 2026-07-07) "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for Google AI Pro and Ultra"; enterprise Code Assist Standard/Enterprise "access remains unchanged"; Antigravity CLI "keeps the most critical features" of Gemini CLI (Agent Skills, Hooks, Subagents, Extensions). *(This post covers the transition and dates only — the `GEMINI.md`/`AGENTS.md`/`@`-import continuity is sourced from the two citations below, not here.)*
- <https://discuss.ai.google.dev/t/antigravity-update-1-20-3-2026-3-5/129320> — (fetched 2026-07-07) Antigravity update **1.20.3** (2026-03-05): "Added support for reading rules from `AGENTS.md` in addition to `GEMINI.md`." Native `AGENTS.md`, so the Canonical Source is read directly even without the `@`-import.
- <https://geminicli.com/docs/cli/gemini-md.md> — (fetched 2026-07-07) current context-file doc (carries a banner that "Gemini CLI will be replaced by Antigravity CLI"): default file `GEMINI.md`, filename configurable via `context.fileName` (example `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`), and "break down large `GEMINI.md` files … by importing content from other files using the `@file.md` syntax" — i.e. the `context.fileName` + `@`-import mechanism persists across the surface rename.

---

## Grok Build (xAI) — NATIVE-CANONICAL

- **Native files.** Grok Build reads `AGENTS.md` **natively, by filename** — no adapter, no pointer.
  Its launch post: *"Your AGENTS.md, plugins, hooks, skills, and MCP servers all work out of the box."*
- **Import/pointer.** n/a — like Codex, it reads the Canonical Source directly; there is no in-file
  `@import` to configure.
- **`AGENTS.md` support.** Native since launch (early beta, 2026-05-25). It slots in exactly like
  Codex and Copilot: **native-canonical — no Adapter, no parity-check change.**
- **Model.** Grok Build is *"now powered by Grok 4.5 — our new model"* (`x.ai/cli`). It launched on
  **`grok-build-0.1`** (`x.ai/news/grok-build-0-1`, 2026-05-29 — *"the same model that powers the Grok
  Build CLI"*), which **Grok 4.5** superseded as the CLI's default model on 2026-07-08
  (`x.ai/news/grok-4-5`). Living docs name the current model family **Grok / Grok 4.5**; the superseded
  `grok-build-0.1` is recorded here as history, not adopted as the current model.
- **Verdict:** **NATIVE-CANONICAL** — the Canonical Source *is* Grok Build's native file; no Adapter,
  no pointer, no inlining.

**Citations** (fetched 2026-07-10)
- <https://x.ai/news/grok-build-cli> — (2026-05-25) "Grok Build is a new coding agent that runs right from your terminal."
- <https://x.ai/news/grok-build-cli> — (2026-05-25) "Your AGENTS.md, plugins, hooks, skills, and MCP servers all work out of the box."
- <https://x.ai/news/grok-build-0-1> — (2026-05-29) "the same model that powers the Grok Build CLI." (`grok-build-0.1`, the launch model, since superseded by Grok 4.5.)
- <https://x.ai/cli> — "A powerful coding agent and CLI for complex coding work, now powered by Grok 4.5 — our new model."
- <https://x.ai/news/grok-4-5> — (2026-07-08) "Grok 4.5 is now the default model in Grok Build."
- <https://x.ai/build/changelog> — CLI version 0.2.94 (2026-07-09); the pre-1.0 (0.2.x) line ships ~daily.
- *Method note:* WebFetch is HTTP 403-blocked on `x.ai` (pages load only via a live browser session), and the changelog's latest release needs a live-DOM read — a single page-text fetch mis-selects a stale entry — so re-verify it against the DOM or an independent release tracker. Facts here are from live primary `x.ai` pages, corroborated by `byteiota.com` and independent trackers.

---

## Impact on ADR 0002 — confirmed with amendments

[ADR 0002](../adr/0002-agents-md-canonical-pointer-projection.md) is **confirmed** in
its core decision (one Canonical Source; per-tool Adapters resolve to it) and
**amended** in two specifics; the ADR file carries a matching *Verification* section.

1. **Confirmed — Claude Adapter.** `CLAUDE.md` → `@AGENTS.md` is the documented,
   deterministic import. (Add operational caveats: one-time import-approval dialog,
   4-hop recursion limit.)
2. **Confirmed — Gemini Adapter.** `GEMINI.md` → `@AGENTS.md` works (or name
   `AGENTS.md` directly via `context.fileName`). IDE Code Assist favors native
   `GEMINI.md`/`AGENT.md`. Unchanged by the 2026-05-19 Gemini CLI → Antigravity CLI
   transition (re-verified 2026-07-07, #56): Antigravity CLI still honors both files.
3. **Confirmed — Codex.** Reads `AGENTS.md` natively; no Adapter needed — as ADR 0002
   already stated.
4. **Amended — Copilot Adapter (ADR 0002 line: "`.github/copilot-instructions.md` —
   short pointer").** A *short pointer is followed by no Copilot surface.* Replace with:
   rely on **native `AGENTS.md`** for the surfaces ADR 0002 actually depends on (coding
   agent since 2025-08-28, code review since 2026-06-18, VS Code in-editor); reserve a
   **rendered/inlined `.github/copilot-instructions.md`** (Graceful-Degradation hybrid
   render) only if the non-`AGENTS.md`-aware IDEs (JetBrains/Visual Studio/Xcode/
   Eclipse) must be supported.
5. **Reinforced — CI parity check (ADR 0008).** The check must verify **two** Adapter
   shapes: (a) that import-style Adapters (`CLAUDE.md`, `GEMINI.md`) contain a resolvable
   `@AGENTS.md`; and (b) that any *rendered* Adapter (a hybrid-render
   `copilot-instructions.md`) matches the current `AGENTS.md` byte-for-byte in its
   rendered region — a rendered copy is the drift risk a pointer doesn't have.

**Net:** no scaffold-blocking surprise. The two heaviest agents (Claude dev, Codex
review) look exactly where the Canonical Source lives; Copilot's PR surfaces now read
`AGENTS.md` natively; the hybrid render is a narrow, well-scoped fallback rather than
the default. **Scaffolding (issue #2 / Epic #1) may proceed** on ADR 0002 as amended.

## Re-verification

- **Cadence:** re-run this pass before any change to the Adapter/scaffold layer, and
  otherwise no less than quarterly — Copilot alone shipped three relevant changes in
  ~10 months.
- **Watch items:** native `AGENTS.md` in Claude Code (open FR #6235); Copilot
  `AGENTS.md` reaching JetBrains/Visual Studio/Xcode/Eclipse in-editor (would retire
  the one HYBRID-RENDER surface); the `chat.useAgentsMdFile` default; a future
  **Antigravity CLI** release changing the default context filename away from `GEMINI.md`
  (the one scenario that would silently false-green the structural parity check).
- **Method to repeat:** one research pass per tool against the vendor's primary docs;
  record dated URL + direct quote per verdict; update the **As-of** date at the top.

— Claude Code (Opus 4.8)
