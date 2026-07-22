# Persist refresh freshness and gate/annotate the digest on it

**Status:** accepted — closes the freshness gap [ADR 0040](0040-exclude-in-progress-games-from-ingestion.md) left open (issue #34, follow-up from #20).

Refresh outcome existed only in memory: `runRefresh` returned a summary and vanished. Digest and
health could therefore report success over **stale or partially refreshed** data — most acutely on a
sleep/wake laptop, where launchd fires the independent Refresh and Digest jobs late and out of order
([ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)). ADR 0040 stopped a *wrong* (in-progress)
line from being ingested; it explicitly did **not** solve a *stale* one — if no Refresh runs after a
game finalizes, the Digest still cannot tell the reader its data is old. This ADR persists Refresh
freshness and makes the Digest read it. (#23 owns per-player/calendar fault isolation; #22 owns
delivery concurrency — this issue owns the persisted freshness and the Refresh→Digest contract.)

## Decision

**Persist every whole-watch-list Refresh as a durable run**, and **gate/annotate the daily Digest** on
the freshness that produces, exposing the state through `/health` and MCP `status`.

**`refresh_runs`, a claimed run with a renewed lease.** A new table records each sweep's `started_at`,
`finished_at` (null while running), `status` (`running` / `ok` / `partial` / `failed`), a renewed
`claimed_at` lease clock, the four counts, and any error — with DB `CHECK` constraints (status enum,
`finished_at IS NULL` **iff** `running`, counts `>= 0`) because invariants belong in the database
(`rules/backend.md`). The claim mirrors [ADR 0034](0034-digest-delivery-claim-at-least-once.md): one
`BEGIN IMMEDIATE` transaction decides eligibility and reserves the run under one write lock, so
exclusion holds across the launchd CLI and the long-lived server. Two differences from the delivery
claim, each load-bearing:

- **Each run owns its OWN row — a stream, not a shared slot.** Two runs never contend for one
  identity, so a superseded run that settles late only ever writes its older row; it cannot corrupt
  the winner's. The freshness watermark is "the latest run by `(started_at, id)`", read fresh, never a
  single mutable cell.
- **The lease is RENEWED after every player.** A fixed lease cannot tell a crashed run from a slow
  one. Renewal keeps a healthy long sweep live (and blocking a concurrent run); a crashed run stops
  renewing and its lease expires after `REFRESH_LEASE_MS`, so the next run recovers without wedging
  shut. An overlapping run under a live lease no-ops with `already-running`.

**Freshness anchors on `started_at` vs the content date — and why.** A digest for a content day is
`fresh` only if a terminal run **started strictly after that day ended** (host date). Under ADR 0040's
forward-clock finality gate — ingest a game only once its date is before host-today — a run that
started after the day was over saw every one of that day's games as final. `finished_at` cannot prove
this: a sweep that began at 23:59 and finished at 00:05 straddles midnight and may have fetched some
players while their games were live, so it is conservatively `stale`. The read is taken **before
assembly**, against the content date (`window.to`, yesterday) — not the delivery slot — which closes
the TOCTOU where a Refresh finishing between the check and the send could forge a false `fresh`.

**Hybrid degrade, never suppression.** A `stale` or `partial` reading **annotates** the same email
that would otherwise have gone out silently — the Digest is never withheld:

- `fresh` (qualifying run `ok`) → no banner.
- `partial` (qualifying run `partial`) → `⚠️ Last refresh was incomplete (N of M watched players
  refreshed) …` — a `partial` must not silently suppress the warning.
- `stale` (no qualifying run) → `⚠️ Data as of last successful refresh: <date|never>; no refresh has
  run since <content date> …`.

Only the scheduled `1d` path gates; an **on-demand** window never annotates (a human asked for a
specific report), orphan recovery annotates against **its own** `window.to`, and the offseason
heartbeat is untouched. A `partial` here means "≥1 watched player was not refreshed"; the per-player
*why* is #23's, kept out of this ADR deliberately.

**Health as a separate DERIVED vocabulary.** `/health` and MCP `status` gain a `refresh` block whose
`state` — `fresh` / `stale` / `running` / `partial` / `failed` — is a **derived** type, distinct from
the stored `RefreshRunStatus`, because `fresh`/`stale` are computed against `now` (which is why
`healthSnapshot` now takes a clock, threaded through both surfaces). A live `running` lease reports
`running`; otherwise the latest terminal run decides, and a **crashed** run (expired lease) reports its
last terminal outcome, never a phantom `running`. The block is `null` before any refresh has run.

## Consequences

- **Deterministic, documented missed/overlap policy** (AC #4): overlap → `already-running` under a
  live renewed lease, or recovery after `REFRESH_LEASE_MS`; a missed refresh → an annotated Digest the
  next Refresh self-heals. Written up in `docs/guides/running-bryce.md`.
- **A false `stale`/`partial` is bounded to an annotation**, never a suppressed digest — the safe
  direction. A single-player backfill (`runRefreshForPlayer`) records **no** run: it is not a
  watch-list-wide freshness claim.
- **Offseason** reads `stale` by design; the heartbeat is the liveness signal.
- Additive migration (`0005`), no backfill, reversible; no change to existing tables.

**Rejected:** gating on `finished_at` (cannot prove finality across a midnight straddle); **blocking**
a stale digest instead of annotating (a silently missing digest is strictly worse than an annotated
one — the same fail-open judgment as ADR 0034's reconciliation); a single shared refresh "slot" (a
late-settling superseded run would corrupt the watermark — the per-run row rules that out by
construction).
