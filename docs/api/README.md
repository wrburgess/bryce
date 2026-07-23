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

All sixteen routes live under `/api`. Request/response bodies are JSON; inputs are validated by the
same shared Zod schemas the MCP tools use (`src/api/schemas.ts`, `src/queries/statLines.ts`), so a
malformed input is rejected identically on both surfaces.

### `GET /api/players`

List Watch List players. Query: `active=true|false|all` (default `true` — active only; `false` for
deactivated; `all` for both), plus optional `tags=` — a comma-separated **AND** selector (e.g.
`tags=level:aaa,status:rostered`), where a bare namespace (e.g. `tags=prospect`) matches any value in
it; only players matching every token are returned. A malformed selector is a **400**. Returns
`{ "players": [...] }`.

### `POST /api/players`

Add an MLB/MiLB Player. Body `{ "personId": N }`. Runs his first Refresh immediately (unless in
Offseason Sleep). Returns **201** when the Player was newly added, **200** when an existing row was
updated.

### `POST /api/players/ncaa`

Add an NCAA Player by `stats_player_seq`. Body `{ "ncaaPlayerSeq": N }`; name and school are resolved
from his game-log page. Returns **201** on add, **200** on update — same convention as the MLB add.

### `POST /api/players/ncaa/:seq/deactivate`

Deactivate an NCAA Player, addressed by `stats_player_seq` in the path. His row and full history are
kept. Returns `{ "player": {...} }`.

### `POST /api/players/:id/deactivate`

Deactivate an MLB/MiLB Player, addressed by **personId** in the path (`:id` is the MLB Stats API
personId, not the internal row id). Returns `{ "player": {...} }`.

### `GET /api/players/search`

Name search over MLB/MiLB players via the MLB Stats API, each hit resolved to a current team and
level. Query: `q=NAME` (required, non-blank). Returns `{ "results": [...] }`.

### Player tags

Manual-tag management, addressed by **personId** (`:id`) for MLB/MiLB or **`stats_player_seq`**
(`:seq`) for NCAA — the same external addressing as the sibling player routes. Tag semantics live in
the service: a manual write to a derived namespace (`level`/`pos`/`prospect`), or an unknown
namespace/value, is a **400**; an unknown Player is a **404**.

| Route | Meaning |
|---|---|
| `GET /api/players/:id/tags`, `GET /api/players/ncaa/:seq/tags` | List **every** tag (derived + manual), ordered by namespace, value, source. Returns `{ "tags": [...] }`. |
| `POST /api/players/:id/tags`, `POST /api/players/ncaa/:seq/tags` | Add a manual tag. Body `{ "namespace": "status", "value": "rostered" }`. Idempotent; returns **201** `{ "tag": {...} }`. |
| `DELETE /api/players/:id/tags/:namespace/:value`, `DELETE /api/players/ncaa/:seq/tags/:namespace/:value` | Remove a manual tag (no-op if absent). Returns `{ "removed": true }`. |

### `GET /api/stat-lines`

Query stored per-game Stat Lines, newest first. Query params (all optional except as noted):

| Param | Meaning |
|---|---|
| `playerId` | Internal Bryce player id (`players.id`, **not** the personId). |
| `level` | `mlb`, `milb`, or `ncaa`. |
| `from` / `to` | Inclusive `YYYY-MM-DD` bounds; `from > to` is rejected. |
| `limit` | Max rows, `1`–`200`, default `50`. |
| `format` | `json` (default) or `csv`. `csv` downloads the rows as a CSV **Export** ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)) — `Content-Type: text/csv`, `Content-Disposition: attachment; filename="bryce-stat-lines.csv"`, one column per field with `stats` as a JSON column. |

Returns `{ "statLines": [...] }` for `json`; a CSV file body for `csv`.

### `GET /api/digest/preview`

Preview what a Digest would report for a Window, without sending or claiming anything (read-only).
Query: `window=` (one of `1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, default `1d`) and `force=true|false` (default
`false`). **`force` is accepted but a no-op here** — a preview never claims or sends, and window
selection makes its content identical either way. For `format=json` (the default) returns
`{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.

`format` ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)) is one of
`json`/`html`/`md`/`csv`. `html` and `md` render the **whole** Digest (both tables) as a downloadable
**Presentation** document; `csv` exports **one** table as an **Export**, chosen by
`table=batters|pitchers` (default `batters`, ignored for `html`/`md`). A non-`json` response is a file
download — `Content-Type: text/html|text/markdown|text/csv` with `Content-Disposition: attachment`
(filenames `bryce-digest-<window>.html|.md`, `bryce-<table>-<window>.csv`).

### `POST /api/digest/send`

Run the Digest job now. Body is optional: an empty or absent body means "no force, default window"
(so every pre-`force` caller keeps working); otherwise `{ "force"?: boolean, "window"?: spec }`.
Malformed JSON is a client error (**400**). On success returns **200** with the run result. **When
the run's `action` is `"failed"` the status is 502** and the body is the normal result object (not
an error envelope) — a failed send is reported as data, so the caller sees the run detail.

### `POST /api/refresh`

Run a Refresh now. Body is optional: empty or absent refreshes **every** active Player; otherwise
`{ "personId"?: N }` or `{ "ncaaPlayerSeq"?: N }` to refresh one. Malformed JSON is a client error
(**400**), never a full refresh. Returns the refresh summary.

## Error model

Errors are shaped by a single `onError` handler; the status is chosen by error type:

| Condition | Status | Body |
|---|---|---|
| Missing / wrong bearer token | **401** | `{ "error": "unauthorized" }` |
| Zod validation failure (bad input, incl. a malformed `tags` selector) | **400** | `{ "error": "invalid-input", "issues": [...] }` |
| Malformed JSON body (`SyntaxError`) | **400** | `{ "error": "invalid-input", "issues": [{ "message": ... }] }` |
| Manual write to a derived tag namespace / unknown tag namespace or value | **400** | `{ "error": "<message>" }` |
| Unknown person / unknown NCAA player / player not found | **404** | `{ "error": "<message>" }` |
| MLB Stats API or stats.ncaa.org upstream failure | **502** | `{ "error": "<message>" }` |
| No bundled NCAA season lookup for the requested year | **503** | `{ "error": "<message>" }` |
| `POST /api/digest/send` where the run's `action` is `"failed"` | **502** | the normal result object (see above) |

The **502** on a failed send is distinct from the upstream-error 502: it carries the run result
body, not an `{ "error": … }` envelope.

## See also

- [MCP Reference](../mcp/README.md) — the same operations as Claude-facing tools.
- [CLI Reference](../cli/README.md) — the same operations from the command line.
- [Domain glossary](../domain/CONTEXT.md) — Player, Refresh, Digest, Window, Offseason Sleep.
