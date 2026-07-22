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

All ten routes live under `/api`. Request/response bodies are JSON; inputs are validated by the same
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

Returns `{ "statLines": [...] }`.

### `GET /api/digest/preview`

Preview what a Digest would report for a Window, without sending or claiming anything (read-only).
Query: `window=` (one of `1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, default `1d`) and `force=true|false` (default
`false`). **`force` is accepted but a no-op here** — a preview never claims or sends, and window
selection makes its content identical either way. Returns
`{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.

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
| Zod validation failure (bad input) | **400** | `{ "error": "invalid-input", "issues": [...] }` |
| Malformed JSON body (`SyntaxError`) | **400** | `{ "error": "invalid-input", "issues": [{ "message": ... }] }` |
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
