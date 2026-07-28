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

**Named List**:
A curated set of Players over the Watch List, addressed by name. Distinct from a **Tag** (a queryable
attribute) — a list is membership someone chose, not a property a Player has.
_Avoid_: "group"/"collection" (say *list*); "roster" (see **Watch List**)

**Lane**:
A **Named List** that also carries its own schedule and recipients — a refresh interval, a digest
hour, and a `digest_to`. Exactly one live list is the **Default Lane**: what a command means when it
names no list. A Lane is a Named List with a cadence, never a second kind of object
([ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)).
_Avoid_: "channel"/"feed"; calling every list a Lane (a list with no cadence is just a list)

**Default Lane**:
The one live list marked `is_default` — the audience of an unscoped Digest or Refresh. It cannot be
deleted while it is the default, and a database with none *refuses* unscoped commands rather than
falling back to every Player.
_Avoid_: "the main list"; treating "no default" as "everyone"

**Tag**:
A user-queryable label on a Player as `namespace:value`. **Derived** tags (`level:`, `pos:`,
`prospect`) are recomputed automatically from the Player's own data; **manual** tags
(`status:rostered`, `status:scouted`) are set by hand and survive derivation. See the
[tag model reference](tags.md).
_Avoid_: hand-writing a derived tag (it is rejected); "label"/"category" (say *tag* and its *namespace*)

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
The recurring job that re-ingests an active Player's *complete current-season game log* and upserts
it idempotently — no date windows; adding a Player is just his first Refresh. Its audience is a
**Scope**: a set of **Lanes**, or the whole **Watch List**
([ADR 0061](../adr/0061-lane-scoped-refresh-supersedes-whole-sweep.md)).
_Avoid_: "yesterday fetch", "incremental sync" (there is no window to fall out of)

**Scope** (of a Refresh):
Which **Lanes** one **Sweep** covers, resolved *once* before the run is claimed and used by every
selection the sweep makes. Absent means the whole **Watch List**; `sk refresh` with no `--list`
resolves the **Default Lane**. A run records its Scope, and only a run whose Scope covered the
Default Lane can advance the Digest's freshness watermark.
_Avoid_: "filter" (a Scope is decided before the sweep, not applied to its results); treating an
empty Scope as "everyone"

**Probe Plan**:
The set of (level, stat group) pairs one **Refresh** fetches game logs for, for one Player: his
current level in all three groups, plus every pair his stat lines already cover this season. A Player
with none takes the whole fan-out ([ADR 0060](../adr/0060-probe-plan-prunes-refresh-fanout.md)). It
prunes *breadth*, never *dates* — each probed pair is still fetched for the complete season.
_Avoid_: "window", "incremental" (nothing about the dates fetched changed)

**Sweep**:
One Refresh's single pass over its **Scope**, from claiming the run to settling its outcome.
_Avoid_: "run" on its own (ambiguous between the pass and its durable record); assuming a Sweep
always covers the whole **Watch List**

**Skipped Sweep**:
A Refresh that swept nobody at all — during **Offseason Sleep**, behind a concurrent Refresh already
holding the claim, or after being superseded mid-flight. It settles no outcome of its own.
_Avoid_: bare "skipped" (that collides with a **Passed-Over Player**); "failed" (a Skipped Sweep is
not an error)

**Passed-Over Player**:
An active Player a **Sweep** deliberately did not fetch — out of season, or carrying no usable
**External ID**. Distinct from a Player whose refresh was attempted and failed.
_Avoid_: bare "skipped" (see **Skipped Sweep**); "missing" (he is on the Watch List and accounted for)

**Digest**:
The email reporting every Stat Line whose game date falls inside a **Window**, as two tables of
aggregate numbers — Batters and Pitchers — one row per Player per **Level**. Sent every day, even
when empty (an empty Digest is proof of life). A Digest consumes nothing: re-running the same Window
always reports the same content (ADR 0035).
_Avoid_: "unreported stat lines" (the novelty model this replaced — ADR 0030's reporting half)

**Window**:
The inclusive date range a Digest covers: `1d`, `7d`, `14d`, `21d`, `28d`, `35d`, `60d`, or `ytd`.
Every Window ends on the **last completed** host date — yesterday, not today — so a Digest does not
depend on the hour it runs. Regular season only.
_Avoid_: "yesterday's stats" for anything but `1d`

**Roll-up**:
A Window's aggregate numbers for one Player at one Level: counting stats summed, rates **recomputed
from those sums** — never averaged across games, which over-weights low-denominator games while
staying in a plausible range.

**Player Card**:
One Player's own report: his **Roll-up** for each of several player-relative **Card Windows**
(`last10`, `last30`, `ytd`) side by side, split batting/pitching by **Level**. The one report shaped
around a single Player rather than a cohort.
_Avoid_: "player profile", "player page" (a Card is an artifact, not a screen), "player digest"

**Card Window**:
A **Player Card**'s player-relative window — `last10` and `last30` count that Player's own last N
regular-season games, `ytd` runs from his sport's calendar start. Deliberately distinct from a
**Window**, which is one shared date range for everyone in a **Digest**.
_Avoid_: "window" unqualified (the two resolve differently for the same Player)

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

**Presentation**:
A human-readable rendering of a whole *report* — a **Digest** (both Roll-up tables) or a **Player
Card** (every Card Window) — as one multi-section artifact: console text, HTML, PDF, or Markdown,
instead of (or alongside) the email. Same content as the report it renders; only the format differs.
_Avoid_: "report" (the Digest or Player Card is the report; a Presentation is one rendering of it), "document"

**Export**:
Raw tabular rows for a spreadsheet or data tool, as CSV or Excel — *one table per file*. Targets a
single tabular result: a query (**Stat Lines**, ad-hoc SQL) or *one* of a **Digest**'s two tables
(Batters or Pitchers, never both at once). Carries data, not formatting.
_Avoid_: "download" (that is the delivery, not the artifact), "dump"

**Backup**:
An artifact captured for *recovery* — reconstructing lost or corrupted state — as opposed to an
**Export** or **Presentation**, which render data for *consumption*. Takes two forms: a **Snapshot**
and a **Player List Backup**.
_Avoid_: "dump"; "export" for this sense (an **Export** is a spreadsheet artifact, never a restore point)

**Snapshot**:
A consistent, self-contained copy of the *entire database* at one instant, kept as a point-in-time
rollback — above all, the known-good state to return to before a risky change such as a migration.
_Avoid_: "dump"; "replica" (a **Replica** is continuous and off-box; a **Snapshot** is discrete and local)

**Player List Backup**:
A portable, versioned serialization of *every* **Player** row — active and inactive — for re-import
onto a fresh install or after a bad edit; the recovery counterpart to the irreplaceable roster choices.
_Avoid_: "roster file"; "player export" (an **Export** is for a spreadsheet, this is for restore)

**Replica**:
The *continuous*, off-box copy of the live database streamed to remote storage — the guard against
hardware loss, complementary to a **Snapshot** and distinct from it.
_Avoid_: "backup" (a **Replica** tracks the live file continuously, corruption included; a **Snapshot**
is a chosen instant)

**Restore**:
Reconstructing database state by applying a **Backup** — swapping a **Snapshot** into place, or
re-importing a **Player List Backup**.
_Avoid_: overloading the delivery-ledger sense ("guarantee restored across the date boundary",
[ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md)) or a **Replica**'s remote recovery

## Relationships

- A **Player** has exactly one **Level** at a time; promotion or demotion *changes* his Level, it
  never creates a second Player.
- A **Player**'s Level, MiLB Level, and team are refreshed automatically from the source APIs
  during the nightly fetch — the digest regroups on its own when a Player moves.
- A **Watch List** is just the active subset of Players; there is no separate list object.
- A **Named List** holds many Players and a Player may sit in many lists; membership sits UNDER
  `players.active`, so a deactivated Player never appears in a scope even while still listed.
- Exactly one live **Named List** is the **Default Lane**, and every Digest delivery belongs to one
  lane: the delivery slot is keyed `(kind, date_covered, list_id)`, so two lanes may report the same
  date and one lane may not report it twice
  ([ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)).
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
- A **Presentation** carries the same content as the report it renders — the HTML document of the
  `7d` **Digest** shows exactly what the email would; a **Player Card**'s console and HTML renderings
  show exactly what its JSON does. Only the format differs.
  ([ADR 0055](../adr/0055-player-card-presentation-per-surface-defaults-no-pdf.md) deferred PDF a
  second time: the HTML Presentation carries a `@media print` block instead.)
- **Presentation = document, Export = table.** A **Presentation** renders a whole report — a
  **Digest**'s two tables, or a **Player Card**'s every Card Window — as one human-readable artifact;
  an **Export** carries exactly one table — a query result, or one of the Digest's two tables — for a
  spreadsheet.
- A **Digest** is scoped to a *cohort* over one shared **Window**; a **Player Card** is scoped to one
  **Player** over several **Card Windows**. Same Roll-up math, transposed axis — which is why a Card
  is its own report shape and not a one-player Digest.
- A **Snapshot** captures the whole database — every **Player**, **Stat Line**, and delivery record —
  at one instant; a **Player List Backup** captures only the **Player** rows.
- A **Player List Backup** protects the one thing no **Refresh** can rebuild — the human's **Player**
  choices (who is watched, notes, active state). **Stat Line** history is costly to re-pull (source
  rate limits; NCAA seasons may be unavailable to re-scrape) but is in principle re-derivable; the
  choices are not.
- A **Snapshot** is the local rollback point before a risky change; a **Replica** is the continuous
  off-box copy guarding against hardware loss — complementary, not substitutes.
- A **Refresh** either performs a **Sweep** that settles an outcome, or is a **Skipped Sweep** that
  settles nothing — never both.
- Every Player in a **Sweep** ends in exactly one of three states — refreshed, **Passed-Over**, or
  failed — and the three together account for the whole **Watch List**.

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
- **"presentation" vs "export"** — issue #55 listed HTML, PDF, Markdown, CSV, and Excel as one
  "presentation and export" set — resolved: a **Presentation** is a human-readable rendering of a
  **Digest** (HTML/PDF/Markdown); an **Export** is raw rows for a spreadsheet (CSV/Excel) over any
  tabular result. Two concepts, not five loose formats.
- **"player profile" vs "player card"** (issue #141) — the issue used "profile", "single-player
  profile", and "player card" interchangeably while the code had already settled on `PlayerCard` —
  resolved: **Player Card** is the term. "Profile" is retired; it reads as a screen, and this is an
  artifact. Consequently **Presentation** widened from *a rendering of a Digest* to *a rendering of a
  report*, so a Card inherits the Presentation rules rather than spawning a parallel concept.
- **"backup" vs "export"** (issue #67) — a **Backup** exists for *recovery* (a **Snapshot** or a
  **Player List Backup**, re-importable), while an **Export** exists for *consumption* (raw rows for a
  spreadsheet). Resolved: different purposes, different artifacts — never conflate them.
- **"player list"** (issue #67's phrasing) — resolved: a **Player List Backup** captures *every*
  **Player** row, active and inactive, which is broader than the **Watch List** (the active subset
  only); inactive Players carry history and past choices worth restoring.
- **"skipped"** (issue #146) — used for two unrelated things: a whole Refresh that never ran, and one
  Player a running Sweep chose not to fetch. Resolved: **Skipped Sweep** for the first,
  **Passed-Over Player** for the second. Never say "skipped" unqualified, least of all in output the
  HC reads live.
- **"progress"** (issues #95 → #146) — #95 delivered durable per-Sweep counters and #146 reported
  that "progress does not work," which read as a defect in them. Resolved: those are two different
  obligations, and #95 built only the second. **Liveness** is continuous evidence that a Sweep is
  alive and where it is right now; its audience is whoever is watching the terminal, and it is
  discarded the instant it is read. **Accounting** is the durable record of what a Sweep did; its
  audience is `/health`, the MCP status tool, and the **Digest**'s freshness banner, and it is read
  after the fact. Accounting can never serve as Liveness — it is aggregate and after-the-fact by
  construction ([ADR 0056](../adr/0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md)).
- **"batch-add player names"** (issue #68) — the title reads as "add by name," but the domain
  identifies a **Player** by **External ID** (NCAA: `stats_player_seq`), never by a bare name.
  Resolved: a batch add keys on *identity*; a **name** is only a search convenience — the MLB Stats
  API people-search, MLB/MiLB only, since there is no NCAA name search
  ([ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)) — that resolves to an
  **External ID**. A batch takes identifiers directly and names that resolve to *exactly one* hit; a
  name with zero or several hits is *reported back*, never guessed, and an NCAA **Player** enters a
  batch only by `stats_player_seq`.
