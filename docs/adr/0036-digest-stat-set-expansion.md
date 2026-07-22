# Digest stat-set expansion (July 2026): derived rates and per-game decisions stay in-model; wRC+ and WAR are deferred as out-of-model

The July 2026 change requests (issue #54, plus two follow-ons raised during distillation — relief W/L, and dropping the player name from the header) extend the ADR 0033 fixed stat set. Everything the Digest renders must stay derivable from **summed counters** plus **per-game decisions counted at assembly** — the invariant ADR 0035 set for windowed roll-ups. The additions were sorted by that line.

**In-model, added now:**

- **BB% and K%** (batters) — new derived rates in `src/stats/aggregate.ts`: `baseOnBalls / plateAppearances` and `strikeOuts / plateAppearances`, recomputed from summed counters like every other rate. Shown only on windows **≥ 21 days** (`21d`/`28d`/`35d`/`60d`/`ytd`): a rate over `1d`/`7d`/`14d` swings on a handful of plate appearances. This is the first stat set that varies by window *span*, not only `1d`-vs-aggregate.
- **BS** (blown saves, pitchers) — a plain counter; `blownSaves` was already classified in `src/stats/fields.ts`, so it aggregates with no new machinery.
- **RW / RL** (relief win, relief loss, pitchers) — a **relief-only decision counted per game**, on the `countQualityStarts` pattern in `src/digest/assemble.ts`: a game contributes to `RW` when `wins == 1 && gamesStarted == 0`, to `RL` when `losses == 1 && gamesStarted == 0`. Starter decisions are never surfaced (an explicit HC choice). This cannot be recovered from summed `wins`/`losses`/`gamesStarted` — a starter win and a relief loss both sum to 1 and can't be un-mixed — so, like `QS`, it is counted while the per-game rows are still in hand.

**Out-of-model, deferred to a separate issue:**

- **wRC+ and WAR** — requested alongside BB%/K% but structurally different. Both need annual league constants (wOBA weights, league wOBA, league R/PA), park factors, and (for WAR) positional/replacement/defensive context. None of that lives in a gamelog split, and none is derivable from summed counters at any window length — a "21-day WAR" is not a standard statistic. They require a new external data source (FanGraphs / Baseball Savant for MLB, with no clean answer for MiLB or NCAA rows), which is its own integration and its own ADR, not a display change.

## Considered options for wRC+/WAR

- **Approximate from a static MLB constants table, blank elsewhere** — rejected: a watch list mixes MLB, MiLB, and NCAA rows, and a column populated for some levels and `-` for others invites exactly the blended-comparison misread the per-level grouping exists to prevent.
- **Integrate an advanced-metrics source now** — deferred, not rejected: real integration work (new adapter, new failure modes, per-level constants) that dwarfs the rest of issue #54.
- **Drop the request** — rejected: the HC wants them eventually; the follow-up issue keeps them tracked.

## Consequences

- The line for "what the Digest can show" is now explicit: **summed counters, rates recomputed from those sums, and per-game decisions counted at assembly.** A metric needing external reference data or full-season context is out of model until a data-source ADR brings that data in — and adding one must not tempt a contributor to store a pre-computed per-game rate and sum it (ADR 0035's standing warning).
- BB%/K% render on long windows only, so they never appear in the daily `1d` email — every window ≥ 21 days is on-demand (CLI/REST/MCP), which is where the HC asked for them.
