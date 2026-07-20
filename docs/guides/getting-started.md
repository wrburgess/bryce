# Getting Started

Zero to your first digest email, locally, in about ten minutes. This guide covers first-time setup
and local testing; production operations (launchd scheduling, Cloudflare Tunnel, Litestream backup,
remote MCP) live in [Running Bryce](running-bryce.md).

## 1. Prerequisites

- **Node 22+** (`node --version`) and npm.
- **Ruby** (any recent version, macOS system Ruby is fine) — only for the repo's structural parity
  check; the app itself never uses it.
- No Docker, no external database. Storage is a local SQLite file created automatically.

## 2. Install

```bash
git clone https://github.com/wrburgess/bryce.git
cd bryce
npm install
bin/setup        # one-time: activates the branch-protection git hooks
```

## 3. Configure `.env`

```bash
cp .env.example .env
```

For **local testing**, the minimal edit is:

```dotenv
MAILER_PROVIDER=console        # prints the digest to stdout — no email account needed
API_TOKEN=<paste one>          # generate: openssl rand -hex 32
```

Leave the rest at their defaults (`DATABASE_PATH=data/bryce.db`, `TZ=America/Chicago`, polite API
delays). The server **fails closed**: it will not start without an `API_TOKEN`.

When you're ready for real email, switch `MAILER_PROVIDER=postmark` and set `POSTMARK_SERVER_TOKEN`,
`DIGEST_TO`, and `DIGEST_FROM` (or use `smtp` — see
[Running Bryce → Environment variables](running-bryce.md#environment-variables)).

## 4. Sanity check

```bash
npm test                       # full suite on an in-memory database
ruby scripts/parity_check.rb   # repo structural check
```

Both green means your clone and toolchain are good. The database file is created and migrated
automatically on first run of any command below — there is no separate setup step.

## 5. Seed the watch list

The app ships with an **empty watch list** — it emails stats only for players you add.

```bash
# Search MLB/MiLB by name, then add (--pick chooses from multiple matches, 1-based):
npm run seed -- add --search "Jackson Holliday"
npm run seed -- add --search "Smith" --pick 2

# Or add directly by MLB Stats API personId:
npm run seed -- add --person-id 702616

# NCAA players are added by their stats.ncaa.org stats_player_seq
# (how to find it: Running Bryce → NCAA players):
npm run seed -- add --ncaa-seq 2649785

# See the list; deactivate keeps all history:
npm run seed -- list
npm run seed -- deactivate --person-id 702616
```

**Adding a player is his first Refresh** — his complete current-season game log is fetched and
stored on add (skipped during Offseason Sleep; it catches up automatically when the pipeline
wakes). Note that NCAA's season is February–June, so an NCAA player added in the offseason shows
nothing new until then.

## 6. Refresh and send your first digest

```bash
npm run refresh   # re-ingests every active player's full season game log (idempotent)
npm run digest    # sends every stat line not yet reported, grouped MLB → MiLB → NCAA
```

With `MAILER_PROVIDER=console` the digest prints to your terminal instead of sending. Two behaviors
to know:

- **Report-once:** sending marks lines as reported (even with the console provider), so a second
  `npm run digest` the same day reports nothing new. That's the design — an empty digest is proof
  of life, and one digest is sent per day even when empty.
- **Off-season players are omitted**, not listed as "no new stats".

## 7. Validate the NCAA adapter (one-time)

The NCAA scraper's page selectors were built against reference implementations and want one live
confirmation from your machine:

```bash
npm run ncaa:probe -- --seq 2649785 --season 2025 --type batting
```

It fetches one real stats.ncaa.org game-log page and reports HTTP status, the resolved player
name/school, and parsed row count. A clean parse means NCAA ingestion is fully validated.

## 8. Run the server (REST + MCP)

```bash
npm run server
curl http://localhost:3000/health                              # public
curl -H "Authorization: Bearer $API_TOKEN" \
     http://localhost:3000/api/players                         # token-authed REST
```

The MCP server — the primary interface — is at `http://localhost:3000/mcp` (same bearer token).
Routes and tools: [Running Bryce → The MCP server and REST API](running-bryce.md#the-mcp-server-and-rest-api).

## 9. Go to production

When local testing looks right, follow [Running Bryce](running-bryce.md) to make it permanent:

1. [Scheduling with launchd](running-bryce.md#scheduling-with-launchd) — nightly refresh + morning
   digest, self-healing if the laptop was asleep.
2. Switch the mailer to Postmark and send yourself a real digest.
3. [Litestream backup to R2](running-bryce.md#backup-litestream-to-cloudflare-r2).
4. [Cloudflare Tunnel](running-bryce.md#remote-access-cloudflare-tunnel) +
   [connect a Claude client to the remote MCP endpoint](running-bryce.md#connecting-a-claude-client-to-the-remote-mcp-endpoint)
   — after which the watch list is managed by asking Claude from anywhere.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits immediately on start | `API_TOKEN` missing/blank in `.env` — it fails closed by design |
| `npm run digest` says nothing new | Everything was already reported today (report-once), or all players are out of season |
| Weekly "heartbeat" email instead of a daily digest | Offseason Sleep (World Series → earliest watched opening day) — expected |
| NCAA add/probe fails with a 403 or parse error | stats.ncaa.org edge/selector drift — run the probe and see [Running Bryce → NCAA players](running-bryce.md#ncaa-players) |
| `no bundled stats.ncaa.org season lookup for year N` | Annual update needed in `src/ncaa/seasons.ts` |
