import { and, desc, eq } from "drizzle-orm";
import { digestDeliveries } from "../db/schema.js";
import { assembleDigest } from "../digest/assemble.js";
import { renderDigest, renderHeartbeat } from "../digest/render.js";
import { hostDate, sleepWindow } from "../domain/season.js";
import type { WindowSpec } from "../domain/window.js";
import type { DeliveryKind } from "../db/schema.js";
import type { LookupResult, MailReceipt, Mailer } from "../mailer/types.js";
import type { Db } from "../db/client.js";
import type { ClaimRefusal, ClaimResult, Tx } from "./delivery-claim.js";
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
  /** Which date window this run reports. */
  spec: WindowSpec;
  /**
   * Operator override of the once-a-day / once-a-week bookkeeping (testing).
   * When force is what let the run proceed, the run is a REPLAY: it sends and
   * writes NOTHING (see src/jobs/delivery-claim.ts). It never overrides an
   * in-flight claim, and never overrides the Offseason Sleep decision.
   */
  force?: boolean;
}

export interface DigestResult {
  kind: "digest" | "heartbeat";
  action: "sent" | "skipped" | "failed";
  reason: string | null;
  statLineCount: number;
  playerCount: number;
  /**
   * The resolved window label, or null when this run never assembled one — a
   * heartbeat (which covers no window at all) or a digest that was refused
   * before assembly. Reporting a label for a run that composed nothing would
   * describe content that was never selected.
   */
  window: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A send that took over an expired claim reports WHY it ran again (ADR 0034). */
const RECOVERED = "recovered-stale-claim";

/** A recovery the PROVIDER confirmed had already landed: settled, never re-sent. */
const RECONCILED = "reconciled-already-accepted";

/**
 * A send the operator asked for explicitly. It outranks RECOVERED as the
 * explanation for a re-send: force is the deliberate act and the more salient
 * fact about the run, and the row itself still records the rest. Reported
 * whenever force was PASSED, including when the run turned out not to need it —
 * "you asked for this one" is true either way, and is what a log reader wants.
 */
const FORCED = "forced";

/**
 * The Digest: report every Stat Line in a DATE WINDOW, and send daily even when
 * empty. During Offseason Sleep (ADR 0031) a weekly heartbeat replaces it.
 *
 * Selection is by window, not by novelty (superseding ADR 0030): the run
 * consumes nothing and stamps nothing, so re-running a window is always safe
 * and always reports the same content.
 *
 * Delivery runs claim -> assemble -> send -> settle (ADR 0034): the slot is
 * reserved durably BEFORE the provider is called, so two concurrent invocations
 * cannot both send, and a run that dies after acceptance leaves a `sending` row
 * whose lease heals it instead of a silently missing digest. The delivery slot
 * is still keyed by the RUN's host date; the content covers the window ending
 * the day before.
 *
 * `deps.force` is a testing affordance over the de-duplication bookkeeping. A
 * run that only proceeded BECAUSE of it is a replay: it sends and skips BOTH
 * settles, so no production delivery state can be degraded by a test send.
 */
export async function runDigest(input: DigestDeps): Promise<DigestResult> {
  // ONE clock read for the whole run. Every later `now()` returns this instant.
  //
  // The run reads the clock for sleep, the slot date, the claim, assembly, the
  // In Season filter and settlement. Read live, those can straddle midnight: a
  // run starting at 23:59:59.9 claims yesterday's slot and then assembles
  // today's window, so the same content goes out under two different slots on
  // two consecutive days. Freezing the anchor makes slot identity and content
  // identity provably the same decision.
  //
  // Settlement timestamps are the one thing that may legitimately want the real
  // completion time; they are recorded from this anchor deliberately, because a
  // delivery's row should describe the run, not the instant the write landed.
  const runAt = input.now();
  const deps: DigestDeps = { ...input, now: () => runAt };
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
    force: deps.force,
  });
  if (!claim.claimed) {
    return {
      kind: "digest",
      action: "skipped",
      reason: claim.reason,
      statLineCount: 0,
      playerCount: 0,
      window: null,
    };
  }

  // A recovered claim asks the provider whether the crashed attempt already
  // landed BEFORE composing anything — the one case where a send is suppressed.
  //
  // A REPLAY never reconciles. The slot it replays HAS landed — that is its
  // premise — so a lookup would answer "accepted" and suppress the very send the
  // operator asked for, and settleReconciled WRITES: it would stamp a fresh
  // sent_at/reconciled_at on the delivered row and reset its counts to 0, the
  // exact degradation the replay design exists to prevent.
  //
  // Two things currently stop that, and only one is deliberate. This narrowing
  // is required for the call to type-check at all (RecoveredClaim cannot accept
  // the replay arm). Separately, `reconciled` returns early on `!claim.recovered`,
  // which a replay satisfies only because its arm HAS no `recovered` field —
  // accidental protection that would evaporate the day someone adds one. The
  // explicit guard is the one to keep; the test pins the behaviour, not either
  // mechanism.
  if (!claim.replay && (await reconciled(deps, "digest", today, claim))) {
    return {
      kind: "digest",
      action: "skipped",
      reason: RECONCILED,
      statLineCount: 0,
      playerCount: 0,
      window: null,
    };
  }

  // Pure assembly (src/digest/assemble.ts): what this Digest reports. A replay
  // assembles exactly what an ordinary run would — the window is the content,
  // and it does not depend on what any previous delivery reported.
  const assembly = await assembleDigest(db, { now, tz, spec: deps.spec });
  const mail = renderDigest(assembly);
  const { playerCount, statLineCount } = assembly;
  const window = assembly.window.label;

  let receipt: MailReceipt;
  try {
    receipt = await deps.mailer.send(
      { to: deps.to, from: deps.from, ...mail },
      { deliveryKey: deliveryKey("digest", today) },
    );
  } catch (err) {
    // Send failed: settle the claim as failed. The next run re-claims the slot
    // and retries the same window, which reports the same content.
    // A REPLAY holds no claim and settles nothing: settling one as `failed`
    // would wipe sent_at off a genuinely delivered digest.
    if (!claim.replay) {
      settleFailed(db, {
        deliveryId: claim.deliveryId,
        errorMessage: errorMessage(err),
        playerCount,
        statLineCount,
      });
    }
    return {
      kind: "digest",
      action: "failed",
      reason: errorMessage(err),
      statLineCount,
      playerCount,
      window,
    };
  }

  // Send succeeded: record the delivery. No Stat Line is touched — a window
  // consumes nothing, so there is no line state to write.
  if (!claim.replay) {
    settleSent(db, {
      deliveryId: claim.deliveryId,
      now: now(),
      playerCount,
      statLineCount,
      providerMessageId: receipt.providerMessageId,
    });
  }

  return {
    kind: "digest",
    action: "sent",
    reason: sendReason(deps.force === true, claim),
    statLineCount,
    playerCount,
    window,
  };
}

/**
 * Force outranks a stale-claim recovery as the explanation for a re-send. A
 * replay has no `recovered` field at all — it never took a claim to recover —
 * so it can only ever report FORCED, and the union says so.
 */
function sendReason(forced: boolean, claim: Extract<ClaimResult, { claimed: true }>): string | null {
  if (forced) return FORCED;
  return !claim.replay && claim.recovered ? RECOVERED : null;
}

/**
 * Weekly heartbeat during Offseason Sleep: send only if none sent in the last
 * seven days. The rule is evaluated INSIDE the claim transaction — the slot key
 * is (heartbeat, today) but the rule is time-based, so two runs on different
 * days of one week would never collide on the unique index (ADR 0034).
 *
 * The rule is passed ALWAYS, forced or not: a forced heartbeat must be a replay
 * rather than a fresh claim it then settles, or it would restart the rolling
 * seven-day clock and suppress the next real liveness signal for a week.
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
    force: deps.force,
    precondition: (tx) => heartbeatWithinWeek(tx, nowMs),
  });
  if (!claim.claimed) {
    return {
      kind: "heartbeat",
      action: "skipped",
      reason: claim.reason,
      statLineCount: 0,
      playerCount: watchedCount,
      window: null,
    };
  }

  // A replay never reconciles — see the digest path for why suppressing a
  // forced send here would both defeat force and rewrite a delivered row.
  if (!claim.replay && (await reconciled(deps, "heartbeat", today, claim))) {
    return {
      kind: "heartbeat",
      action: "skipped",
      reason: RECONCILED,
      statLineCount: 0,
      playerCount: watchedCount,
      window: null,
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
    // A replay holds no claim: nothing to settle, nothing to degrade.
    if (!claim.replay) {
      settleFailed(db, {
        deliveryId: claim.deliveryId,
        errorMessage: errorMessage(err),
        playerCount: watchedCount,
        statLineCount: 0,
      });
    }
    return {
      kind: "heartbeat",
      action: "failed",
      reason: errorMessage(err),
      statLineCount: 0,
      playerCount: watchedCount,
      window: null,
    };
  }

  // A replay writes nothing — crucially, it never stamps a new `sent_at`, so
  // the rolling seven-day clock keeps running from the last REAL heartbeat.
  if (!claim.replay) {
    settleSent(db, {
      deliveryId: claim.deliveryId,
      now: now(),
      playerCount: watchedCount,
      statLineCount: 0,
      providerMessageId: receipt.providerMessageId,
    });
  }
  return {
    kind: "heartbeat",
    action: "sent",
    reason: sendReason(deps.force === true, claim),
    statLineCount: 0,
    playerCount: watchedCount,
    window: null,
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
