# MCP Reference

The ScoreKeeps MCP server (the application is developed under the internal name Bryce) is the
**primary interface** ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)): twenty-five tools
over the same service layer and Zod schemas the [REST API](../api/README.md) and
[CLI](../cli/README.md) use. Its activated `sk` command is the preferred operator entry point; a
Claude client (web, mobile, or CLI) is the front end, and there is no web UI. It is mounted at
`/mcp` over Streamable HTTP, behind the bearer token. Domain terms —
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

### `report_player`

Returns a **formatted, ready-to-display card** for exactly one tracked Player —
show it verbatim; do not reformat or rebuild it as a table. Supply one typed `id`
(internal `players.id`) or canonical exact `name`, plus an optional ordered
`windows` array containing `last10`, `last30`, and/or `ytd`. Game-count windows
select distinct regular-season games before companion stat lines, while `ytd`
follows the Player sport's season calendar through the last completed host date.
Results retain batting/pitching level splits and actual game/date-span
provenance. Unknown or ambiguous Players and malformed typed inputs return the
standard structured MCP error. The tool sends nothing and writes nothing.

`format` **defaults to `console`** (`#141` /
[ADR 0055](../adr/0055-player-card-presentation-per-surface-defaults-no-pdf.md)),
not `json`: an agent should receive a finished artifact to display, not ~315
key/value pairs it must then lay out — and the console rendering is ~300 tokens
against the JSON's 2–4k, identical every call. It is the **same pure renderer**
`sk report player` prints, so the two surfaces cannot drift.

| `format` | Result |
|----------|--------|
| `console` (default) | A text part: the finished monospace card, one table per Card Window. No `structuredContent`. |
| `html` | A text part: a standalone printable document whose `@media print` rules make browser print → *Save as PDF* paginate correctly. No `structuredContent`. |
| `json` | `structuredContent`: the raw structured card. Use only when you need the numbers to compute with. |

This is the one place the MCP and REST **defaults** intentionally differ —
`GET /api/reports/player/:id` keeps `json` for its programmatic caller. For an
**explicit** `format` the two surfaces return the same bytes.

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

Add an NCAA Player by explicit Highlightly identity. The tool validates `playerId`, `canonicalName`, and `teamId`; it does not scrape stats.ncaa.org or search by name.

- **Inputs:** `playerId`, `canonicalName`, `teamId`.
- **Success:** `{ "action": "added" | "updated", "player": {...}, "refresh": {...} }`.
- **Side effects:** for a **newly added** Player, resolves his name and school from his game-log page,
  then the same first Refresh as `watchlist_add` (skipped during Offseason Sleep); re-adding a Player
  already on the Watch List is a no-op update (`refresh: null`) with no Refresh.

### `watchlist_promote_ncaa_player`

Convert a Highlightly NCAA Player to an explicit MLB/MiLB `personId` without creating a second Player.
The transaction preserves its local ID, Stat Lines, lists, and tags, clears NCAA identity and cursor
state, and rejects a missing source or already-owned person ID without partial conversion.

- **Inputs:** `highlightlyPlayerId`, `personId`.
- **Success:** `{ "player": {...} }` with professional identity only.

### `watchlist_batch_add`

Batch-add up to **25** Players in one call ([#68](https://github.com/wrburgess/bryce/issues/68),
[ADR 0045](../adr/0045-batch-add-stages-by-identity-best-effort-defers-backfill.md)).

- **Inputs:** `entries` — an array of 1 to 25 **typed identity entries**, each **exactly one** of
  `personId` (MLB/MiLB), explicit `highlightlyPlayerId` + `canonicalName` + `teamId` (NCAA), or `name` (an MLB-only people-search convenience that
  must resolve to *exactly one* Player — there is no NCAA name search). An optional `list` adds every
  staged Player to an **existing** named list ([#70](https://github.com/wrburgess/bryce/issues/70));
  batch-add never *creates* a list, so an unknown `list` fails the whole call closed before any write.
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
  multi-key entry, an unknown key, or an **in-batch duplicate** (a `personId` N and a `highlightlyPlayerId`
  N are *different* Players, never a duplicate) — is rejected as an input error **before any network or
  write**, and is the *only* thing that fails the whole call. Every other problem is a per-entry
  outcome; one entry failing never aborts the others (batch-add is deliberately non-transactional).
  An unknown *top-level* key (a stray sibling of `entries`/`list`) is **rejected** here (strict),
  consistent with REST's 400, because the tool registers the strict batch schema and the MCP SDK
  preserves its `.strict()`. The entry shape, the 25 cap, the exactly-one-key rule, and in-batch dedupe
  are strictly enforced on every surface, so no malformed entry is ever staged.

### `watchlist_deactivate`

Deactivate a Player, keeping his row and full Stat Line history.

- **Inputs:** exactly one of `personId` (MLB/MiLB) or `highlightlyPlayerId` (NCAA). Providing both or
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
  `list` (named list to scope to its active members, [#70](https://github.com/wrburgess/bryce/issues/70);
  an unknown list is rejected), `format` (`json` default, or `csv`) — all optional.
- **Success:** `{ "statLines": [...] }` for `json`; for `csv`, a CSV **Export** returned inline as a
  text part (no `structuredContent`) — one column per field, `stats` as a JSON column
  ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)).
- **Side effects:** none.

### `digest_preview`

Preview the Digest for a Window as the Batters and Pitchers tables the email would carry.

- **Inputs:** `window` (a date window `1d`/`7d`/`14d`/`21d`/`28d`/`35d`/`60d`/`ytd`, or a per-player
  game-count window `last10games`/`last30games` — #153; default `1d`; an unsupported value is rejected).
  A game-count window reports each Player over his own last N distinct regular-season games, so each row
  carries its real `agg.games` and a `spanFrom`/`spanTo` (two Players cover different date spans; the
  `window` is the cohort envelope). Then `force` — **accepted but ignored here**, because a preview never
  claims or sends — `list` (a named
  list to scope to its active members, [#70](https://github.com/wrburgess/bryce/issues/70); an unknown
  list is rejected), `tags` (a [tag selector](../domain/tags.md#selector-grammar) scoping the preview
  to a **cohort**, [#140](https://github.com/wrburgess/bryce/issues/140); with `list` the two
  **intersect**, a cohort matching no Players is an empty preview, and a malformed selector is
  rejected) and `format` (`json` default, or `html`/`md`/`csv`) with `table` (`batters`
  default, or `pitchers`; used only by `csv`).
- **Success:** for `json`, `{ window, statLineCount, playerCount, batters, pitchers, unknownFields, mail }`.
  For `html`/`md` a whole-Digest **Presentation** (both tables) and for `csv` a one-table **Export**
  (`table` selects it), each returned inline as a text part with no `structuredContent`
  ([ADR 0037](../adr/0037-presentation-export-formats-digest-and-tabular.md)).
- **Side effects:** none — sends nothing, claims nothing, writes nothing; re-running a Window returns
  the same content.

### `send_digest`

Run the Digest job now for a Window.

- **Inputs:** `window` (as above, including the game-count windows `last10games`/`last30games` — #153,
  which route to the on-demand path like a cohort scope; an unsupported value is rejected and nothing is
  sent), `force`
  (default `false`), and `list` — a lane ([#70](https://github.com/wrburgess/bryce/issues/70))
  that scopes the send to its active members. A tag-free **`1d`** send is that lane's **scheduled
  artifact** ([#193](https://github.com/wrburgess/bryce/issues/193) /
  [ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 1,
  superseding ADR 0046 decision 4): it **claims that lane's own once-per-date slot**, so calling it
  twice for one lane on one date returns `already-sent-today` (use `force` for a deliberate re-send),
  while two **different** lanes may each send that date. Omitting `list` on such a send means **the
  default lane**, not every active Player, and it goes to the lane's configured `digest_to` when one is
  set. Any wider window keeps the on-demand behavior and the host recipients. An unknown or deleted
  list is rejected; a lane deleted between resolution and the claim comes back as
  `{ action: "skipped", reason: "lane-deleted" }` with nothing mailed, `force` included. During
  Offseason Sleep an **unscoped** `1d` call becomes the weekly host heartbeat while a call that named a
  lane is `{ action: "skipped", reason: "offseason-sleep" }`. `tags`
  ([#140](https://github.com/wrburgess/bryce/issues/140)) scopes the send to a **cohort** and is
  on-demand for the same reason — the delivery-slot key `(kind, date_covered)` has no tag dimension,
  so a cohort send takes no slot and records no delivery row; with `list` the two **intersect**, and a
  malformed selector is rejected with nothing sent. `force` applies only to the daily
  `1d` slot: it overrides the already-sent-today
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

- **Inputs:** `personId` (MLB/MiLB) or `highlightlyPlayerId` (NCAA) to refresh one Player; omit both to
  refresh **every** active Player.
- **Success:** a per-player result such as `{ skipped, inserted, updated }` when a Player is
  specified; otherwise a whole-watch-list result with `status` (`ok`, `partial`, or `failed`),
  `playersRefreshed`, `playersSkipped`, `playersFailed`, `statLinesInserted`, `statLinesUpdated`,
  and any per-player failures. This tool attaches **no progress sink**, so its output is unchanged by
  the #146 live-console work. A
  concurrent sweep or Offseason Sleep returns a skipped result instead of doing work.
- **Side effects:** upserts Stat Lines. Only a whole-watch-list Refresh records the freshness run
  surfaced by `status` and `GET /health`; a single-player Refresh does not.

### `player_tag_add`

Add a **manual** tag to a Player, addressed by `personId` (MLB/MiLB) or `highlightlyPlayerId` (NCAA) —
exactly one.

- **Inputs:** `personId` or `highlightlyPlayerId`; `namespace` and `value`. Manual tags live in the
  `status` namespace (`rostered` or `scouted`); a write to a derived namespace (`level`/`pos`/`prospect`)
  or an unknown namespace/value is an error result.
- **Success:** `{ tag: { id, playerId, namespace, value, source, createdAt } }`.
- **Side effects:** inserts one `source='manual'` row (idempotent — re-adding is a no-op).

### `player_tag_remove`

Remove a **manual** tag from a Player, addressed by `personId` or `highlightlyPlayerId` — exactly one.

- **Inputs:** `personId` or `highlightlyPlayerId`; `namespace` and `value`. A derived namespace is rejected.
- **Success:** `{ removed: true }` (removing an absent manual tag is a no-op).
- **Side effects:** deletes the matching `source='manual'` row, if any.

### `player_tags_list`

List **every** tag (derived and manual) for a Player, addressed by `personId` or `highlightlyPlayerId` —
exactly one.

- **Inputs:** `personId` or `highlightlyPlayerId`.
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
- **Success:** `{ ok, players, statLines, lastDelivery, refresh, lanes }` — active Player count, stored Stat Line
  count, the last digest/heartbeat delivery (including an in-flight `sending` status), Refresh
  freshness/progress when a whole-watch-list Refresh has run, and the per-lane delivery view.
  `lanes` is additive in [#193](https://github.com/wrburgess/bryce/issues/193)
  ([ADR 0062](../adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 5): one
  entry per **live** lane, ordered by id, each
  `{ listId, name, isDefault, digestHour, lastDelivery: { dateCovered, status, sentAt } | null }` over
  that lane's `digest` rows only — a lane with `digestHour: null` is *not scheduled*, a scheduled lane
  with `lastDelivery: null` has *never delivered*, and a scheduled lane with a stale or `failed` one is
  a *dead lane*. Heartbeat rows are excluded so the default lane cannot inherit forged liveness from
  them. `refresh` carries `playersRefreshed`,
  **`playersSkipped`**, **`playersFailed`**, `playersTotal`, and the two stat-line counts; the two
  bolded fields are additive in #146 so the durable **Accounting** matches the CLI's live
  classification exactly ([ADR 0056](../adr/0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md)).
  For a run settled before #146 they read `0`, which means *not recorded*, not *nothing happened*.
- **Side effects:** none.

### Named player lists (`#70`)

Eight tools over the named-list service ([ADR 0046](../adr/0046-named-player-lists-scoped-digests.md),
[ADR 0059](../adr/0059-explicit-default-lane-supersedes-implicit-default.md)).
A list is curated membership over the Watch List — distinct from tags (#30) and rosters (#69). A
named-list scope selects a list's **active** members; `players.active` stays the master gate. Names are
trimmed, non-blank, and case-sensitively unique among live lists. An unknown list surfaces as `isError`
(`no list named "…"`); a duplicate live name as `isError` (`… already exists`).

- **`lists_list`** — every live list with its active-member count. Read-only. No inputs.
- **`list_create`** — create a list. Input `name`. `{ "list": {...} }`.
- **`list_rename`** — rename a live list. Inputs `name`, `newName`.
- **`list_delete`** — **soft-delete** a list (its name frees for reuse; membership rows are kept).
  Input `name`. The **default lane** is refused (`isError`) — point the default elsewhere first.
- **`list_set_default`** — point the **default lane** at this list: what a tool or command that names
  no list means. Input `name`. `{ "list": {...} }`. Clears the previous holder in the same
  transaction; re-pointing at the current default writes nothing. An unknown list is `isError`.
- **`list_members`** — a list's active members, ordered by id. Input `name`. `{ "list", "members" }`.
- **`list_add_players`** — add members, idempotently. Inputs `name` and `players` (an array of
  references, each exactly one of `personId` or `ncaaPlayerSeq`). `{ "list", "added", "players" }`. A
  reference to a Player not on the Watch List is rejected.
- **`list_remove_players`** — remove members (hard-deletes the join rows; removing a non-member is a
  no-op). Same inputs; `{ "list", "removed", "players" }`.

## Connecting a Claude client

Point a client at the `/mcp` endpoint (locally `http://localhost:3000/mcp`, or your tunnel host such
as `https://your-host.example.com/mcp`), authenticating with the bearer token.

**Smoke-test the endpoint first.** Before wiring any client, confirm the server answers a real MCP
client end to end:

```sh
API_TOKEN=... MCP_URL=https://your-host.example.com/mcp sk connector smoke
```

It runs `initialize` → `tools/list` (asserts all twenty-five tools) → `status` → a read-only
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
