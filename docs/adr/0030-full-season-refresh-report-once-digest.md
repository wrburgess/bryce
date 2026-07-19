# Completeness-driven ingestion, novelty-driven reporting — no date windows

The handoff framed the pipeline as "fetch yesterday's stats, email yesterday's digest"; the HC
clarified that "yesterday" was just a phrase — the requirement is to capture all stats for watched
players whenever they become available. So the pipeline has no date windows anywhere. **Refresh**
re-ingests every active Player's complete current-season game log on every run, upserting
idempotently on the ADR 0029 per-game key: late finals, official-scorer corrections, a laptop
asleep for days (ADR 0028), and mid-season player adds (a Player's add is his first Refresh —
instant season backfill) are all the same code path. **Digest** reports every Stat Line not yet
reported by a previous Digest — a late-surfacing line is announced a day late, never lost — with
`DigestDelivery` holding the high-water mark so re-runs cannot double-send. The Digest sends daily
even when empty (on a laptop-hosted system, silence is indistinguishable from breakage); a
correction to an already-reported line updates storage quietly and is not re-announced.

Deliberate rejection: windowed fetching ("trailing N days") — it is an optimization that
reintroduces the very loss modes the full-season re-sweep eliminates, at a scale (tens of players,
one API call each) where the optimization buys nothing. Do not add a window later without
re-reading this.
