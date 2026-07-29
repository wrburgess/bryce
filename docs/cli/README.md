# CLI Reference

The command-line entry point to Bryce's pipeline is **`sk`** (ScoreKeeps). Activate the project-local
executable once with `npm link`, then run `sk …` from any directory. The executable resolves its own
project-local TypeScript runtime; it does not require a global `tsx`. Each is a thin presenter over
the same service layer the [REST API](../api/README.md) and [MCP tools](../mcp/README.md) use. Each
job's **summary** is a deterministic `key=value` line and
every command exits non-zero on failure — but the output is not purely ASCII `key=value`: `digest`
with `MAILER_PROVIDER=console` prints the full rendered email above its summary, and `seed`/`list`
echo the canonical (NFC) player identity, which may contain non-ASCII characters (e.g. `José`), in
UTF-8 — a deliberate policy scoping the ASCII-safe-stdout rule to machine output
([ADR 0047](../adr/0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md)). Domain terms below —
**Player**, **Refresh**, **Digest**, **Window**, **Offseason Sleep** — are defined in
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md).

Built-in help is the canonical source for command syntax and supported options: use `sk help`,
`sk help players lists`, or `sk digest --help`. This page is the deeper operational reference.
Existing `npm run …` scripts remain migration-compatible; arguments after one must follow `--`. The
activated `sk` executable may run from any directory; `.env` and relative configured paths are
resolved from the current working directory, so run it from the directory whose data/configuration
you intend to use.

## `refresh` — re-ingest a lane's current season

```sh
sk refresh                        # the DEFAULT lane, live per-player progress
sk refresh --quiet                # only the terminal summary (what scheduled runs use)
sk refresh -q                     # short alias
sk refresh --list Prospects       # scope the sweep to a named lane
sk refresh -l Prospects           # short alias for --list (#192)
```

Re-ingests the **full current season** game log for every active Player **in the lane** and upserts it
idempotently (no date windows — a Refresh makes storage complete). Running it twice changes nothing the
second time. During **Offseason Sleep** it exits without any API calls
(`refresh skipped list=<lane> reason=offseason-sleep`).

**Bare `sk refresh` means the DEFAULT lane**, not every active Player
([#192](https://github.com/wrburgess/bryce/issues/192),
[ADR 0061](../adr/0061-lane-scoped-refresh-supersedes-whole-sweep.md)) — the same rule
`sk players add` follows. `players lists show` marks the default lane and `players lists set-default`
moves it. `players.active` remains the master gate above membership: a deactivated Player who is still
enrolled in the lane is not fetched.

**Both lane failures are closed, before anything is claimed or swept.** An unknown (or soft-deleted)
`--list` and a database with **no** default lane each print a greppable `error: …` line to stderr and
exit **1** with no run recorded — a typo must never widen a sweep. The MCP `refresh` tool and
`POST /refresh` are unchanged this phase and still sweep the whole Watch List.

> **The asymmetry is closed.** `sk refresh` is lane-scoped from #192 and bare `sk digest` is lane-scoped
> from [#193](https://github.com/wrburgess/bryce/issues/193), so both mean the default lane. The digest's
> `fresh` banner therefore asks a **per-lane** coverage question: a run counts if it swept the lane the
> digest is about — a whole-list sweep (which covers every lane) or a scoped sweep whose recorded lane
> list contains it. A sweep that left this lane out leaves the banner reading `stale`, deliberately, so a
> narrow sweep cannot forge a completeness claim over players it never touched. The test is **coverage**,
> not which lane you named ([ADR 0061](../adr/0061-lane-scoped-refresh-supersedes-whole-sweep.md)
> decision 8, narrowed per lane by
> [ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 2).
>
> **Adding a player to a lane makes that lane `stale` until its next sweep**, and that is the same rule
> rather than a new one: a scoped run records the lane, not the players it fetched, so an active Player
> who joined *after* that sweep started would otherwise be reported under a `fresh` banner over stats
> nobody ever fetched. The tick reads the lane as due and re-sweeps it, which restores `fresh`
> automatically. A *whole-list* sweep is unaffected — it swept every then-active player, so a later lane
> enrollment says nothing about what it covered — and an **inactive** enrollee is never a gap, because
> `players.active` is the master gate.

> **Two `refresh done` grammars exist — grep for the right one.** This sweep prints
> `refresh done list=<lane> status=… players=… skipped=… failed=… inserted=… updated=…`. The
> **first-refresh** line printed by `sk seed add` and `sk players add` for a brand-new player is a
> different, shorter record: `refresh done inserted=… updated=…`, with no `list=` and no `status=`
> (see [`players add`](#players-add--add-one-player-and-attach-him-to-a-lane) below). They report
> different things — a whole sweep versus one player's backfill — and are **not** being reconciled;
> match on `status=` (or on `list=`) when you mean the sweep. The other grammar is documented under
> `players add` below.

*Which* game logs each Player needs is derived per Player, not swept blindly across all six levels
([ADR 0060](../adr/0060-probe-plan-prunes-refresh-fanout.md)): his current level in all three stat
groups, plus every level and group his stat lines already cover this season. A Player with no lines
yet — anyone newly added — is fetched across every level. The season fetched per level is always the
whole season.

### Live output (#146, [ADR 0056](../adr/0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md))

The job emits typed progress events and this CLI is the only thing that renders them. The content is
identical whether stdout is a terminal or a pipe; only the way a **hang** is made visible differs.

```
refresh start players=12 season=2026 run=7
refresh phase=calendars start
refresh call=getSeason sportId=1 outcome=ok elapsed=512ms
refresh phase=calendars done failures=0
refresh player=3/12 id=41 name=Roch_Cholowsky start
refresh player=3/12 id=41 call=getBoxScore matchId=99123 outcome=ok elapsed=847ms
refresh player=3/12 id=41 waiting call=getBoxScore matchId=99123 elapsed=30000ms
refresh player=3/12 id=41 done outcome=refreshed inserted=4 updated=1 elapsed=48200ms refreshed=3 passedOver=0 failed=0
refresh notice code=ncaa-season-missing season=2026
refresh done list=Watchlist status=ok players=11 skipped=1 failed=0 inserted=44 updated=3
```

- **Key order is fixed** — `refresh` · `player=i/total` · `id=` · `name=` · `call=` · the call's own
  keys · `outcome=` · `elapsed=` — so the stream is stably greppable. Every elapsed value is integer
  milliseconds with an `ms` suffix.
- **Piped or redirected** (cron, `> refresh.log`): append-only ASCII lines, **no control
  characters**. A call still outstanding after 30s emits a `waiting` line, repeated every 30s, so a
  stall is distinguishable from truncation.
- **On a terminal**: the same lines, plus one *in-place* line for the call in flight whose elapsed
  time ticks each second. Cursor control appears on that line only; every settled line is plain.
- **Player names and failure reasons are folded to ASCII** and spaces become `_`, so one line stays
  one parseable record: no escape sequence in an upstream name can overwrite what the presenter
  already printed, and no crafted upstream error message can forge a trailing `key=value` token that
  reads as this run's own counters
  ([ADR 0047](../adr/0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md), amended for #146).
- **The three notices move from stderr to stdout in verbose mode.** `ncaa-season-missing`,
  `tag-sync-failed`, and `targeted-calendar-failures` were unconditional `stderr` writes before #146;
  a verbose run now renders them as `refresh notice code=…` on **stdout**, alongside the rest of the
  stream. `sk refresh 2> errors.log` therefore no longer captures them — use `--quiet`, which keeps
  the pre-#146 stderr text byte-identically, or redirect stdout. Callers with no presenter attached
  (the MCP tool, the REST route, and the seed path) are unaffected: they still get the original
  stderr line and nothing else.
- **The terminal lines lead with `list=`** (#192): `refresh done list=<lane> status=… … updated=…` and
  `refresh skipped list=<lane> reason=…`. The lane comes **first** because the run's own counters come
  last, and it is ASCII-folded like every other runtime-derived field — a lane name is
  operator-supplied text, so folding is what stops one called `x status=ok` from forging a token ahead
  of the real ones.
- **`--quiet`** prints **exactly one terminal line and nothing else**, and that line is byte-identical
  to the verbose run's terminal line — plus the stderr failure summary and the three legacy notice
  lines, which are unconditional. The scheduled [`tick`](#tick--run-whatever-the-lanes-owe-right-now)
  runs the sweep in this mode.

Console counts and the persisted `/health` / MCP `status` counts agree **by construction**: a
player's `done` line is emitted only after that player's progress write has committed, so the
terminal can never show more players settled than the database knows about.

**Exit codes are unchanged** by the live output or by the lane: `failed` (a blocked run that refreshed
nobody) exits 1; `ok`, `partial`, and any Skipped Sweep exit 0. A manual lane refresh started while
another sweep holds a live lease prints `refresh skipped list=<lane> reason=already-running` and exits
0 — the same refusal any whole sweep gets, because it is the same claim.

## `tick` — run whatever the lanes owe right now

```sh
sk tick                           # per-stage lines plus the terminal summary
sk tick --quiet                   # only the terminal line (what the scheduled agent uses)
sk tick -q                        # short alias
```

**The one scheduled job** ([#193](https://github.com/wrburgess/bryce/issues/193) /
[ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 3). It runs
every 15 minutes from [`ops/templates/com.sk.tick.plist`](../../ops/templates/com.sk.tick.plist) and
replaces the retired fixed agents `com.sk.refresh.plist` (03:30) and `com.sk.digest.plist` (05:00) —
because a lane's cadence lives in the database (`players lists configure`, #191) and a fixed clock time
cannot express a value the HC edits.

Each tick, in order:

1. **Refresh** — every live lane whose `refresh_interval_minutes` has elapsed since a sweep that
   *covered it* started, **less a tolerance of half a tick** (7m30s). If any are due, **one** sweep runs
   carrying the union of their ids (a Player on two due lanes is fetched once). Refresh is first so a due
   digest reports data this tick fetched.
2. **Digest** — during Offseason Sleep, at most one **unscoped** run to carry the weekly host
   heartbeat, plus one run for each scheduled lane that still owes an **earlier** day (recovery only —
   no regular offseason digest is mailed); otherwise one run per live lane whose `digest_hour` has been
   reached and whose slot for today holds no `sent` row.

```
tick refresh lanes=Watchlist,Prospects outcome=ok players=12 skipped=0 failed=0 inserted=44 updated=3
tick digest list=Watchlist kind=digest action=sent statLines=18 players=9
tick done refreshed=2 digests=1 ok=true
```

- **Due-selection is advisory; the claims are the gate.** Everything above is a cheap pre-read that
  keeps a quiet tick quiet. A digest still claims its `(digest, date, lane)` slot and a sweep still
  claims its run, so a tick overlapping a still-loaded old agent, a manual `sk digest`, or the server's
  MCP tool is **refused**, never duplicated. That is what makes the ops migration below safe to do by
  hand.
- **The hour test is `>=`, not `==`** — a laptop asleep at 05:00 wakes at 09:00 and still sends. Today's
  `sent` row is what stops it re-sending every tick afterwards; a **`failed`** slot therefore reads as
  due and is **retried on the next tick** rather than waiting for tomorrow.
- **Refresh due-ness carries a half-tick tolerance so the schedule cannot drift.** `StartInterval` is
  approximate — launchd fires late and restarts its countdown across sleep/wake — and each sweep is
  anchored on the *previous* sweep's real start, so without the tolerance every late tick would push the
  next sweep a full 15 minutes later, permanently. On the seeded 1440-minute / `digest_hour` 5 setup that
  drift reaches the digest hour in about a week and every digest after it banners `stale`. A lane is
  therefore swept **at most 7m30s early**, never twice inside one interval.
- **Offseason Sleep suspends today's digest, never recovery.** A lane that still owes an earlier day is
  caught up while asleep, one day per invocation — so a send that failed on the season's last day is not
  stranded until Opening Day. A lane whose lane was **deleted** while a delivery was in flight has that
  abandoned `sending` row settled `failed` by the tick once its 10-minute lease expires (nothing is
  mailed) — otherwise it would show on `/health` as in flight forever.
- **Failure is isolated per stage and per lane.** A sweep that throws still leaves every due digest
  attempted; a lane that throws still leaves the lanes after it attempted. Exit is **1** if anything
  errored or a send failed — *after* all due work was attempted — and **0** otherwise (a `partial`
  sweep is not a failure, matching `sk refresh`).
- **`--quiet` prints exactly one line** (`tick done …`) and suppresses the refresh live stream, the
  refresh notice lines, and digest warnings. A tick with nothing due prints that one line in **either**
  mode. At ~96 ticks a day into an unrotated `logs/tick.log`, that is the difference between a few
  kilobytes a day and a per-player stream — which is why the `--` in `npm run tick -- --quiet` is
  load-bearing and pinned by `scripts/check-operational-templates.ts`.

## `digest` — build and send a windowed Digest

```sh
sk digest                         # default 1d window
sk digest -w 7d                   # short alias
sk digest --window=14d            # equals form
sk digest --list Prospects        # scope to a named list
sk digest -l Prospects            # short alias for --list (#191)
sk digest --force                 # daily-slot test replay
```

Builds the Digest for a **Window** and sends it through the configured mailer. Writes no stat-line
state, so re-running a Window always sends the same content.

**Bare `sk digest` means the DEFAULT lane**, not every active Player
([#193](https://github.com/wrburgess/bryce/issues/193),
[ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md)) — the same rule
`sk refresh` and `sk players add` follow. On a migrated host this changes nothing: `drizzle/0012`
enrolled every active Player in the seeded default lane. A Player on **no** lane is now neither
refreshed nor digested — tracked as [#202](https://github.com/wrburgess/bryce/issues/202); `GET /health`
→ `lanes` is where you see it.

| Flag | Default | Accepted values |
|---|---|---|
| `--window <spec>` / `--window=<spec>` / `-w <spec>` | `1d` | date windows `1d`, `7d`, `14d`, `21d`, `28d`, `35d`, `60d`, `ytd`; per-player game-count windows `last10games`, `last30games` (#153) |
| `--list <name>` / `--list=<name>` / `-l <name>` | the **default lane** on a tag-free `1d` send; all active otherwise | any existing list name (#70) |
| `--tags <selector>` / `--tags=<selector>` | off (no cohort scope) | any valid tag selector (#140) |
| `--force` | off (boolean) | present or absent |

- Both `--window 7d` and `--window=7d` are accepted. An unsupported window (e.g. `30d`) **fails
  closed**: the command exits `1`, writes an `error: unsupported --window value; supported: …` line
  to stderr, and sends nothing.
- `--force` applies only to the daily `1d` slot: it overrides the already-sent-today guard (and, in
  Offseason Sleep, the weekly-heartbeat rule). When it overrides one of those, the send is a
  **write-free replay** (no delivery row is created or changed); but forcing when today's slot does
  not exist yet, or over a failed/expired slot, sends and **records a delivery row normally**. It
  never jumps an in-flight claim held by another run. The full semantics — and the three
  consequences worth knowing — are in
  [Running Bryce → Forcing a test send](../guides/running-bryce.md#forcing-a-test-send) and
  [ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md).
- The `1d` window is the scheduled daily artifact; any wider window (`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`) is an
  on-demand report that takes no slot and answers even during Offseason Sleep
  ([ADR 0035](../adr/0035-window-selected-digest.md)). During Sleep, an **unscoped** `1d` run becomes
  the weekly host heartbeat; a run that **named a lane** skips **today's**
  digest (`action=skipped reason=offseason-sleep`) instead, because the heartbeat is one liveness signal
  per host and not one per lane ([ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md),
  affirmed by [ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 4).
  Sleep does **not** suspend orphan recovery: a named lane that still owes an **earlier** day claims and
  mails that day first and *then* reports the skip for today, so a send that failed on the season's last
  day is not stranded until Opening Day ([ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md)).
- The **game-count** windows `last10games` / `last30games` report each Player over his own last N
  distinct regular-season games — a per-player ordered limit, so two Players in one report cover
  different date spans, and each row carries its real games count (`GP`) and first–last date (`Span`).
  They are **on-demand only** (no daily slot), like a cohort scope, and compose with `--list` / `--tags`
  ([#153](https://github.com/wrburgess/bryce/issues/153) / [ADR 0052](../adr/0052-cohort-game-count-windows.md)).

  ```sh
  sk digest -w last10games                             # all tracked, each over his last 10 games
  sk digest --tags level:aaa -w last30games            # AAA cohort, each over his last 30 games
  ```
- `--list NAME` (or the short `-l NAME`) scopes the send to a named lane's active members
  ([#70](https://github.com/wrburgess/bryce/issues/70) / [ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)).
  A tag-free **`1d`** named-lane send is the lane's **scheduled artifact**, not an on-demand report
  ([#193](https://github.com/wrburgess/bryce/issues/193) /
  [ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 1,
  superseding ADR 0046 decision 4): it **claims that lane's own once-per-date slot**, so a second one
  the same day is refused `already-sent-today` (use `--force` for a deliberate re-send), a failed
  attempt is retried, and yesterday's orphaned slot is recovered. Two **different** lanes may each send
  on the same date. It goes to the lane's `digest_to` when one is configured, otherwise to `DIGEST_TO`.
  Any wider window, or any `--tags` scope, stays on-demand and keeps the host recipients. An unknown
  list **fails closed** (exit `1`, `error: no list named "…"`, nothing sent), and a lane deleted between
  resolution and the claim is refused too (`action=skipped reason=lane-deleted`, nothing mailed — even
  under `--force`, which overrides bookkeeping and never lane liveness). All three spellings —
  `--list NAME`, `--list=NAME`, `-l NAME` — scope identically: the router rewrites an alias and an
  `=` form to one canonical spelling before the command reads it, so a short flag can never be
  silently dropped and send an unscoped digest ([#191](https://github.com/wrburgess/bryce/issues/191)).
- `--tags SELECTOR` scopes the send to a **cohort** — the Players matching every token
  ([#140](https://github.com/wrburgess/bryce/issues/140) / [ADR 0050](../adr/0050-tag-scoped-cohort-reports.md)).
  The grammar is the one in [Player Tags](../domain/tags.md#selector-grammar): comma-separated tokens
  are AND, a bare namespace matches any value in it.

  ```sh
  sk digest --tags level:dsl                          # the DSL guys
  sk digest --tags status:scouted -w 28d              # everyone scouted, past 28 days
  sk digest --tags level:aaa,status:rostered -w ytd   # AAA and on the roster, season to date
  sk digest --list "Top 30" --tags level:aaa          # in the list AND AAA (they intersect)
  ```

  Like a named-list send, a tag-scoped send is **on-demand only** — it takes no daily slot and
  records no delivery row, whatever its window. A cohort matching **no** Players is an empty report
  (exit `0`); a **malformed** selector **fails closed** (exit `1`, `error: malformed tag token '…'`,
  nothing sent), so a typo never masquerades as an honest empty cohort.

## `report player` — a read-only single-player card

```sh
sk report player --id 42 --windows last10,last30,ytd     # the console card
sk report player --name "José Test" --windows last10,ytd
sk report player --id 42 --format json                   # the machine contract
sk report player --id 42 --format html --out card.html   # a printable document
sk report player --id 42 --open                          # render HTML, open it
npm run report -- player --id 42
```

Use exactly one internal Bryce `--id` or canonical exact `--name`. `--windows`
is optional and defaults to `last10,last30,ytd`; its comma-separated values are
case-insensitive tokens. `last10` and `last30` count distinct regular-season
games, not stat-line rows; `ytd` uses the current Player sport's cached season
start through the last completed host date. The card carries level-split
batting/pitching aggregates and actual game/date-span provenance. It never sends
a Digest or writes database state. An unknown/ambiguous selector or invalid
window writes `error: …` to stderr and exits `1`.

### Formats and destinations (`#141` / [ADR 0055](../adr/0055-player-card-presentation-per-surface-defaults-no-pdf.md))

`--format` **defaults to `console`** here, not `json`: the audience at a terminal
is a human, who should receive a finished artifact rather than a data structure.
`--format json` remains the machine contract, unchanged. The `format` default
follows each surface's audience — CLI `console`, MCP `console`, REST `json` —
so a programmatic REST caller is untouched.

| Format | Output |
|--------|--------|
| `console` (default) | One monospace table per Card Window: a header line, then the batting and pitching lines. `BB%`/`K%` appear on `last30`/`ytd` only, exactly as in the Digest. |
| `html` | A standalone document with a `@media print` block (page break per Card Window, repeating table headers, grayscale-safe colors), so browser print → *Save as PDF* paginates correctly. There is no `--format pdf`. |
| `json` | The raw structured card — every counter and derived rate. |

| Invocation | Behavior |
|------------|----------|
| no `--format` | `console` |
| `--out PATH` | Valid with **every** format. Renders, writes the payload to `PATH`, prints nothing on stdout, exits `0`. |
| `--open` alone | Implies `--format html`; renders to a temp path, then launches it. |
| `--open --out PATH` | Writes `PATH` (not a temp path), then launches `PATH`. |
| `--open --format console\|json` | **Usage error, exit `1`** — a console or JSON rendering is not a browser document, and silently upgrading the format would hide the mistake. |

The write must **succeed before** the launcher runs: a failed write reports to
stderr, exits non-zero, and never opens a browser. A failed launch exits
non-zero and names the path, so the already-written file is still usable.

## `players:lists` — manage named player lists (`#70`)

```sh
sk players lists create --name Prospects
sk players lists rename --name Prospects --to "Top 30"
sk players lists add    --name "Top 30" --person-ids 691185,700001 --highlightly-player-ids 501
sk players lists remove --name "Top 30" --person-ids 700001
sk players lists show                       # every live list + member counts + which is default
sk players lists show   --name "Top 30"     # a list's active members
sk players lists set-default --name "Top 30"  # point the default lane here
sk players lists configure --name "Top 30" --digest-hour 5   # this lane's cadence (#191)
sk players lists delete --name "Top 30"     # soft-delete; the name frees for reuse
```

A thin presenter over the named-list service ([ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)):
a list is curated membership over the Watch List, distinct from tags (#30) and rosters (#69). A
scope selects a list's **active** members (`players.active` stays the master gate). Output is greppable
`key=value` lines; a failure writes an `error=…` line to stderr and exits `1`. Members are addressed
by `--person-ids` (MLB/MiLB, comma-separated) and/or `--highlightly-player-ids` (NCAA); `add` is idempotent and
`remove` no-ops on a non-member. An unknown list, or a reference to a Player not on the Watch List,
fails closed. (Distinct from `seed list`, which prints players.)

Exactly one live list is the **default lane** — what a command that names no list means
([ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)). The `0012` migration
seeds it as `Watchlist`, enrolling every active Player, and `show` marks it with `default=true`.
`set-default` moves the flag (clearing the previous holder in the same transaction; re-pointing at the
current default writes nothing). **`delete` refuses the default list** — point the default elsewhere
first, or every unscoped command would start failing. If the default is ever lost (restoring a pre-v5
Player List Backup is the usual way), `sk digest` refuses with an `error:` line naming `set-default`
rather than mailing every Player.

### `players lists configure` — a lane's cadence and recipients (`#191`)

```sh
sk players lists configure --name "Top 30" --digest-hour 5          # digest at 05:00 host time
sk players lists configure --name "Top 30" --digest-hour 0          # midnight IS a valid hour
sk players lists configure --name "Top 30" --refresh-every 1440     # refresh once a day
sk players lists configure --name "Top 30" --digest-to hc@example.com
sk players lists configure --name "Top 30" --digest-hour none       # clear it back to the default
```

Sets the three **Lane** columns [ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)
declared in phase 1. They remain **inert** — nothing reads them until
[#192](https://github.com/wrburgess/bryce/issues/192) and
[#193](https://github.com/wrburgess/bryce/issues/193) — so configuring a lane today changes no refresh
or digest behavior; it records the intent those phases will act on.

| Flag | Sets | Accepted values |
|---|---|---|
| `--refresh-every MINUTES` | `refresh_interval_minutes` | a **canonical** positive integer, or the reserved `none` |
| `--digest-hour HOUR` | `digest_hour` | a **canonical** integer `0`–`23` inclusive, or the reserved `none` |
| `--digest-to ADDRESS` | `digest_to` | any non-blank recipient value except the reserved `-`, or the reserved `none` |

- **Only the flags you pass are written.** Setting `--digest-hour` leaves `refresh_every` and
  `digest_to` exactly as they were; configuring one column never silently clears another.
- **`none` is a RESERVED word** meaning *clear this column to NULL*. It therefore cannot be used as a
  literal `--digest-to` address.
- **`-` is RESERVED too**, because it is how an unset column *renders*. Accepting it as a recipient
  would make a configured lane print identically to a cleared one, so `--digest-to -` is refused at the
  input rather than encoded on the way out. A recipient that merely *contains* a hyphen
  (`a-b@example.com`) is fine.
- **`--digest-hour 0` is valid** — it means a midnight digest, and the database `CHECK` allows it.
- **Read the values back with `players lists show`**, which appends `refreshEvery=` · `digestHour=` ·
  `digestTo=` to each list line, rendering an unset column as `-` — the same null spelling `configure`
  prints. The four leading keys keep their order and spelling, so an existing script reading that line
  is unaffected.
  It is the one place the usual positive-integer rule would be wrong.
- Values must be **canonical**: `07`, `1e2`, `+5`, and `3.0` are usage errors, not silently coerced
  numbers, so a typo can never become a schedule. Out-of-range values (`--digest-hour 24`,
  `--refresh-every 0`) are refused at the router **and** again in the service, which is what a REST or
  MCP caller will inherit.
- At least one of the three flags is required; `configure --name X` alone fails loudly rather than
  succeeding as a no-op. An unknown list writes `error=no list named "…"` and exits `1`.

Output is one greppable line, with `-` for an unset column:

```
list configured id=3 name=Top 30 refreshEvery=1440 digestHour=5 digestTo=hc@example.com
```

## `players add` — add one player straight onto a lane (`#191`)

```sh
sk players add --name "Maximo Acosta"                        # onto the DEFAULT lane
sk players add --name "Maximo Acosta" --list Prospects       # onto a named lane
sk players add --name "Maximo Acosta" -l Prospects           # short alias for --list
sk players add --name "smith" --pick 2                       # choose from a numbered list (1-based)
sk players add --name "Roch Cholowsky" --ncaa --list Prospects
```

Collapses the two-step `sk seed add` + `sk players lists add` dance into one command: resolve a
player by name, add him to the Watch List, and attach him to a **Lane**. The identity rules are
exactly `seed add`'s — one shared implementation, so the two commands cannot disambiguate a name
differently.

| Flag | Required | Notes |
|---|---|---|
| `--name NAME` | **yes** | The name to search. MLB/MiLB people-search by default. |
| `--list NAME` / `-l NAME` | no | Target lane. **Omitted → the default lane**; unknown → fails closed. |
| `--pick I` | no | **One-based** choice among several MLB matches. Requires `--name`. |
| `--ncaa` | no | Search NCAA players through Highlightly instead. **Cannot be combined with `--pick`.** |

- **The lane is resolved FIRST** — before any upstream call and before any write. A typo'd `--list`
  costs no API call and can never leave a player created but homeless. With `--list` omitted and no
  default set, it refuses with the same `no default list is set` line `digest` gives.
- **List names are case-sensitive** ([ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)):
  `--list prospects` does not find a list named `Prospects`, it fails closed.
- **`--ncaa` has no `--pick` escape.** Several Highlightly hits print each candidate's explicit
  identity and exit `1`, telling you to re-run with it — the same rule `seed add --ncaa` follows.
  Passing `--ncaa --pick` is a usage error, refused at preflight, rather than a second ambiguity rule.
- **Re-adding is idempotent**: an existing player and an existing membership both report
  `member=existing`, exit `0`, and run **no** refresh.
- Adding a **new** player runs his **first Refresh** immediately (or reports it skipped in Offseason
  Sleep), exactly like `seed add`.

Output is one greppable line, plus the first-refresh line for a brand-new player only:

```
added player id=7 personId=691185 name=Maximo Acosta list=Prospects member=added
refresh done inserted=44 updated=0
```

NCAA rows carry `highlightlyPlayerId=…` in place of `personId=…`.

> **This `refresh done` is NOT the sweep's `refresh done` — grep for the right one.** This line is the
> **first-refresh** record for one brand-new player (`sk seed add` prints the same one): only
> `inserted=` and `updated=`, no `list=` and no `status=`. The `refresh` command's terminal line is
> `refresh done list=<lane> status=… players=… skipped=… failed=… inserted=… updated=…` (see
> [`refresh`](#refresh--re-ingest-a-lanes-current-season) above). The divergence predates #192 and is
> **deliberately left alone** — reconciling two grammars that report genuinely different events would
> churn unrelated tests for no correctness gain. Match on `status=` for the sweep, or anchor on
> `^refresh done inserted=` for this one.

**The two-write caveat, stated rather than hidden.** Creating the player and attaching him to the
lane are two writes and **cannot** be one transaction — the create does network I/O and runs the
first Refresh, and a SQLite write lock is never held across the network. So if the attach fails, the
command does not pretend nothing happened. It reports the residual state and the exact repair, and
exits non-zero:

```
error: player id=7 created but not attached to list=Prospects - re-run: sk players lists add --name Prospects --person-ids 691185
```

A lane soft-deleted between the two writes is refused the same way: the attach re-reads the lane
under its write lock, so membership is never written onto a dead lane.

## `connector smoke` — prove a connector can reach `/mcp`

```sh
API_TOKEN=... MCP_URL=https://your-host.example.com/mcp sk connector smoke
sk connector smoke --mutate       # STAGING ONLY — exercises the write path
```

Drives the **real** MCP SDK client over Streamable HTTP against a running Bryce `/mcp`
([#37](https://github.com/wrburgess/bryce/issues/37)): it initializes, discovers the full tool set,
reads health and a digest preview, and confirms an unauthenticated request still fails closed.
Configuration is environment-only and **no secret is ever echoed**. The opt-in `--mutate` additionally
exercises the write path — against a designated, already-inactive staging sentinel only, never a live
Player. The full procedure, including what to check when it fails, is in
[Running Bryce → Verify the connector path locally first](../guides/running-bryce.md#verify-the-connector-path-locally-first).

## `seed` — manage the Watch List

```sh
sk seed add --person-id 691185
sk seed add --highlightly-player-id 501 --canonical-name "Gavin Kelly" --team-id 10
sk seed promote --highlightly-player-id 501 --person-id 691185
sk seed add --ncaa --name "Roch Cholowsky"
sk seed add --search "acosta"            # prints a numbered list if several match
sk seed add --search "smith" --pick 2    # choose from that list (1-based)
sk seed deactivate --person-id 691185
sk seed deactivate --highlightly-player-id 501
sk seed list
sk seed list --tags status:rostered,level:aaa   # tag-filtered roster (comma = AND)
sk seed tag add --person-id 691185 --tag status:rostered
sk seed tag remove --person-id 691185 --tag status:rostered
sk seed tag list --person-id 691185
sk seed tag rebuild                              # re-derive every player's derived tags
```

One required subcommand (`add` | `promote` | `deactivate` | `list` | `tag`), then flags:

| Subcommand | Flags | Notes |
|---|---|---|
| `add` | `--person-id N` | Add an MLB/MiLB Player by MLB Stats API personId. |
| `add` | `--highlightly-player-id N --canonical-name NAME --team-id N` | Add an NCAA Player by explicit Highlightly identity. |
| `promote` | `--highlightly-player-id N --person-id N` | Atomically convert a Highlightly NCAA Player to MLB/MiLB while preserving its local history, lists, and tags. |
| `add` | `--ncaa --name "NAME"` | Search Highlightly for NCAA players by name and add the sole match; ambiguous results print the explicit identity needed to retry. |
| `add` | `--search "NAME" [--pick I]` | Name search; `--pick I` is **one-based** and **search-only**. With one match and no `--pick`, it adds that Player; with several and no `--pick`, it prints a numbered list and exits `1`. |
| `deactivate` | `--person-id N` \| `--highlightly-player-id N` | Remove a Player from the Watch List; his row and full history are kept. |
| `list` | `[--tags EXPR]` | Print every Player row (active and inactive) plus a `total=` line. `--tags` is a comma-separated **AND** selector (a bare namespace like `prospect` matches any value); only matching rows print. |
| `tag add` | `--person-id N` \| `--highlightly-player-id N`, `--tag ns:value` | Add a **manual** tag (`status:rostered` \| `status:scouted`). A write to a derived namespace (`level`/`pos`/`prospect`) or an unknown value exits `1`. |
| `tag remove` | `--person-id N` \| `--highlightly-player-id N`, `--tag ns:value` | Remove a manual tag (no-op if absent). |
| `tag list` | `--person-id N` \| `--highlightly-player-id N` | Print every tag (derived + manual) for the Player plus a `total=` line. |
| `tag rebuild` | — | Re-derive the `level`/`pos`/`prospect` tags for **every** Player (the one-shot backfill). |

See the [Player tag model reference](../domain/tags.md) for the full namespace vocabulary, the derived
values, and the selector grammar shared by `list --tags` and the REST/MCP surfaces.

Adding a **new** Player runs his **first Refresh** immediately — his whole current season is
backfilled — unless the pipeline is in Offseason Sleep, in which case the add succeeds and the
Refresh is skipped. Re-adding a Player already on the Watch List is a no-op update with no Refresh;
use `refresh` to re-pull his season.

NCAA adds use an explicit Highlightly player ID plus canonical name and team ID; no NCAA HTML probe
or sequence-based command is available.

## `db:migrate` — apply pending migrations

```sh
sk db migrate
```

Opens (creating if needed) the SQLite database, which **applies any pending migrations as a side
effect**, then reports `migrations applied path=…`. Takes **no arguments**. Every other entry point
migrates on startup too, so this is only for applying migrations without running a job. It now also
takes an automatic **Snapshot before any pending migration applies** (see `db:backup` below and
[ADR 0042](../adr/0042-snapshot-and-player-backup-complement-litestream.md)).

## `db:backup` — take a Snapshot and prune

```sh
sk db backup
```

Takes a **Snapshot** — a consistent, whole-database point-in-time copy — into `BACKUP_DIR` (default
`backups/`), then prunes to the newest `BACKUP_KEEP_LAST` (default `10`). Takes **no arguments**;
malformed invocation fails loud. Output is two `key=value` lines:

```
snapshot created name=bryce-20260722T030000Z-000.db dir=backups
retention keepLast=10 kept=10 deleted=1
```

A **Snapshot** is the local, testable rollback point — complementary to, not a replacement for, the
off-box Litestream **Replica** ([ADR 0042](../adr/0042-snapshot-and-player-backup-complement-litestream.md)).
Snapshot files are owner-only (`0600`). Schedule it nightly with launchd — see
[Running Bryce → Backup and restore](../guides/running-bryce.md#backup-and-restore).

## `db:restore` — swap a Snapshot into place

```sh
sk db restore --from backups/bryce-20260722T030000Z-000.db
```

**Restore** is the destructive recovery op: it validates the candidate Snapshot (integrity check,
foreign-key check, expected tables, and migration-history compatibility), takes a **safety Snapshot**
of the current database, then atomically swaps the validated file into place, clearing stale WAL
sidecars.

| Flag | Required | Notes |
|---|---|---|
| `--from FILE` | **yes** | The Snapshot file to restore. Refused if it aliases the live database (path, symlink, or hardlink). |

**Stop the app first.** Restore **refuses** (`error: database is in use by pid …`) while any Bryce
process (server, launchd jobs) is running, via a cooperative interlock. It never opens or migrates the
live database itself — see the [Restore runbook](../guides/running-bryce.md#restore-runbook) for the
full stop-everything-then-restore procedure, including the mandatory **fix/revert the offending
migration before restart** step.

## `players:backup` — write a Player List Backup

```sh
sk players backup --out backups/players.json
```

Writes a **Player List Backup** — a portable, versioned JSON serialization of *every* Player row
(active and inactive) — the recovery counterpart to the one thing no Refresh can rebuild: the human's
roster choices and notes. Network-free. The file is written crash-safely (temp + fsync + rename),
owner-only (`0600`). Refuses to overwrite the live database or a Snapshot filename.

| Flag | Required | Notes |
|---|---|---|
| `--out FILE` | **yes** | Destination path for the JSON envelope. |

A **Player List Backup** is *not* an **Export** (a spreadsheet artifact for consumption) — it is a
restore point ([Domain glossary](../domain/CONTEXT.md)).

## `players:restore` — re-import a Player List Backup

```sh
sk players restore --in backups/players.json
```

Re-imports a Player List Backup **network-free and all-or-nothing**, upserting on each Player's natural
identity (MLB `external_id`, legacy NCAA `stats_player_seq`, or Highlightly player ID) so existing rows keep their `id` and their
**Stat Line** history stays intact. Reports `player-list restored inserted=N updated=M total=T`. An
invalid payload or an identity conflict fails the whole import with a non-zero exit.

**The backup's default Lane wins**, so a restore can move which Lane is the default
([ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)). It never does so
quietly: the restore prints `warning: default list changed from "X" to "Y"` with the
`players lists set-default` command that changes it back, or — for a pre-v5 payload, which carries no
Lane configuration and can only leave the database default-less — `warning: no default list after
restore`, since every unscoped command fails until one is set.

| Flag | Required | Notes |
|---|---|---|
| `--in FILE` | **yes** | The Player List Backup JSON to import. |

## `players:batch-add` — stage many Players in one call

```sh
sk players batch-add --person-ids 691185,700001
sk players batch-add --names "Bobby Witt Jr." --names "Gunnar Henderson"
sk players batch-add --file roster.txt
```

Stages up to **25** Players onto the Watch List in one call ([#68](https://github.com/wrburgess/bryce/issues/68),
[ADR 0045](../adr/0045-batch-add-stages-by-identity-best-effort-defers-backfill.md)). Each Player's
**identity** is resolved and his row is staged **now**, but — unlike `seed add` — **no first Refresh
runs inline**: his Stat Lines appear at the next `sk refresh`. Prints one greppable
`outcome status=... ` line per entry, then a `summary added=… updated=… unresolved=… failed=… total=…`
line. All flags and the file merge into one batch.

| Flag | Notes |
|---|---|
| `--person-ids 1,2,3` | Comma-separated MLB personIds. Repeatable; a non-integer token is a usage error. |
| `--highlightly-player-id ID --canonical-name NAME --team-id ID` | One explicit Highlightly NCAA identity. |
| `--names NAME` | One MLB/MiLB name to people-search (must resolve to exactly one Player). Repeat the flag per name. |
| `--file PATH` | A paste-friendly file of tagged lines (below), combinable with the flags. |

**File grammar** — each line is trimmed; blank lines and `#` comments are ignored:

| Line | Becomes |
|---|---|
| `highlightly:<playerId>\|<canonicalName>\|<teamId>` | An explicit Highlightly NCAA identity (all three fields are required). |
| `name:<x>` | An explicit name — the escape hatch for a name that is all digits. |
| `<digits>` | An MLB personId. |
| anything else | A name. |

**Exit codes.** A completed batch (valid shape) exits **0** *even when some entries are `unresolved`
or `failed`* — those are per-entry outcomes, not a run failure. It exits **1** on a **usage error**:
an unknown flag, a non-integer id token, an unreadable file, a file over the **64 KB** ceiling, or a
**shape rejection** — an empty batch, over the 25 cap, or an in-batch duplicate (a `personId` N and an
`highlightlyPlayerId` N are *different* Players, never a duplicate). A shape rejection writes nothing.

## `server` — start the HTTP server

```sh
sk server
```

Starts the long-lived HTTP server that hosts `GET /health` (public), the [REST API](../api/README.md)
under `/api`, and the [MCP server](../mcp/README.md) at `/mcp` — both behind the bearer token
([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)). It **fails closed**: with no `API_TOKEN`
configured it refuses to start and serves nothing (including `/health`). The port is `SERVER_PORT`
(default `3000`). Takes no arguments; all configuration is environment-only (see
[Getting Started](../guides/getting-started.md) and [Running Bryce](../guides/running-bryce.md)).

## See also

- [REST API Reference](../api/README.md) — the same operations over HTTP.
- [MCP Reference](../mcp/README.md) — the same operations as Claude-facing tools.
- [Domain glossary](../domain/CONTEXT.md) — Player, Refresh, Digest, Window, Offseason Sleep.
