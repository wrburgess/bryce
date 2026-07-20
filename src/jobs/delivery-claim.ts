import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { DeliveryKind } from "../db/schema.js";
import { digestDeliveries, statLines } from "../db/schema.js";

/**
 * The durable delivery claim (ADR 0034).
 *
 * Delivery is claim -> assemble -> send -> settle. The claim is a row in
 * `digest_deliveries` with `status = "sending"`, taken inside a single
 * `BEGIN IMMEDIATE` transaction so the read that decides eligibility and the
 * write that reserves the slot happen under one write lock. The existing
 * `digest_deliveries_kind_date_uq` unique index is what makes the reservation
 * exclusive — the invariant lives in the database, not in app code
 * (rules/backend.md).
 *
 * The guarantee: mutual exclusion is EXACT — at most one invocation per
 * (kind, date_covered) slot may reach the mail provider at a time. The
 * crash-after-acceptance window is AT-LEAST-ONCE — a delivery whose provider
 * acceptance was never durably recorded is re-sent once its lease expires. A
 * duplicate email is an accepted, bounded, observable outcome; a silently
 * missing digest is not.
 *
 * The send NEVER happens inside a transaction: better-sqlite3 transactions are
 * synchronous, so a network call cannot live inside one.
 *
 * ---------------------------------------------------------------------------
 * FORCE IS A REPLAY, AND A REPLAY WRITES NOTHING.
 *
 * When `force` is what allowed the run to proceed, the run is a REPLAY: it
 * sends the mail and writes NOTHING. When force was not needed, the run is an
 * ordinary run and records normally.
 *
 * A testing affordance must be incapable of degrading production delivery
 * state. The concrete failure this rules out: `settleFailed` sets
 * `status = 'failed', sent_at = NULL`. If a forced run re-claimed an already
 * `sent` row and the mailer then threw, the record of a genuinely delivered
 * email would be destroyed — and the next scheduled run would re-claim that
 * `failed` row and send an EMPTY digest, because the lines it covered are
 * already stamped. The replay design makes that impossible by construction
 * rather than by remembering to check for it: a replay carries no claim to
 * settle, and the `ClaimResult` union below makes settling one a type error.
 *
 * Force NEVER overrides a live lease. That refusal keeps its own branch,
 * evaluated before anything force can influence — it is ADR 0034's
 * exact-mutual-exclusion guarantee, not de-duplication bookkeeping.
 * ---------------------------------------------------------------------------
 */

/** How long a `sending` claim is honored before another run may recover it. */
export const LEASE_MS = 10 * 60 * 1000;

/** The transaction handle drizzle hands a better-sqlite3 transaction callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ClaimResult =
  /** An ordinary run holding a real claim: it settles, and it records. */
  | {
      claimed: true;
      replay: false;
      deliveryId: number;
      /** 1 on a first claim; higher after a retry or a stale-claim recovery. */
      attempt: number;
      /** True when this claim took over a lease that expired mid-flight. */
      recovered: boolean;
      /**
       * The `claimed_at` this claim OVERWROTE — null on a first claim or on a
       * row that never carried one. Captured before the update because it is
       * the crashed attempt's clock: a reconciliation lookup needs it as the
       * lower bound of the provider search, and after the update it is gone.
       */
      previousClaimedAt: string | null;
    }
  /**
   * A forced REPLAY: send the mail, write nothing. There is no claim to settle,
   * and this variant is shaped so that saying otherwise does not compile: it has
   * no `attempt`, and its id field is NAMED DIFFERENTLY (`replayOfDeliveryId`,
   * not `deliveryId`), so `settleSent`/`settleFailed` cannot be reached from it
   * even via a null check — a rename is a barrier a narrowing cannot cross.
   *
   * `replayOfDeliveryId` is the id of the already-`sent` delivery this run is
   * replaying, so assembly can re-include the lines that delivery already
   * reported. It is null whenever there is no such delivery — no row for the
   * slot at all, or a row that is `failed`/`sending` and therefore stamped no
   * lines (which happens when a heartbeat's rolling seven-day rule refused
   * because of a `sent` row for a DIFFERENT date). Null is the ordinary
   * "unreported lines only" predicate, which is exactly right in those cases.
   */
  | { claimed: true; replay: true; replayOfDeliveryId: number | null }
  | { claimed: false; reason: ClaimRefusal };

export type ClaimRefusal =
  | "already-sent-today"
  | "claimed-by-another-run"
  | "heartbeat-sent-within-week";

export interface ClaimArgs {
  kind: DeliveryKind;
  dateCovered: string;
  now: Date;
  leaseMs?: number;
  /**
   * An extra eligibility rule evaluated INSIDE the claim transaction, under the
   * same write lock as the slot reservation. The heartbeat's rolling seven-day
   * rule uses this: its slot key is (heartbeat, today) but its rule is
   * time-based, so two runs on DIFFERENT days inside one week never collide on
   * the unique index — the rule has to be decided under the lock, not before it.
   * Returns a refusal reason to decline the claim, or null to proceed.
   */
  precondition?: (tx: Tx) => ClaimRefusal | null;
  /**
   * Operator override for the de-duplication bookkeeping ONLY (testing
   * affordance). When force is what allows the run to proceed — an
   * `already-sent-today` slot, or a precondition that would have refused — the
   * result is a REPLAY that writes nothing. When the run was eligible anyway,
   * force is unused and the claim is entirely ordinary. Force never overrides a
   * live lease.
   */
  force?: boolean;
}

/**
 * Reserve the (kind, dateCovered) delivery slot, or explain why not.
 * Synchronous by construction: the whole decision is one immediate transaction.
 */
export function claimDelivery(db: Db, args: ClaimArgs): ClaimResult {
  const leaseMs = args.leaseMs ?? LEASE_MS;
  const nowIso = args.now.toISOString();
  const nowMs = args.now.getTime();

  const forced = args.force === true;

  return db.transaction(
    (tx): ClaimResult => {
      const existing = tx
        .select()
        .from(digestDeliveries)
        .where(
          and(
            eq(digestDeliveries.kind, args.kind),
            eq(digestDeliveries.dateCovered, args.dateCovered),
          ),
        )
        .all()[0];

      // A live claim held by another run: refuse, forced or not. This branch is
      // ADR 0034's exact-mutual-exclusion guarantee, so it stands on its own and
      // runs FIRST — before the precondition, and before anything `force` can
      // influence. Overriding it would put two invocations at the mail provider
      // for one slot; force is a statement about bookkeeping, never about
      // concurrency safety. It must also never be tightened into "hold forever":
      // an expired lease is taken over below, which is the only thing standing
      // between this design and a silently missing digest.
      if (
        existing !== undefined &&
        existing.status === "sending" &&
        leaseIsLive(existing.claimedAt, nowMs, leaseMs)
      ) {
        return { claimed: false, reason: "claimed-by-another-run" };
      }

      // The extra rule (the heartbeat's rolling seven days) is always ASKED,
      // even when forced — a forced run must not take a fresh slot and settle
      // it, because that would reset the rolling clock and suppress the next
      // real liveness signal for a week. Force turns its refusal into a replay
      // instead: send now, record nothing, leave the clock where it was.
      const refusal = args.precondition?.(tx) ?? null;
      if (refusal !== null) {
        if (forced) {
          // Only an already-`sent` slot has lines to re-include. A precondition
          // may refuse because of a row that is not this slot's at all (the
          // heartbeat rule reads the latest `sent` heartbeat of ANY date), and
          // this slot's own row may be `failed` or `sending` — stamped nothing,
          // so offering its id would widen the novelty predicate by an id no
          // line carries, and describe a replay of something never delivered.
          const replayOf = existing?.status === "sent" ? existing.id : null;
          return { claimed: true, replay: true, replayOfDeliveryId: replayOf };
        }
        return { claimed: false, reason: refusal };
      }

      if (existing === undefined) {
        const inserted = tx
          .insert(digestDeliveries)
          .values({
            kind: args.kind,
            dateCovered: args.dateCovered,
            sentAt: null,
            status: "sending",
            claimedAt: nowIso,
            attemptCount: 1,
            errorMessage: null,
            createdAt: nowIso,
          })
          .returning({ id: digestDeliveries.id })
          .all()[0];
        if (inserted === undefined) {
          throw new Error(`Failed to claim ${args.kind} delivery for ${args.dateCovered}`);
        }
        return {
          claimed: true,
          replay: false,
          deliveryId: inserted.id,
          attempt: 1,
          recovered: false,
          previousClaimedAt: null,
        };
      }

      if (existing.status === "sent") {
        if (forced) {
          // The whole point of the replay: this row is NOT re-claimed, so its
          // status, sent_at, counts and provider id survive the forced run
          // untouched — including when the mailer then throws.
          return { claimed: true, replay: true, replayOfDeliveryId: existing.id };
        }
        return { claimed: false, reason: "already-sent-today" };
      }

      // Only an EXPIRED `sending` lease reaches here (the live one refused
      // above), so a `sending` row at this point is a stale-claim recovery.
      const recovered = existing.status === "sending";

      // "failed" (retry after a provider rejection) or a recovered "sending" —
      // both re-take the slot and bump the attempt counter.
      //
      // errorMessage, providerMessageId and reconciledAt are cleared here, not
      // left for the settle: a `sending` row describes the attempt IN FLIGHT, so
      // carrying the previous attempt's failure text, provider id, or
      // reconciliation stamp would make the in-flight row lie to /health (the
      // observability this whole design leans on) and would hand the
      // reconciliation pass a stale id to key on. A reconciled row is `sent` and
      // so normally unreachable here — but an operator reopening a slot by hand
      // (docs/guides/running-bryce.md) must not inherit a stamp for a lookup
      // this attempt never made.
      const attempt = existing.attemptCount + 1;
      // Read BEFORE the update overwrites it: the crashed attempt's clock is the
      // only lower bound a reconciliation lookup can search from.
      const previousClaimedAt = existing.claimedAt;
      tx.update(digestDeliveries)
        .set({
          status: "sending",
          claimedAt: nowIso,
          attemptCount: attempt,
          errorMessage: null,
          providerMessageId: null,
          reconciledAt: null,
        })
        .where(eq(digestDeliveries.id, existing.id))
        .run();
      return {
        claimed: true,
        replay: false,
        deliveryId: existing.id,
        attempt,
        recovered,
        previousClaimedAt,
      };
    },
    { behavior: "immediate" },
  );
}

/**
 * The id of the `sent` delivery for a slot, or null when there is none. The
 * preview surfaces need it to widen their novelty predicate the way a forced
 * send does (they hold no claim to read it from); it lives here, beside the
 * state machine that owns the table. Read-only, and synchronous like the rest
 * of this module.
 *
 * `status = "sent"` is part of the question, not an optimization: only a
 * settled delivery ever stamped a Stat Line, so a `failed` or `sending` row's
 * id would widen the predicate by an id no line carries. That is inert today
 * only because `settleSent` is the single writer of `stat_lines`
 * `digest_delivery_id` — filtering here makes the correctness structural
 * instead of resting on that unrelated fact staying true.
 */
export function findDeliveryId(db: Db, kind: DeliveryKind, dateCovered: string): number | null {
  const row = db
    .select({ id: digestDeliveries.id })
    .from(digestDeliveries)
    .where(
      and(
        eq(digestDeliveries.kind, kind),
        eq(digestDeliveries.dateCovered, dateCovered),
        eq(digestDeliveries.status, "sent"),
      ),
    )
    .all()[0];
  return row?.id ?? null;
}

/** A claim is live while its lease has not expired; an unstamped claim is stale. */
function leaseIsLive(claimedAt: string | null, nowMs: number, leaseMs: number): boolean {
  if (claimedAt === null) return false;
  const claimedMs = Date.parse(claimedAt);
  if (!Number.isFinite(claimedMs)) return false;
  return nowMs - claimedMs < leaseMs;
}

export interface SettleSentArgs {
  deliveryId: number;
  now: Date;
  playerCount: number;
  statLineCount: number;
  providerMessageId: string | null;
  /** stat_lines.id to mark reported in the SAME transaction as the delivery. */
  reportedIds: number[];
}

/**
 * Settle a claim as `sent`. One immediate transaction marks the delivery and
 * every reported Stat Line, so a crash mid-settle rolls both back together and
 * the lease heals the slot — never a delivery marked sent with unmarked lines.
 */
export function settleSent(db: Db, args: SettleSentArgs): void {
  const nowIso = args.now.toISOString();
  db.transaction(
    (tx) => {
      tx.update(digestDeliveries)
        .set({
          sentAt: nowIso,
          playerCount: args.playerCount,
          statLineCount: args.statLineCount,
          status: "sent",
          providerMessageId: args.providerMessageId,
          errorMessage: null,
        })
        .where(eq(digestDeliveries.id, args.deliveryId))
        .run();
      if (args.reportedIds.length > 0) {
        tx.update(statLines)
          .set({ digestDeliveryId: args.deliveryId })
          .where(inArray(statLines.id, args.reportedIds))
          .run();
      }
    },
    { behavior: "immediate" },
  );
}

export interface SettleReconciledArgs {
  deliveryId: number;
  now: Date;
  providerMessageId: string | null;
}

/**
 * Settle a recovered claim as `sent` because the PROVIDER confirmed the crashed
 * attempt already landed — no second email (ADR 0034 amendment).
 *
 * It marks NO Stat Lines, and that is the load-bearing decision. The crashed
 * attempt emailed a set of lines we never recorded; Refresh may have run since,
 * so today's assembly can contain lines that were never in that email. Marking
 * those would report them as delivered when they were not — silent CONTENT
 * loss, the exact failure this whole design refuses. Marking nothing costs a
 * repeat of the crashed email's content in the next digest; content is
 * duplicated, never lost.
 *
 * The counts are zeroed for the same reason: this run composed nothing, so it
 * records nothing. `reconciled_at` is what lets an operator tell "we sent this"
 * from "the provider told us it was already accepted".
 */
export function settleReconciled(db: Db, args: SettleReconciledArgs): void {
  const nowIso = args.now.toISOString();
  db.transaction(
    (tx) => {
      tx.update(digestDeliveries)
        .set({
          sentAt: nowIso,
          reconciledAt: nowIso,
          playerCount: 0,
          statLineCount: 0,
          status: "sent",
          providerMessageId: args.providerMessageId,
          errorMessage: null,
        })
        .where(eq(digestDeliveries.id, args.deliveryId))
        .run();
    },
    { behavior: "immediate" },
  );
}

export interface SettleFailedArgs {
  deliveryId: number;
  playerCount: number;
  statLineCount: number;
  errorMessage: string;
}

/**
 * Settle a claim as `failed` after the provider rejected the send: the slot is
 * released for the next run (a `failed` row is re-claimable) and every line
 * stays unmarked, so nothing is lost (ADR 0030).
 */
export function settleFailed(db: Db, args: SettleFailedArgs): void {
  db.transaction(
    (tx) => {
      tx.update(digestDeliveries)
        .set({
          sentAt: null,
          playerCount: args.playerCount,
          statLineCount: args.statLineCount,
          status: "failed",
          errorMessage: args.errorMessage,
        })
        .where(eq(digestDeliveries.id, args.deliveryId))
        .run();
    },
    { behavior: "immediate" },
  );
}

/**
 * Stable per-slot key handed to the mail provider. Stable — not per-attempt —
 * so a future reconciliation can ask the provider "did THIS slot land?" and get
 * one answer for every attempt at it.
 */
export function deliveryKey(kind: DeliveryKind, dateCovered: string): string {
  return `bryce:${kind}:${dateCovered}`;
}
