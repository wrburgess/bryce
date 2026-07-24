# REST API Reference

A thin, token-authed REST API over Bryce's service layer ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)):
request/response orchestration only, with every behavior living in the same service layer the
[CLI](../cli/README.md) and [MCP tools](../mcp/README.md) share. It exists for scripted clients; the
[MCP server](../mcp/README.md) is the primary, human-facing interface. Domain terms — **Player**,
**Refresh**, **Digest**, **Window**, **Offseason Sleep** — are defined in
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md).

## Base URL and authentication

All routes below are mounted under `/api` — locally `http://localhost:3000/api`, or
`https://your-host.example.com/api` behind the Cloudflare Tunnel. Every `/api/*` request carries a
bearer token:

```
Authorization: Bearer $API_TOKEN
```

The comparison is constant-time over SHA-256 digests; a missing or wrong token gets a **401** with a
fixed body and the token is never echoed or logged:

```json
{ "error": "unauthorized" }
```

**The server fails closed.** With no `API_TOKEN` configured, the app refuses to construct and
**nothing is served — including `GET /health`**. `GET /health` is the one route that, once the
server is up, is public (no bearer required); everything under `/api` requires the token. Requests
and responses are JSON.

## Routes

All routes live under `/api`. Request/response bodies are JSON; inputs are validated by the same
shared Zod schemas the MCP tools use (`src/api/schemas.ts`, `src/queries/statLines.ts`), so a
malformed input is rejected identically on both surfaces.

### `GET /api/players`

List Watch List players. Query: `active=true|false|all` (default `true` — active only; `false` for
deactivated; `all` for both). Returns `{ "players": [...] }`.

### `POST /api/players`

Add an MLB/MiLB Player. Body `{ "personId": N }`. Runs his first Refresh immediately (unless in
Offseason Sleep). Returns **201** when the Player was newly added, **200** when an existing row was
updated.

### `POST /api/players/ncaa`

Add an NCAA Player by `stats_player_seq`. Body `{ "ncaaPlayerSeq": N }`; name and school are resolved
from his game-log page. Returns **201** on add, **200** on update — same convention as the MLB add.

### `POST /api/players/batch`

Batch-add up to **25** Players in one call ([#68](https://github.com/wrburgess/bryce/issues/68),
[ADR 0045](../adr/0045-batch-add-stages-by-identity-best-effort-defers-backfill.md)). Body
`{ "entries": [ ... ], "list"?: NAME }`, where each entry is a **typed identity** — **exactly one** of
`{ "personId": N }`, `{ "ncaaPlayerSeq": N }`, or `{ "name": "..." }` (an MLB-only people-search
convenience that must resolve to exactly one Player). `list` (optional) adds every staged Player to an
**existing** named list ([#70](https://github.com/wrburgess/bryce/issues/70)); batch-add never
*creates* a list, so an unknown `list` **fails the whole call closed (404)** before any write.

- **Always returns 200** for a well-formed batch: `{ "summary": { added, updated, unresolved, failed,
  total }, "entries": [ ... ] }`. Each entry is a discriminated outcome on `status` — `added`/`updated`
  carry the `player`; `unresolved` carries a `reason` (and `candidates` for `name_ambiguous`); `failed`
  carries a `reason` and a display `message`. A **soft** per-entry failure stays inside this 200 body;
  it never takes the 404/502 seam.
- **400** when the batch **shape** is bad — empty, over the 25 cap, an untyped/multi-key entry, an
  unknown key, or an in-batch duplicate (a `personId` N and an `ncaaPlayerSeq` N are *different*
  Players) — rejected before any network or write. **413** when the request body exceeds **64 KB**.
- **Deferred backfill (unlike `POST /api/players`):** each Player is staged by **identity** now, but
  **no first Refresh runs inline** — his Stat Lines appear at the next Refresh (or an explicit
  `POST /api/refresh`), which sweeps the active Watch List. Batch-add records no freshness run.

### `POST /api/players/ncaa/:seq/deactivate`

Deactivate an NCAA Player, addressed by `stats_player_seq` in the path. His row and full history are
kept. Returns `{ "player": {...} }`.

### `POST /api/players/:id/deactivate`

Deactivate an MLB/MiLB Player, addressed by **personId** in the path (`:id` is the MLB Stats API
personId, not the internal row id). Returns `{ "player": {...} }`.

### `GET /api/players/search`

Name search over MLB/MiLB players via the MLB Stats API, each hit resolved to a current team and
level. Query: `q=NAME` (required, non-blank). Returns `{ "results": [...] }`.

### `GET /api/stat-lines`

Query stored per-game Stat Lines, newest first. Query params (all optional except as noted):

| Param | Meaning |
|---|---|
| `playerId` | Internal Bryce player id (`players.id`, **not** the personId). |
| `level` | `mlb`, `milb`, or `ncaa`. |
| `from` / `to` | Inclusive `YYYY-MM-DD` bounds; `from > to` is rejected. |
| `limit` | Max rows, `1`–`200`, default `50`. |
| `list` | Named list ([#70](https://github.com/wrburgess/bryce/issues/70)) to scope to its **active** members; an unknown list is rejected (**404**). Omit for all players. |
| `format` | `json` (default) or `csv`. `csv` downloads the rows as a CSV **Export** ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)) — `Content-Type: text/csv`, `Content-Disposition: attachment; filename="bryce-stat-lines.csv"`, one column per field with `stats` as a JSON column. |

Returns `{ "statLines": [...] }` for `json`; a CSV file body for `csv`.

### `GET /api/digest/preview`

Preview what a Digest would report for a Window, without sending or claiming anything (read-only).
Query: `window=` (one of `1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, default `1d`) and `force=true|false` (default
`false`). **`force` is accepted but a no-op here** — a preview never claims or sends, and window
selection makes its content identical either way. `list=NAME`
([#70](https://github.com/wrburgess/bryce/issues/70)) scopes the preview to a named list's active
members; an unknown list is rejected (**404**). For `format=json` (the default) returns
`{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.

`format` ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)) is one of
`json`/`html`/`md`/`csv`. `html` and `md` render the **whole** Digest (both tables) as a downloadable
**Presentation** document; `csv` exports **one** table as an **Export**, chosen by
`table=batters|pitchers` (default `batters`, ignored for `html`/`md`). A non-`json` response is a file
download — `Content-Type: text/html|text/markdown|text/csv` with `Content-Disposition: attachment`
(filenames `bryce-digest-<window>.html|.md`, `bryce-<table>-<window>.csv`).

### `POST /api/digest/send`

Run the Digest job now. Body is optional: an empty or absent body means "no force, default window"
(so every pre-`force` caller keeps working); otherwise `{ "force"?: boolean, "window"?: spec,
"list"?: NAME }`. A `list` ([#70](https://github.com/wrburgess/bryce/issues/70)) scopes the send to a
named list's active members; a named-list send is **on-demand only** — it takes no daily slot,
whatever its window — and an unknown list is rejected (**404**). Malformed JSON is a client error
(**400**). On success returns **200** with the run result. **When the run's `action` is `"failed"`
the status is 502** and the body is the normal result object (not an error envelope) — a failed send
is reported as data, so the caller sees the run detail.

### Named player lists (`#70`)

Named lists ([ADR 0046](../adr/0046-named-player-lists-scoped-digests.md)) are curated membership over
the Watch List — distinct from tags (#30) and rosters (#69). A named-list scope selects a list's
**active** members; `players.active` stays the master gate. Names are trimmed, non-blank, and
case-sensitively unique among **live** lists.

- **`GET /api/lists`** — every live list with its active-member count: `{ "lists": [{ id, name,
  memberCount, createdAt, updatedAt }] }`.
- **`POST /api/lists`** — create a list. Body `{ "name": NAME }`. **201** with `{ "list": {...} }`;
  a duplicate live name is **409**; a blank name is **400**.
- **`GET /api/lists/:name`** — the list plus its active members: `{ "list": {...}, "members": [...] }`.
  Unknown list **404**.
- **`PATCH /api/lists/:name`** — rename. Body `{ "name": NEW }`. Unknown list **404**; a collision with
  another live list **409**.
- **`DELETE /api/lists/:name`** — **soft-delete** the list (its name frees for reuse; membership rows
  are left in place). Unknown list **404**.
- **`POST /api/lists/:name/members`** — add members. Body `{ "players": [ { "personId": N } | {
  "ncaaPlayerSeq": N } ] }`. Idempotent (re-adding a member is a no-op). Returns `{ "list", "added",
  "players" }`. Unknown list **404**; a reference to a Player not on the Watch List **404**.
- **`DELETE /api/lists/:name/members`** — remove members (hard-deletes the join rows; removing a
  non-member is a no-op). Same body; returns `{ "list", "removed", "players" }`.

### `POST /api/refresh`

Run a Refresh now. Body is optional: empty or absent refreshes **every** active Player; otherwise
`{ "personId"?: N }` or `{ "ncaaPlayerSeq"?: N }` to refresh one. Malformed JSON is a client error
(**400**), never a full refresh. Returns the refresh summary.

## Error model

Errors are shaped by a single `onError` handler; the status is chosen by error type:

| Condition | Status | Body |
|---|---|---|
| Missing / wrong bearer token | **401** | `{ "error": "unauthorized" }` |
| Zod validation failure (bad input) | **400** | `{ "error": "invalid-input", "issues": [...] }` |
| Malformed JSON body (`SyntaxError`) | **400** | `{ "error": "invalid-input", "issues": [{ "message": ... }] }` |
| Unknown person / unknown NCAA player / player not found / **unknown list** (#70) | **404** | `{ "error": "<message>" }` |
| **Duplicate live list name** (#70) | **409** | `{ "error": "<message>" }` |
| MLB Stats API or stats.ncaa.org upstream failure | **502** | `{ "error": "<message>" }` |
| No bundled NCAA season lookup for the requested year | **503** | `{ "error": "<message>" }` |
| `POST /api/digest/send` where the run's `action` is `"failed"` | **502** | the normal result object (see above) |

The **502** on a failed send is distinct from the upstream-error 502: it carries the run result
body, not an `{ "error": … }` envelope.

## See also

- [MCP Reference](../mcp/README.md) — the same operations as Claude-facing tools.
- [CLI Reference](../cli/README.md) — the same operations from the command line.
- [Domain glossary](../domain/CONTEXT.md) — Player, Refresh, Digest, Window, Offseason Sleep.
