# The Digest selects by date window, not by novelty — and reports roll-ups, not single games

The Digest used to report **every Stat Line not yet reported by a previous Digest**: novelty-driven
selection, tracked by stamping `stat_lines.digest_delivery_id` on every line a send covered, rendered
as one prose line per game grouped into Level sections (ADR 0030).

It now reports **every Stat Line whose game date falls inside a requested window**, rendered as two
tables — Batters and Pitchers — of aggregate numbers, one row per Player per Level.

## What forced the change

Two things the novelty model could not express.

**There was no aggregation.** Every number the Digest rendered was a single-game number. "How has he
hit over the last week" had no answer, because the reporting unit was a game and nothing summed
across games.

**There was no way to ask.** The Digest was a daily artifact and only a daily artifact. A 7-day or
season-to-date view was not a parameter that existed.

The data was never the obstacle. `stat_lines` is already a true per-Player-per-game game log keyed on
`(player_id, game_id, stat_type)` (ADR 0029), storing both the split's stat object and the entire
gameLog split verbatim; Refresh already re-ingests the whole current season every run (ADR 0030's
ingestion half, which **stands unchanged**). Windowed aggregation was a read-side problem the whole
time.

## The selection rule

> A Digest reports every Stat Line for an active Player whose `game_date` falls within
> `[window.from, window.to]` and whose `game_type` is regular season.

`1d`, `7d`, `14d`, `21d`, and `ytd` are the supported windows. An unsupported value is **rejected** on
every surface — CLI, REST, MCP — rather than defaulted, because the window *is* the content and
quietly substituting a different one would answer a question nobody asked.

### Every window ends on the last completed host date

Windows end **yesterday**, not today. A run at 08:00 covering "today" would be empty every morning
— the day's games have not been played — and a run at 23:00 would cover a partial day. Anchoring on
the last completed date makes the report independent of the hour it runs: 06:00 and 23:00 on the same
date produce byte-identical output.

A game played today therefore first appears in tomorrow's Digest. That is correct for a daily
artifact: the game is not over when the Digest is composed.

This is distinct from `digest_deliveries.date_covered`, which remains the host date of the **run**.
The delivery slot is keyed by run date; the content covers the window ending the day before.

### Rows group by Player *and* Level

`players.milb_level` records where a Player is **now**. `stat_lines.sport_id` records where each game
was actually **played**. Those diverge constantly — `src/mlb/levels.ts` has always said it: *"Level is
a mutable location, never identity."*

Grouping by Player alone would fold a promoted Player's Triple-A, High-A and Single-A performance
into one slash line labelled with wherever he happens to be today. That number describes nobody, and
it is exactly the blended comparison a prospect tracker exists to prevent. So the grouping key is
`(player, sport_id)`, and each row's Level is read from its own Stat Lines.

A `1d` window groups by `(player, game_id)` instead, so a doubleheader stays two rows.

## What this costs, and why it is acceptable

**Novelty selection caught late-arriving data for free.** A game posted two days after it was played,
or an official-scorer correction that rewrites an old row, was reported whenever it landed, because
"not yet reported" has no relationship to dates. A fixed window does not do that: a correction to a
July 3rd game does not reappear in the July 19th Digest.

The mitigation is structural rather than a mechanism. A window **consumes nothing** — every Digest
recomputes from the game log. So a correction that misses one day's `1d` email is still present, and
correct, in every subsequent `7d`, `14d`, `21d` and `ytd` report that covers its date. The loss is one
day's notification, never the data.

This is the deliberate reversal of ADR 0030's reasoning, which chose novelty precisely *because* MLB
revises box scores. The judgement changed because aggregation made windows necessary, and because
re-runnability turned out to defuse most of what novelty was protecting.

## What follows from "a Digest writes nothing"

`stat_lines.digest_delivery_id` is **dropped**. It existed only to make novelty work.

A surprising amount of machinery existed only to protect that column, and goes with it:

- the novelty-widening `includeDeliveryId` parameter on assembly, and `previewDeliveryId`, which
  existed so a forced preview could re-include lines a delivery had already stamped;
- `replayOfDeliveryId`, and the deliberately-renamed-field barrier in the claim result union that
  made a replay's id unreachable from `settleSent`/`settleFailed`.

That barrier's whole purpose was to make one failure impossible by construction: a forced run
re-claiming an already-`sent` row, the mailer then throwing, and `settleFailed` wiping `sent_at` off a
genuinely delivered digest. Under window selection there is no line state a forced run can corrupt,
because there is no line state at all.

Dropping the column has a second benefit worth stating: reintroducing stamping now requires a schema
migration, which is a far more visible act than flipping a line of code.

**The replay concept survives in reduced form.** A forced run still holds no claim and still settles
nothing — that is what stops `settleFailed` from damaging a delivered row. It simply no longer needs
to carry a delivery id.

## What is unchanged

**ADR 0034 in full.** Delivery is still claim → assemble → send → settle. Exact mutual exclusion, the
lease, takeover of an expired claim, strictly fail-open provider reconciliation, and the rule that
force never overrides a live claim all stand exactly as written. Only line stamping was removed from
the flow.

**ADR 0029.** Stat Line identity is still `(player_id, game_id, stat_type)`, enforced by a unique
index. The migration that drops the column is a SQLite table rebuild, and that index was verified to
survive it and still enforce — without it, doubleheaders would collapse and Refresh's upsert would
start inserting duplicates.

**ADR 0031.** Offseason Sleep and the weekly heartbeat are untouched.

**ADR 0033.** The stat set is the same fixed format, every stat always shown, zeros included —
transposed from comma-joined prose into table columns. Fielding still merges into the batting row as
an error count and never renders standalone.

**ADR 0030's ingestion half.** Refresh still performs a full-season, no-window sweep of the current
season's game log — no date windows anywhere in ingestion. Only the *reporting* half of that ADR is
superseded here. "On every run" carries the established exceptions, unchanged by this branch:
Offseason Sleep skips the whole job (ADR 0031), a player whose source identity cannot be resolved is
skipped, and NCAA ingestion stops after its bundled seven-day post-season grace. The
correction-mitigation argument above depends only on ingestion continuing to run and recompute while
a season is live, which those exceptions do not disturb.

## Consequences

- Aggregate rates must be **recomputed from summed counters**, never averaged across games. Averaging
  over-weights low-denominator games — a 1-for-1 pinch-hit appearance moves a season line as much as
  an 0-for-5 start — and it stays inside a plausible range while doing it, which is what makes the
  error hard to see. Innings are summed as **outs**, since `"6.1"` is six innings and one out.
- Every stat field must be classified as a counter, a rate, an innings value, or excluded. An
  unclassified field is excluded and reported, never summed — allowlist, not blocklist, following
  `src/mlb/gameTypes.ts`.
- The host timezone is now **content**, not just a label. Under novelty selection a wrong host date
  only mislabelled the delivery slot; under window selection it shifts every boundary. This is why
  the host timezone key was renamed to `BRYCE_TZ`: `TZ` is a reserved POSIX variable that ambient
  tooling sets, and it silently defeated the configured value.
- Postseason games are ingested but excluded from every window. An October `ytd` line blending
  playoff and regular-season stats is not a season line.
- A watched Player with no games in the window renders a zero row, replacing the old "no new stats"
  tail. Pitchers' zero rows go in the Pitchers table — an idle reliever rendered as an 0-for-0 batter
  reads as a bad week rather than no appearances.
