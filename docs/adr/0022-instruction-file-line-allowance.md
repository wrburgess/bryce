# Instruction-file line allowance (soft budget for the Canonical Source + adapters)

The always-loaded instruction files carry a **recurring, four-way context cost** — `AGENTS.md` is read
every session by all four tools (natively by Codex/Copilot, via `@AGENTS.md` import-expansion by
Claude and Gemini). Since `@AGENTS.md` **expands at launch** (imports do not save context), Claude's
effective startup payload is `AGENTS.md` + the `CLAUDE.md` notes — which had reached ~229 lines, over
Claude's own published ~200-line soft threshold. We therefore adopt a **soft line allowance**, recorded
here so future edits are held to it: **`AGENTS.md` ≤ ~170 lines, `CLAUDE.md` ≤ ~25 lines, and the
binding invariant — Claude's combined imported payload ≤ ~200 lines.** No enforcement tooling ships
with this decision (deliberately out of scope, issue #80); the budget is a human guardrail.

This was decided by the issue's required **four-tool review** (Claude, Codex, Copilot, Gemini), whose
reconciled recommendation is on issue #80. Vendor anchors: Claude ~200 lines (the binding one), Codex
32 KiB (`project_doc_max_bytes`), Copilot ~1,000 lines; Gemini publishes no count (its concern is
attention dilution, not a byte budget).

Sources (as of 2026-07-09):

- Claude — <https://code.claude.com/docs/en/memory> (loaded in full; >200 lines consumes more context; imports don't reduce it)
- Codex — <https://developers.openai.com/codex/guides/agents-md> (`project_doc_max_bytes`, 32 KiB default)
- Copilot — <https://docs.github.com/en/copilot/tutorials/customize-code-review> (~1,000-line practical max) and <https://github.blog/ai-and-ml/github-copilot/unlocking-the-full-power-of-copilot-code-review-master-your-instructions-files/> (does not follow external links)
- Gemini — <https://geminicli.com/docs/cli/gemini-md/> (hierarchical context files, `@file.md` imports)

## Considered Options

- **Self-set number with no external anchor** — rejected: the four-tool review surfaced real vendor
  anchors, so the budget need not be arbitrary.
- **Per-file budgets only** — insufficient: Claude's constraint is the *combined* imported payload, not
  either file alone, so the combined-≤200 invariant is the load-bearing target.
- **Enforce via a parity/lint check** — deferred: a line-budget check is a possible follow-up, not part
  of issue #80.

## Consequences

- **Relocation guardrail:** trim by relocating **reference** content (skill descriptions → each
  `SKILL.md`; CLI-transition history → `docs/research/tool-config-discovery.md`), but keep
  **instructions** resident (the umbrella closing-keyword rule, the non-slash invocation distinction,
  the quality gate) — **Copilot does not follow external links**, so load-bearing instruction moved
  behind a pointer would be lost to it.
- **Allowance vs. actual:** ~170 is a soft ceiling with headroom for host customization and future
  skills; the initial trim (Skills + Rules sections → tables) lands `AGENTS.md` well under it.
