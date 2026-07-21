# Baseball Digest

The domain language of Bryce: a single-user daily digest of stat lines for a personal watch list of
baseball players across MLB, MiLB, and NCAA.

## Language

**Player**:
A human being on the watch list — exactly one record per person, whatever level or team he is at.
_Avoid_: "prospect" (a stage, not an identity), "level-slot" (a Player is not "Holliday at AAA")

**Level**:
A Player's current competitive tier — `mlb`, `milb`, or `ncaa` — a mutable *location*, never part of
identity.
_Avoid_: "league" (MiLB levels contain many leagues), "class"

**MiLB Level**:
The minor-league tier (Triple-A, Double-A, High-A, Single-A, Rookie/Complex) a `milb` Player is
currently assigned to; empty for `mlb` and `ncaa` Players.
_Avoid_: "affiliate" (that's the team, not the tier)

**Watch List**:
The set of *active* Players — the digest's audience of one's chosen few. Deactivating a Player
removes him from the digest but keeps his history.
_Avoid_: "roster" (a real baseball concept; using it here invites confusion)

**External ID**:
A Player's source-native identity: the MLB Stats API `personId`, which is stable across MLB and
every MiLB level. NCAA Players have their own source-native identity — the stats.ncaa.org
`stats_player_seq`, stored in a separate `players.ncaa_player_seq` column so `external_id` stays
MLB-only and one human is still one Player row across levels
([ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)).
_Avoid_: "player id" (ambiguous with the app's own primary key)

**Stat Line**:
One Player's line for one *game* in one role — batting or pitching. The digest's atomic unit;
per-game, never per-day.
_Avoid_: "daily stat line" (a date can hold two games), "box score" (that's the whole game's record)

**Game ID**:
The source-native identifier of a single game (the MLB Stats API `gamePk`). The NCAA adapter prefers
the source contest id (from the game-log page's box-score/contest anchor) and, when the page exposes
none, synthesizes a stable stand-in (a deterministic hash of date + opponent + game sequence, flagged
in `raw`) so nothing outside the adapter knows the difference
([ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)).
_Avoid_: "game date" (a date is not an identifier — doubleheaders)

**Refresh**:
The recurring job that re-ingests every active Player's *complete current-season game log* and
upserts it idempotently — no date windows; adding a Player is just his first Refresh.
_Avoid_: "yesterday fetch", "incremental sync" (there is no window to fall out of)

**Digest**:
The email reporting every Stat Line whose game date falls inside a **Window**, as two tables of
aggregate numbers — Batters and Pitchers — one row per Player per **Level**. Sent every day, even
when empty (an empty Digest is proof of life). A Digest consumes nothing: re-running the same Window
always reports the same content (ADR 0035).
_Avoid_: "unreported stat lines" (the novelty model this replaced — ADR 0030's reporting half)

**Window**:
The inclusive date range a Digest covers: `1d`, `7d`, `14d`, `21d`, or `ytd`. Every Window ends on
the **last completed** host date — yesterday, not today — so a Digest does not depend on the hour it
runs. Regular season only.
_Avoid_: "yesterday's stats" for anything but `1d`

**Roll-up**:
A Window's aggregate numbers for one Player at one Level: counting stats summed, rates **recomputed
from those sums** — never averaged across games, which over-weights low-denominator games while
staying in a plausible range.

**In Season**:
A Player whose competition still has games left to play. An out-of-season Player drops out of the
Digest entirely — no "no new stats" mention — and rejoins automatically when his games resume.
_Avoid_: "active" (that's the Watch List flag; a benched or injured Player is still In Season)

**Offseason Sleep**:
The system's state from the end of the World Series to the **earliest opening day among watched
levels** — NCAA opening day (mid-February) if any NCAA Player is watched, otherwise MLB Opening
Day. Refresh pauses and the daily Digest is replaced by a weekly heartbeat ("alive; N players
watched; games resume ~{next opening day}"). Spring-training games are deliberately outside the
domain — no Stat Lines, no early wake. MCP and the API stay live; only the pipeline sleeps.
_Avoid_: "shutdown", "hibernate" (history remains queryable all winter)

## Relationships

- A **Player** has exactly one **Level** at a time; promotion or demotion *changes* his Level, it
  never creates a second Player.
- A **Player**'s Level, MiLB Level, and team are refreshed automatically from the source APIs
  during the nightly fetch — the digest regroups on its own when a Player moves.
- A **Watch List** is just the active subset of Players; there is no separate list object.
- A **Player** produces at most two **Stat Lines** per game — one batting, one pitching (a two-way
  player produces both).
- One date can hold several **Stat Lines** for the same Player (doubleheaders): uniqueness is
  Player + **Game ID** + role, never Player + date
  ([ADR 0029](../adr/0029-stat-lines-per-game-keyed-by-game-id.md)).
- A **Refresh** makes storage complete; a **Digest** reports each **Stat Line** exactly once —
  ingestion is completeness-driven, reporting is novelty-driven
  ([ADR 0030](../adr/0030-full-season-refresh-report-once-digest.md)).
- A correction to an already-reported **Stat Line** updates storage quietly; it is not re-announced.
- The **Digest** lists an **In Season** Player with no new **Stat Lines** under a "No new stats"
  tail per Level section; an out-of-season Player is omitted, not listed.
- While at least one Player is **In Season**, the **Digest** is daily (even when empty); during
  **Offseason Sleep** a weekly heartbeat replaces it, and the daily cadence resumes automatically
  at the earliest opening day among watched levels
  ([ADR 0031](../adr/0031-offseason-sleep-world-series-to-opening-day.md)).

## Example dialogue

> **Dev:** "Holliday got called up Tuesday — do I need to move him to an MLB **Player**?"
> **Domain expert:** "No. He's one **Player** whose **Level** changed. Wednesday's digest shows him
> in the MLB section automatically, and his Triple-A lines from Monday are still his history."

## Flagged ambiguities

- "level" was used to mean both *identity* ("the AAA guy I'm watching") and *location* — resolved:
  location only, refreshed from the source, never identity.
- NCAA player identity — **resolved** (Phase 3,
  [ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)): NCAA has a clean
  source-native id after all, the stats.ncaa.org `stats_player_seq`, stored in its own
  `players.ncaa_player_seq` column (no school+name matching needed). `external_id` stays MLB-only.
- "daily stat line" (the handoff's table name) read as one-per-day — resolved: a **Stat Line** is
  per-game; the *digest* is what's daily.
- "yesterday's stats" (the handoff's framing) read as a date-window rule — resolved: it was just a
  phrase. Capture all stats whenever available (**Refresh**); report each exactly once (**Digest**).
- "No game" (the handoff's list label) conflated four truths — off-day, sat out (DNP), data lag,
  season over — resolved: the list is "No new stats", shown only for **In Season** Players; data
  lag self-heals next Digest; DNP detection (schedule cross-reference) is a deferred later idea.
- **Offseason Sleep vs. NCAA** — NCAA baseball starts mid-February, inside the post-World-Series
  sleep window. Resolved: the sleep ends at the *earliest opening day among watched levels*, so a
  watched NCAA Player wakes the pipeline for NCAA opening day; MLB/MiLB Players rejoin at MLB
  Opening Day (spring training still excluded).
