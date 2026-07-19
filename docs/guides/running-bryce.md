# Running Bryce (Phase 1 — MLB/MiLB pipeline)

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
npm run seed -- list
npm run refresh
npm run digest
```

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
| `TZ` | no | `America/Chicago` | Host timezone for "today" (digest date, season math) |
| `MAILER_PROVIDER` | no | `postmark` | `postmark`, `smtp` (Forward Email), or `console` |
| `POSTMARK_SERVER_TOKEN` | with postmark | — | Postmark server token |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | with smtp | port `465` | SMTP relay credentials |
| `DIGEST_TO` / `DIGEST_FROM` | unless console | — | Digest recipient and sender addresses |
| `MLB_API_DELAY_MS` | no | `500` | Polite delay between MLB Stats API calls |
| `SERVER_PORT` | no | `3000` | Health-check HTTP server port |

## Scheduling with launchd

Two jobs: Refresh (nightly, after West Coast games finish) and Digest (~5 AM Central). Both are
safe to re-run — Refresh is idempotent (ADR 0030) and Digest never double-sends for a covered date.
launchd runs missed jobs on wake, which is exactly what a sometimes-asleep laptop needs.

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

The health stub (`npm run server`, [`src/server.ts`](../../src/server.ts)) binds locally; expose it
without opening ports via a named tunnel:

```sh
cloudflared tunnel create bryce
cloudflared tunnel route dns bryce bryce.example.com
cloudflared tunnel run --url http://localhost:3000 bryce
```

`GET /health` returns `{ ok, players, statLines, lastDelivery }` — a glanceable check that the
laptop, database, and last send are alive. The REST API proper and MCP surface are Phase 2+
([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)).
