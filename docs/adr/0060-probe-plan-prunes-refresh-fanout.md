# Refresh probes a pruned plan, not the whole 6x3 fan-out

**Status:** accepted

**Amends:** [ADR 0030](0030-full-season-refresh-report-once-digest.md) — the *ingestion* half, which
reads as "every sportId x every stat group, every run". The **no-date-windows** rule it exists to
protect is unchanged and is what this ADR is written to preserve.

A **probe plan** is the set of `(sportId, statGroup)` pairs one Refresh fetches game logs for, for one
MLB/MiLB Player. Until now that set was a constant: `SPORT_IDS` x `STAT_GROUPS` = 6 x 3 = **18**
`getGameLog` calls per player per sweep, whatever the player's history. Now it is **derived**, per
player, from two facts the sweep already has — where he is *today*, and which `(sportId, statType)`
pairs have *ever* produced a stat line for him this season
([issue #197](https://github.com/wrburgess/bryce/issues/197)).

## The plan

One query, issued after the identity fetch and before any game log:

```sql
SELECT DISTINCT sport_id, stat_type FROM stat_lines
 WHERE player_id = ? AND source = 'mlb_stats_api'
   AND sport_id IN (1, 11, 12, 13, 14, 16)
   AND game_date LIKE '<season>-%'
```

Its result is the **seen set**. The plan is then:

- **FULL fan-out** (the exact prior 18-call behavior) when *any* of: the seen set is empty; the person
  carries no `currentTeam`; that team's sport is outside `SPORT_IDS`.
- **Otherwise**, probe exactly `{(currentSportId, g) for every g in STAT_GROUPS}` union
  `{(sportId, group-of(statType)) for every seen pair at a sport OTHER than the current one}`.

The current level is always probed **in full**, all three groups, so a two-way player's first pitching
appearance — or a position player's first relief inning — is ingested on the same sweep it happens,
never a sweep late. Historical levels are probed only at pairs that have already produced lines,
because that is where their quiet corrections land.

The decision is a pure exported function, `probePlanFor`, table-tested directly rather than only
through the orchestration — the same shape as `deriveRefreshStatus`.

## Why this was asked

Nothing is wrong with the full sweep's *results*; it is wrong about its *cost*. Fifteen of the
eighteen calls for a settled MLB player are requests for a level he has never played at, repeated
every night forever, and that ratio only worsens as the watch list grows.

Windowing the *dates* was rejected in ADR 0030 and stays rejected — it reintroduces the loss modes
(late finals, corrections, a laptop asleep for days) the full-season re-sweep eliminates. Pruning the
*fan-out* is a different axis: every pair that is probed is still fetched **whole-season, no window**,
so completeness at each probed pair is bit-for-bit what it was.

## What is preserved

- **No date windows, anywhere.** Every probed pair fetches the complete current season, exactly as
  before. ADR 0030's ingestion contract is narrowed in breadth, never in depth.
- **The backfill path.** Adding a Player is his first Refresh, and a first Refresh has an empty seen
  set, so it takes the FULL fan-out. A mid-season call-up added with zero rows does not lose his
  lower-level season. The same holds for `runRefreshForPlayer`, which reaches this code through
  `refreshPlayer` and inherits the empty-seen rule with no branch of its own.
- **Quiet corrections at every level a player has played.** A seen pair stays probed for the rest of
  the season, so an official-scorer correction to an April Double-A line still lands in July.
- **The finality gate.** [ADR 0040](0040-exclude-in-progress-games-from-ingestion.md)'s same-day hold
  is applied per split, downstream of the plan, and is untouched.
- **Every other path.** NCAA/Highlightly ingestion does not use `SPORT_IDS` at all. No progress-event
  kind is added or changed ([ADR 0056](0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md)),
  and `RefreshSummary` keeps its shape.

## Decisions this fixes

1. **The seen-pairs query is filtered by `source`, not merely by player.** The filter exists to keep a
   *stored* value from minting a *request*: a row written by the NCAA or Highlightly provider would
   otherwise be read back as a level to probe, and the sweep would issue `getGameLog` calls against the
   MLB Stats API for a sport it never covers. Its `sport_id` alone cannot be relied on to disqualify
   it — a malformed row can carry a swept id — which is exactly the case the covering test constructs,
   and the only one in which this filter is the sole thing in the way.

   The `SPORT_IDS` constraint appears **twice**, and only one copy is load-bearing. `probePlanFor`
   re-applies it to its own input, so the pure exported function is safe in isolation rather than
   resting on its one caller's `WHERE` clause; that copy is the one under test. The `inArray` in the
   query narrows what SQLite reads and changes no outcome — deleting it turns nothing red, and the
   comment at the call site says so, so a later reader does not mistake it for a guard.

2. **The full fan-out is keyed on the *current* sport being a swept one — one predicate, not three.**
   `SPORT_IDS` membership is the load-bearing test: we only ever probe a sport the MLB path sweeps. It
   subsumes `levelForSportId` returning `null` (an unknown id) and returning `ncaa` (sportId 22),
   because the non-NCAA keys of the level map are exactly `SPORT_IDS`. Writing all three would put two
   provably unreachable branches in the file, which `rules/testing.md` treats as worse than the
   redundancy is worth: a branch no input can reach is indistinguishable from one that enforces
   nothing. Both scenarios are still covered as *behavior* — an unknown sport and an NCAA sport each
   have their own test, and deleting the single guard turns both red.

3. **No new index.** The query's `WHERE` leads with `player_id`, which the existing
   `stat_lines_player_source_game_type_uq` unique index (`player_id, source, game_id, stat_type`)
   covers as a two-column equality prefix; SQLite filters `sport_id` and `game_date` from the small
   per-player row set that prefix yields. At this project's scale — one host, tens of players, a few
   hundred rows each — that is already far cheaper than the fifteen HTTP calls it removes, and a
   dedicated index would cost writes on every ingest to save microseconds on one read per player per
   sweep. This is a recorded decision, not an assumption: if the watch list ever grows by orders of
   magnitude, re-measure before adding one.

## The residual risk, stated plainly

A correction that **adds a first-ever line at a pair never seen before, at a historical level**, is
missed until something else re-probes that level. Concretely: a player is at Triple-A, played eight
Double-A games in April, and in July the provider *adds* a Double-A **fielding** line he had none of.
The seen set holds `(12, batting)` but not `(12, fielding)`, so that pair is not probed.

This is accepted, for three reasons. It requires a provider to invent a game-log row in a group a
player never appeared in, at a level he has left — the rarest shape of an already rare event. It
self-heals: any return to that level makes it the current sport, which is probed in full. And
[#199](https://github.com/wrburgess/bryce/issues/199)'s periodic deep sweep is the intended
belt-and-braces, re-running the whole 6x3 fan-out on a slower cadence; this ADR is what makes that
issue worth opening rather than redundant.

The failure mode this deliberately does **not** accept is a missed *promotion or demotion*: the
current level comes from the identity fetch, not from history, so a player who moved yesterday is
probed at his new level in full on the very next sweep.
