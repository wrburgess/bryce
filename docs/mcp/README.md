# MCP Reference

The MCP server is Bryce's **primary interface** ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)):
eleven tools over the same service layer and Zod schemas the [REST API](../api/README.md) and
[CLI](../cli/README.md) use, so a Claude client (web, mobile, or CLI) is the front end and there is
no web UI. It is mounted at `/mcp` over Streamable HTTP, behind the bearer token. Domain terms —
**Player**, **Refresh**, **Digest**, **Window**, **Offseason Sleep** — are defined in
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md).

## Authentication and the result contract

`/mcp` sits behind the same bearer middleware as `/api`:

```
Authorization: Bearer $API_TOKEN
```

The server **fails closed**: with no `API_TOKEN` configured the app refuses to construct and nothing
is served; with a token set, a missing or wrong one gets a constant **401** (`{ "error":
"unauthorized" }`) and the token is never echoed or logged.

Every tool returns its payload as JSON **twice** — once as `structuredContent` and once as a text
part carrying the same JSON — so a client that reads only text still gets the full result. A tool
that hits a known error instead returns an error result:

```json
{ "content": [{ "type": "text", "text": "error: <message>" }], "isError": true }
```

`isError: true` with an `error: …` text part (and no `structuredContent`) is how invalid input
(e.g. `invalid input: window …`), an unknown Player, a read-only-query violation, and an MLB/NCAA
upstream failure all surface. An unexpected (non-domain) error is not swallowed — it propagates.

## Tools

### `watchlist_list`

List Watch List players.

- **Inputs:** `active` — `"true"` (default, active only), `"false"` (deactivated), or `"all"`.
- **Success:** `{ "players": [...] }`.
- **Side effects:** none (read-only).

### `watchlist_add`

Add an MLB/MiLB Player by MLB Stats API personId.

- **Inputs:** `personId` — the MLB Stats API personId.
- **Success:** `{ "action": "added" | "updated", "player": {...}, "refresh": {...} | null }`.
- **Side effects:** a **newly added** Player is inserted and his **first Refresh** runs immediately —
  writing his current-season Stat Lines — unless the pipeline is in Offseason Sleep, when the Refresh
  is skipped. Re-adding a Player already on the Watch List returns `action: "updated"` with
  `refresh: null` and runs **no** Refresh; use `run_refresh` to re-pull his season.

### `watchlist_add_ncaa`

Add an NCAA Player by stats.ncaa.org `stats_player_seq`.

- **Inputs:** `ncaaPlayerSeq` — the `stats_player_seq`.
- **Success:** `{ "action": "added" | "updated", "player": {...}, "refresh": {...} }`.
- **Side effects:** for a **newly added** Player, resolves his name and school from his game-log page,
  then the same first Refresh as `watchlist_add` (skipped during Offseason Sleep); re-adding a Player
  already on the Watch List is a no-op update (`refresh: null`) with no Refresh.

### `watchlist_deactivate`

Deactivate a Player, keeping his row and full Stat Line history.

- **Inputs:** exactly one of `personId` (MLB/MiLB) or `ncaaPlayerSeq` (NCAA). Providing both or
  neither is an input error.
- **Success:** `{ "player": {...} }` with `active: false`.
- **Side effects:** flips the Watch List `active` flag; no history is removed.

### `player_search`

Search MLB/MiLB players by name, each hit resolved to a current team and level.

- **Inputs:** `q` — a name or partial name (non-blank).
- **Success:** `{ "results": [{ personId, fullName, position, level, milbLevel, teamName }, ...] }`.
- **Side effects:** none (calls the MLB Stats API people search).

### `stat_lines`

Query stored per-game Stat Lines, newest first.

- **Inputs:** `playerId` (internal Bryce `players.id`, not the personId), `level` (`mlb`/`milb`/`ncaa`),
  `from`/`to` (inclusive `YYYY-MM-DD`; `from > to` is rejected), `limit` (`1`–`200`, default `50`) —
  all optional.
- **Success:** `{ "statLines": [...] }`.
- **Side effects:** none.

### `digest_preview`

Preview the Digest for a Window as the Batters and Pitchers tables the email would carry.

- **Inputs:** `window` (`1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, default `1d`; an unsupported value is rejected)
  and `force` — **accepted but ignored here**, because a preview never claims or sends.
- **Success:** `{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.
- **Side effects:** none — sends nothing, claims nothing, writes nothing; re-running a Window returns
  the same content.

### `send_digest`

Run the Digest job now for a Window.

- **Inputs:** `window` (as above; an unsupported value is rejected and nothing is sent) and `force`
  (default `false`). `force` applies only to the daily `1d` slot: it overrides the already-sent-today
  guard (and, in Offseason Sleep, the weekly-heartbeat rule). Overriding one of those makes the send a
  **write-free replay**; but forcing when today's slot does not exist yet, or over a failed/expired
  slot, sends and **records a delivery row normally**. It never overrides an in-flight claim held by
  another run.
- **Success:** the run result, e.g. `{ kind, action, statLineCount, playerCount, window, reason }`
  where `action` is `sent` / `skipped` / `failed`.
- **Side effects:** may send mail and record a delivery row for the daily slot; the report writes no
  Stat Line state, so a Window is always safe to repeat ([ADR 0035](../adr/0035-window-selected-digest.md),
  [ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md)).

### `run_refresh`

Re-ingest the current season now.

- **Inputs:** `personId` (MLB/MiLB) or `ncaaPlayerSeq` (NCAA) to refresh one Player; omit both to
  refresh **every** active Player.
- **Success:** the refresh summary, e.g. `{ skipped, inserted, updated }` for one Player or
  `{ skipped, playersRefreshed, statLinesInserted, statLinesUpdated }` for all.
- **Side effects:** upserts Stat Lines. No-op during Offseason Sleep (`skipped: true`).

### `sql_query`

Run a single read-only SQL query for ad-hoc analysis.

- **Inputs:** `sql` — one `SELECT`/`WITH`/`EXPLAIN` statement (writes are rejected and the connection
  itself is read-only); `params` — positional bind values for `?` placeholders (up to 50 strings,
  numbers, or nulls). Tables: `players`, `stat_lines`, `digest_deliveries`, `season_calendar`.
- **Success:** `{ columns, rows, rowCount, truncated }`; rows are capped at 200 (`truncated: true`
  when the cap is hit).
- **Side effects:** none — the connection cannot write.

### `status`

Health snapshot, the same shape as `GET /health`.

- **Inputs:** none.
- **Success:** `{ ok, players, statLines, lastDelivery }` — active Player count, stored Stat Line
  count, and the last digest/heartbeat delivery (including an in-flight `sending` status).
- **Side effects:** none.

## Connecting a Claude client

Point a client at the `/mcp` endpoint (locally `http://localhost:3000/mcp`, or your tunnel host such
as `https://your-host.example.com/mcp`), authenticating with the bearer token.

### Claude Code — works today

Static bearer headers are supported, so a single command registers the server:

```sh
claude mcp add --transport http bryce https://your-host.example.com/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

Then ask in plain language — "add Konnor Griffin to my watch list", "what did my guys do this
week?", "preview today's digest" — and the tools do the rest.

### claude.ai / Claude mobile — pending verification ([#37](https://github.com/wrburgess/bryce/issues/37))

The hosted custom-connector flow (Settings → Connectors → Add custom connector) is **OAuth-based**,
so passing a **static `Authorization: Bearer` header is not yet confirmed to work** against Bryce's
token middleware. This path is tracked in issue #37 and is **not** documented here as working until
that verification lands — do not assume the bearer token alone connects the hosted apps.

## See also

- [REST API Reference](../api/README.md) — the same operations over HTTP.
- [CLI Reference](../cli/README.md) — the same operations from the command line.
- [Domain glossary](../domain/CONTEXT.md) — Player, Refresh, Digest, Window, Offseason Sleep.
