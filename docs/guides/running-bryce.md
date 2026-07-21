# Running Bryce (MLB/MiLB/NCAA pipeline + MCP/REST server)

How to run the daily pipeline on its intended host: a Mac (laptop or mini) with Node 22, launchd
for scheduling, and optional Litestream replication + Cloudflare Tunnel exposure
([ADR 0028](../adr/0028-local-macbook-hosting-cloudflare-tunnel.md)). The domain language used
below (Player, Refresh, Digest, Offseason Sleep) is defined in
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md).

## Setup

```sh
nvm use              # Node 22 (.nvmrc)
npm ci
cp .env.example .env # then fill in values
npm run db:migrate   # optional: jobs also migrate themselves at startup
```

Seed the watch list, then run the jobs by hand once:

```sh
npm run seed -- add --search "acosta" --pick 1   # or: add --person-id 691185
npm run seed -- add --ncaa-seq 2649785           # NCAA player by stats_player_seq (see NCAA below)
npm run seed -- list
npm run refresh
npm run digest
npm run digest -- --force   # test send: re-send today's digest even if it already went out
```

`--force` overrides only the "already sent today" bookkeeping, and a forced run is a **replay**: it
sends the mail and writes nothing at all — no delivery row is created or changed, and no Stat Line is
marked reported. Three consequences worth knowing before you use it:

- A line that arrived *after* the real send is **included** in the forced email but stays unreported,
  so the next real digest still carries it. A test send never consumes anything.
- It cannot jump an in-flight run: if another invocation holds a live claim on today's slot you get
  `action=skipped reason=claimed-by-another-run`, and it clears within ten minutes on its own.
- It does not override Offseason Sleep. **Forcing during the offseason sends a heartbeat, not a
  digest** — that is what the system would really send that day. The forced heartbeat does not
  restart the rolling seven-day clock, so the next real heartbeat still arrives on schedule.

The same flag is available on the other two surfaces: `POST /api/digest/send` with `{"force": true}`
(and `GET /api/digest/preview?force=true` to look without sending), or the MCP `send_digest` /
`digest_preview` tools with `force: true`. The full design is
[ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md) → *The force flag does not touch any
of this*.

## Environment variables

All configuration is environment-only; secrets never live in the repo. Each entrypoint first loads
`.env` from the working directory if present (native Node loader, [`src/env.ts`](../../src/env.ts));
real environment variables always win over file values, and the launchd plists below work because
they set `WorkingDirectory` to the repo. `loadConfig` (see
[`src/config.ts`](../../src/config.ts)) then validates on startup and fails closed on anything
missing.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_PATH` | no | `data/bryce.db` | SQLite file; created and migrated automatically |
| `BRYCE_TZ` | no | `America/Chicago` | Host timezone for "today" (digest windows, season math) |
| `MAILER_PROVIDER` | no | `postmark` | `postmark`, `smtp` (Forward Email), or `console` |
| `POSTMARK_SERVER_TOKEN` | with postmark | — | Postmark server token |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | with smtp | port `465` | SMTP relay credentials |
| `DIGEST_TO` / `DIGEST_FROM` | unless console | — | Digest recipient and sender addresses |
| `MLB_API_DELAY_MS` | no | `500` | Polite delay between MLB Stats API calls |
| `NCAA_SCRAPE_DELAY_MS` | no | `3000` | Polite delay between stats.ncaa.org scrape requests |
| `SERVER_PORT` | no | `3000` | HTTP server port (`/health`, `/api`, `/mcp`) |
| `API_TOKEN` | for `/api` + `/mcp` | — | Bearer token guarding `/api/*` and `/mcp`; without it the server refuses to start those surfaces (`/health` stays public) |

## Scheduling with launchd

Two jobs: Refresh (nightly, after West Coast games finish) and Digest (~5 AM Central). Refresh is
idempotent ([ADR 0030](../adr/0030-full-season-refresh-report-once-digest.md)), so re-running it is
free. launchd runs missed jobs on wake, which is exactly what a sometimes-asleep laptop needs.

**That wake behaviour is why Digest re-entry is not theoretical.** On wake, the missed Digest job
fires as its own process at the moment the long-lived server may be handling an MCP `send_digest`
call or a `POST /api/digest/send` — two processes, two SQLite connections, one delivery slot. Digest
survives that: each run takes a durable claim on its `(kind, date)` slot before the mail provider is
called, so **only one invocation ever reaches the provider for a slot**
([ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md); the `BEGIN IMMEDIATE` claim is what
makes it hold across processes, and a pinned `busy_timeout` keeps a contender waiting rather than
failing).

Re-entry is safe; it is not *exactly-once*. If Bryce dies in the window between the provider
accepting the mail and the row recording it, that acceptance is unrecoverable and the content goes
out again — Digest is **at-least-once** across that one window, a deliberate choice over a silently
missing digest. See *Stuck deliveries and duplicate emails* below for what that looks like and what
to do about it.

`~/Library/LaunchAgents/com.bryce.refresh.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bryce.refresh</string>
  <key>WorkingDirectory</key><string>/Users/YOU/code/bryce</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>npm run refresh >> logs/refresh.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
</dict>
</plist>
```

`~/Library/LaunchAgents/com.bryce.digest.plist` — identical shape, label `com.bryce.digest`,
command `npm run digest >> logs/digest.log 2>&1`, and:

```xml
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>
```

Load both:

```sh
launchctl load ~/Library/LaunchAgents/com.bryce.refresh.plist
launchctl load ~/Library/LaunchAgents/com.bryce.digest.plist
```

During Offseason Sleep ([ADR 0031](../adr/0031-offseason-sleep-world-series-to-opening-day.md))
the schedules keep firing but Refresh exits without API calls and Digest degrades to the weekly
heartbeat — no plist changes needed across seasons.

## Backup: Litestream to Cloudflare R2

Continuous SQLite replication (the database is the only state worth protecting):

```yml
# /usr/local/etc/litestream.yml
dbs:
  - path: /Users/YOU/code/bryce/data/bryce.db
    replicas:
      - type: s3
        bucket: bryce-backup
        path: bryce.db
        endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
        # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the R2 API token, via env
```

Run `litestream replicate` under its own launchd job (or `brew services start litestream`).
Restore with `litestream restore -o data/bryce.db s3://bryce-backup/bryce.db`.

## Remote access: Cloudflare Tunnel

The server (`npm run server`, [`src/server.ts`](../../src/server.ts)) binds locally; expose it
without opening ports via a named tunnel:

```sh
cloudflared tunnel create bryce
cloudflared tunnel route dns bryce bryce.example.com
cloudflared tunnel run --url http://localhost:3000 bryce
```

`GET /health` returns `{ ok, players, statLines, lastDelivery }` — a glanceable check that the
laptop, database, and last send are alive. It is the only public route; everything else rides
behind the token below.

## Stuck deliveries and duplicate emails

Bryce can send the **same content twice**, in one specific situation, on purpose. Read this once so a
duplicate email reads as a known outcome rather than a bug. The full guarantee and why it was chosen
are in [ADR 0034](../adr/0034-digest-delivery-claim-at-least-once.md); this section is the
operational half.

The short version: every digest and heartbeat takes a **claim** on its `(kind, date)` slot — a
`digest_deliveries` row with `status = "sending"` — before the mail provider is called. Racing
invocations can never both mail you; the loser skips. But if Bryce dies between the provider
accepting the mail and the row recording it, that acceptance is unrecoverable, and the content goes
out again. A duplicate announces itself; a silently missing digest does not.

On **Postmark**, a recovering run first asks Postmark whether that delivery already landed, and skips
the resend when Postmark confirms it — so the duplicate is *less likely* than it used to be, never
impossible (see *Reconciled deliveries* below). On SMTP and the console mailer nothing changed.

**Reading `/health`.** `GET /health` (and the MCP `status` tool) reports the last delivery's status
verbatim, including `sending`:

```json
{ "ok": true, "lastDelivery": { "kind": "digest", "dateCovered": "2026-07-19", "status": "sending", "sentAt": null } }
```

- **`sending` with a recent `claimed_at`** — a run is in flight right now. Normal; wait.
- **`sending` older than ten minutes** — a run died. The claim's lease has expired, so it blocks
  nothing: any further run *on that same date* reclaims the slot and sends. **No manual action is
  needed.**
- **A `sending` row that just stays there** — expected, and harmless. If no further run happens on
  that date (the usual shape: the 5 AM job crashes, the next one is tomorrow), that row is never
  reclaimed and remains as a historical artifact. Nothing is lost: the crashed run marked no Stat
  Lines, so the next day's digest reports them anyway — the digest is novelty-driven, not
  date-windowed ([ADR 0030](../adr/0030-full-season-refresh-report-once-digest.md)). The same is
  true of a crashed heartbeat: a `sending` row never counts toward the seven-day rule, so the next
  run still sends.
- **Two emails carrying the same lines** — the crash window above. `attempt_count` on the row says
  how many times that slot was claimed:

  ```sh
  sqlite3 data/bryce.db \
    "SELECT kind, date_covered, status, attempt_count, claimed_at, sent_at, provider_message_id,
            reconciled_at
       FROM digest_deliveries ORDER BY id DESC LIMIT 5;"
  ```

  An `attempt_count` above 1 on a `sent` row is the fingerprint of a retry or a recovery.

### Reconciled deliveries (Postmark only)

When a run recovers a crashed claim on Postmark, it searches Postmark's outbound messages for that
slot's delivery key before composing anything. If Postmark reports the message as `Sent`, `Processed`
or `Queued`, the row settles `sent` with **`reconciled_at` stamped** and no second email goes out.
That column is how you tell the two apart:

- **`reconciled_at` null** — we mailed this delivery ourselves.
- **`reconciled_at` set** — we did *not* mail it; Postmark told us the crashed attempt already had.
  Such a row deliberately carries `stat_line_count = 0` and `player_count = 0`: this run composed
  nothing, so it recorded nothing. The lines the crashed email contained stay unreported and go out
  in the **next** digest — which is why you may still see that content once more. Content is
  duplicated, never lost.

**The lookup only ever suppresses on a positive answer.** A miss, an HTTP error, an unreadable
response, or a lookup that takes longer than five seconds all fall back to re-sending — exactly the
behaviour above. Postmark documents no consistency guarantee for its message search, so a miss
moments after acceptance is expected; the duplicate you get in that case is the intended outcome, not
a failed reconciliation. Nothing here needs manual action, and there is no new credential or setting:
the lookup uses the same `POSTMARK_SERVER_TOKEN` as the send.

**If an email never arrived**, reopening the slot is not the operative step — the digest is
novelty-driven ([ADR 0030](../adr/0030-full-season-refresh-report-once-digest.md)), so the lines it
already reported stay marked and a bare re-run mails you an empty digest. Un-mark those lines and
they go out with the next digest:

```sh
sqlite3 data/bryce.db <<'SQL'
UPDATE stat_lines SET digest_delivery_id = NULL
 WHERE digest_delivery_id = (SELECT id FROM digest_deliveries
                              WHERE kind = 'digest' AND date_covered = '2026-07-19');
SQL
```

Then either wait for tomorrow's scheduled run or, to send *today* when today's slot is already
`sent`, reopen it as well — a `failed` row is re-claimable, so the next run retries it:

```sh
sqlite3 data/bryce.db \
  "UPDATE digest_deliveries SET status = 'failed'
     WHERE kind = 'digest' AND date_covered = '$(date +%F)';"
npm run digest
```

Do **not** delete a delivery row — the Stat Lines it reported reference it by foreign key.

## The MCP server and REST API

The primary interface ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)) is the **MCP
server** at `POST https://bryce.example.com/mcp` (Streamable HTTP), with a thin **REST API** under
`/api` for scripted clients. Both share one service layer and one Zod validation per input shape,
and both sit behind the same bearer token. During Offseason Sleep
([ADR 0031](../adr/0031-offseason-sleep-world-series-to-opening-day.md)) they stay live — history
remains queryable; only the pipeline sleeps.

### API_TOKEN setup

```sh
openssl rand -hex 32        # generate once, put in .env as API_TOKEN=...
```

The server fails closed: with no `API_TOKEN` it refuses to start at all — app construction
throws, so nothing is served, including `/health`. With a token set, every request to `/api`
and `/mcp` needs `Authorization: Bearer $API_TOKEN`; a missing or
wrong token gets a constant 401 (the token is never echoed or logged). Treat the token like any
secret — rotate it by editing `.env` and restarting the server (Cloudflare Access in front of the
tunnel is the second, independent layer per
[ADR 0028](../adr/0028-local-macbook-hosting-cloudflare-tunnel.md)).

### Connecting a Claude client to the remote MCP endpoint

The MCP tools are: `watchlist_list`, `watchlist_add`, `watchlist_add_ncaa`, `watchlist_deactivate`,
`player_search`, `stat_lines`, `digest_preview`, `send_digest`, `run_refresh`, `sql_query` (read-only
SQL, capped), and `status`. `watchlist_deactivate` and `run_refresh` accept either `personId`
(MLB/MiLB) or `ncaaPlayerSeq` (NCAA).

- **claude.ai / Claude mobile** — Settings -> Connectors -> Add custom connector, URL
  `https://bryce.example.com/mcp`. When the connector setup offers an auth header, use
  `Authorization: Bearer $API_TOKEN`.
- **Claude Code** —

  ```sh
  claude mcp add --transport http bryce https://bryce.example.com/mcp \
    --header "Authorization: Bearer $API_TOKEN"
  ```

Then ask in plain language — "add Konnor Griffin to my watch list", "what did my guys do this
week?", "preview today's digest" — and the tools do the rest.

### REST API routes

All under `https://bryce.example.com/api` with the same bearer header, JSON in/out:

| Route | Purpose |
|---|---|
| `GET /api/players?active=true\|false\|all` | List watch-list players |
| `POST /api/players` `{"personId": N}` | Add an MLB/MiLB player (first Refresh runs immediately) |
| `POST /api/players/ncaa` `{"ncaaPlayerSeq": N}` | Add an NCAA player by stats_player_seq |
| `POST /api/players/{personId}/deactivate` | Deactivate an MLB/MiLB player, keeping history |
| `POST /api/players/ncaa/{seq}/deactivate` | Deactivate an NCAA player, keeping history |
| `GET /api/players/search?q=NAME` | Name search with team/level resolution (MLB/MiLB) |
| `GET /api/stat-lines?playerId=&level=&from=&to=&limit=` | Query stored stat lines |
| `GET /api/digest/preview?force=true\|false` | What the next digest would report (read-only); `force` also shows what a forced send would carry |
| `POST /api/digest/send` `{"force": true}` (optional) | Run the digest job now; `force` re-sends today as a replay that records nothing |
| `POST /api/refresh` `{"personId": N}` or `{"ncaaPlayerSeq": N}` (optional) | Refresh one player or everything |

## NCAA players

NCAA baseball has no MLB Stats API `personId`, so an NCAA Player is identified by his stats.ncaa.org
`stats_player_seq` and its data is scraped from stats.ncaa.org through an isolated adapter
([ADR 0032](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)).

**Finding a player's `stats_player_seq`:** open his player page on stats.ncaa.org — the URL is
`https://stats.ncaa.org/players/{stats_player_seq}` (the trailing number is the seq). It also appears
as `stats_player_seq=...` in a game-log link's query string.

**Adding him** (his first Refresh runs immediately, unless the pipeline is in Offseason Sleep):

```sh
npm run seed -- add --ncaa-seq 2649785
```

- **REST:** `POST /api/players/ncaa` with `{"ncaaPlayerSeq": 2649785}`.
- **MCP / Claude:** the `watchlist_add_ncaa` tool — or just ask "add NCAA player 2649785 to my watch
  list". His name and school are resolved from his game-log page.

**Validating the scrape on this host** — stats.ncaa.org is behind Akamai bot protection, so confirm a
live fetch and parse from the Mac before relying on it:

```sh
npm run ncaa:probe -- --seq 2649785 --season 2025 --type batting
```

It prints the HTTP status and what the parser extracted (name, school, row count), exiting non-zero on
any failure.

**Annual season-lookup update:** stats.ncaa.org keys requests by opaque per-season ids that change
each year. `src/ncaa/seasons.ts` bundles them (plus each season's Division-I opening/closing dates)
per season; add a new entry each January (the file documents exactly where to read the ids off a
player page). A season with no bundled entry is simply treated as not In Season for NCAA — logged
loudly, never a silent gap.

**Scraping posture / terms of use:** this is an unofficial scrape (there is no official NCAA stats
API). Bryce is deliberately a polite, single-user client — a generous `NCAA_SCRAPE_DELAY_MS` between
requests and no parallel fetching — and fails loudly rather than hammering the site. Respect
stats.ncaa.org's terms of use; if the site blocks or rate-limits, back off rather than working around
the protection.
