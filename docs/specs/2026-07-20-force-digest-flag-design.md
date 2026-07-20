# Force flag for the Digest — design

**Status:** approved, pending implementation
**Date:** 2026-07-20

## Problem

`runDigest` refuses to send twice for the same host-date. That guard is correct in production
(ADR 0030: `DigestDelivery` is the high-water mark, re-runs must not double-send), but it makes the
digest untestable end-to-end after the day's real send has already gone out — you get
`action=skipped reason=already-sent-today` and no email.

A second, subtler blocker sits behind the first. `assembleDigest` selects only Stat Lines with
`digest_delivery_id IS NULL`. A successful send stamps every reported line, so even if the guard
were bypassed the resulting email would render "no new stats" — a real send, but an empty one, which
is not what you want when checking rendering.

Offseason Sleep (ADR 0031) has an equivalent blocker: `runHeartbeat` skips when a heartbeat went out
within the last 7 days.

## Goal

A `force` flag that means exactly one thing: **ignore the "already sent" bookkeeping.** It overrides
the de-duplication guards and nothing else.

## Non-goals

- **Not** an override of the Offseason Sleep decision itself. `sleepWindow` still chooses digest vs.
  heartbeat. Forcing during sleep sends a *heartbeat*, because that is what the system would really
  send. A flag that forced the digest path in December would make test sends lie about production
  behavior and could mask a genuine seasonal bug.
- **Not** a re-report of the full season. Force re-reports the lines covered by *today's* delivery,
  not every line ever sent.
- **Not** persisted to `digest_deliveries`. There is no `forced` column and this design adds none —
  a schema migration is too much permanence for a testing affordance. Force is visible in the run
  result only.
- **Not** gated behind config. See "Why no gate" below.

## Design

### Flag threading

`DigestDeps` gains `force?: boolean`, defaulting to `false`. `runDigest` and `runHeartbeat` both
consult it. No other call-graph shapes change.

### Guard becomes a lookup, not an early return

The existing guard query in `runDigest` already fetches precisely the id the re-report needs. Rather
than discarding it on the skip path, it is retained:

```ts
const priorDeliveryId = await findSentDigestDeliveryId(db, today);
if (priorDeliveryId !== null && !force) {
  return { kind: "digest", action: "skipped", reason: "already-sent-today", ... };
}
```

`findSentDigestDeliveryId(db, date)` is extracted into `src/digest/assemble.ts` and exported, so the
one query definition serves both `runDigest`'s guard and assembly's re-report lookup.

### Assembly widens its novelty predicate

`AssembleDeps` gains `force?: boolean`. When set, `assembleDigest` resolves today's sent digest
delivery itself and widens the filter at `src/digest/assemble.ts:44`:

```ts
const novelty = deliveryId === null
  ? isNull(statLines.digestDeliveryId)
  : or(isNull(statLines.digestDeliveryId), eq(statLines.digestDeliveryId, deliveryId));
```

Assembly resolving the id internally (rather than receiving it) keeps it self-contained, which
matters because the preview surfaces call `assembleDigest` directly with no job wrapper. The cost is
one extra unique-index lookup on forced runs only.

Everything downstream — the ADR 0033 fielding merge, the `noNewStats` tail, `playerCount`,
`reportedIds` — derives from that single row set and follows without further change.

When nothing has been sent today, or today's only delivery is a `failed` one, the lookup yields
`null` and a forced run is byte-for-byte an ordinary run. Force never *adds* anything to a digest
that would have sent normally; it only removes a reason to skip.

### Idempotence falls out of the existing upsert

`digest_deliveries` has a unique index on `(kind, date_covered)`, and the insert already uses
`onConflictDoUpdate`. A forced re-send therefore returns the **same** delivery id, and re-stamping
today's lines writes the value they already hold. The high-water mark cannot move backward. No
special-casing is required on the force path.

### Result reporting

A forced send reports `reason: "forced"` (where an ordinary send reports `null`), so the CLI line
and the REST/MCP response state why the once-a-day contract did not apply. A forced send that then
*fails* keeps the error message as its reason — the failure is the more important fact.

### Surfaces

| Surface | Shape |
|---|---|
| CLI | `npm run digest -- --force` — a bare `process.argv.slice(2).includes("--force")`. Not `seed.ts`'s flag-map parser: this is one valueless boolean. |
| MCP | `send_digest` and `digest_preview` take `DigestInputShape = { force: z.boolean().default(false) }`, added to `src/api/schemas.ts` beside `RefreshInputShape`. |
| REST | `POST /digest/send` accepts optional body `{ "force": true }`, parsed as `/refresh` already does (absent/empty body → `{}`). `GET /digest/preview` accepts `?force=true`. |

Preview accepts `force` for symmetry with send: it is read-only, nearly free, and lets you inspect
what a forced digest would contain without sending. An agent driving the MCP surface (ADR 0027, the
primary interface) should not find the two halves inconsistent.

### Why no gate

Force is ungated on all three surfaces. This is a single-user system that emails its own operator;
the worst outcome of an unintended force is a duplicate message in that operator's inbox. It does
not lose data, does not move the high-water mark (per the upsert above), and has no external side
effect on any third party. A config gate with a fail-closed path in `loadConfig` would be more
machinery than that risk earns, and a CLI-only restriction would block the surface most used.

## Testing

Added to `test/digest.test.ts`, using the existing `fakeClock` / `CapturingMailer` / factory
helpers — no wall-clock waits, no static fixtures (`rules/testing.md`).

- Forced run after a successful send today **sends again**, and the captured mail body contains the
  same stat lines as the first send — asserting content, not just `action=sent`.
- The forced run reports `reason: "forced"`.
- After a forced run, the `digest_deliveries` row count for `(digest, today)` is still 1, its id is
  unchanged, and the affected `stat_lines.digest_delivery_id` values still point at it — the
  high-water-mark invariant, asserted as database state.
- Forced run during Offseason Sleep, inside the 7-day window, sends a **heartbeat** — confirming
  force overrides the weekly guard without overriding the sleep decision.
- Forced preview returns the same lines the forced send would report, and writes nothing: no
  delivery row, no stamped lines.
- Sad path: forced send whose mailer throws records a `failed` delivery, leaves lines unstamped, and
  reports the error message rather than `"forced"`.
- Unforced behavior is covered by the existing suite, which stands as the regression net.

## Files touched

- `src/jobs/digest.ts` — `force` in `DigestDeps`; guard retained rather than early-returned;
  `runHeartbeat` week-check honors force; `reason: "forced"`.
- `src/digest/assemble.ts` — `force` in `AssembleDeps`; exported
  `findSentDigestDeliveryId`; widened novelty predicate.
- `src/api/schemas.ts` — `DigestInputShape`.
- `src/api/routes.ts` — force on `POST /digest/send` and `GET /digest/preview`.
- `src/mcp/server.ts` — force on `send_digest` and `digest_preview`; tool descriptions updated to
  state that force overrides the once-a-day guard.
- `src/cli/digest.ts` — `--force` parsing.
- `test/digest.test.ts` (and preview/API/MCP tests as the surfaces require).
