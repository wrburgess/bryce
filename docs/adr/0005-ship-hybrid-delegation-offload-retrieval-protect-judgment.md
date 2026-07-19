# `ship` delegates by output-weight, not per-phase: offload retrieval, protect judgment

> Note (#73): skill names below predate the six-skill rename (grill-with-docs→distill, cplan→devise, impl→invoke, rtr→listen, drop→clip, voice→follow). This ADR records the decision as of its date; the names here are historical.

**Status:** accepted

`ship` is a phase-sequencing orchestrator whose goal is a lean main-thread context (no "dumb zone" degradation, no mid-run `/compact`). We reach that by delegating **output-heavy, signal-light** work to discardable sub-agents while **keeping judgment-heavy work in a clean orchestrator context** — *not* by delegating every phase uniformly.

This is a deliberate refinement of the original "hand off each phase to a sub-agent" request. Uniform per-phase delegation is more elegant as process but hurts *outcomes*: it forces the two decisions that matter most — *is this plan good?* and *is this safe to merge?* — to be made off a lossy summary of a sub-agent's reasoning the orchestrator never saw. The cure for the dumb zone is to keep the *thinking* in a clean window and offload the *reading*.

## The rule

- **Delegate (output-heavy):** codebase exploration, the `impl` code+test/lint/fix loop, the `verify` full-diff review, the `rtr` fetch-and-fix churn. Sub-agent output dwarfs the signal the orchestrator needs; each returns a compact handoff contract and its context is discarded.
- **Keep in the orchestrator (judgment-heavy):** assessment synthesis, plan authoring + reconciliation, `rtr` severity / stop-and-ask calls, and the `final` merge-readiness call.
- **Gates are session boundaries:** assess+plan in one clean session; **build (`impl`→`final`) in a fresh session** so the orchestrator stays lean through the delegated heavy ops. A pre-`final` context check offers another reset.
- **State is externalized:** durable artifacts live in the issue / PR / git; a fresh phase re-reads them rather than the orchestrator carrying them.
- **Faithfulness backstop:** the plan gate and the PR each get an independent second-model review (the primary reviewer tool); degrade to "stop and ask" if no second model is reachable.

## Alignment

Consistent with Anthropic's sub-agent / context-engineering guidance ("offload retrieval, protect judgment") and Matthew Pocock's dumb-zone framing. Preserves the two human gates (plan approval, merge) and all quality gates at full strength (per ADR 0003 — degrade the mechanism, never the bar).

## Consequences

- On tools without sub-agent fan-out, `ship` degrades to inline phases with "compact between phases" (ADR 0003).
- Each delegated phase needs a defined, minimal handoff contract; each kept phase needs enough clean context to exercise real judgment — which is why the plan gate doubles as a session boundary.
