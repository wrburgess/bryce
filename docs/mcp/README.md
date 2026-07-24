# MCP Reference

The MCP server is Bryce's **primary interface** ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)):
fifteen tools over the same service layer and Zod schemas the [REST API](../api/README.md) and
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

- **Inputs:** `active` — `"true"` (default, active only), `"false"` (deactivated), or `"all"`; optional
  `tags` — a comma-separated **AND** selector (e.g. `level:aaa,status:rostered`), where a bare namespace
  (e.g. `prospect`) matches any value in it. Only players matching every token are returned.
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

### `watchlist_batch_add`

Batch-add up to **25** Players in one call ([#68](https://github.com/wrburgess/bryce/issues/68),
[ADR 0045](../adr/0045-batch-add-stages-by-identity-best-effort-defers-backfill.md)).

- **Inputs:** `entries` — an array of 1 to 25 **typed identity entries**, each **exactly one** of
  `personId` (MLB/MiLB), `ncaaPlayerSeq` (NCAA), or `name` (an MLB-only people-search convenience that
  must resolve to *exactly one* Player — there is no NCAA name search). An optional `list` is accepted
  but ignored today (the [#70](https://github.com/wrburgess/bryce/issues/70) named-list seam).
- **Success:** `{ "summary": { added, updated, unresolved, failed, total }, "entries": [ ... ] }`. Each
  entry is a discriminated outcome on `status`: `added` / `updated` carry the `player`; `unresolved`
  carries a `reason` (`person_not_found` · `name_no_match` · `name_ambiguous` · `ncaa_not_found`) and,
  for `name_ambiguous` only, a `candidates` array; `failed` carries a `reason`
  (`unsupported_season` · `upstream_error`) and a display `message`.
- **Deferred backfill (unlike `watchlist_add`):** each Player's **identity** is resolved and his row is
  staged **now**, but **no first Refresh runs inline** — his Stat Lines appear at the next `run_refresh`
  (or the nightly Refresh), which sweeps the active Watch List and backfills him. Batch-add records
  **no** freshness run, so it does not affect the digest freshness gate. Run `run_refresh` afterward to
  backfill early.
- **Shape is strict, resolution is soft:** a bad **shape** — empty, over the 25 cap, an untyped or
  multi-key entry, an unknown key, or an **in-batch duplicate** (a `personId` N and an `ncaaPlayerSeq`
  N are *different* Players, never a duplicate) — is rejected as an input error **before any network or
  write**, and is the *only* thing that fails the whole call. Every other problem is a per-entry
  outcome; one entry failing never aborts the others (batch-add is deliberately non-transactional).
  An unknown *top-level* key (a stray sibling of `entries`/`list`) is **rejected** here (strict),
  consistent with REST's 400, because the tool registers the strict batch schema and the MCP SDK
  preserves its `.strict()`. The entry shape, the 25 cap, the exactly-one-key rule, and in-batch dedupe
  are strictly enforced on every surface, so no malformed entry is ever staged.

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
  `from`/`to` (inclusive `YYYY-MM-DD`; `from > to` is rejected), `limit` (`1`–`200`, default `50`),
  `format` (`json` default, or `csv`) — all optional.
- **Success:** `{ "statLines": [...] }` for `json`; for `csv`, a CSV **Export** returned inline as a
  text part (no `structuredContent`) — one column per field, `stats` as a JSON column
  ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)).
- **Side effects:** none.

### `digest_preview`

Preview the Digest for a Window as the Batters and Pitchers tables the email would carry.

- **Inputs:** `window` (`1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, default `1d`; an unsupported value is rejected),
  `force` — **accepted but ignored here**, because a preview never claims or sends — and `format`
  (`json` default, or `html`/`md`/`csv`) with `table` (`batters` default, or `pitchers`; used only by
  `csv`).
- **Success:** for `json`, `{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.
  For `html`/`md` a whole-Digest **Presentation** (both tables) and for `csv` a one-table **Export**
  (`table` selects it), each returned inline as a text part with no `structuredContent`
  ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)).
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

### `player_tag_add`

Add a **manual** tag to a Player, addressed by `personId` (MLB/MiLB) or `ncaaPlayerSeq` (NCAA) —
exactly one.

- **Inputs:** `personId` or `ncaaPlayerSeq`; `namespace` and `value`. Manual tags live in the
  `status` namespace (`rostered` or `scouted`); a write to a derived namespace (`level`/`pos`/`prospect`)
  or an unknown namespace/value is an error result.
- **Success:** `{ tag: { id, playerId, namespace, value, source, createdAt } }`.
- **Side effects:** inserts one `source='manual'` row (idempotent — re-adding is a no-op).

### `player_tag_remove`

Remove a **manual** tag from a Player, addressed by `personId` or `ncaaPlayerSeq` — exactly one.

- **Inputs:** `personId` or `ncaaPlayerSeq`; `namespace` and `value`. A derived namespace is rejected.
- **Success:** `{ removed: true }` (removing an absent manual tag is a no-op).
- **Side effects:** deletes the matching `source='manual'` row, if any.

### `player_tags_list`

List **every** tag (derived and manual) for a Player, addressed by `personId` or `ncaaPlayerSeq` —
exactly one.

- **Inputs:** `personId` or `ncaaPlayerSeq`.
- **Success:** `{ tags: [...] }`, ordered by namespace, value, source.
- **Side effects:** none (read-only).

See the [Player tag model reference](../domain/tags.md) for the full namespace vocabulary, the derived
values, and the selector grammar (the `tags` filter on `watchlist_list` uses the same selector).

### `sql_query`

Run a single read-only SQL query for ad-hoc analysis.

- **Inputs:** `sql` — one `SELECT`/`WITH`/`EXPLAIN` statement (writes are rejected and the connection
  itself is read-only); `params` — positional bind values for `?` placeholders (up to 50 strings,
  numbers, or nulls); `format` (`json` default, or `csv`). Tables: `players`, `stat_lines`,
  `player_tags`, `digest_deliveries`, `season_calendar`.
- **Success:** for `json`, `{ columns, rows, rowCount, truncated }`. For `csv`, the result rows as a
  CSV **Export** returned inline as a text part (no `structuredContent`); when the 200-row cap is hit,
  a **second text part** carries a truncation warning so the CSV table itself stays uncorrupted
  ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)). `csv` is **MCP-only** —
  there is no REST download for `sql_query` (a GET carrying SQL/params in the URL would leak them).
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

**Smoke-test the endpoint first.** Before wiring any client, confirm the server answers a real MCP
client end to end:

```sh
API_TOKEN=... MCP_URL=https://your-host.example.com/mcp npm run connector:smoke
```

It runs `initialize` → `tools/list` (asserts all fifteen tools) → `status` → a read-only
`digest_preview`, then checks that a no-bearer request still `401`s — and never prints a secret. See
[Running Bryce → Cloudflare Access](../guides/running-bryce.md#cloudflare-access-in-front-of-the-tunnel)
for the full flag set and the Cloudflare Access topology.

### Claude Code — works today

Static bearer headers are supported, so a single command registers the server:

```sh
claude mcp add --transport http bryce https://your-host.example.com/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

Then ask in plain language — "add Konnor Griffin to my watch list", "what did my guys do this
week?", "preview today's digest" — and the tools do the rest.

### claude.ai web + iPhone — how to verify ([#37](https://github.com/wrburgess/bryce/issues/37))

This path is **pending verification** — do **not** assume the bearer token alone connects the hosted
apps until the live test below is recorded. Here is how to add the connector and, in the same steps,
find out whether it can work for your account.

1. **Open the connector settings.** On **claude.ai web**: Settings → Connectors → **Add custom
   connector**. On **iPhone**: the Claude app's Settings → Connectors → add a custom connector. Both
   hosted surfaces share one connector backend, so what works on one should work on the other.
2. **Enter the URL:** `https://your-host.example.com/mcp` (your tunnel host, not localhost — the
   hosted apps reach Bryce over the internet).
3. **Look for a request-header field — this is the tell.** Anthropic's static-credential feature
   (`static_headers`) is *"Fixed credential (API key or bearer token) entered by an organization
   administrator as a request header when adding the connector"* and is currently **Beta**
   ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication)).
   - **If the add-connector screen lets you enter a request header**, the beta is available for your
     account: enter `Authorization` with value `Bearer <your API_TOKEN>`. That is the single header
     Bryce's `/mcp` needs once the path is exempted from the interactive Cloudflare Access policy.
   - **If there is no header field and it only offers an OAuth sign-in**, the static-header path is
     **not available for your account**. Bryce's `/mcp` speaks a static bearer token, not the hosted
     OAuth flow, so record this as *"static-header path unsupported"* — it is the documented signal
     that the Phase-2 OAuth work is needed, not a misconfiguration.
4. **Apply the Cloudflare Access exemption on `/mcp`** and run the discovery + read + mutation checks.
   The full step-by-step (including the two-path + bearer-rotation matrix to record) is the
   **Manual Verification Stage** in
   [Running Bryce → Cloudflare Access](../guides/running-bryce.md#manual-verification-stage-the-gate-that-closes-37).

**Proven status:** *pending the live test above.* The HC updates this line to "verified working via
the static-header path" or "static-header path unsupported; OAuth required (Phase 2)" once the Manual
Verification Stage is recorded, and only then is [#37](https://github.com/wrburgess/bryce/issues/37)
closed.

## See also

- [REST API Reference](../api/README.md) — the same operations over HTTP.
- [CLI Reference](../cli/README.md) — the same operations from the command line.
- [Domain glossary](../domain/CONTEXT.md) — Player, Refresh, Digest, Window, Offseason Sleep.
