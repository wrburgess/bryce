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
| `--window <spec>` / `--window=<spec>` | `1d` | `1d`, `7d`, `14d`, `21d`, `ytd` |
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
- The `1d` window is the scheduled daily artifact; any wider window (`7d`/`14d`/`21d`/`ytd`) is an
  on-demand report that takes no slot and answers even during Offseason Sleep
  ([ADR 0035](../adr/0035-window-selected-digest.md)).

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
migrates on startup too, so this is only for applying migrations without running a job.

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
