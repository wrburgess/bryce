# Delivery is a durable claim with a lease: exact mutual exclusion, at-least-once on crash

Digest and heartbeat delivery used to run check → send → persist with nothing between the check and
the send. Two invocations (the launchd CLI, the MCP `send_digest` tool, the REST route, or two of any
of them) could both pass the "already sent today?" check and both mail the HC; and a process that
died after the provider accepted the mail but before the delivery row was written left no trace at
all, so the next run sent the same digest again with no way to know it had.

Delivery is now **claim → assemble → send → settle**.

## The guarantee

> **Mutual exclusion is exact.** At most one invocation per `(kind, date_covered)` slot may reach the
> mail provider at a time.
>
> **The crash-after-acceptance window is at-least-once.** A delivery whose provider acceptance was
> never durably recorded is re-sent after its lease expires.

A duplicate email is an accepted, bounded, observable outcome. A silently missing digest is not.
That asymmetry is the whole design: every branch that could hold a slot forever was written to
release it instead, because the failure that matters here is silence, not noise.

## The state machine

`digest_deliveries.status` widens from `sent | failed` to `sending | sent | failed`. `sending` is a
**durable claim** on the slot, carrying `claimed_at` (the lease clock) and `attempt_count`.

A speculative `pending` member was drafted and then removed: nothing could write it, and an
unwritable state still forces every consumer of `DeliveryStatus` — the health seam and both surfaces
it feeds — to handle a case that cannot occur. Every member here is reachable.

| Row state at claim time | Decision |
|---|---|
| no row | insert `sending`, `attempt_count = 1` → **claimed** |
| `sent` | **refused**, `already-sent-today` |
| `failed` | re-claim, bump `attempt_count` → **claimed** (today's retry-after-outage path) |
| `sending`, `now - claimed_at < lease` | **refused**, `claimed-by-another-run` |
| `sending`, lease expired | re-claim, bump `attempt_count` → **claimed**, `recovered-stale-claim` |

The claim runs as one `BEGIN IMMEDIATE` transaction (`src/jobs/delivery-claim.ts`), so the read that
decides eligibility and the write that reserves the slot happen under a single write lock; the
existing `digest_deliveries_kind_date_uq` unique index is what makes the reservation exclusive. The
invariant lives in the database, not in app code (`rules/backend.md`). The send never happens inside
that transaction — better-sqlite3 transactions are synchronous, so a network call cannot live in one.

The settle is a second immediate transaction that moves `sending → sent` (with `sent_at`, the counts,
and `provider_message_id`) **and** marks every reported Stat Line in the same statement pair, so a
crash mid-settle rolls both back together. There is no reachable state where a delivery reads `sent`
while its lines went unmarked.

**The lease is 10 minutes** (`LEASE_MS`). The job takes seconds; ten minutes is a wide margin against
a slow provider, and it bounds how long a crashed run can suppress the next one.

**The heartbeat's rolling seven-day rule is evaluated inside the claim transaction.** Its slot key is
`(heartbeat, today)` but its rule is time-based, so two runs on *different* days inside one week
would never collide on the unique index at all — the rule has to be decided under the lock, not
before it. Only `sent` rows count toward the seven days: a `sending` or `failed` heartbeat must never
suppress the next one, or one crash would silence the liveness signal for a week.

## The force flag does not touch any of this

A `force` flag exists so the digest can be re-sent during testing after the day's real send
(`docs/specs/2026-07-20-force-digest-flag-design.md`). It overrides **de-duplication bookkeeping
only**, and it does so without writing:

> When force is what allowed the run to proceed, the run is a **replay**: it sends the mail and
> writes **nothing**. When force was not needed, the run is an ordinary run and records normally.

- **The guarantee above is unchanged.** Force never overrides `claimed-by-another-run`. That refusal
  sits in its own branch, evaluated before anything force can influence — mutual exclusion is
  concurrency safety, not bookkeeping, and a testing affordance must not be able to reopen it. A
  forced run that meets a live lease skips, exactly as an unforced one does.
- **A replay takes no claim, so it settles nothing.** No delivery row is inserted or updated, no
  `attempt_count` moves, no Stat Line is marked. `ClaimResult` is a discriminated union whose replay
  variant cannot be passed to `settleSent`/`settleFailed`, so this is a compile-time property rather
  than a convention. In particular a forced send whose provider *rejects* the mail cannot run
  `settleFailed` over an already-`sent` row — which would have wiped `sent_at` off a genuinely
  delivered digest and left the next scheduled run to re-claim it and mail an empty one.
- **The heartbeat's seven-day clock does not move.** The rolling rule is still evaluated inside the
  claim transaction on a forced run; force only turns its refusal into a replay. A forced heartbeat
  therefore never stamps a new `sent_at`, and the next real liveness signal fires on its original
  schedule.
- **Force-vs-force is unguarded, by design.** Two concurrent forced replays both send, and the
  operator gets two test emails. Both are operator-initiated and neither writes, so the only cost is
  a duplicate the operator asked for; guarding it would mean giving replays a claim, reintroducing
  the settle-path hazard above.

Because a replay writes nothing, it is invisible to the scheduled pipeline: the row still reads
`sent`, so the next scheduled run refuses `already-sent-today` and reports exactly what it would have
reported anyway.

## Why at-least-once, not at-most-once

Between "the provider accepted this mail" and "we durably recorded that it did" there is a window no
amount of local transaction discipline can close — the two facts live in different systems. Something
has to give:

- **At-most-once** (hold the slot, alert, never re-send) trades a duplicate for a *missing* digest,
  and the missing one is invisible until the HC notices days of silence.
- **At-least-once** (re-send after the lease) trades a missing digest for a duplicate, which is
  self-announcing: the HC sees two identical emails and `attempt_count` on the row says why.

We chose at-least-once, and we surface it rather than hide it: `status = "sending"` is reported
through `GET /health` and the MCP `status` tool, `attempt_count` records every re-claim, and the
recovering run returns `reason: "recovered-stale-claim"`.

**Recovery takes two shapes, and only one of them re-claims the row.** A run on the *same date*,
after the lease expires, reclaims the stale `sending` row in place — that is the literal re-send, and
`attempt_count` increments. A run on a *later* date claims a different slot entirely, and the stale
row is simply never reclaimed. Both are safe, for the same reason: the crashed run marked no Stat
Lines, so a later digest reports them regardless (ADR 0030 — novelty-driven, not date-windowed), and
a `sending` heartbeat never counts toward the seven-day rule. The leftover row is a historical
artifact, not a blockage. Given a once-daily schedule the second shape is the common one, so in
practice the duplicate usually arrives as *tomorrow's digest carrying today's lines* rather than as
two identical emails.

Closing the window properly needs provider-side reconciliation — asking the provider "did *this* slot
already land?" before re-sending. This change makes that a pure addition rather than a second
refactor: `Mailer.send(message, context?)` now returns a `MailReceipt` and carries a stable
per-slot `deliveryKey` (`bryce:digest:2026-07-19`) — Postmark as `Metadata`, SMTP as an
`X-Bryce-Delivery-Key` header, the console mailer ignores it. `provider_message_id` is stored on the
settled row. The lookup itself is deliberately **not** built here.

## Operational notes

- `busy_timeout = 5000` is pinned on every connection (`src/db/client.ts`) so a second *process*
  contending for a claim's write lock waits rather than failing. **This pins an existing default
  rather than introducing one:** better-sqlite3 already applies a 5000 ms busy timeout via its
  `timeout` constructor option, verified against the installed version. The explicit pragma is
  defensive against a future driver-default change; deleting it is a no-op today. An earlier draft of
  this ADR claimed the pragma prevented an immediate `SQLITE_BUSY` — that was wrong, and the
  correction is recorded here rather than silently dropped.
- **Lock contention is not covered by the test suite.** better-sqlite3 is synchronous, so two
  connections in one Node process never overlap inside a transaction; the cross-connection test proves
  the claim is *durable in the file*, not that contention resolves. Proving that needs a real second
  process (issue #26's territory).
- The migration (`drizzle/0002_ambiguous_vapor.sql`) is three `ALTER TABLE ... ADD COLUMN`
  statements. `status` has no CHECK constraint, so widening the enum is a TypeScript-level change;
  no existing row is rewritten.
- Rolling the code back with the columns present is safe — the old code never reads them. The only
  forward-incompatible state is a `sending` row, which old code ignores, degrading to exactly
  today's behaviour rather than to a crash.
- What an operator does with a stuck `sending` row is in
  [`docs/guides/running-bryce.md`](../guides/running-bryce.md) → *Stuck deliveries and duplicate
  emails*.
