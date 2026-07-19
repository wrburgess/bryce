# Name the harness, not its model: a harness↔model naming and attribution convention

**Status:** accepted

## Context

Upstream ai-config's ADR 0023 (its Tool Roster decision; not vendored into this host) names the two
axes this repo turns
on — **harnesses** (the tools that carry config and run the agent loop) and **models** (the LLMs that
are declared). But the prose and the attribution table predate that clarity and conflate the two in
one specific, repeated way: they name the **fourth configured harness "Gemini,"** which is a *model*
name. The harness is Google's **Antigravity** (Gemini CLI → Antigravity CLI, announced 2026-05-19;
documented in [`docs/research/tool-config-discovery.md`](../research/tool-config-discovery.md)).

The tell is everywhere the tools are enumerated — `(Claude, Codex, Copilot, Gemini)` — three harness
names plus one model. And [`PROJECT.md`](../../PROJECT.md) → *Attribution & Model Declaration* lists
the agent row as `Gemini` and even declares its model as `Gemini (host sets model)` (and Codex's as
`Codex (host sets model)`) — a *harness* name filling a *model* column. "Gemini" is thus ambiguous
(harness? model?) — the exact ambiguity ADR 0023 says the repo is built to avoid. That warrants a
one-time cleanup plus a rule to stop it regressing.

## Decision

1. **Name the harness by its harness name — never the model it runs.** The four configured harnesses
   are **Claude Code · Codex · Copilot · Antigravity**. The fourth is **Antigravity**; the *model* it
   runs is **Gemini / Gemini Flash**.
2. **The attribution "Declared model" column names a model, not a harness.** Claude Code → Opus /
   Fable; Codex → GPT; Copilot → varies; Antigravity → Gemini Flash. This makes the table consistent
   with the attribution footer, which already splits `<Tool>` from `<Model>`
   ([ADR 0007](0007-attribution-includes-model-version-for-audits.md)).
3. **Formalize `Harness` and `Model` as [`CONTEXT.md`](../../CONTEXT.md) vocabulary**, so "refer to
   each by its specific name" has a canonical home.
4. **The one-time fix touches living docs only.** Immutable ADRs are *not* rewritten — e.g.
   [ADR 0022](0022-instruction-file-line-allowance.md)'s "four-tool review (Claude, Codex, Copilot,
   Gemini)" records what a tool was called at decision time and stays. The **`GEMINI.md` adapter
   filename is unchanged** — it is the file Antigravity actually reads.

## Considered options

- **A — Keep "Gemini" as shorthand for the fourth tool.** Rejected: it is the one enumerated name
  that is a *model*, reintroducing the harness/model ambiguity ADR 0023 exists to remove — and it is
  already stale, since the harness is Antigravity.
- **B — Expand every tool to its full harness name everywhere** ("Claude Code", never "Claude").
  Rejected as over-churn: "Claude", "Codex", and "Copilot" are harness names (or their shorthands),
  not model names — only "Gemini" is a model. Fix the name that is actually wrong.
- **C — Surgical fix (chosen).** `Gemini → Antigravity` in living prose and the attribution table,
  name model families in the model column, record `Harness`/`Model` vocabulary, and leave immutable
  ADRs and the `GEMINI.md` filename alone.

## Consequences

- `CONTEXT.md` gains **Harness** and **Model** terms; the attribution table names harnesses and their
  model families distinctly, so provenance is unambiguous (the audit goal of ADR 0007).
- **Grok Build** (xAI's `AGENTS.md`-native harness; model `grok-build-0.1`) is a plausible *fifth*
  harness but is **out of scope here.** Adding it belongs to the Tool Roster inclusion test (ADR 0023)
  and the research doc's dated-citation discipline, not a prose-naming PR — tracked separately.
- The **parity check is unaffected** — it polices adapter resolution and `PROJECT.md` section headings,
  not prose tool names. It cannot catch a model-name-as-harness slip, so reviewers must eyeball for it
  (the same neutrality blind spot noted in `docs/rules/`).
