# Testing Rules

**Applies to:** The test suite
**Deep doc:** `docs/rules/testing-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Test behavior and side effects**, not that the code merely runs: assert content, database state, redirects, and enqueued work.
- **Cover the sad paths**: invalid input, `nil`, duplicates, and boundary values — that is where regressions hide.
- **Build the test infrastructure the scenario needs** (helpers, shared setup, data builders, HTTP record/replay) rather than declaring a thing untestable. That is part of the work, not a reason to skip it.
- **Self-review before "done":** for each test ask, "if this passed but the feature were broken, would I know?"
- **Evaluate LLM-driven behavior with task-specific evals**, not only example-based asserts: when a feature's output is *graded* rather than exact (a rubric, an LLM-as-judge, a golden-set score), treat the eval as a first-class test that runs in CI alongside the suite, with an explicit pass threshold. *(Extend per host.)*

## Anti-Patterns

- **Never build tests on schema-coupled static test data** — because it drifts from the schema and obscures intent; construct each case's data with programmatic builders instead. *(Extend per host.)*
- **Never assert only a status code / `success`** — because a broken feature can still return 200; assert the content, side effects, and redirect. *(Extend per host.)*
- **Never insert wall-clock waits in a test** (a real-time sleep) — because it is flaky and slow; control the clock — freeze or advance time — instead. *(Extend per host.)*
- **Never claim something "can't be tested" without first attempting it** with the host's stack — because most "untestable" cases have a documented tool (headless browser, HTTP record/replay). *(Extend per host.)*
- **Never ship LLM-driven behavior guarded only by deterministic asserts** — because a model or prompt change can regress output quality while every equality check still passes; add a task-specific eval with a graded threshold. *(Extend per host.)*
