import { and, desc, eq } from "drizzle-orm";
import { digestDeliveries } from "../db/schema.js";
import { assembleDigest } from "../digest/assemble.js";
import { renderDigest, renderHeartbeat } from "../digest/render.js";
import { hostDate, sleepWindow } from "../domain/season.js";
import type { DeliveryKind } from "../db/schema.js";
import type { LookupResult, MailReceipt, Mailer } from "../mailer/types.js";
import type { Db } from "../db/client.js";
import type { ClaimRefusal, Tx } from "./delivery-claim.js";
import {
  claimDelivery,
  deliveryKey,
  settleFailed,
  settleReconciled,
  settleSent,
} from "./delivery-claim.js";
import { loadActivePlayers, loadCalendars } from "./refresh.js";

export interface DigestDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  tz: string;
  to: string;
  from: string;
}

export interface DigestResult {
  kind: "digest" | "heartbeat";
  action: "sent" | "skipped" | "failed";
  reason: string | null;
  statLineCount: number;
  playerCount: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A send that took over an expired claim reports WHY it ran again (ADR 0034). */
const RECOVERED = "recovered-stale-claim";

/** A recovery the PROVIDER confirmed had already landed: settled, never re-sent. */
const RECONCILED = "reconciled-already-accepted";

/**
 * The Digest (ADR 0030): report every Stat Line not yet reported by a previous
 * Digest — novelty-driven, no date windows — and send daily even when empty.
 * During Offseason Sleep (ADR 0031) a weekly heartbeat replaces it.
 *
 * Delivery runs claim -> assemble -> send -> settle (ADR 0034): the slot is
 * reserved durably BEFORE the provider is called, so two concurrent invocations
 * cannot both send, and a run that dies after acceptance leaves a `sending` row
 * whose lease heals it instead of a silently missing digest.
 */
export async function runDigest(deps: DigestDeps): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const sleep = sleepWindow(calendars, activePlayers, now(), tz);

  if (sleep.sleeping) {
    return runHeartbeat(deps, activePlayers.length, sleep.nextOpeningDay);
  }

  const today = hostDate(now(), tz);
  const claim = claimDelivery(db, {
    kind: "digest",
    dateCovered: today,
    now: now(),
  });
  if (!claim.claimed) {
    return {
      kind: "digest",
      action: "skipped",
      reason: claim.reason,
      statLineCount: 0,
      playerCount: 0,
    };
  }

  // A recovered claim asks the provider whether the crashed attempt already
  // landed BEFORE composing anything — the one case where a send is suppressed.
  if (await reconciled(deps, "digest", today, claim)) {
    return {
      kind: "digest",
      action: "skipped",
      reason: RECONCILED,
      statLineCount: 0,
      playerCount: 0,
    };
  }

  // Pure assembly (src/digest/assemble.ts): what this Digest would report.
  const assembly = await assembleDigest(db, { now, tz });
  const mail = renderDigest({
    date: assembly.date,
    lines: assembly.lines,
    noNewStats: assembly.noNewStats,
  });
  const { reportedIds, playerCount } = assembly;

  let receipt: MailReceipt;
  try {
    receipt = await deps.mailer.send(
      { to: deps.to, from: deps.from, ...mail },
      { deliveryKey: deliveryKey("digest", today) },
    );
  } catch (err) {
    // Send failed: settle the claim as failed, leave every line unmarked — the
    // next run re-claims the slot, retries, and nothing is lost (ADR 0030).
    settleFailed(db, {
      deliveryId: claim.deliveryId,
      errorMessage: errorMessage(err),
      playerCount,
      statLineCount: reportedIds.length,
    });
    return {
      kind: "digest",
      action: "failed",
      reason: errorMessage(err),
      statLineCount: reportedIds.length,
      playerCount,
    };
  }

  // Send succeeded: one transaction marks the delivery and every reported line.
  settleSent(db, {
    deliveryId: claim.deliveryId,
    now: now(),
    playerCount,
    statLineCount: reportedIds.length,
    providerMessageId: receipt.providerMessageId,
    reportedIds,
  });

  return {
    kind: "digest",
    action: "sent",
    reason: claim.recovered ? RECOVERED : null,
    statLineCount: reportedIds.length,
    playerCount,
  };
}

/**
 * Weekly heartbeat during Offseason Sleep: send only if none sent in the last
 * seven days. The rule is evaluated INSIDE the claim transaction — the slot key
 * is (heartbeat, today) but the rule is time-based, so two runs on different
 * days of one week would never collide on the unique index (ADR 0034).
 */
async function runHeartbeat(
  deps: DigestDeps,
  watchedCount: number,
  nextOpeningDay: string | null,
): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const today = hostDate(now(), tz);
  const nowMs = now().getTime();

  const claim = claimDelivery(db, {
    kind: "heartbeat",
    dateCovered: today,
    now: now(),
    precondition: (tx) => heartbeatWithinWeek(tx, nowMs),
  });
  if (!claim.claimed) {
    return {
      kind: "heartbeat",
      action: "skipped",
      reason: claim.reason,
      statLineCount: 0,
      playerCount: watchedCount,
    };
  }

  if (await reconciled(deps, "heartbeat", today, claim)) {
    return {
      kind: "heartbeat",
      action: "skipped",
      reason: RECONCILED,
      statLineCount: 0,
      playerCount: watchedCount,
    };
  }

  const mail = renderHeartbeat({ date: today, playerCount: watchedCount, nextOpeningDay });
  let receipt: MailReceipt;
  try {
    receipt = await deps.mailer.send(
      { to: deps.to, from: deps.from, ...mail },
      { deliveryKey: deliveryKey("heartbeat", today) },
    );
  } catch (err) {
    settleFailed(db, {
      deliveryId: claim.deliveryId,
      errorMessage: errorMessage(err),
      playerCount: watchedCount,
      statLineCount: 0,
    });
    return {
      kind: "heartbeat",
      action: "failed",
      reason: errorMessage(err),
      statLineCount: 0,
      playerCount: watchedCount,
    };
  }

  settleSent(db, {
    deliveryId: claim.deliveryId,
    now: now(),
    playerCount: watchedCount,
    statLineCount: 0,
    providerMessageId: receipt.providerMessageId,
    reportedIds: [],
  });
  return {
    kind: "heartbeat",
    action: "sent",
    reason: claim.recovered ? RECOVERED : null,
    statLineCount: 0,
    playerCount: watchedCount,
  };
}

interface RecoveredClaim {
  deliveryId: number;
  recovered: boolean;
  previousClaimedAt: string | null;
}

/**
 * Reconciliation, shared by both delivery paths (ADR 0034 amendment). Returns
 * true only when the provider POSITIVELY confirmed the crashed attempt already
 * landed — in which case the delivery is settled `sent` here and the caller must
 * not send.
 *
 * STRICTLY FAIL-OPEN. Every other path returns false and the caller sends
 * exactly as it does today:
 *   - a fresh claim, or a `failed`-row retry — nothing crashed, nothing to ask
 *     about; reconciliation is strictly a recovery-path concern;
 *   - a provider with no lookup capability (SMTP, console) — documented
 *     at-least-once, and an absent optional method is how that is expressed;
 *   - `not-found` (including "not indexed yet" — Postmark documents no search
 *     consistency guarantee, so a miss right after acceptance is expected);
 *   - `unavailable` (HTTP error, unreadable body, rejected request, timeout);
 *   - a lookup that throws despite the contract saying it must not.
 *
 * The asymmetry is deliberate and inverted from the rest of ADR 0034: here the
 * dangerous direction is a WRONG "accepted", which suppresses a real send —
 * silent mail loss, strictly worse than the duplicate this avoids. So only a
 * positive confirmation may ever suppress.
 */
async function reconciled(
  deps: DigestDeps,
  kind: DeliveryKind,
  dateCovered: string,
  claim: RecoveredClaim,
): Promise<boolean> {
  if (!claim.recovered) return false;
  const lookup = deps.mailer.findAccepted;
  if (lookup === undefined) return false;

  let result: LookupResult;
  try {
    result = await lookup.call(deps.mailer, deliveryKey(kind, dateCovered), claim.previousClaimedAt);
  } catch {
    // The contract says findAccepted must not throw; a provider that does is
    // still just "we do not know", and not knowing re-sends.
    return false;
  }
  if (result.outcome !== "accepted") return false;

  settleReconciled(deps.db, {
    deliveryId: claim.deliveryId,
    now: deps.now(),
    providerMessageId: result.providerMessageId,
  });
  return true;
}

/**
 * The rolling seven-day rule, run under the claim's write lock. Only `sent`
 * rows count: a `sending` (in-flight or crashed) or `failed` heartbeat must
 * never suppress the next one, or a stuck row would silence the heartbeat
 * indefinitely — exactly the silent loss this design refuses.
 */
function heartbeatWithinWeek(tx: Tx, nowMs: number): ClaimRefusal | null {
  const last = tx
    .select()
    .from(digestDeliveries)
    .where(and(eq(digestDeliveries.kind, "heartbeat"), eq(digestDeliveries.status, "sent")))
    .orderBy(desc(digestDeliveries.sentAt))
    .limit(1)
    .all()[0];
  const lastSentAt = last?.sentAt ?? null;
  if (lastSentAt !== null && nowMs - Date.parse(lastSentAt) < WEEK_MS) {
    return "heartbeat-sent-within-week";
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
