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
- **Enforce the offline-test invariant fail-closed, not by convention.** The default suite blocks all **in-process** non-loopback `fetch` + TCP/TLS **socket** egress via a guard (`test/support/network-guard.ts`, wired in `vitest.config.ts` `setupFiles`); loopback stays open for in-process servers/MCP transports. Every blocked attempt is both thrown AND recorded as a redacted `{ surface, host, port }` record, and a teardown assertion fails the owning test even when a provider's fail-open catch block swallowed the throw. A real external call belongs in the explicit `*.live.test.ts` tier (`npm run test:live`), never in the default suite. *(Provenance: issue #25; child processes / UDP are out of scope. Extend per host.)*

## Anti-Patterns

- **Never build tests on schema-coupled static test data** — because it drifts from the schema and obscures intent; construct each case's data with programmatic builders instead. *(Extend per host.)*
- **Never assert only a status code / `success`** — because a broken feature can still return 200; assert the content, side effects, and redirect. *(Extend per host.)*
- **Never insert wall-clock waits in a test** (a real-time sleep) — because it is flaky and slow; control the clock — freeze or advance time — instead. *(Extend per host.)*
- **Never claim something "can't be tested" without first attempting it** with the host's stack — because most "untestable" cases have a documented tool (headless browser, HTTP record/replay). *(Extend per host.)*
- **Never ship LLM-driven behavior guarded only by deterministic asserts** — because a model or prompt change can regress output quality while every equality check still passes; add a task-specific eval with a graded threshold. *(Extend per host.)*
- **Never prove a cross-process concurrency invariant with a second in-process connection alone** — because a same-process handle shares the runtime's locks, caches, and file descriptors and can pass while the real race still exists; spawn a genuine separate process to hold the contended resource and assert the other party is actually refused. *(Provenance: issue #67 / PR #80; extend per host.)*
- **Never construct a default/real provider client in a default-suite test, or reach a live service** — because a forgotten fake egresses (flakiness, rate limits, real email, unintended production contact), and a fail-open catch block can hide it behind a green pass; inject a fake transport, or use the `*.live.test.ts` tier via `npm run test:live`. The guard makes this fail closed, but constructing the real client is the anti-pattern the guard exists to catch. *(Provenance: issue #25; extend per host.)*
