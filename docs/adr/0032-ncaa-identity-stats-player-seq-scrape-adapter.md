# NCAA identity is stats_player_seq in its own column, sourced by an isolated scrape adapter

NCAA baseball has no MLB Stats API `personId`, so Phase 3 gives it a source-native identity of its
own: the stats.ncaa.org `stats_player_seq`, stored in a new nullable, unique `players.ncaa_player_seq`
column. `external_id` stays MLB-only; the two identity columns live side by side so one human is still
one Player row across levels (a recruit who later signs pro keeps his row, gaining an `external_id`
without losing his NCAA history) — never a second Player. NCAA rows carry `external_id = NULL`, MLB/MiLB
rows carry `ncaa_player_seq = NULL`, and SQLite's unique index permits many NULLs on each side.

The data source is a scrape of stats.ncaa.org — there is no official NCAA stats API — reached through
an **isolated adapter** under `src/ncaa/` (client, parser, normalizer, season lookup). Nothing outside
that boundary knows the data came from HTML: the adapter returns the same `NewStatLineRow` shape the
MLB pipeline produces. The **Game ID** follows ADR 0029 — the source contest id when the page exposes
one (a box-score/contest anchor), and a deterministic 31-bit FNV-1a hash of
`seq|date|opponent|row-index-on-date` as a fallback, flagged inside `raw.gameIdSource` so a synthetic
id is never mistaken for a real one. Doubleheaders stay two rows (per-date game numbering), exactly
like MLB.

stats.ncaa.org sits behind Akamai bot protection that rate-limits and IP-bans aggressive clients, so
the adapter's posture is deliberately **unofficial, polite, and loud**: a full modern-browser header
set (the baseballr `.ncaa_headers()` precedent), a generous default delay between requests, the current
`/players/{stats_player_seq}?year_stat_category_id={id}` URL form (isolated in one builder), and
Zod-validated parsing that throws on a malformed/shifted table rather than silently yielding garbage
(ADR 0025). An HTTP-200 Akamai challenge page is a typed source-access failure, never evidence that a
player is missing. The per-season `year_stat_category_id` values and the Division-I opening/closing
dates are **bundled** in `src/ncaa/seasons.ts` and updated once a year; a season with no bundled entry
produces no calendar row and no ingest — NCAA is simply treated as not In Season, logged loudly, never
a silent gap. The live page could not be captured from the build environment (the Akamai interstitial),
so the shipped fixtures are **constructed faithful to the reference implementations**
(billpetti/baseballr `ncaa_game_logs.R`, nathanblumenfeld/collegebaseball `ncaa_scraper.py`); the
`ncaa:probe` CLI validates the real page and parser on the host.
