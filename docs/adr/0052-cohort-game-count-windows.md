# Cohort reports over per-player game-count windows

The windowed report engine gains a **game-count window** — `last10games` / `last30games` — beside its
date windows, so a cohort report can be asked for as "all tracked players (or a tag/list cohort), each
over his own last N regular-season games, aggregated" (#153). This is the one row of #29's report table
that #150 did not deliver, filed standalone because #150 closed the umbrella.

A game-count window is a **different query shape** from every date window. A date window applies one
range to every player; a game-count window is a **per-player ordered limit**, so two players in one
report cover different date spans. #31 named conflating the two as the most likely silent defect in the
feature — "anyone who implements `last10games` as 'roughly the last two weeks' has introduced the defect
this phase exists to prevent." This ADR records how the two are kept apart while sharing everything they
legitimately can.

## Considered Options

- **A separate window vocabulary + a dedicated assembly engine, reusing the shared row math (chosen).**
  `GAME_COUNT_WINDOW_SPECS` is a tuple disjoint from `WINDOW_SPECS`, so the date engine (`resolveWindow`,
  `SPAN_DAYS`) can never receive a game-count token. A new `assembleGameWindow` selects each player's last
  N distinct games and rolls them up through the **same** `buildStatRowCore` / fielding-fold / PA / rate
  math the digest uses (extracted to `src/digest/rows.ts`), producing the same `DigestAssembly` the
  existing renderer and all three surfaces already consume.
- **Extend `WINDOW_SPECS` and thread a game-count branch through `assembleDigest`.** Rejected: every line
  of `assembleDigest` assumes one shared `window.from`/`.to`, and `resolveWindow`/`SPAN_DAYS`/`labelFor`
  index the spec as a date — so a game-count token flowing through them is exactly the #31 conflation,
  with the largest blast radius on the shipped daily digest.
- **Batch the single-player card across the cohort.** Loop `assemblePlayerCard` per player. Rejected: an
  N+1 by construction (`rules/backend.md`), and it normalizes the anti-pattern the repo guards against.

## Consequences

The decisions this ADR fixes:

1. **The window vocabularies are disjoint by type.** `ReportWindowSpec = WindowSpec | GameCountWindowSpec`,
   and `isGameCountSpec` is the only bridge. Widening `ResolvedWindow.spec` to the union means every
   consumer got an explicit game-count branch (`isLongWindow`, `digestWindowTitle`) rather than a silent
   fallthrough; `SPAN_DAYS` and `resolveWindow` stay date-only and are never reached with a game-count
   token.

2. **One statement selects the whole cohort — no N+1, no `IN (...)`.** A ranked CTE
   (`rankedGameLinesQuery`) numbers each player's **distinct** games most-recent-first with
   `ROW_NUMBER() OVER (PARTITION BY player_id …)` and keeps `rn <= N`, then joins back to `stat_lines` to
   load every stat-type row for the selected games. The cohort scope is the **same** `tagScopeCondition` /
   list-`EXISTS` the digest uses (correlated on `players.id`), so the two reports never drift on what a
   selector means, and neither binds a materialized id list (SQLite's ~999-parameter cap, provenance
   #70 / PR #86).

3. **Distinct games, not rows — and a deterministic boundary.** The CTE groups by
   `(player_id, source, game_id, game_date, game_number)` **before** ranking, so a doubleheader counts as
   two games and a batting+fielding+pitching game counts as one (ADR 0029 per-game identity). The rank
   orders by `game_date DESC, game_number DESC, MAX(id) DESC` — reproducing the single-player card's
   `id DESC` tiebreaker, because `(game_date, game_number)` is **not** unique per player, so dropping it
   would make the N boundary nondeterministic. Pinned by a tie-boundary test.

4. **Provenance is per row, not per report.** There is no single date span a game-count report shares, so
   each row carries its own `spanFrom`/`spanTo` (the real first/last date its games cover) and its `GP`
   column is the aggregate's own game count — so a "past 10" row for a player with 4 games shows **4**,
   never implying 10. `window.from`/`.to` hold the cohort **envelope** (min/max across every selected
   game), an honest report-level span deliberately distinct from the per-row spans. The renderer shows a
   `Span` column only for a game-count window; all four surfaces (text/HTML/Markdown/CSV) inherit it from
   one `Column[]`.

5. **Split by level at the league grain.** Rows group by `(player, sportId, leagueName)` — the
   single-player card's key, **not** the digest's coarser `(player, sportId)`. sportId 16 covers every
   rookie/complex league, so grouping by sportId alone would blend the Dominican Summer League with a
   domestic complex under one label; a promotion inside the last N games yields one row per level, neither
   containing the other's totals. `buildStatRowCore` is shared, but the group key is the caller's, so the
   digest's existing `(player, sportId)` grouping is byte-identical (pinned by `digest-*.test.ts`); whether
   the digest should adopt the finer key is a possible follow-up, out of scope here.

6. **A game-count report is on-demand and read-only.** It has no single date to key a daily slot on, so it
   routes to the no-claim, no-delivery-row path (identical to ADR 0046/0050 for lists/tags), stamps no
   `digest_delivery_id`, and touches no stat-line state. No idle/zero-row tail either: a game-count report
   is about players who **have** games, so a player with zero completed regular games simply does not
   appear (a deliberate divergence from the daily digest, whose "who didn't play" tail is load-bearing).

Further consequences:

- **The window function forgoes the card's early-exit.** SQLite computes `ROW_NUMBER()` over the whole
  partition (a TEMP B-TREE for the ordering) rather than stopping after N as the single-player cursor
  does, and it serves the group/rank through `stat_lines_player_source_game_type_uq` rather than the
  recency index. On this single-user host (a watch list of tens, a season of games each) the cost is
  negligible; an `EXPLAIN QUERY PLAN` test asserts the base tables are index-backed (no full scan) and the
  whole thing is one statement. A larger deployment should revisit the query shape.
- **The token spellings differ from the card's on purpose.** The cohort surface uses `last10games` /
  `last30games` where the single-player card (`PLAYER_CARD_WINDOWS`) uses `last10` / `last30`. The suffix
  makes a cohort game-count report distinguishable from the card's window at a glance and keeps the two
  closed sets from colliding; an operator moving between `report player` and `digest` sees different
  tokens for the related concept.
- **One implementation of the shared row math.** The fielding-fold, PA derivation, aggregate, QS, and
  relief-decision logic moved intact from `assemble.ts` to `rows.ts` and is now called by both engines;
  the digest's behavior is pinned unchanged by its existing suite.
