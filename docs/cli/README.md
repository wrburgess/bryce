# CLI Reference

The command-line entry points to Bryce's pipeline, run as npm scripts on the host (a Mac with Node
22). Each is a thin presenter over the same service layer the [REST API](../api/README.md) and
[MCP tools](../mcp/README.md) use. Each job's **summary** is a deterministic `key=value` line and
every command exits non-zero on failure — but the output is not purely ASCII `key=value`: `digest`
with `MAILER_PROVIDER=console` prints the full rendered email above its summary, and `seed`/`list`
echo upstream player names that may contain non-ASCII characters (e.g. `José`). Domain terms below —
**Player**, **Refresh**, **Digest**, **Window**, **Offseason Sleep** — are defined in
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md).

There is no `--help` handler: this page is the reference. Arguments after `npm run <script>` must
follow a `--` separator so npm forwards them to the script rather than consuming them itself.

## `refresh` — re-ingest the current season

```sh
npm run refresh
```

Re-ingests the **full current season** game log for every active Player and upserts it idempotently
(no date windows — a Refresh makes storage complete). Running it twice changes nothing the second
time. Takes **no arguments**. During **Offseason Sleep** it exits without any API calls
(`refresh skipped reason=offseason-sleep`).

## `digest` — build and send a windowed Digest

```sh
npm run digest                       # default 1d window
npm run digest -- --window 7d        # space form
npm run digest -- --window=14d       # equals form
npm run digest -- --force            # daily-slot test replay
```

Builds the Digest for a **Window** and sends it through the configured mailer. Writes no stat-line
state, so re-running a Window always sends the same content.

| Flag | Default | Accepted values |
|---|---|---|
| `--window <spec>` / `--window=<spec>` | `1d` | `1d`, `7d`, `14d`, `21d`, `28d`, `35d`, `60d`, `ytd` |
| `--list <name>` / `--list=<name>` | off (all active) | any existing list name (#70) |
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
- `--list NAME` scopes the send to a named list's active members
  ([#70](https://github.com/wrburgess/bryce/issues/70) / [ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)).
  A named-list send is **on-demand only** (it takes no daily slot); an unknown list **fails closed**
  (exit `1`, `error: no list named "…"`, nothing sent).

## `players:lists` — manage named player lists (`#70`)

```sh
npm run players:lists -- create --name Prospects
npm run players:lists -- rename --name Prospects --to "Top 30"
npm run players:lists -- add    --name "Top 30" --person-ids 691185,700001 --ncaa-seqs 2649785
npm run players:lists -- remove --name "Top 30" --person-ids 700001
npm run players:lists -- show                       # every live list + member counts
npm run players:lists -- show   --name "Top 30"     # a list's active members
npm run players:lists -- delete --name "Top 30"     # soft-delete; the name frees for reuse
```

A thin presenter over the named-list service ([ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)):
a list is curated membership over the Watch List, distinct from tags (#30) and rosters (#69). A
scope selects a list's **active** members (`players.active` stays the master gate). Output is greppable
`key=value` lines; a failure writes an `error=…` line to stderr and exits `1`. Members are addressed
by `--person-ids` (MLB/MiLB, comma-separated) and/or `--ncaa-seqs` (NCAA); `add` is idempotent and
`remove` no-ops on a non-member. An unknown list, or a reference to a Player not on the Watch List,
fails closed. (Distinct from `seed list`, which prints players.)

## `seed` — manage the Watch List

```sh
npm run seed -- add --person-id 691185
npm run seed -- add --ncaa-seq 2649785
npm run seed -- add --search "acosta"            # prints a numbered list if several match
npm run seed -- add --search "smith" --pick 2    # choose from that list (1-based)
npm run seed -- deactivate --person-id 691185
npm run seed -- deactivate --ncaa-seq 2649785
npm run seed -- list
```

One required subcommand (`add` | `deactivate` | `list`), then flags:

| Subcommand | Flags | Notes |
|---|---|---|
| `add` | `--person-id N` | Add an MLB/MiLB Player by MLB Stats API personId. |
| `add` | `--ncaa-seq N` | Add an NCAA Player by stats.ncaa.org `stats_player_seq`. |
| `add` | `--search "NAME" [--pick I]` | Name search; `--pick I` is **one-based** and **search-only**. With one match and no `--pick`, it adds that Player; with several and no `--pick`, it prints a numbered list and exits `1`. |
| `deactivate` | `--person-id N` \| `--ncaa-seq N` | Remove a Player from the Watch List; his row and full history are kept. |
| `list` | — | Print every Player row (active and inactive) plus a `total=` line. |

Adding a **new** Player runs his **first Refresh** immediately — his whole current season is
backfilled — unless the pipeline is in Offseason Sleep, in which case the add succeeds and the
Refresh is skipped. Re-adding a Player already on the Watch List is a no-op update with no Refresh;
use `refresh` to re-pull his season.

## `ncaa:probe` — validate the NCAA scrape on this host

```sh
npm run ncaa:probe -- --seq 2649785 --season 2025 --type batting
```

Fetches **one** live stats.ncaa.org game-log page and reports the HTTP status plus what the parser
extracted (name, school, row count). Use it to confirm the scrape adapter works from the host before
relying on it ([ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)); it exits
non-zero on any fetch or parse failure.

| Flag | Required | Default |
|---|---|---|
| `--seq N` | **yes** (`stats_player_seq`) | — |
| `--season YYYY` | no | current calendar year |
| `--type batting\|pitching\|fielding` | no | `batting` |

## `db:migrate` — apply pending migrations

```sh
npm run db:migrate
```

Opens (creating if needed) the SQLite database, which **applies any pending migrations as a side
effect**, then reports `migrations applied path=…`. Takes **no arguments**. Every other entry point
migrates on startup too, so this is only for applying migrations without running a job. It now also
takes an automatic **Snapshot before any pending migration applies** (see `db:backup` below and
[ADR 0042](../adr/0042-snapshot-and-player-backup-complement-litestream.md)).

## `db:backup` — take a Snapshot and prune

```sh
npm run db:backup
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
npm run db:restore -- --from backups/bryce-20260722T030000Z-000.db
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
npm run players:backup -- --out backups/players.json
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
npm run players:restore -- --in backups/players.json
```

Re-imports a Player List Backup **network-free and all-or-nothing**, upserting on each Player's natural
identity (MLB `external_id` or NCAA `stats_player_seq`) so existing rows keep their `id` and their
**Stat Line** history stays intact. Reports `player-list restored inserted=N updated=M total=T`. An
invalid payload or a split-identity conflict fails the whole import with a non-zero exit.

| Flag | Required | Notes |
|---|---|---|
| `--in FILE` | **yes** | The Player List Backup JSON to import. |

## `players:batch-add` — stage many Players in one call

```sh
npm run players:batch-add -- --person-ids 691185,700001 --ncaa-seqs 2649785
npm run players:batch-add -- --names "Bobby Witt Jr." --names "Gunnar Henderson"
npm run players:batch-add -- --file roster.txt
```

Stages up to **25** Players onto the Watch List in one call ([#68](https://github.com/wrburgess/bryce/issues/68),
[ADR 0045](../adr/0045-batch-add-stages-by-identity-best-effort-defers-backfill.md)). Each Player's
**identity** is resolved and his row is staged **now**, but — unlike `seed add` — **no first Refresh
runs inline**: his Stat Lines appear at the next `npm run refresh`. Prints one greppable
`outcome status=... ` line per entry, then a `summary added=… updated=… unresolved=… failed=… total=…`
line. All flags and the file merge into one batch.

| Flag | Notes |
|---|---|
| `--person-ids 1,2,3` | Comma-separated MLB personIds. Repeatable; a non-integer token is a usage error. |
| `--ncaa-seqs 10,20` | Comma-separated NCAA `stats_player_seq`. Repeatable; a non-integer token is a usage error. |
| `--names NAME` | One MLB/MiLB name to people-search (must resolve to exactly one Player). Repeat the flag per name. |
| `--file PATH` | A paste-friendly file of tagged lines (below), combinable with the flags. |

**File grammar** — each line is trimmed; blank lines and `#` comments are ignored:

| Line | Becomes |
|---|---|
| `ncaa:<n>` | An NCAA `stats_player_seq` (a non-numeric `ncaa:` value is a usage error). |
| `name:<x>` | An explicit name — the escape hatch for a name that is all digits. |
| `<digits>` | An MLB personId. |
| anything else | A name. |

**Exit codes.** A completed batch (valid shape) exits **0** *even when some entries are `unresolved`
or `failed`* — those are per-entry outcomes, not a run failure. It exits **1** on a **usage error**:
an unknown flag, a non-integer id token, an unreadable file, a file over the **64 KB** ceiling, or a
**shape rejection** — an empty batch, over the 25 cap, or an in-batch duplicate (a `personId` N and an
`ncaaPlayerSeq` N are *different* Players, never a duplicate). A shape rejection writes nothing.

## `server` — start the HTTP server

```sh
npm run server
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
