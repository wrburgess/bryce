# Force flag for the Digest — design

**Status:** approved, pending implementation
**Date:** 2026-07-20
**Builds on:** ADR 0030 (novelty-driven reporting), ADR 0031 (Offseason Sleep), ADR 0034 (delivery claim)

## Problem

`runDigest` refuses to send twice for the same host-date. That refusal is correct in production
(ADR 0030: `DigestDelivery` is the high-water mark; ADR 0034: the claim makes it exact), but it makes
the digest untestable end-to-end once the day's real send has gone out — you get
`action=skipped reason=already-sent-today` and no email.

A second, subtler blocker sits behind the first. `assembleDigest` selects only Stat Lines with
`digest_delivery_id IS NULL`. A successful send stamps every reported line, so even if the refusal
were bypassed the resulting email would render "no new stats" — a real send, but an empty one, which
is not what you want when checking rendering.

Offseason Sleep (ADR 0031) has an equivalent blocker: the heartbeat's rolling seven-day rule,
evaluated as a claim `precondition`.

## Goal

A `force` flag that means exactly one thing: **ignore the "already sent" bookkeeping.** It overrides
the de-duplication rules and nothing else.

## The central constraint: force does not touch mutual exclusion

`claimDelivery` can refuse for three reasons. Force overrides two of them and **must never** override
the third:

| Refusal | Forced? | Why |
|---|---|---|
| `already-sent-today` | **overridden** | De-duplication bookkeeping. Exactly what force is for. |
| `heartbeat-sent-within-week` | **overridden** | The same bookkeeping, on the ADR 0031 path. |
| `claimed-by-another-run` | **never** | This is ADR 0034's exact-mutual-exclusion guarantee. |

`claimed-by-another-run` means a live, unexpired lease is held by an in-flight run. Overriding it
would put two invocations at the mail provider for one slot simultaneously — precisely the defect
PR #40 was written to eliminate. Force is a statement about *bookkeeping*, not about *concurrency
safety*, and a testing affordance must not be able to reopen a closed correctness hole.

A forced run that collides with a live claim therefore still returns
`action=skipped reason=claimed-by-another-run`. The lease is at most `LEASE_MS` (10 minutes), so this
resolves on its own.

## Non-goals

- **Not** an override of the Offseason Sleep decision itself. `sleepWindow` still chooses digest vs.
  heartbeat. Forcing during sleep sends a *heartbeat*, because that is what the system would really
  send. A flag that forced the digest path in December would make test sends lie about production
  behaviour and could mask a genuine seasonal bug.
- **Not** a re-report of the full season. Force re-reports the lines covered by *today's* delivery,
  not every line ever sent.
- **Not** a new persisted column. Force is visible in the run result only; `attemptCount` already
  records that the slot was re-claimed. A schema migration is too much permanence for a testing
  affordance.
- **Not** gated behind config. See "Why no gate".

## Design

### Flag threading

`DigestDeps` gains `force?: boolean` (default `false`). `ClaimArgs` gains `force?: boolean`. No other
call-graph shapes change.

### The claim admits a forced re-take

In `claimDelivery`, one branch becomes conditional:

```ts
if (existing.status === "sent" && !args.force) {
  return { claimed: false, reason: "already-sent-today" };
}
```

Control then falls through to the **existing** re-claim branch — the one already used for `failed`
retries and recovered `sending` rows. That branch sets `status: "sending"`, bumps `attemptCount`, and
clears `errorMessage` / `providerMessageId`. Force needs no new state machine; it reuses the one
ADR 0034 already built.

Critically, the live-lease check sits in a **separate branch** (`existing.status === "sending"`) that
force does not modify, so mutual exclusion is preserved by construction rather than by remembering to
check for it.

### The heartbeat precondition is omitted, not defeated

`runHeartbeat` passes its rolling seven-day rule as a claim `precondition`. Forcing simply omits it:

```ts
precondition: force ? undefined : (tx) => heartbeatWithinWeek(tx, nowMs),
```

The rule is not weakened or special-cased — it is not asked. Everything else about the claim,
including the lease check, is unchanged.

### Assembly widens its novelty predicate

`AssembleDeps` gains `includeDeliveryId?: number | null`. The filter at `src/digest/assemble.ts:44`
becomes:

```ts
const novelty = includeDeliveryId == null
  ? isNull(statLines.digestDeliveryId)
  : or(isNull(statLines.digestDeliveryId), eq(statLines.digestDeliveryId, includeDeliveryId));
```

`runDigest` passes `force ? claim.deliveryId : null`. **The claim already returns the id**, so the
send path needs no additional query at all.

Everything downstream — the ADR 0033 fielding merge, the `noNewStats` tail, `playerCount`,
`reportedIds` — derives from that single row set and follows without further change.

When nothing has been sent today, or today's only row is `failed`, a forced run is byte-for-byte an
ordinary run: the fresh claim's id matches no existing line, so the predicate collapses back to
`IS NULL`. Force never *adds* anything to a digest that would have sent normally; it only removes a
reason to skip.

### Idempotence still holds — now via the claim

The forced re-claim reuses the **same row** (`existing.id`), so `settleSent` stamps today's lines with
the delivery id they already hold. The high-water mark cannot move backward. This is the same
guarantee as before PR #40, resting now on the claim's re-take rather than on an upsert.

### Result reporting

`reason` is already occupied on the success path by `RECOVERED` (`"recovered-stale-claim"`).
Precedence:

```ts
reason: force ? "forced" : claim.recovered ? RECOVERED : null
```

Force wins because it is the operator's deliberate act and the more salient explanation for why the
once-a-day contract did not apply. A forced send that then *fails* keeps the error message as its
reason — the failure is the more important fact.

### Accepted consequence: a forced run widens the at-least-once window

Re-claiming a `sent` row flips its status to `sending`. Two things follow, both acceptable, both
stated here so they are not discovered later:

1. **While the forced run is in flight**, `/health` reports the day's digest as in-flight rather than
   sent. It settles back to `sent` on completion.
2. **If the forced run dies after provider acceptance**, the slot is left `sending`; the lease heals
   it and the next scheduled run re-sends — a duplicate of a digest that had *already* been
   delivered successfully before the force.

(2) is a new way to enter ADR 0034's documented at-least-once envelope, not a departure from it: the
outcome is a duplicate email to the operator, which that ADR already accepts as bounded and
observable. It is also self-inflicted and testing-only.

### Surfaces

| Surface | Shape |
|---|---|
| CLI | `npm run digest -- --force` — a bare `process.argv.slice(2).includes("--force")`. Not `seed.ts`'s flag-map parser: this is one valueless boolean. |
| MCP | `send_digest` and `digest_preview` take `DigestInputShape = { force: z.boolean().default(false) }`, added to `src/api/schemas.ts` beside `RefreshInputShape`. |
| REST | `POST /digest/send` accepts optional body `{ "force": true }`, parsed as `/refresh` already does (absent/empty body → `{}`). `GET /digest/preview` accepts `?force=true`. |

Preview accepts `force` for symmetry with send: it is read-only, nearly free, and lets you inspect
what a forced digest would contain without sending. An agent driving the MCP surface (ADR 0027, the
primary interface) should not find the two halves inconsistent.

Preview has no claim to draw an id from, so it resolves one via a small exported helper —
`findDeliveryId(db, kind, dateCovered)` in `src/jobs/delivery-claim.ts`, beside the state machine
that owns that table.

Every surface's tool/route description states that force overrides the once-a-day guard **and that it
does not override an in-flight claim** — the seam must not misrepresent the guarantee (`rules/backend.md`).

### Why no gate

Force is ungated on all three surfaces. This is a single-user system that emails its own operator;
the worst outcome of an unintended force is a duplicate message in that operator's inbox. It cannot
lose data, cannot move the high-water mark, cannot breach mutual exclusion, and has no external side
effect on any third party. A config gate with a fail-closed path in `loadConfig` would be more
machinery than that risk earns, and a CLI-only restriction would block the surface most used.

## Testing

Added to `test/digest.test.ts` and `test/delivery-claim.test.ts`, using the existing `fakeClock` /
`CapturingMailer` / factory helpers — no wall-clock waits, no static fixtures (`rules/testing.md`).

**Claim layer**
- Forced claim over a `sent` row succeeds, reuses the same row id, bumps `attemptCount`, and clears
  `providerMessageId`.
- Forced claim against a **live** `sending` lease still refuses with `claimed-by-another-run` — the
  guarantee test. If this passes while the feature is broken, nothing else in the suite would catch it.
- Forced claim over an **expired** `sending` lease behaves exactly as unforced recovery.

**Job layer**
- Forced run after a successful send today sends again, and the captured mail body contains the same
  stat lines as the first send — asserting content, not just `action=sent`.
- The forced run reports `reason: "forced"`, and reports `"forced"` in preference to
  `"recovered-stale-claim"` when both apply.
- After a forced run: still exactly one `digest_deliveries` row for `(digest, today)`, same id, and
  the affected `stat_lines.digest_delivery_id` values still point at it — the high-water-mark
  invariant, asserted as database state.
- Forced run during Offseason Sleep, inside the seven-day window, sends a **heartbeat** — force
  overrides the weekly rule without overriding the sleep decision.
- Forced preview returns the same lines the forced send would report, and writes nothing: no claim,
  no delivery row mutation, no stamped lines.
- Sad path: forced send whose mailer throws settles `failed`, leaves lines unstamped, and reports the
  error message rather than `"forced"`.

Unforced behaviour is covered by the existing suite, which stands as the regression net.

## Files touched

- `src/jobs/delivery-claim.ts` — `force` in `ClaimArgs`; conditional `sent` refusal; exported
  `findDeliveryId`.
- `src/jobs/digest.ts` — `force` in `DigestDeps`; threaded to both claims; heartbeat precondition
  omitted when forced; `includeDeliveryId` passed to assembly; `reason` precedence.
- `src/digest/assemble.ts` — `includeDeliveryId` in `AssembleDeps`; widened novelty predicate.
- `src/api/schemas.ts` — `DigestInputShape`.
- `src/api/routes.ts` — force on `POST /digest/send` and `GET /digest/preview`.
- `src/mcp/server.ts` — force on `send_digest` and `digest_preview`; descriptions updated.
- `src/cli/digest.ts` — `--force` parsing.
- `test/digest.test.ts`, `test/delivery-claim.test.ts`, plus preview/API/MCP surface tests.

## Documentation

ADR 0034 states the delivery guarantee. It gains a short subsection noting that force can re-take a
`sent` slot, that it cannot re-take a live one, and that (2) above is a self-inflicted entry into the
already-documented at-least-once window. `docs/guides/running-bryce.md` gains the `--force` usage.
