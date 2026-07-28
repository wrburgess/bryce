# An explicit default lane supersedes ADR 0046's implicit default

**Status:** accepted

**Supersedes:** [ADR 0046](0046-named-player-lists-scoped-digests.md) decision 1
(*implicit default — no seeded default row, no backfill*).

A **Lane** is a named player list that additionally carries its own cadence and recipients. Exactly
one live list is the **default lane**, and it is what an **unscoped** command means. The delivery slot
gains the lane as a third key column, so two lanes may digest the same date and one lane still may not
digest it twice.

Concretely ([issue #190](https://github.com/wrburgess/bryce/issues/190), phase 1 of the
[#189](https://github.com/wrburgess/bryce/issues/189) epic):

- `player_lists` gains `is_default`, `refresh_interval_minutes`, `digest_hour`, and `digest_to`, under
  a **partial unique index** `WHERE is_default = 1 AND deleted_at IS NULL` and `CHECK` bounds on both
  cadence columns — declared in the ORM schema so a drizzle table rebuild re-emits them
  (`rules/backend.md`).
- `digest_deliveries` gains `list_id integer NOT NULL REFERENCES player_lists(id)`, and its unique
  index becomes `(kind, date_covered, list_id)`.
- `drizzle/0012` seeds the default lane, enrolls every **active** player in it, and backfills every
  existing delivery row to it.

The three cadence columns ship **inert**: nothing reads them until
[#192](https://github.com/wrburgess/bryce/issues/192) and
[#193](https://github.com/wrburgess/bryce/issues/193). Declaring them now is what keeps the epic to one
migration.

## Why this was asked

ADR 0046 chose an implicit default deliberately: with no list named, every read kept today's exact
path, so named lists cost nothing when unused. That property was right for #70 and is wrong for lanes.

Once a lane carries a **schedule**, "no list named" has to resolve to *something the scheduler can
name*. An implicit default cannot be pointed at a different cohort, cannot carry a digest hour, and
cannot appear in a backup — so the HC could configure a lane and still have the daily digest ignore it.
The default therefore becomes a **row**, with an identity, a name, and a place in the backup.

Making it a row is also what makes it **inspectable**: `lists show` marks it, `set-default` moves it,
and `NoDefaultListError` names the command that repairs it. The implicit version had no state to show
and no failure to report — a database with no default simply behaved like a database with every
player in scope, which is the one outcome an unscoped digest must never have.

## Decisions this fixes

1. **The default is a seeded row, and the migration backfills it.** Reverses ADR 0046 decision 1. The
   lane is named `Watchlist`; if a **live** list already holds that name, the migration appends the
   smallest free integer suffix. It never adopts, renames, or merges into an existing list — silently
   rewriting the HC's curation is worse than an odd name, and failing outright would leave the app
   unable to start. A **soft-deleted** namesake is not a collision (the name index is partial), so the
   plain name is used.

2. **`digest_deliveries.list_id` is `NOT NULL`, and that is load-bearing.** SQLite treats NULLs as
   *distinct* in a unique index, so a nullable `list_id` would permit unlimited
   `(digest, <date>, NULL)` rows and silently void the slot uniqueness
   [ADR 0034](0034-digest-delivery-claim-at-least-once.md)'s durable claim rests on — surfacing as
   duplicate digests. The constraint is carried from the rebuilt table's creation, not tightened
   afterwards, so no window exists in which the column is present and unpopulated.

3. **The provider-side idempotency key carries the lane's IMMUTABLE id — every lane, including the
   default.** `deliveryKey` emits `bryce:<kind>:<date>:list-<id>`. Stale-claim recovery looks this key
   up at the provider to ask whether a crashed attempt already landed, and a positive answer
   *suppresses* the send; two lanes sharing `bryce:digest:<date>` would have one lane's delivered
   message suppress the other's — silent loss, because a suppressed send looks exactly like a
   successful one.

   A draft of this decision exempted the **default** lane, keeping the pre-lane key byte for byte so
   that recovery lookups in flight across the migration boundary — and messages already in the
   provider's history — still resolved. The Reviewer refuted it: that ties the key to `is_default`, a
   flag `set-default` **moves**. Lane A sends a date's digest while default, the HC re-points the
   default at lane B, and B emits A's key; B then crashes after claiming and before sending, its
   recovery finds A's accepted message, and B is settled as delivered having never sent. Silent, and
   reachable through an operation this phase ships.

   What the exemption bought is worth strictly less: it matters only for a slot that is `failed` or
   lease-expired at the instant `0012` runs, which re-sends instead of reconciling — at most **one
   duplicate email, once, loudly**. Delivery is at-least-once by design
   ([ADR 0034](0034-digest-delivery-claim-at-least-once.md)), so a duplicate is the failure this
   project already accepts; a silently skipped digest is the one it does not. Keying on the row id
   makes the collision unconstructable rather than merely unlikely.

4. **The default list cannot be deleted, and the refusal is atomic.** Soft-delete runs as one
   conditional `UPDATE ... WHERE name = ? AND deleted_at IS NULL AND is_default = 0` inside
   `BEGIN IMMEDIATE`; a zero-row result is re-read in the same transaction to tell
   `CannotDeleteDefaultListError` from `UnknownListError`. Reading "is this the default?" and then
   deleting on the answer would delete a list that became the default in the gap, leaving none.

5. **The backup bumps v4 → v5 and the payload's default wins on restore.** Each list carries
   `isDefault` and all three cadence fields; v1–v4 imports are retained. Restore is merge-by-live-name,
   so it clears every live default first and then applies the payload's — a restore is a deliberate act
   of replacement, and letting the database's prior default win would make the restored state depend on
   what happened to be there. A payload with **no `lists` array at all** (v1) states nothing about lists
   and leaves the default alone. A pre-v5 payload that *does* carry lists leaves none, and the restore
   says so, naming `players lists set-default`.

   **The win is announced, never silent.** Payload-wins has one real cost: a restore run months later
   for an unrelated reason — recovering a player deleted by mistake — also re-points the schedule at
   whichever lane was default when the backup was written, and the next digest simply covers a cohort
   the HC did not choose. Database-wins would avoid that but makes the restored state depend on prior
   state, which is the thing a restore exists to eliminate, and it leaves a restore into a fresh
   database with no default at all. So the policy stands and the restore **prints the change**, naming
   both lanes and the `set-default` command that undoes it. The comparison is by list **id** between
   the pre-restore and post-restore endpoints, not by whether the flag was rewritten: merge-by-name
   reuses the incumbent row, so a restore whose payload names the lane that was already default reports
   nothing. When the restore leaves **no** default, the existing no-default warning is the only line —
   it is the same event stated in the form that names the fix.

## Consequences

- **The delivery-slot change lands early and provably inert.** Until #193 routes lane-scoped sends onto
  the claimed path, every row carries the default lane, so the three-column index behaves exactly like
  the two-column one it replaces. A defect after #193 is therefore attributable to #193's behavior
  change rather than to this schema.

- **This phase touches the delivery *writer*, not only the schema.** `claimDelivery` takes a lane, and
  the scheduled digest and the offseason heartbeat resolve the default before claiming. That was not
  optional: with `list_id` `NOT NULL`, a migration that left the writer alone would brick the daily
  digest on its first run.

- **The scheduled path now has a refusal.** A database with no live default raises
  `NoDefaultListError` rather than mailing an unscoped cohort — threaded through REST (409), MCP
  (`isError`), and the CLI (`error:` + exit 1), with a sad path per route (`rules/backend.md`, and the
  [#140](https://github.com/wrburgess/bryce/issues/140) per-route lesson). An **on-demand** report
  takes no slot and so needs no lane; it still runs.

- **The migration rebuilds two tables, and `PRAGMA foreign_keys=OFF` does not help.** drizzle wraps
  every migration in `BEGIN`/`COMMIT`, and SQLite ignores that pragma inside a transaction;
  `defer_foreign_keys` does not rescue it either, because renaming a replacement table into place does
  not decrement the deferred-violation counter. `drizzle/0012` therefore orders its statements so no
  constraint is violated even under immediate enforcement: it parks `list_members`, empties it, swaps
  `player_lists`, and restores the rows verbatim with their ids.

- **Rollback is forward-only once lanes are live.** Before lane-scoped deliveries exist, down is
  lossless. After #193, two rows may legitimately share `(kind, date_covered)`, so recreating the
  two-column unique index would fail or demand deleting delivery history; a down step must abort with
  an operator-actionable error rather than silently merge or drop deliveries. ADR 0046's phrasing that
  such a revert "loses nothing" does not survive this change.

- **`kind: "heartbeat"` rows carry the default lane's id although a heartbeat is not lane-scoped** — one
  liveness signal for the host, riding the lane's slot. A known wart, recorded here rather than
  discovered later.

- **`refresh_interval_minutes` is an interval, not a cron expression.** Decided in this phase because
  changing it later is another migration. The interval avoids a parser dependency and its test surface;
  it cannot express "weekdays only". The seeded lane's `1440` and `digest_hour` of `5` reproduce the
  host's existing `ops/templates` schedule exactly, so the lane describes the behavior the host already
  has rather than proposing a new one.
