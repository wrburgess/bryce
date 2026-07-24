import { and, desc, eq } from "drizzle-orm";
import { digestDeliveries } from "../db/schema.js";
import type { DigestAssembly } from "../digest/assemble.js";
import { assembleDigest } from "../digest/assemble.js";
import { renderDigest, renderHeartbeat } from "../digest/render.js";
import { hostDate, sleepWindow } from "../domain/season.js";
import type { WindowSpec } from "../domain/window.js";
import { resolveWindow } from "../domain/window.js";
import type { DeliveryKind } from "../db/schema.js";
import type { LookupResult, MailReceipt, Mailer } from "../mailer/types.js";
import type { Db } from "../db/client.js";
import type { ClaimRefusal, ClaimResult, Tx } from "./delivery-claim.js";
import {
  claimDelivery,
  deliveryKey,
  findOrphanedDigestDate,
  reportKey,
  settleFailed,
  settleReconciled,
  settleSent,
} from "./delivery-claim.js";
import { loadActivePlayers, loadCalendars } from "./refresh.js";
import type { DigestFreshnessState } from "./refresh-run.js";
import { digestFreshnessFor } from "./refresh-run.js";

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
   * Scope an ON-DEMAND send to a named list's active members (issue #70 /
   * ADR 0046). A named-list send is never the scheduled daily slot — the slot
   * key `(kind, date_covered)` has no list dimension — so any run carrying a
   * listId is routed to the on-demand path (no claim, no delivery row),
   * whatever its window. The scheduler passes no list, so the daily 1d slot is
   * unaffected.
   */
  listId?: number;
  /**
   * Operator override of the once-a-day / once-a-week bookkeeping (testing).
   * When force is what let the run proceed, the run is a REPLAY: it sends and
   * writes NOTHING (see src/jobs/delivery-claim.ts). It never overrides an
   * in-flight claim, and never overrides the Offseason Sleep decision.
   */
  force?: boolean;
  /**
   * Operator-visible channel for things the run noticed but did not act on.
   * Defaults to stderr; injected in tests so the warning can be asserted rather
   * than merely printed.
   */
  warn?: (message: string) => void;
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
  /**
   * The freshness verdict the daily digest gated on (ADR 0043), or null. Only
   * the scheduled 1d path (today's run and orphan recovery) reads it; an
   * on-demand report never annotates, and neither a claim-refusal, a reconciled
   * recovery, nor a heartbeat composes a dated digest to judge. It is the STATE,
   * not suppression: a `stale`/`partial` digest still sends, annotated.
   */
  freshness: DigestFreshnessState | null;
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
  const warn = input.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const { db, now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const sleep = sleepWindow(calendars, activePlayers, now(), tz);

  // An ON-DEMAND report is not the scheduled artifact, and the two differ in
  // both directions.
  //
  // It takes no claim. The claim exists so the DAILY digest cannot go out twice
  // for one date; its slot is keyed `(kind, date_covered)` with no room for a
  // window. Sharing that slot means a 7d request after the day's 1d report is
  // refused `already-sent-today`, and a failed 7d attempt is silently completed
  // by the next 1d run — the wrong content settling the wrong slot. An operator
  // who asks for a window explicitly is not deduplicating anything; he asked.
  //
  // It also ignores Offseason Sleep. Sleep stops the daily artifact mailing
  // nothing every day for months. Answering an explicit "give me my season to
  // date" with a liveness heartbeat is not that, it is refusing the question.
  // A named-list send is on-demand by definition (ADR 0046 decision 4): it never
  // takes the daily slot, whose key has no list dimension. Route any run with a
  // list — or any non-1d window — to the on-demand path.
  if (deps.spec !== "1d" || deps.listId !== undefined) {
    return runOnDemandReport(deps, warn);
  }

  const today = hostDate(now(), tz);

  // Catch up ONE orphaned prior day BEFORE deciding today's run — and before the
  // sleep check, deliberately. `claimDelivery` already re-claims a failed or
  // stale slot correctly, but only ever sees the date it is handed, so once
  // midnight passes, yesterday's failed digest is never retried and its
  // notification is lost (ADR 0034's recovery guarantee, which novelty selection
  // used to provide for free across dates). A digest that failed on the season's
  // last day would then never recover, because the next run is already asleep —
  // so recovery must run whether or not TODAY is sleeping. The recovered run
  // assembles ITS date's window (asOf), never today's, and never forces. One per
  // run bounds catch-up to a single extra email; a multi-day backlog drains a
  // day at a time rather than arriving as a burst.
  const orphan = findOrphanedDigestDate(db, today, now().getTime());
  if (orphan !== null) {
    await deliverDailyDigest(deps, orphan, orphan, false, warn);
  }

  // Only TODAY's run is replaced by the offseason heartbeat; the recovery above
  // is for an in-season day that still owes its digest.
  if (sleep.sleeping) {
    return runHeartbeat(deps, activePlayers.length, sleep.nextOpeningDay);
  }

  return deliverDailyDigest(deps, today, today, deps.force === true, warn);
}

/**
 * One daily digest: claim the (digest, dateCovered) slot, reconcile a recovered
 * claim, assemble the 1d window as of `asOf`, send, settle. Shared by today's
 * run (dateCovered = asOf = today) and by recovery of an orphaned prior day
 * (dateCovered = asOf = that day).
 */
async function deliverDailyDigest(
  deps: DigestDeps,
  dateCovered: string,
  asOf: string,
  force: boolean,
  warn: (message: string) => void,
): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const claim = claimDelivery(db, { kind: "digest", dateCovered, now: now(), force });
  if (!claim.claimed) {
    return {
      kind: "digest",
      action: "skipped",
      reason: claim.reason,
      statLineCount: 0,
      playerCount: 0,
      window: null,
      freshness: null,
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
  if (!claim.replay && (await reconciled(deps, "digest", dateCovered, claim))) {
    return {
      kind: "digest",
      action: "skipped",
      reason: RECONCILED,
      statLineCount: 0,
      playerCount: 0,
      window: null,
      freshness: null,
    };
  }

  // Read the freshness watermark BEFORE assembly (ADR 0043, fixing the TOCTOU):
  // resolve the same 1d window purely to get the CONTENT date (window.to =
  // yesterday), judge freshness against it, THEN assemble. A refresh that lands
  // between this read and the send can only make the reading conservatively
  // MORE stale than reality — an annotated email, never a suppressed one — which
  // is the hybrid-degrade contract. Anchoring on the content date (not the
  // delivery slot) and on the run's START (not its finish) are the two
  // correctness fixes ADR 0043 turns on.
  const contentDate = resolveWindow("1d", now(), tz, null, asOf).to;
  const freshness = digestFreshnessFor(db, contentDate, tz);

  // Pure assembly (src/digest/assemble.ts): what this Digest reports. A replay
  // assembles exactly what an ordinary run would — the window is the content,
  // and it does not depend on what any previous delivery reported. `asOf`
  // anchors the window on the slot's own date, so a recovered prior day reports
  // its day, not today's.
  const assembly = await assembleDigest(db, { now, tz, spec: "1d", asOf });

  // Fail-closed has two halves. Excluding an unrecognised stat key is the safe
  // one; SAYING SO is the other. Without this an upstream field addition is
  // dropped from every future report and nobody learns the tables went stale —
  // which is exactly the silent staleness the classification exists to prevent.
  reportUnknownFields(assembly, warn);
  const mail = renderDigest(assembly, freshness);
  const { playerCount, statLineCount } = assembly;
  const window = assembly.window.label;

  let receipt: MailReceipt;
  try {
    receipt = await deps.mailer.send(
      { to: deps.to, from: deps.from, ...mail },
      { deliveryKey: deliveryKey("digest", dateCovered) },
    );
  } catch (err) {
    // Send failed: settle the claim as failed. A later run re-claims the slot
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
      freshness: freshness.state,
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
    reason: sendReason(force, claim),
    statLineCount,
    playerCount,
    window,
    freshness: freshness.state,
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
 * An on-demand windowed report: assemble, render, send. No claim, no delivery
 * row, no settlement, nothing written anywhere.
 *
 * This is the whole of option B. The delivery machinery in ADR 0034 protects
 * ONE guarantee — the daily digest goes out at most once per date — and its
 * slot key has no room for a window. Rather than widen that key and owe
 * crash-recovery for every window an operator might ask for, an explicit
 * request simply opts out of bookkeeping it never needed.
 *
 * What that costs: an on-demand report that dies mid-send is not retried
 * automatically. A human asked for it and is watching; he asks again. What it
 * buys: a 7d request can never be refused because a 1d one already went out,
 * and can never be silently completed by one.
 */
async function runOnDemandReport(
  deps: DigestDeps,
  warn: (message: string) => void,
): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const assembly = await assembleDigest(db, { now, tz, spec: deps.spec, listId: deps.listId });
  reportUnknownFields(assembly, warn);

  const mail = renderDigest(assembly);
  const { playerCount, statLineCount } = assembly;
  const window = assembly.window.label;

  try {
    await deps.mailer.send(
      { to: deps.to, from: deps.from, ...mail },
      { deliveryKey: reportKey(assembly.window.spec, assembly.window.to) },
    );
  } catch (err) {
    return {
      kind: "digest",
      action: "failed",
      reason: errorMessage(err),
      statLineCount,
      playerCount,
      window,
      // An on-demand report NEVER annotates freshness (ADR 0043): a human asked
      // for a specific window and is watching — the daily proof-of-life gate is
      // not his concern.
      freshness: null,
    };
  }

  return {
    kind: "digest",
    action: "sent",
    reason: null,
    statLineCount,
    playerCount,
    window,
    freshness: null,
  };
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
      freshness: null,
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
      freshness: null,
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
      // The offseason heartbeat is the liveness signal, untouched by the
      // freshness gate (ADR 0043): it composes no dated digest to judge.
      freshness: null,
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
    freshness: null,
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

/**
 * Fail-closed has two halves. Excluding an unrecognised stat key is the safe
 * one; SAYING SO is the other. Without this an upstream field addition is
 * dropped from every future report and nobody learns the tables went stale.
 */
function reportUnknownFields(
  assembly: DigestAssembly,
  warn: (message: string) => void,
): void {
  if (assembly.unknownFields.length === 0) return;
  warn(
    `digest: ${assembly.unknownFields.length} unclassified stat field(s) excluded ` +
      `from ${assembly.window.label}: ${assembly.unknownFields.join(", ")}. ` +
      `Classify them in src/stats/fields.ts.`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
