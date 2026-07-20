# Force flag for the Digest — design (Option A: forced runs are replays)

**Status:** approved, implemented
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

## The core rule

> When `force` is what allowed the run to proceed, the run is a **replay**: it sends the mail and
> writes **NOTHING**. When force was not needed, the run is an ordinary run and records normally.

A testing affordance must be *incapable* of degrading production delivery state — not merely careful
about it. The rule is stated in `src/jobs/delivery-claim.ts` and enforced by the type system (below).

### Why "re-claim the sent row and settle it" was rejected

The obvious design — let a forced run re-take the `sent` slot through ADR 0034's existing re-claim
branch, then settle it as usual — loses data on the sad path, and loses it silently:

1. Today's digest sends for real. The row reads `sent`, `sent_at` stamped, lines marked.
2. An operator forces a test send. The row is re-claimed: `status = 'sending'`.
3. The mail provider rejects it. `settleFailed` sets **`status = 'failed', sent_at = NULL`** — the
   record of a genuinely delivered email is now destroyed.
4. The next scheduled run sees a `failed` row, re-claims it, and sends. Every line that digest
   covered is *already stamped*, so what goes out is an **empty digest**.

The operator ends up with a lost delivery record and an empty email, from a flag whose entire purpose
was to be harmless. Nothing in step 3 is exotic: a provider outage during a test send is exactly the
scenario force gets used in. The replay design makes the whole sequence unreachable by construction —
there is no claim to settle, so there is nothing to settle wrongly.

## The claim decision table

| Row state | `force=false` | `force=true` |
|---|---|---|
| no row | insert `sending` → **claimed** | same (force unused) |
| `failed` | re-claim, bump attempt → **claimed** | same (force unused) |
| `sending`, lease **LIVE** | refuse `claimed-by-another-run` | **refuse `claimed-by-another-run` — UNCHANGED** |
| `sending`, lease expired | re-claim → **claimed**, recovered | same (force unused) |
| `sent` | refuse `already-sent-today` | **REPLAY** (send, write nothing) |
| heartbeat weekly rule would refuse | refuse `heartbeat-sent-within-week` | **REPLAY** (send, write nothing) |

Read the right-hand column as one sentence: force changes the outcome **only** where the outcome was
de-duplication bookkeeping. Every other row is untouched, which is why a forced run that was eligible
anyway is byte-for-byte an ordinary run.

The live-lease refusal keeps its **own branch**, evaluated before anything force can influence. That
is ADR 0034's exact-mutual-exclusion guarantee, not bookkeeping: overriding it would put two
invocations at the mail provider for one slot — precisely the defect the claim was built to
eliminate. Force is a statement about *bookkeeping*, never about *concurrency safety*.

A forced run that collides with a live claim therefore still returns
`action=skipped reason=claimed-by-another-run`. The lease is at most `LEASE_MS` (10 minutes), so it
resolves on its own.

## The type change: "never settle a replay" is compiler-enforced

```ts
export type ClaimResult =
  | { claimed: true; replay: false; deliveryId: number; attempt: number; recovered: boolean }
  | { claimed: true; replay: true;  replayOfDeliveryId: number | null }
  | { claimed: false; reason: ClaimRefusal };
```

The replay variant has no `attempt` and **no `deliveryId` field at all**. `runDigest` guards both
settles with `if (!claim.replay)`, and TypeScript narrows `deliveryId` to `number` inside — so
calling `settleSent`/`settleFailed` on a replay is a *type error*, not a code-review item. The rule
"a replay writes nothing" cannot be forgotten in a later edit.

**The rename is what makes that true.** An earlier draft gave the replay arm a nullable `deliveryId`
and claimed the same guarantee; it did not hold, because a null check narrows it right back:

```ts
if (claim.deliveryId !== null) settleFailed(db, { deliveryId: claim.deliveryId, … }); // compiled!
```

That is the data-loss path this design exists to eliminate, reintroduced by a line that type-checks.
A *differently named* field cannot be passed to a `deliveryId` parameter under any narrowing, so the
barrier is structural rather than nominal.

`replayOfDeliveryId` is the id of the already-`sent` delivery being replayed, purely so assembly can
re-include the lines that delivery reported. It is null whenever there is no such delivery: no row
for the slot (a forced heartbeat on a day with no heartbeat row), or a row that is `failed` or
`sending` and therefore stamped no lines — which is what a heartbeat refusal sourced from a *different
date's* `sent` row looks like. Null is the ordinary "unreported lines only" predicate, which is the
correct answer in each of those cases.

## The heartbeat precondition is asked, not omitted

`runHeartbeat` passes its rolling seven-day rule as a claim `precondition`, **always** — forced or
not. `claimDelivery` decides that a force-overridden precondition refusal means REPLAY.

Omitting the rule when forced (`precondition: force ? undefined : …`) reads simpler and is wrong. A
forced heartbeat runs on a day that usually has **no heartbeat row**, so with the rule omitted the
claim takes a *fresh* `(heartbeat, today)` slot and settles it — stamping a new `sent_at` and
**restarting the rolling seven-day clock**. The next genuine liveness signal is then suppressed for a
week. The failure is invisible at the moment it happens: the test send works fine, and the damage is
a week of silence starting later. Passing the rule always, and treating its refusal as a replay,
keeps the clock exactly where the last real heartbeat left it.

## Assembly widens its novelty predicate

`AssembleDeps` gains `includeDeliveryId?: number | null`, and the novelty filter widens from
`IS NULL` to `IS NULL OR = includeDeliveryId`:

```ts
const novelty =
  includeDeliveryId === null
    ? isNull(statLines.digestDeliveryId)
    : or(isNull(statLines.digestDeliveryId), eq(statLines.digestDeliveryId, includeDeliveryId));
```

`runDigest` reads the id off whichever arm it holds (`claim.replay ? claim.replayOfDeliveryId :
claim.deliveryId`) — **the claim already returns it**, so the send path needs no extra query. On an
ordinary claim, no line is stamped with that id yet, so the predicate collapses back to `IS NULL`:
force never *adds* anything to a digest that would have sent normally, it only removes a reason to
skip.

Everything downstream — the ADR 0033 fielding merge, the `noNewStats` tail, `playerCount`,
`reportedIds` — derives from that single row set and follows without further change.

The field is **optional**, which means a call site that forgets it fails *open and silently*: a
forced preview would return an empty digest and look merely uneventful. Both preview surfaces
therefore go through one shared helper, `previewDeliveryId(db, deps, force)` in
`src/digest/assemble.ts`, which resolves the slot id via `findDeliveryId(db, kind, dateCovered)`
(exported from `src/jobs/delivery-claim.ts`, beside the state machine that owns that table). Preview
holds no claim, so it must look the id up; sharing the helper is what keeps REST and MCP from
drifting.

`findDeliveryId` filters on `status = "sent"`. Only a settled delivery ever stamped a Stat Line, so a
`failed` or `sending` row's id would widen the predicate by an id no line carries. That is inert
today — `settleSent` is the sole writer of `stat_lines.digest_delivery_id` — but resting a preview's
correctness on a fact about a different module is exactly the sort of load-bearing coincidence that
breaks quietly later. The filter states the requirement where it is relied on, and two tests pin it.

## Line marking under replay

**A replay marks nothing** — including any genuinely new, never-reported line that arrived since the
real send. Such a line **is included in the forced email** (it satisfies `IS NULL`) but is **not
stamped**, so the next real digest still reports it.

This is the right behaviour for a test send: the operator sees current content, and no production
reporting is consumed by a test. The alternative — stamping those lines — would mean a test send
could silently swallow a line the HC never received in a real digest.

## Concurrency analysis

| Race | Outcome | Verdict |
|---|---|---|
| Forced run vs a **live scheduled claim** | Forced run refused `claimed-by-another-run` | Guarantee intact |
| Scheduled run vs an **in-flight forced replay** | The row still reads `sent` (the replay writes nothing), so the scheduled run refuses `already-sent-today` | Correct |
| **Forced replay vs forced replay** | Both send; two test emails | **ACCEPTED** (below) |

Force-vs-force is unguarded by design. Both runs are operator-initiated, both are replays, and
**neither writes**, so the only consequence is two copies of a test email in the operator's own
inbox. Guarding it would mean giving replays a claim — reintroducing exactly the settle-path hazard
this design removes, to prevent a duplicate the operator caused on purpose. Documented rather than
prevented.

Note what the middle row means in practice: a forced replay is *invisible* to the scheduled pipeline.
It cannot make a scheduled run skip, cannot make one send, and cannot change what one reports.

## Non-goals

- **Not** an override of the Offseason Sleep decision. `sleepWindow` still chooses digest vs.
  heartbeat. Forcing during sleep sends a *heartbeat*, because that is what the system would really
  send. A flag that forced the digest path in December would make test sends lie about production
  behaviour and could mask a genuine seasonal bug.
- **Not** a re-report of the full season. Force re-reports the lines covered by *today's* delivery,
  not every line ever sent.
- **Not** a new persisted column, and not a new delivery row. A replay leaves the table exactly as it
  found it; `reason: "forced"` on the run result is the only trace.
- **Not** gated behind config. See "Why no gate".

## Surfaces

| Surface | Shape |
|---|---|
| CLI | `npm run digest -- --force` — an exported, pure `parseForce(argv)`; one valueless boolean, so a bare `includes`, not `seed.ts`'s flag-map parser. The entrypoint is `runDigestCli(argv, deps)` with `main()` building the real deps, matching `runSeed`/`runProbe`, so the *wiring* is testable and not only the parse. |
| MCP | `send_digest` and `digest_preview` take `DigestInputShape` (`{ force: z.boolean().default(false) }`) and re-parse with `DigestInputSchema.parse(args)` inside `guarded()`, matching `run_refresh`. |
| REST | `POST /api/digest/send` reads an optional `{"force": true}` body via the `/refresh` raw-text pattern (absent/empty body → `{}`), so every existing no-body caller keeps working; malformed JSON is a 400, never a silent force. `GET /api/digest/preview?force=true`. |

### The GET query param is a string enum, not a coerced boolean

`?force=` uses `z.enum(["true", "false"])`, **not** `z.coerce.boolean()`. Coercion is JS truthiness,
under which the non-empty string `"false"` is `true` — so `?force=false` would *force*. That is a
trap that reads as correct in review and fails in the direction of sending unwanted mail. The
codebase already has the right precedent in `PlayersListInputSchema` (`active` as string literals),
and `test/api.test.ts` carries the regression test.

MCP is a separate schema because MCP inputs are typed JSON: a client sending `force: "yes"` should be
told it is wrong, not obeyed.

Preview accepts `force` for symmetry with send: it is read-only, nearly free, and lets you inspect
what a forced digest would contain without sending. An agent driving the MCP surface (ADR 0027, the
primary interface) should not find the two halves inconsistent.

Every tool/route description states what force overrides **and** that it does not override an
in-flight claim or the Offseason Sleep decision — a seam must not misrepresent the guarantee
(`rules/backend.md`).

### Why no gate

Force is ungated on all three surfaces. This is a single-user system that emails its own operator;
the worst outcome of an unintended force is a duplicate message in that operator's inbox. Under the
replay design it cannot lose data, cannot write to the database at all, cannot move the high-water
mark, cannot breach mutual exclusion, and has no external side effect on any third party. A config
gate with a fail-closed path in `loadConfig` would be more machinery than that risk earns, and a
CLI-only restriction would block the surface most used.

## Testing

All in the existing suite with the existing helpers (`fakeClock`, `CapturingMailer`, factories) — no
wall-clock waits, no static fixtures (`rules/testing.md`). Claim coverage lives in
`test/digest.test.ts`, under `describe("forced delivery")`.

**Claim layer** — forced claim over `sent` returns `replay: true` and leaves the row byte-identical
(status, sentAt, counts, providerMessageId, attemptCount); forced claim against a **live** `sending`
lease still refuses `claimed-by-another-run`; forced claim over an expired lease, over a `failed`
row, and with no row at all are each ordinary (`replay: false`) claims. `replayOfDeliveryId` is
pinned on the precondition path both ways: the slot's id when that slot is `sent`, and null when it
is `failed` (a refusal sourced from another date's row).

**Branch order** — the digest kind passes no precondition, so a forced-digest live-lease test reaches
the live-lease refusal under *either* ordering and cannot pin it. A **heartbeat** that is both
live-leased and inside the seven-day window can: the two branches disagree, so only the order decides
the outcome. Forced and unforced versions of that case are both asserted, and the unforced one also
pins the `claimed-by-another-run` reason string the hoist changed.

**Digest job** — a forced run after a same-day send re-sends, asserted on the **rendered stat lines
in the mail body**; it reports `reason: "forced"` in preference to `"recovered-stale-claim"`; the
delivery row afterwards is identical (one row, same id, same `sent_at`, same counts, same provider
id) with lines still stamped by the original; new unreported lines are included but left unstamped
and are still reported by the next scheduled run.

**Regressions, named as such** — a forced send whose mailer throws returns `action: "failed"` while
the delivery row stays `sent` with its original `sent_at` (the data-loss case above); a forced
heartbeat does not move the seven-day clock, so the next legitimate heartbeat fires on its original
schedule (the clock-reset case above).

**Surfaces** — forced preview matches a forced send and writes nothing; `previewDeliveryId` resolves
a `sent` row and ignores a `failed` or `sending` one; REST force via body, no-body unchanged,
malformed JSON and wrong-typed force both 400; `?force=true` forces and `?force=false` does not (the
coercion trap); MCP both tools accept `{force: true}` and reject a wrong-typed one; `/health`
unchanged by a forced run. On the CLI, `parseForce` is unit-tested *and* `runDigestCli(["--force"],
deps)` is driven end to end against a `testDb` + `CapturingMailer` — a same-day re-run mails a second
time, and the unforced control does not. Dropping `force` from the wiring used to leave the suite
green; it no longer does.

Each of these was mutation-checked against the design it rejects: re-claiming the `sent` row fails
seven tests, omitting the heartbeat precondition fails the clock-reset test, moving the live-lease
refusal back below the precondition fails the heartbeat branch-order pair, giving the replay arm a
nullable `deliveryId` lets a `settleFailed` call compile again, and dropping the `sent` filter from
`findDeliveryId` fails both `previewDeliveryId` status tests.

## Files touched

- `src/jobs/delivery-claim.ts` — `force` in `ClaimArgs`; `ClaimResult` discriminated union with the
  replay arm's `replayOfDeliveryId`; replay branches; live-lease refusal hoisted into its own leading
  branch; exported `findDeliveryId`, filtered to `sent`.
- `src/jobs/digest.ts` — `force` in `DigestDeps`, threaded to both claims; both settles guarded by
  `!claim.replay`; `includeDeliveryId` passed to assembly; `reason` precedence.
- `src/digest/assemble.ts` — `includeDeliveryId` in `AssembleDeps`; widened novelty predicate;
  `previewDeliveryId` helper shared by both preview surfaces.
- `src/api/schemas.ts` — `DigestInputShape` / `DigestInputSchema` / `DigestQueryInputSchema`.
- `src/api/routes.ts`, `src/mcp/server.ts` — two of the three surfaces.
- `src/cli/digest.ts` — the third: refactored to `runDigestCli(argv, deps)` + a thin `main()`.
- `test/digest.test.ts`, `test/digest-preview.test.ts`, `test/api.test.ts`, `test/mcp.test.ts`,
  `test/server.test.ts`, `test/cli-digest.test.ts`.

## Documentation

ADR 0034 gains a short force subsection (a replay writes nothing; the guarantee is unchanged;
force-vs-force is unguarded by design) plus a note on the branch reorder — that it changed one
unforced refusal *reason* from `heartbeat-sent-within-week` to `claimed-by-another-run`, and that a
live lease now skips the precondition entirely, so preconditions must stay side-effect-free reads.
`docs/guides/running-bryce.md` gains
`npm run digest -- --force` and the note that forcing during the offseason sends a heartbeat.
