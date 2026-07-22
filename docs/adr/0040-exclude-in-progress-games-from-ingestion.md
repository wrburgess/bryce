# Exclude in-progress games from ingestion — a date-based finality gate

**Status:** accepted — tightens the ingestion half of [ADR 0030](0030-full-season-refresh-report-once-digest.md) (issue #77).

Refresh re-ingests every active Player's complete current-season game log and upserts idempotently on
the [ADR 0029](0029-per-game-stat-line-identity.md) per-game key. It ingested **every** allowlisted
split unconditionally — with no notion of whether the game was final. The MLB `gameLog` split carries
**no game-status field** (its `game` object is `{gamePk, link, content, gameNumber, dayNight}`; verified
against `test/fixtures/mlb/gamelog_pitching_mlb.json`), and a game appears in the log the moment it
starts, its stats updating live. So a Refresh that ran while a watched player's game was in progress
stored a **partial line as if it were final**. That shipped: a Digest reported Zack Wheeler's start as
`2.2 IP / 2 K` instead of the final `7.0 IP / 9 K, L`, because a mid-game capture was never corrected
before send (on a sleep/wake laptop, launchd fires missed jobs out of order — [ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)).

**Decision:** ingest a game only once its date is strictly **before host-today**. A split whose date is
today may still be in progress, so it is skipped. Because the Digest only ever reports *yesterday*
([ADR 0035](0035-window-selected-digest.md)), holding today's games one day costs nothing: the next
Refresh re-ingests the now-final line and the ADR 0029 upsert overwrites the row in place — the same
eventual-consistency path ADR 0030 already relies on for late finals and scorer corrections. This adds
no API call, schema, or migration; it is one guard beside the existing gameType allowlist in
`refreshPlayer`.

**Scope.** This gate covers the MLB/MiLB `gameLog` ingestion path, where the live-update problem
provably exists. NCAA ingestion is a separate stats.ncaa.org box-score scrape ([ADR 0032](0032-ncaa-identity-stats-player-seq-scrape-adapter.md)),
not a live feed, and is left unchanged.

**What this does NOT solve.** It prevents a *wrong* line, not a *stale* one. If no Refresh runs after a
game finalizes, that game is simply *absent* until one does — better than a wrong partial, but the
Digest still cannot tell the reader its data is stale. Persisting Refresh freshness and gating/annotating
the Digest on it is [issue #34](https://github.com/wrburgess/bryce/issues/34), tracked separately.

**Rejected (for now):** a per-game finality lookup via the schedule endpoint's `status.codedGameState`.
It is more precise — it would ingest a same-day *final* immediately and correctly handle postponements —
but it costs extra API calls and needs live verification of the schedule endpoint's shape across every
swept sportId. The date gate fixes the observed defect with none of that surface; the status lookup can
supersede this ADR later if same-day finals prove worth the cost.
