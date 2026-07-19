# Skills — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/skills.md`](../../rules/skills.md). Heavy,
subsystem-specific case studies for authoring Skill bodies + Invocation Shims — **not** auto-loaded;
read on demand when the trigger in [`docs/rules/README.md`](README.md) fires (working in `skills/` or
`.claude/commands/`). Each entry ends with a `(Reference: #NNNN)` pointer to the issue/PR that
produced it.

## A scoped invocation must not advance a shared progress marker (Reference: #46)

**The case.** `scout` runs an intake **sweep** and records a **last-swept marker** — a high-water
mark that defines the next run's incremental window. Issue #46 added the `clip` front door, which
invokes `scout` in a new **inbox-only / specific-drop scope**: it processes only the handed-over drop
and skips the Watchlist feed/handle sweep entirely.

**What nearly shipped.** The scope change correctly guarded the *procedure* steps (skip the feed poll,
don't advance the marker, surface no feed-staleness) — but `scout`'s `<quality-gate>` still carried
the pre-existing invariant *"for a non-empty sweep, the last-swept marker was advanced, the staleness
notes are in the PR body."* An inbox-only run whose drop earns a stance **is** a non-empty sweep (it
opens a PR), so an agent reconciling against that checklist would advance the marker to today —
recording a feed window it never swept. The next full sweep would then treat everything up to that
date as already covered and **skip it silently**. An adversarial review pass caught the contradiction
before merge; the fix (PR #49) carved the marker/staleness invariants by mode in both the steps *and*
the gate.

**The rule it yields.** When a sweep/scan-style skill gains a **scoped or partial** invocation mode,
every piece of **shared progress state** it can advance — a recency/last-swept marker, a cursor, a
high-water mark, a dedupe cache — must be gated on the **full-scope** path. A partial run records only
the progress it actually made, never progress it skipped. And the audit is not just the numbered
steps: **the quality-gate / self-review checklist carries the same invariant**, and it is exactly
where a stale "always advance" assertion hides — it reads as a completion requirement an agent will
satisfy literally.

**Symptom to watch for.** A later full run that "finds nothing new" in a window you know had output —
the marker was advanced by a run that never covered that window.

_(Reference: #46; fix in PR #49.)_
