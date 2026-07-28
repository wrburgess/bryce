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

## `refresh` — re-ingest the current season

```sh
sk refresh                        # live per-player progress (the interactive default)
sk refresh --quiet                # only the terminal summary (what scheduled runs use)
sk refresh -q                     # short alias
```

Re-ingests the **full current season** game log for every active Player and upserts it idempotently
(no date windows — a Refresh makes storage complete). Running it twice changes nothing the second
time. During **Offseason Sleep** it exits without any API calls
(`refresh skipped reason=offseason-sleep`).

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
refresh done status=ok players=11 skipped=1 failed=0 inserted=44 updated=3
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
- **`--quiet`** reproduces exactly the pre-#146 output: the single `refresh done …` (or
  `refresh skipped reason=…`) line, plus the stderr failure summary and the three legacy notice
  lines, which are unconditional. Scheduled runs use it — see `ops/templates/com.sk.refresh.plist`,
  where the `--` in `npm run refresh -- --quiet` is load-bearing.

Console counts and the persisted `/health` / MCP `status` counts agree **by construction**: a
player's `done` line is emitted only after that player's progress write has committed, so the
terminal can never show more players settled than the database knows about.

**Exit codes are unchanged** by the live output: `failed` (a blocked run that refreshed nobody) exits
1; `ok`, `partial`, and any Skipped Sweep exit 0.

## `digest` — build and send a windowed Digest

```sh
sk digest                         # default 1d window
sk digest -w 7d                   # short alias
sk digest --window=14d            # equals form
sk digest --force                 # daily-slot test replay
```

Builds the Digest for a **Window** and sends it through the configured mailer. Writes no stat-line
state, so re-running a Window always sends the same content.

| Flag | Default | Accepted values |
|---|---|---|
| `--window <spec>` / `--window=<spec>` | `1d` | date windows `1d`, `7d`, `14d`, `21d`, `28d`, `35d`, `60d`, `ytd`; per-player game-count windows `last10games`, `last30games` (#153) |
| `--list <name>` / `--list=<name>` | off (all active) | any existing list name (#70) |
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
  ([ADR 0035](../adr/0035-window-selected-digest.md)).
- The **game-count** windows `last10games` / `last30games` report each Player over his own last N
  distinct regular-season games — a per-player ordered limit, so two Players in one report cover
  different date spans, and each row carries its real games count (`GP`) and first–last date (`Span`).
  They are **on-demand only** (no daily slot), like a cohort scope, and compose with `--list` / `--tags`
  ([#153](https://github.com/wrburgess/bryce/issues/153) / [ADR 0052](../adr/0052-cohort-game-count-windows.md)).

  ```sh
  sk digest -w last10games                             # all tracked, each over his last 10 games
  sk digest --tags level:aaa -w last30games            # AAA cohort, each over his last 30 games
  ```
- `--list NAME` scopes the send to a named list's active members
  ([#70](https://github.com/wrburgess/bryce/issues/70) / [ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)).
  A named-list send is **on-demand only** (it takes no daily slot); an unknown list **fails closed**
  (exit `1`, `error: no list named "…"`, nothing sent).
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
