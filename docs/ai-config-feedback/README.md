# ai-config Feedback Ledger

Bryce is the **first Host App to vendor the [ai-config](https://github.com/wrburgess/ai-config)
Generic Baseline**, which makes it the baseline's first field test. This directory is the ledger
where friction, gaps, and wins observed while working under the vendored bundle are recorded — so
generalizable learnings flow **upstream** to ai-config instead of evaporating between sessions.

## Protocol

1. **Record at the moment of friction.** Any agent session that fights the vendored config — a file
   that had to be forked, a check that failed out of the box, a procedure with no path for this
   host's situation — adds an entry to a dated file here (`YYYY-MM-DD-<slug>.md`). The self-review
   checklist ([`rules/self-review.md`](../../rules/self-review.md)) carries the reminder.
2. **Disposition every entry** with exactly one of:
   - **`upstream`** — any future Host App, regardless of stack or domain, would benefit. Must be
     business-neutral and stack-neutral (the baseline's own bar). These get filed as GitHub issues
     on `wrburgess/ai-config`, where they enter its normal lifecycle (assess → devise → …) under
     ai-config's own gates.
   - **`overlay`** — stack-specific, belongs in a Stack Overlay (upstream ADR 0017), e.g. a future
     `ai-config-typescript` seeded like `docs/overlays/ai-config-rails.md`.
   - **`host-only`** — Bryce context (its gate-policy *values*, hosting, stack picks). Recorded so
     the boundary is explicit, and deliberately **not** pushed upstream.
3. **Track status per entry:** `recorded` → `filed (ai-config#N)` → `adopted upstream` /
   `rejected upstream`. When an adopted change ships, a re-run of `ai-config-sync` pulls it back
   down and the entry is closed.

## The filter, stated once

The upstream test is: *"would a project with a completely different stack and domain hit the same
thing?"* If yes → `upstream`. If only same-stack projects would → `overlay`. If only Bryce → `host-only`.
When in doubt, record it `host-only` and let a second occurrence in a future project promote it —
one data point is an anecdote, the baseline should move on patterns.

## Why plain issues, not ai-config's intake pipeline

ai-config's own intake pipeline (`scout`/`clip`, the Learnings Log) tracks *external field voices*.
Host-App feedback is first-party engineering input with a concrete change attached, so it enters as
ordinary tracked issues instead — the lifecycle, not the research roster.
