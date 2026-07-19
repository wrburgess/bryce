# Project Handoff: Daily Baseball Digest

> Source: project handoff from the HC (2026-07-19). This is the product spec the lifecycle builds
> against; decisions refined from it are captured in [`CONTEXT.md`](../../CONTEXT.md) and
> [`docs/adr/`](../adr/) via the `distill` skill.

## ⚠️ Architecture revision — 2026-07-19 (supersedes parts of the original below)

Same product (daily digest of MLB/MiLB/NCAA stat lines for a personal watch list), re-scoped the
same day in an architecture session with the HC. Where this section conflicts with the original
handoff below, **this section wins**; the original is kept intact as the product-requirements
record (data sources, data model starting point, digest content, and phasing intent all still
apply).

- **Stack: TypeScript on Node** — not Rails ([ADR 0025](../adr/0025-typescript-node-stack.md)).
  Hono for HTTP, Zod for all boundary contracts, Drizzle for schema/migrations, Vitest for tests.
- **Interface: AI/API-first, no web UI** ([ADR 0027](../adr/0027-mcp-first-interface-no-web-ui.md)).
  Primary surface is an **MCP server** (watch-list tools, stat queries, digest preview, read-only
  SQL); a thin token-authed REST API alongside; the digest email gains an optional LLM-written
  narrative summary. The original Phase 2 web UI is **cancelled**.
- **Storage: SQLite (WAL) + Litestream → R2** ([ADR 0026](../adr/0026-sqlite-over-postgres.md)).
- **Hosting: the HC's MacBook behind a Cloudflare Tunnel**, `launchd`-managed, Cloudflare Access on
  the tunnel ([ADR 0028](../adr/0028-local-macbook-hosting-cloudflare-tunnel.md)). Jobs are
  **self-healing, not punctual**: trailing-window fetches, covered-date-keyed digest delivery,
  idempotent upserts.
- **Email: provider-agnostic mailer** — default Postmark (HC's existing free Developer plan),
  Forward Email SMTP as the alternative. The original "provider TBD" question is resolved.
- **Revised phasing:** Phase 1 — MLB/MiLB pipeline + digest email (unchanged milestone);
  Phase 2 — **MCP server + REST API** (replaces the web UI); Phase 3 — NCAA (unchanged);
  a contained Python analysis annex remains a sanctioned later idea (ADR 0025).
- **Distill deltas (see `docs/domain/CONTEXT.md` + ADRs 0029–0030):** Stat Lines are per-game
  (doubleheader-safe); no date windows — full-season Refresh + report-once Digest, sent daily even
  when empty; out-of-season Players are omitted from the Digest until their games resume.
  **Later idea added:** DNP detection via schedule cross-reference ("sat: 3rd straight game").

## Overview

Build a Rails application that emails me a daily digest of the previous day's stats for a personal
watch list of baseball players across three levels: **MLB, MiLB (all levels), and NCAA**. This is a
single-user personal tool — no auth complexity, no multi-tenancy. Prioritize boring, conventional
Rails over clever custom solutions.

## Stack & Conventions

- **Rails 8** (latest stable), following framework defaults wherever possible
- **Solid Queue** for background jobs, with `config/recurring.yml` for scheduling (no Sidekiq/Redis
  unless a hard requirement emerges)
- **Hotwire (Turbo + Stimulus)** for any interactivity — no React, no heavy JS
- **Bootstrap 5** for styling (cssbundling or the bootstrap gem, whichever is cleaner with the
  current Rails default)
- **SQLite** is fine for this workload unless there's a reason to use Postgres
- **ActionMailer** for the digest email; SMTP config via credentials/env (provider TBD — leave
  configurable, assume something like Postmark/SES/Resend)
- **Faraday** for HTTP clients, **Nokogiri** only if we end up scraping
- Standard testing setup (Minitest is fine); test the API client parsing and the digest assembly
  logic at minimum

## Data Sources

### MLB + MiLB — MLB Stats API (free, no key)

Base: `https://statsapi.mlb.com/api/v1`

The same API covers MLB and all minor league levels via `sportId`:

| sportId | Level |
|---------|-------|
| 1 | MLB |
| 11 | Triple-A |
| 12 | Double-A |
| 13 | High-A |
| 14 | Single-A |
| 16 | Rookie/Complex |

Key endpoints:

- **Player search:** `/people/search?names={query}` — for adding players to the watch list
- **Game logs:** `/people/{personId}/stats?stats=gameLog&group=hitting&season={year}` (also
  `group=pitching`) — the workhorse for daily stat lines. Verify whether `sportId` is needed on this
  call for minor leaguers; test with a real MiLB player ID early.
- **Schedule:** `/schedule?sportId={id}&date={YYYY-MM-DD}` — useful for knowing whether games happened
- **Person details:** `/people/{personId}` — current team, level, position

Be a good citizen: cache responses, don't hammer the API, add a modest delay between calls in the
nightly job.

### NCAA — self-hosted ncaa-api

Use **[henrygd/ncaa-api](https://github.com/henrygd/ncaa-api)** — an open-source JSON API mirroring
ncaa.com paths (scores, box scores, stats, rankings). The public demo instance is rate-limited to
5 req/sec and not meant for reliability, so **self-host it via the provided docker-compose** as part
of this project's infrastructure. It supports an `x-ncaa-key` header for access restriction if
exposed.

Fallback/supplement: `stats.ncaa.org` can be scraped directly (this is what the R `baseballr`
package does for player game logs and season stats). If ncaa-api's box score data proves awkward for
per-player daily lines, replicate baseballr's `ncaa_game_logs` URL patterns in Ruby.

**NCAA caveat to design around:** identifiers and data shapes are messier than MLB's. Player
matching may need school + name rather than a clean numeric ID. Keep the NCAA adapter isolated so
its ugliness doesn't leak into the rest of the app.

## Data Model (starting point)

```
Player
  name, level (enum: mlb, milb, ncaa), external_id (string, nullable for ncaa),
  team_name, school_name (ncaa), position, milb_level (nullable), active (bool),
  notes (text) — why I'm watching this guy

DailyStatLine
  player_id, game_date, opponent, stat_type (enum: batting, pitching),
  stats (json — AB, H, HR, RBI, BB, K, SB / IP, H, ER, BB, K, pitches, decision),
  raw_payload (json — keep the source response for debugging)
  unique index on [player_id, game_date, stat_type]

DigestDelivery
  sent_at, date_covered, player_count, status, error_message — for observability
```

Use a `stats` JSON column rather than 30 nullable columns — the batting/pitching stat sets differ,
and JSON keeps this conventional without a gnarly STI hierarchy. Normalize the keys in the adapter
layer so the mailer view doesn't care about the source.

## Architecture

- `app/services/stats_sources/mlb_stats_api.rb` — client for MLB/MiLB
- `app/services/stats_sources/ncaa.rb` — client/adapter for NCAA
- Both return a common normalized stat-line shape (plain hashes or a small PORO — no dry-rb, no
  interactors)
- `FetchDailyStatsJob` — nightly, iterates active players, fetches yesterday's lines, upserts
  DailyStatLines
- `SendDigestJob` — runs after fetch (chain it or schedule ~30 min later), assembles and sends the
  email
- Schedule both in `config/recurring.yml` — run around 5:00 AM Central so West Coast night games are
  final

## The Digest Email

- One email, HTML (Bootstrap-ish inline styles or a simple hand-rolled table layout — email CSS is
  its own world, keep it plain and readable on iPhone Mail)
- Grouped by level: MLB → MiLB → NCAA
- Each player: name, team, opponent, and their line (e.g., `2-4, HR, 3 RBI` or `6.0 IP, 2 ER, 8 K, W`)
- Players who didn't play: collapse into a single "No game" list at the bottom of each section
- Subject like: `⚾ Daily Digest — Sat Jul 18 — 9 players had games`
- Include a plain-text part

## Simple Web UI (Phase 2, keep minimal)

- CRUD for the watch list (add/remove/deactivate players) — standard scaffold-quality Rails with
  Bootstrap
- Player search backed by the MLB `/people/search` endpoint (Stimulus-powered typeahead is fine)
- A page showing recent stat lines per player
- No auth beyond HTTP basic auth or similar — single user

## Phases

1. **Phase 1 — MLB/MiLB pipeline:** Rails app, Player + DailyStatLine models, MLB Stats API client,
   fetch job, mailer, recurring schedule. Seed the watch list via console. **A working daily email
   for MLB/MiLB players is the milestone.**
2. **Phase 2 — Watch list UI:** CRUD + player search typeahead.
3. **Phase 3 — NCAA:** Stand up self-hosted ncaa-api, build the NCAA adapter, integrate into the
   digest. (Note: NCAA season is Feb–June, so this can be built/tested against historical data in the
   offseason.)
4. **Later ideas (do not build now):** weekly rollups, milestone alerts (first HR, promotion to a new
   level), prospect ranking context.

## Open Questions to Resolve During Build

- Exact game-log endpoint behavior for MiLB players (sportId param handling) — spike this first
- Whether ncaa-api box scores give clean per-player lines or whether we go straight to
  stats.ncaa.org patterns
- Email provider (pick whatever is cheapest/simplest to configure)
- Deployment target — assume Kamal-friendly Docker setup per Rails 8 defaults unless directed
  otherwise
