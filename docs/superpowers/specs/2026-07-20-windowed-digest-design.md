# Windowed Digest — Design

**Date:** 2026-07-20
**Status:** Approved (brainstorming complete; implementation plan not yet written)

## Problem

The Digest today reports **every Stat Line not yet reported by a previous Digest** — novelty-driven
selection with no date windows, rendered as one line per player per game (ADR 0030). Two things are
missing:

1. **Aggregation.** There is no way to ask "how has this player hit over the last 7 days?" Every
   number rendered is a single-game number.
2. **On-demand windows.** The Digest is a daily artifact. There is no way to request a 7-day or
   season-to-date view, or to re-render a past window.

The underlying data is already sufficient. `stat_lines` is a true per-player-per-game gamelog keyed
on `(player_id, game_id, stat_type)` — per-game, never per-date, so doubleheaders are distinct rows
(ADR 0029). It stores the split's `stats` object and the entire gameLog split as `raw`, explicitly
"for future re-processing". `src/jobs/refresh.ts` re-pulls the **whole current season** on every run
("No date windows, ever") and upserts idempotently, so the season is already backfilled from opening
day. As of this writing the live database holds 1047 lines spanning 2026-03-25 → 2026-07-19.

Windowed aggregation is therefore a **read-side** problem. No new collection is required.

## Decisions

| # | Decision |
|---|---|
| 1 | A window renders as a **roll-up** — aggregate numbers per player, not a list of games. |
| 2 | A window is a **calendar-day range**, and every row shows `GP` so sample size is visible. |
| 3 | A report covers **one window**. Multiple windows means multiple reports. |
| 4 | Layout is **two tables** — Batters and Pitchers — each with a TOTALS row. Abbreviated names, no links. |
| 5 | **One artifact.** The daily Digest *becomes* the 1-day windowed report. Selection changes from novelty to window; format changes from per-game lines to tables. |
| 6 | `stat_lines.digest_delivery_id` is **dropped**. |
| 7 | **Regular season only** in every window. |
| 8 | Fielding stays **merged into the batter row** (errors as a column), per ADR 0033. |
| 9 | Doubleheaders render as **two rows** — the row grain is a parameter, not a constant. |

The name stays **Digest**. There is one artifact; renaming every module to "Report" would be churn
without gain. `CONTEXT.md` and a new ADR record the redefinition.

## Aggregation model

Every field in a stat object belongs to exactly one of four classes. This classification *is* the
feature; getting it wrong produces plausible-looking nonsense.

### 1. Summable counters

Sum across the grouped games. Batting: 26 fields. Pitching: 43. Fielding: 10.

Examples: `hits`, `atBats`, `homeRuns`, `rbi`, `strikeOuts`, `totalBases`, `plateAppearances`,
`stolenBases`, `earnedRuns`, `battersFaced`, `wins`, `saves`, `putOuts`, `assists`, `errors`.

### 2. Derived rates

**Recomputed from the summed counters. Never averaged.**

- Batting (9): `avg`, `obp`, `slg`, `ops`, `babip`, `atBatsPerHomeRun`, `stolenBasePercentage`,
  `caughtStealingPercentage`, `groundOutsToAirouts`
- Pitching (18): `era`, `whip`, `avg`, `obp`, `slg`, `ops`, `hitsPer9Inn`, `homeRunsPer9`,
  `runsScoredPer9`, `strikeoutsPer9Inn`, `walksPer9Inn`, `strikePercentage`, `strikeoutWalkRatio`,
  `pitchesPerInning`, `winPercentage`, `caughtStealingPercentage`, `stolenBasePercentage`,
  `groundOutsToAirouts`
- Fielding (3): `fielding`, `rangeFactorPer9Inn`, `rangeFactorPerGame`

A player who goes 3-for-4 and then 0-for-4 has aggregated `avg` of `.375` — `sum(hits) / sum(atBats)`.
Averaging the two game-level values (`.750` and `.000`) gives the same `.375` only by coincidence of
equal denominators. With a 3-for-4 and an 0-for-1 the two methods diverge: `.600` correct versus
`.375` averaged.

The averaging error is insidious because it stays in a plausible range — it does not produce an
obviously broken number, it produces a *wrong* one. It systematically over-weights low-denominator
games: a 1-for-1 pinch-hit appearance moves an averaged season line exactly as much as an 0-for-5
start. Summing rate fields instead of averaging them is the louder failure (season `avg` in the tens),
and unclassified fields default to exclusion precisely so neither can happen by accident.

### 3. Baseball-notation innings

`inningsPitched` (pitching) and `innings` (fielding) use baseball notation: `"6.1"` is six innings
plus one out, not six-and-a-tenth. They are not arithmetically summable — `6.1 + 6.1 = 12.2` in
baseball, which arithmetic gets wrong.

Every operation converts to outs, sums, and converts back. `src/digest/rates.ts` already provides
`ipToOuts` and `formatIp`; the aggregate path reuses them rather than reimplementing.

### 4. Non-aggregatable

Excluded from roll-ups entirely: `summary` (per-game prose, e.g. `"2-4 | BB, RBI, 2 R"`) and
fielding's `position`.

### Unknown fields fail closed

An unclassified field is **excluded** from the aggregate and warned to stderr — never summed. This
follows the existing precedent in `src/mlb/gameTypes.ts`: *"Allowlist, not blocklist: an unknown
future gameType stays out until reviewed (fail closed)."*

Summing anything numeric is the worst available default, because every rate field is numeric and
would silently produce garbage.

### Observed field inventory

Counts from the live database as of 2026-07-20, and the basis for the classification tables:

| stat_type | distinct fields | counters | rates | innings | excluded |
|---|---|---|---|---|---|
| batting | 36 | 26 | 9 | 0 | 1 |
| pitching | 63 | 43 | 18 | 1 | 1 |
| fielding | 15 | 10 | 3 | 1 | 1 |

## Row grain

The row grain is a parameter:

```
groupBy: "game"    → one row per (player, game_id)
groupBy: "player"  → one row per player across the window
```

`aggregate()` accepts a set of stat lines either way — a single game is the one-element case — so
there is no second renderer and no doubleheader special case. ADR 0029's per-game identity already
guarantees the two games of a doubleheader are distinct rows; `game_number` is stored and renders as
`Gm 1` / `Gm 2`.

Defaults: `1d` → `groupBy: "game"`; `7d`, `14d`, `ytd` → `groupBy: "player"`. The parameter is
internal; it is not exposed on the CLI in this iteration.

Because `1d` rows are per-game, they carry opponent (`vs CHW`, `@ STL`). Aggregated windows do not.

## Window semantics

`resolveWindow(spec, now, tz) -> { from, to, label }` — pure, host-timezone aware.

### Anchor

**Every window ends on the last completed host-timezone date — yesterday, not today.**

This matters because the window is now the content. A digest run at 08:00 covering "today" would be
empty every morning, since the day's games have not been played. Anchoring to yesterday makes the
output independent of run hour: a 06:00 run and a 23:00 run on the same date produce the same report.
It also matches the reference artifact this design was drawn from, which is titled "Yesterday's
Stats".

A game played today therefore first appears in tomorrow's digest. That is correct for a daily
artifact and is not a delay — the game is not over when the digest is composed.

Note this is distinct from `digest_deliveries.date_covered`, which remains the host date of the
**run**. The delivery slot is keyed by run date; the content covers the window ending the day before.

| spec | meaning (where `end` = `today - 1`) |
|---|---|
| `1d` | the single host-timezone date `end` |
| `7d` | `end - 6` through `end`, inclusive (7 calendar days) |
| `14d` | `end - 13` through `end`, inclusive |
| `ytd` | the current season's `regularSeasonStart` through `end` |

Every window filters `game_type` to regular season only. Ingestion currently allows postseason types
as well (`src/mlb/gameTypes.ts`), so without this filter an October YTD line would silently blend
playoff and regular-season stats.

`ytd` reads `regularSeasonStart` from `season_calendar`. When no calendar row exists for the season,
`ytd` falls back to January 1 of the season year and warns — consistent with the existing fail-open
posture in `src/domain/season.ts` ("with no calendar data ... the pipeline is treated as awake").

## Architecture

### New modules

| Module | Responsibility |
|---|---|
| `src/stats/fields.ts` | Classification tables — counter / rate / innings / excluded, per stat type. Data, no logic. |
| `src/stats/aggregate.ts` | Pure. `aggregate(StatLineRow[]) -> Aggregate`. Sums counters, sums innings via outs, derives rates from the sums. |
| `src/domain/window.ts` | Pure. `resolveWindow(spec, now, tz)`. |

### Changed modules

| Module | Change |
|---|---|
| `src/digest/assemble.ts` | Select by window instead of novelty; group per `groupBy`; drop `includeDeliveryId` and `previewDeliveryId`. |
| `src/digest/render.ts` | Batters and Pitchers tables with TOTALS rows, in text and HTML. |
| `src/jobs/digest.ts` | Same claim → send → settle flow; remove replay plumbing and line stamping. |
| `src/cli/digest.ts` | Add `--window` (default `1d`). |
| `src/api/routes.ts` | `window` parameter on the existing preview and send routes. |
| `src/mcp/server.ts` | `window` parameter on the digest preview tool. |
| `src/db/schema.ts` | Drop `stat_lines.digest_delivery_id` (with a drizzle migration). |

### What survives unchanged

`digest_deliveries` and the whole delivery-claim design (ADR 0034) stay: mutual exclusion, the lease,
recovery of a crashed claim, provider reconciliation, and the offseason heartbeat. Two runs must
still not both email you, and `settleFailed` must still never wipe `sent_at` off a delivered row.

### What the change removes

Under window selection a report consumes nothing, so `--force` cannot corrupt line state — there is
no line state. That retires:

- `assembleDigest`'s `includeDeliveryId` novelty-widening
- `previewDeliveryId` and its "both surfaces must not drift" contract
- `replayOfDeliveryId` and the deliberately-renamed-field barrier in `src/jobs/delivery-claim.ts`

Forced sends still bypass settlement, so the `replay` concept survives in reduced form: a forced run
sends without touching delivery state. It simply no longer needs to carry a delivery id.

## Rendering

```
Bryce — Last 7 Days (Jul 13–19)

Batters
Player        GP   Batting          HR   RBI    K
B Harper       6   .310/.380/.520    3     8    7
C Yelich       5   .250/.333/.400    0     2    4
TOTALS        11   .282/.354/.497    3    10   11

Pitchers
Player        GP     IP   W-L    ERA   WHIP    K
Z Wheeler      2   13.0   1-0   2.31   0.98   14
TOTALS         2   13.0   1-0   2.31   0.98   14
```

The rendered column set is a **selection** over the complete aggregate. The aggregator computes every
classified field for every window; the email renders the columns above; the REST and MCP surfaces
return the full object. Adding a column later is a render change, not a data change.

`aggregate()` produces both the per-player rows and the TOTALS row — same function, different
grouping — so a totals row cannot drift from the rows above it.

Players with no games in the window appear with zeros (`0`, `.000/.000/.000`, `0`, `0`, `0`). This
replaces the current "no new stats" tail, which becomes unnecessary: a `GP 0` row says it better.

Both a plain-text and an HTML rendering are produced from one assembled structure, so the two cannot
diverge in content.

## Error handling

| Case | Behavior |
|---|---|
| Unclassified stat field | Excluded from the aggregate, warned to stderr. Never summed, never throws. |
| Unparseable `inningsPitched` | Treated as zero outs, per the existing `formatIp` precedent. |
| Zero games in window | Full table of zeros, still sent — preserves "send daily even when empty" (ADR 0030). |
| Invalid `--window` value | Fail closed: non-zero exit, no send. |
| No `season_calendar` row for `ytd` | Fall back to January 1 of the season year, warn. |

## Testing strategy

Testing-first, per `rules/testing.md`.

- **Field classification is exhaustive.** A test over real `raw` payloads asserting every observed key
  is classified. This is the test that catches an MLB schema change instead of silently dropping a
  stat.
- **Rates are derived, not averaged.** The load-bearing test. Fixtures must be chosen so the two
  methods give *different* answers — equal denominators hide the bug.
- **Innings are outs-based.** `6.1 + 6.1 = 12.2`, not `12.2` arithmetic.
- **Window resolution.** DST transitions, month and year boundaries, and a regression pinning that an
  evening run in `America/Chicago` does not shift the window by a day.
- **The anchor is run-hour independent.** A 06:00 and a 23:00 run on the same host date resolve to
  identical windows. This is the test that would have caught the `TZ` bug as a content defect.
- **Doubleheader renders two rows** for a 1-day window.
- **Zero-GP player renders a zero row.**
- **TOTALS are re-derived** from summed counters, not averaged across rendered rows.
- **Regular-season filter** excludes an ingested postseason game from every window.

One validation to run once, outside the suite: aggregate a player's full YTD from `stat_lines` and
compare against MLB's own season totals from the API. That is a real correctness oracle for the rate
math. It belongs in a probe script alongside `src/cli/ncaa-probe.ts`, not in a networked unit test.

## Ordering

**The `TZ` configuration bug lands first, as its own change.**

`src/env.ts` loads `.env` via `process.loadEnvFile`, which by design never overrides a real
environment variable. A shell exporting `TZ=UTC` therefore silently defeats `.env`'s
`TZ=America/Chicago`, and `hostDate` returns the UTC date. This was observed in production on
2026-07-20: an evening run wrote a delivery row for `date_covered = 2026-07-21` while the host date
was still `2026-07-20`.

Under novelty selection a wrong host date only mislabels the delivery slot. Under window selection
**the host date is the content** — `game_date >= today - 6` is the entire query — so every window
would silently shift by a day for any evening run. Shipping windows on top of this bug bakes it into
the output.

The fix is to stop using `TZ` as the configuration key. It is a reserved POSIX variable that ambient
tooling sets; the collision, not the precedence rule, is the defect. Rename to `BRYCE_TZ` in
`src/config.ts` and `.env.example`. "Real environment variables win" remains correct for secrets and
should not change.

Separately, the stray `digest_deliveries` row for `2026-07-21` must be deleted, or the July 21 digest
will be refused as `already-sent-today`.

Implementation order:

1. Fix the timezone configuration key; delete the stray delivery row.
2. `src/stats/fields.ts` and `src/stats/aggregate.ts` with their tests — pure, no consumers yet.
3. `src/domain/window.ts` with its tests.
4. Rework `assemble.ts` to window selection; drop `digest_delivery_id` with a migration.
5. Rework `render.ts` to the table format (text and HTML).
6. Wire `--window` through the CLI, REST, and MCP surfaces.

Steps 2 and 3 are independent of each other and of step 1.

## Out of scope

- Exposing `groupBy` on the CLI (the parameter exists internally).
- Postseason windows or a regular-season/postseason split.
- A multi-window comparison view (7d/14d/YTD side by side). Decision 3 makes this a separate
  "player detail" artifact if it is ever wanted.
- NCAA aggregation. NCAA players use a different scrape path (`src/ncaa/`) with a different stat
  shape; no NCAA player is currently watched. The field-classification design extends to it, but this
  iteration covers MLB and MiLB.
- Arbitrary date ranges (`--from` / `--to`). The four named windows cover the stated need.

## Superseded

A new ADR supersedes **ADR 0030**'s novelty-driven selection model and records window-driven selection
in its place. ADR 0029 (per-game identity), ADR 0031 (offseason sleep), ADR 0033 (fielding merged into
the batting line), and ADR 0034 (delivery claim) are unaffected.
