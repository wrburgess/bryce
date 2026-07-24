# Getting Started

From nothing to your first digest email, step by step. No prior knowledge of this codebase is
assumed — if you can use GitHub, you can run ScoreKeeps Baseball Tracker (the development project is named Bryce). Production operations (scheduling, remote
access, backup) live in [Running Bryce](running-bryce.md); this guide gets you testing locally.

**What Bryce is, in one paragraph:** you keep a personal watch list of baseball players (MLB,
minor league, NCAA). A nightly *Refresh* pulls each player's full season game log; a daily *Digest*
emails a windowed roll-up of the last completed day (or a requested reporting window). There's no web
UI — you manage the watch list from the command line, a small REST API, or by asking Claude
through the built-in MCP server.

## 1. Install the prerequisites

Bryce runs anywhere Node runs; the production setup assumes macOS (launchd scheduling), and these
instructions are written for a Mac.

**Node.js 22 or newer** — pick one:

```bash
# Option A: Homebrew (https://brew.sh)
brew install node

# Option B: the official installer from https://nodejs.org (choose the LTS/Current ≥ 22)
```

Verify:

```bash
node --version    # must print v22.x or higher
npm --version     # any version that comes with it is fine
```

No separate language runtime is needed for the repo's structural check either — it runs on the same
Node toolchain as the app (via `tsx`), so Node ≥ 22 above covers it.

**Git** — you have it if you've used GitHub from this machine (`git --version`; macOS offers to
install the developer tools if not).

No Docker. No database server. Storage is a single SQLite file the app creates itself.

## 2. Get the code

```bash
git clone https://github.com/wrburgess/bryce.git
cd bryce
```

(Or `gh repo clone wrburgess/bryce`, or clone your fork — anything that leaves you inside a
`bryce/` directory works.)

## 3. Install the packages

```bash
npm install
```

This reads `package.json` and downloads every dependency into `node_modules/` (a minute or two on
first run; it prints a summary like `added 300 packages` at the end). Then activate the repo's
git hooks once:

```bash
bin/setup
```

## 4. Create your configuration file

The app reads its settings from a `.env` file that is **never committed** (it will hold secrets
later). Start from the template:

```bash
cp .env.example .env
```

Open `.env` in any editor. For local testing you only need to change **two** lines:

```dotenv
# 1) Print digests to the terminal instead of sending real email — perfect for testing:
MAILER_PROVIDER=console

# 2) Paste in a token (the server refuses to start without one — that's deliberate):
API_TOKEN=paste-the-output-of-the-next-command-here
```

Generate a token and copy the output into `API_TOKEN=`:

```bash
openssl rand -hex 32
# prints something like: 9f2c4a...64 hex characters...b81e
```

Every other line can stay at its default. For reference, what they mean:

| Variable | What it is | Default |
|---|---|---|
| `DATABASE_PATH` | Where the SQLite file lives; created + migrated automatically | `data/bryce.db` |
| `BRYCE_TZ` | Your timezone — defines "today" for digests and season boundaries | `America/Chicago` |
| `MAILER_PROVIDER` | `console` (print), `postmark`, or `smtp` | `postmark` |
| `POSTMARK_SERVER_TOKEN` | Only when provider is `postmark` (see step 9) | empty |
| `SMTP_HOST/PORT/USER/PASS` | Only when provider is `smtp` (e.g. Forward Email) | empty |
| `DIGEST_TO` / `DIGEST_FROM` | Recipient and sender for real email (not needed for `console`) | empty |
| `MLB_API_DELAY_MS` | Politeness delay between MLB Stats API calls | `500` |
| `NCAA_SCRAPE_DELAY_MS` | Politeness delay between stats.ncaa.org requests | `3000` |
| `SERVER_PORT` | Port for the local REST/MCP server | `3000` |
| `API_TOKEN` | Bearer token guarding `/api` and `/mcp`; server fails closed without it | empty |

## 5. Make sure everything works

```bash
npm test
```

Expected: a Vitest run ending in `Tests  225 passed` (a few seconds). Optionally also
`npx tsx scripts/parity-check.ts`, which should print `parity_check: OK`. Green here means your
machine is fully set up. There is no "create the database" step — the first real command below
creates and migrates `data/bryce.db` on its own.

## 6. Add players to your watch list

Bryce ships with an **empty watch list**; it only tracks players you add.

**MLB / minor-league players** — search by name:

```bash
npm run seed -- add --search "Jackson Holliday"
```

If several players match, it prints a numbered list; re-run with `--pick` to choose one:

```bash
npm run seed -- add --search "Smith" --pick 2
```

Adding a player immediately fetches his **entire current-season game log** (his "first Refresh"),
so expect it to take a few seconds and print what it ingested. If you already know a player's MLB
Stats API personId you can use `add --person-id 702616` instead.

**NCAA players** are added by their stats.ncaa.org ID (`stats_player_seq`). Search for the player on
stats.ncaa.org, open the player's page, and copy the `stats_player_seq` value from its URL — see
[Running Bryce → NCAA players](running-bryce.md#ncaa-players) for an example:

```bash
npm run seed -- add --ncaa-seq 2649785
```

Note: NCAA's season is roughly February–June, so an NCAA player added in the offseason has no new
stats until spring — that's normal.

**Manage the list:**

```bash
npm run seed -- list                          # who's being watched
npm run seed -- deactivate --person-id 702616 # stop watching (all history is kept)
npm run seed -- deactivate --ncaa-seq 2649785
```

## 7. Run a Refresh and send your first Digest

```bash
npm run refresh
```

Re-pulls every active player's full season game log and stores it. It's idempotent — running it
twice changes nothing the second time. Expect one polite, throttled API call per player per stat
category.

```bash
npm run digest
```

Builds the default one-day digest for the last completed host date and "sends" it — with
`MAILER_PROVIDER=console` it prints the email (subject, HTML, and plain text) straight to your
terminal. You can request a different Digest window (for example, `npm run digest -- --window 7d`);
the complete supported-window list and syntax live in the [CLI Digest reference](../cli/README.md#digest--build-and-send-a-windowed-digest).

### Choose a Digest variation

A **Window** is the period of completed games to include. Every window ends on yesterday in your
configured timezone, so the result does not depend on the time of day you run it. The default `1d`
window is the scheduled daily Digest; the wider windows are on-demand reports you can ask for at any
time.

| What you want | Command | What happens |
|---|---|---|
| Yesterday's whole watch list | `npm run digest` | The default `1d` daily Digest. It sends at most once per host date. |
| The last week | `npm run digest -- --window 7d` | An on-demand report for the previous seven completed days. Safe to repeat. |
| A longer recent period | `npm run digest -- --window 14d` | Use `14d`, `21d`, `28d`, `35d`, or `60d` for that many completed days. |
| This season so far | `npm run digest -- --window ytd` | An on-demand year-to-date report from the relevant season start through yesterday. |

You can also focus a Digest on a named **list**: a curated subset of your active watch list. Create
the list, add players to it, then pass its name with `--list`:

```bash
npm run players:lists -- create --name Prospects
npm run players:lists -- add --name Prospects --person-ids 691185,700001
npm run digest -- --window 7d --list Prospects
```

A named-list Digest is always on-demand, even with `--window 1d`, so it does not consume or replace
the whole-watch-list daily slot. A list contains only active players; deactivating a player removes
them from every scoped Digest without deleting their history. List names must already exist — a typo
fails without sending a wider, unintended report.

Use `npm run players:lists -- show` to see your lists and their member counts. The [CLI reference]
(../cli/README.md#playerslists--manage-named-player-lists-70) documents renaming, removing members,
and deleting lists. The [Digest reference](../cli/README.md#digest--build-and-send-a-windowed-digest)
has the full flag contract, including `--force` for a deliberate test replay of the scheduled daily
slot.

You should see your players' lines grouped by level, in the fixed format — e.g.
`PA 4, H 2, BB 1, K 1, 2B 0, 3B 0, HR 1, RBI 3, R 2, SB 0, CS 0, E 0` for hitters or
`IP 6.1, ER 2, K 8, K/9 11.4, BB 1, HA 4, HRA 1, ERA 2.84, WHIP 0.79, QS 1, S 0, BS 0, HLD 0, RW 0, RL 0`
for pitchers (every stat always shown, zeros included; ERA/WHIP/K-9 are that game's rates only) —
with in-season players who did not play shown as zero rows when applicable.

Two behaviors that surprise people, both by design:

- **Daily delivery:** the scheduled one-day digest sends at most once per day (yes, even with the
  console mailer); requested multi-day windows are on-demand and can be run again safely. One
  scheduled digest per day, even when empty — an empty digest is proof the pipeline is alive.
- **Out-of-season players are omitted entirely**, not listed under "No new stats". From the World
  Series to the earliest watched opening day the whole pipeline sleeps, and a weekly heartbeat
  email replaces the daily digest.

## 8. Validate the NCAA scraper (one time)

The NCAA page parser needs one live confirmation from your machine:

```bash
npm run ncaa:probe -- --seq 2649785 --season 2025 --type batting
```

It fetches one real stats.ncaa.org game-log page and prints the HTTP status, the player name and
school it resolved, and how many game rows it parsed. A clean parse = NCAA support is fully
validated. (If it fails, the fix is isolated to one file — report the output.) Run it once more
with `--type fielding`: the bundled fielding category ids follow the source's consecutive-id
pattern but are unverified until this probe confirms them
([ADR 0033](../adr/0033-digest-stat-set-single-game-rates-fielding.md)).

## 9. Switch to real email

When the console digest looks right:

1. Sign in to [Postmark](https://postmarkapp.com) → your Server → **API Tokens** → copy the
   Server token.
2. In Postmark, verify a **Sender Signature** for the address you'll send from.
3. In `.env`:

   ```dotenv
   MAILER_PROVIDER=postmark
   POSTMARK_SERVER_TOKEN=your-token
   DIGEST_TO=you@example.com
   DIGEST_FROM=the-verified-sender@example.com
   ```

4. `npm run digest` now emails you. (Prefer SMTP? Set `MAILER_PROVIDER=smtp` and the four `SMTP_*`
   variables instead — any provider works, e.g. Forward Email.)

## 10. Run the server and talk to it

```bash
npm run server
```

Then, from another terminal:

```bash
curl http://localhost:3000/health          # public health check — JSON status
curl -H "Authorization: Bearer YOUR_API_TOKEN" http://localhost:3000/api/players
```

The MCP server — the primary interface — is at `http://localhost:3000/mcp` with the same bearer
token; point a Claude client at it and you can say "add Paul Skenes to my watch list" instead of
using the CLI. Tool list, REST routes, and remote setup: the [MCP](../mcp/README.md),
[REST API](../api/README.md), and [CLI](../cli/README.md) reference pages.

## 11. Make it permanent (production)

Everything so far ran by hand. [Running Bryce](running-bryce.md) covers turning it into the
set-and-forget daily email:

1. [Scheduling with launchd](running-bryce.md#scheduling-with-launchd) — nightly refresh + morning
   digest that self-heal if the laptop was asleep.
2. [Litestream backup to Cloudflare R2](running-bryce.md#backup-litestream-to-cloudflare-r2).
3. [Cloudflare Tunnel](running-bryce.md#remote-access-cloudflare-tunnel) +
   [connecting a Claude client to the remote MCP endpoint](../mcp/README.md)
   — manage the watch list from your phone, from anywhere.

## Updating to a newer version later

```bash
git pull
npm install     # picks up any new dependencies
npm run digest  # database migrations apply automatically on the next run of anything
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `npm install` fails on `better-sqlite3` | Node too old — re-check `node --version` ≥ 22 |
| Server exits immediately on start | `API_TOKEN` missing or blank in `.env` — it fails closed by design |
| `npm run digest` shows no games | No watched player appeared in the selected window; the scheduled daily Digest still sends an empty report, while Offseason Sleep replaces it with a weekly heartbeat |
| Weekly "heartbeat" email instead of a daily digest | Offseason Sleep (World Series → earliest watched opening day) — expected |
| Real email not arriving | `DIGEST_FROM` not a verified Postmark Sender Signature, or wrong server token |
| NCAA add/probe fails with a 403 or parse error | stats.ncaa.org edge/selector drift — run the probe and see [Running Bryce → NCAA players](running-bryce.md#ncaa-players) |
| `no bundled stats.ncaa.org season lookup for year N` | Annual one-line update needed in `src/ncaa/seasons.ts` |
