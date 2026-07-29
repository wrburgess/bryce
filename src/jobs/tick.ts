import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerListRow } from "../db/schema.js";
import { digestDeliveries } from "../db/schema.js";
import { hostDate, hostHour, sleepWindow } from "../domain/season.js";
import type { HighlightlyClient } from "../highlightly/client.js";
import { liveLists } from "../lists/service.js";
import type { Mailer } from "../mailer/types.js";
import type { MlbClient } from "../mlb/client.js";
import type { DigestResult } from "./digest.js";
import { runDigest } from "./digest.js";
import type { RefreshProgressSink } from "./refresh-progress.js";
import type { RefreshSummary } from "./refresh.js";
import { loadActivePlayers, loadCalendars, runRefresh } from "./refresh.js";
import { latestCoveringRun } from "./refresh-run.js";

/**
 * The Tick (#193, ADR 0062 decision 3): ONE frequent job that asks what is owed
 * right now, replacing the two fixed launchd agents (refresh 03:30, digest
 * 05:00).
 *
 * WHY A POLLER AND NOT MORE PLISTS. Lanes carry their own cadence since #191 —
 * `refresh_interval_minutes` and `digest_hour` per lane, editable from the CLI —
 * and a fixed-schedule agent cannot express a value that lives in the database
 * and changes without a redeploy. One agent that wakes every 15 minutes and
 * reads the lanes can; adding a plist per lane cannot, and would put the
 * schedule in two places that drift.
 *
 * DUE-SELECTION IS ADVISORY; THE CLAIM IS THE GATE. Everything this file decides
 * is a cheap pre-read whose only job is to keep a quiet tick quiet. Correctness
 * still rests entirely on the durable claims underneath — `claimDelivery` for a
 * digest (ADR 0034), `claimRefreshRun` for a sweep (ADR 0043) — which are what
 * make it safe for this job to overlap the retired fixed agents during the
 * manual ops migration, or a manual `sk digest`, or the long-running server's
 * MCP tool. A second claimant is refused; it is never a second email.
 *
 * REFRESH RUNS BEFORE DIGESTS, in one sequential pass, so a lane whose digest
 * hour has arrived reports data this same tick just fetched rather than data
 * from fifteen minutes ago.
 *
 * FAILURE IS ISOLATED PER STAGE AND PER LANE (Reviewer must-fix 2). An
 * unexpected throw from the sweep must not suppress every lane's digest, and one
 * lane's throw must not suppress the lanes after it — a tick that abandons its
 * remaining work on the first fault would turn a single broken lane into a
 * silent host-wide outage, and would do it four times an hour without saying so.
 * Each stage records its own outcome and the pass continues; `ok` is false if
 * ANY attempted action failed, which is what the CLI turns into exit 1.
 *
 * IT PRESENTS NOTHING. Like `runRefresh` before it (ADR 0056), the job returns a
 * typed result and `src/cli/tick.ts` decides, alone, what becomes text — which
 * is what makes `--quiet`'s "exactly one terminal line" a property of one file
 * rather than a convention spread across two.
 */

export interface TickDeps {
  db: Db;
  now: () => Date;
  tz: string;
  /** Refresh-side provider clients, passed straight through to `runRefresh`. */
  client: MlbClient;
  /** Optional only for installations without an attached NCAA player. */
  highlightlyClient?: HighlightlyClient;
  /**
   * The Refresh Liveness sink (ADR 0056), attached by the CLI in verbose mode
   * and omitted under `--quiet`. Absent means the sweep emits nothing, exactly
   * as it does for the MCP tool and the REST route.
   */
  onRefreshProgress?: RefreshProgressSink;
  /** Where the refresh job's three legacy notice lines go when no sink is attached. */
  writeLegacyNotice?: (line: string) => void;
  mailer: Mailer;
  /** The `DIGEST_TO`-derived host recipients; a lane's own `digest_to` outranks it. */
  to: string;
  from: string;
  /**
   * Digest diagnostics (unclassified stat fields). Threaded so the CLI can
   * collect and suppress them under `--quiet` rather than let them leak around
   * the single terminal line; unset means the digest's own stderr default.
   */
  warn?: (message: string) => void;
}

/** What the refresh stage did, or why it could not (#193). */
export interface TickRefresh {
  /** The due lanes this sweep covered, in `liveLists` order. */
  lanes: PlayerListRow[];
  /** The sweep's summary, or null when it threw. */
  summary: RefreshSummary | null;
  /** The unexpected throw's message, or null on any normal outcome. */
  error: string | null;
}

/** What one digest invocation did, or why it could not (#193). */
export interface TickDigest {
  /**
   * The lane invoked, or null for the UNSCOPED Offseason-Sleep invocation that
   * carries the host heartbeat. Null is not "unknown": it is the whole reason
   * that invocation is different from a lane's (ADR 0062 decision 4).
   */
  lane: PlayerListRow | null;
  result: DigestResult | null;
  error: string | null;
}

export interface TickResult {
  /** Null when no lane's refresh interval had elapsed — the sweep was not attempted. */
  refresh: TickRefresh | null;
  /**
   * A throw from the digest stage's own SETUP — the reads that decide Offseason
   * Sleep, before any lane is chosen. It has no lane to attribute to, so it is
   * its own field rather than a `TickDigest` with a null lane (which already
   * means the unscoped heartbeat invocation, a different thing entirely).
   *
   * Recorded rather than propagated for the same reason the refresh stage's
   * throw is: the stages are isolated from each other, so a fault on this side
   * must not erase the record of a sweep that already succeeded this tick.
   */
  digestError: string | null;
  /** One entry per invocation actually made, in the order they were made. */
  digests: TickDigest[];
  /**
   * True iff every attempted action ended `sent`/`skipped`/`ok`/`partial`. A
   * `partial` sweep is not a job failure (the same rule `sk refresh` follows);
   * a `failed` sweep, a `failed` send, and an unexpected throw all are.
   */
  ok: boolean;
}

/** How long a heartbeat suppresses the next one — the rolling week of ADR 0031. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Has `intervalMinutes` elapsed since a covering sweep STARTED (#193)?
 *
 * Pure and exported so the boundary is table-tested directly rather than only
 * through the orchestration — the same treatment `deriveRefreshStatus` gets.
 *
 * `>=` PINS THE EXACT BOUNDARY: elapsed exactly equal to the interval is DUE. A
 * strict `>` would make a lane configured for 15 minutes, ticked every 15
 * minutes, land one tick late forever — the interval is a floor on the gap, not
 * a value the clock must exceed.
 *
 * A never-swept lane (`null`) is due, and so is one whose recorded start time is
 * unparseable: both fail toward REFRESHING, which costs one extra sweep, rather
 * than toward silence, which costs a stale digest nobody is told about.
 */
export function refreshIsDue(
  lastCoveringStartedAt: string | null,
  intervalMinutes: number,
  nowMs: number,
): boolean {
  if (lastCoveringStartedAt === null) return true;
  const startedMs = Date.parse(lastCoveringStartedAt);
  if (!Number.isFinite(startedMs)) return true;
  return nowMs - startedMs >= intervalMinutes * 60_000;
}

/**
 * Is this lane's digest owed right now (#193)?
 *
 * Two conditions, and both are deliberately weak on their own. The hour test is
 * `>=`, never `===`: a laptop asleep at 05:00 wakes at 09:00 and must still send
 * the 05:00 digest, which an equality test would have skipped until tomorrow.
 * That alone would re-send every tick for the rest of the day, so the second
 * condition — today's slot has no `sent` row — is what stops it.
 *
 * A `failed` slot therefore reads as DUE and is retried on later ticks, which is
 * the acceptance criterion this design was chosen for: a send that failed at
 * 05:00 against a briefly-broken mailer goes out at 05:15 rather than waiting
 * for tomorrow's orphan recovery. The cost is bounded and accepted — roughly
 * four attempts an hour against a mailer that stays broken (ADR 0062).
 */
export function digestIsDue(hour: number, digestHour: number, sentToday: boolean): boolean {
  return !sentToday && hour >= digestHour;
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  // ONE clock read for the whole tick, for the reason `runDigest` freezes one:
  // due-ness, the slot date, and the sweep's own timestamps must all describe
  // the same instant, or a tick that straddles an hour boundary can decide a
  // lane is due against one hour and claim its slot against another.
  const runAt = deps.now();
  const now = (): Date => runAt;
  const lanes = await liveLists(deps.db);

  const refresh = await runRefreshStage(deps, lanes, now, runAt);
  const { digestError, digests } = await runDigestStage(deps, lanes, now, runAt);

  const refreshFailed =
    refresh !== null && (refresh.error !== null || refresh.summary?.status === "failed");
  const digestFailed =
    digestError !== null || digests.some((d) => d.error !== null || d.result?.action === "failed");
  return { refresh, digestError, digests, ok: !refreshFailed && !digestFailed };
}

/**
 * The refresh half: select every lane whose interval has elapsed and sweep them
 * in ONE run carrying the union of their ids.
 *
 * One run, not one per lane, because `runRefresh` refuses a second concurrent
 * sweep (`already-running`) — so a per-lane loop would sweep the first lane and
 * skip the rest, and because union-and-dedupe already falls out of the scoped
 * selection's correlated EXISTS (ADR 0061 #5): a Player on two due lanes is
 * fetched exactly once.
 */
async function runRefreshStage(
  deps: TickDeps,
  lanes: PlayerListRow[],
  now: () => Date,
  runAt: Date,
): Promise<TickRefresh | null> {
  const nowMs = runAt.getTime();
  const due = lanes.filter((lane) => {
    const interval = lane.refreshIntervalMinutes;
    if (interval === null) return false;
    // The COVERING run, not the latest run: another lane's sweep must not
    // advance this lane's clock, while a whole-list sweep must advance every
    // lane's. One shared helper answers both (src/jobs/refresh-run.ts).
    const covering = latestCoveringRun(deps.db, lane.id);
    return refreshIsDue(covering?.startedAt ?? null, interval, nowMs);
  });
  if (due.length === 0) return null;

  try {
    const summary = await runRefresh({
      db: deps.db,
      client: deps.client,
      highlightlyClient: deps.highlightlyClient,
      now,
      tz: deps.tz,
      onProgress: deps.onRefreshProgress,
      writeLegacyNotice: deps.writeLegacyNotice,
      scope: { lists: due, listIds: due.map((lane) => lane.id) },
    });
    return { lanes: due, summary, error: null };
  } catch (err) {
    // The digest half still runs (Reviewer must-fix 2). A sweep that threw
    // leaves the digests reporting older data — annotated `stale` by their own
    // freshness banner — which is strictly better than not sending them at all.
    return { lanes: due, summary: null, error: errorMessage(err) };
  }
}

/**
 * The digest half: during Offseason Sleep, at most one UNSCOPED invocation to
 * carry the host heartbeat; otherwise one invocation per due lane.
 */
async function runDigestStage(
  deps: TickDeps,
  lanes: PlayerListRow[],
  now: () => Date,
  runAt: Date,
): Promise<{ digestError: string | null; digests: TickDigest[] }> {
  const { db, tz } = deps;
  const digests: TickDigest[] = [];
  try {
    // Sleep is judged ONCE for the host, against every active Player — the same
    // question `runDigest` asks when invoked unscoped. Judging it per lane would
    // let a lane of NCAA-only players fall asleep while the host is awake, which
    // is a defensible design and NOT this one: the heartbeat is host-level, so
    // the decision that replaces digests with it has to be host-level too.
    //
    // These two reads are inside the boundary deliberately: they are the digest
    // stage's SETUP, and a database fault here has no lane to attribute itself
    // to. Left uncaught it would escape `runTick` entirely and erase the record
    // of a sweep that may have just succeeded — the stage isolation, undone from
    // the inside.
    const sleep = sleepWindow(await loadCalendars(db), await loadActivePlayers(db), runAt, tz);

    if (sleep.sleeping) {
      // The claim's rolling-week rule is the real gate; this pre-read only keeps
      // ~96 sleeping ticks a day from each opening a claim transaction and being
      // refused `heartbeat-sent-within-week`. Scheduled lanes are NOT invoked
      // while sleeping: a scoped invocation would skip anyway (ADR 0062 #4), so
      // calling it would be noise.
      if (heartbeatOwed(db, runAt.getTime())) digests.push(await invokeDigest(deps, null, now));
      return { digestError: null, digests };
    }

    const hour = hostHour(runAt, tz);
    const today = hostDate(runAt, tz);
    for (const lane of lanes) {
      const digestHour = lane.digestHour;
      if (digestHour === null) continue;
      if (!digestIsDue(hour, digestHour, sentToday(db, lane.id, today))) continue;
      // Awaited in sequence, and each invocation's failure is caught inside
      // `invokeDigest`, so lane N+1 is attempted whatever lane N did.
      digests.push(await invokeDigest(deps, lane, now));
    }
    return { digestError: null, digests };
  } catch (err) {
    // Whatever was already attempted is KEPT, not discarded: a fault after lane
    // A sent must not make the tick report that it never did.
    return { digestError: errorMessage(err), digests };
  }
}

/** One `runDigest` invocation with its failure boundary (Reviewer must-fix 2). */
async function invokeDigest(
  deps: TickDeps,
  lane: PlayerListRow | null,
  now: () => Date,
): Promise<TickDigest> {
  try {
    const result = await runDigest({
      db: deps.db,
      mailer: deps.mailer,
      now,
      tz: deps.tz,
      to: deps.to,
      from: deps.from,
      spec: "1d",
      // Null is the UNSCOPED heartbeat invocation; a lane passes both its id and
      // the name it holds right now (the job re-reads the row regardless).
      listId: lane?.id,
      listName: lane?.name,
      warn: deps.warn,
    });
    return { lane, result, error: null };
  } catch (err) {
    // The planned deleted-lane refusal is NOT one of these — it arrives as a
    // `skipped` result carrying `lane-deleted`, because the claim refuses rather
    // than throwing. This boundary is for the genuinely unexpected: a database
    // fault, a lane deleted between `liveLists` and resolution (UnknownListError),
    // a mailer that throws outside the job's own catch.
    return { lane, result: null, error: errorMessage(err) };
  }
}

/** Does today's `(digest, date, lane)` slot already hold a `sent` row? */
function sentToday(db: Db, listId: number, today: string): boolean {
  return (
    db
      .select({ id: digestDeliveries.id })
      .from(digestDeliveries)
      .where(
        and(
          eq(digestDeliveries.kind, "digest"),
          eq(digestDeliveries.dateCovered, today),
          eq(digestDeliveries.listId, listId),
          eq(digestDeliveries.status, "sent"),
        ),
      )
      .limit(1)
      .all()[0] !== undefined
  );
}

/**
 * Might a heartbeat be owed? Deliberately LANE-BLIND and deliberately
 * conservative — it mirrors `heartbeatWithinWeek`'s query (only `sent` rows
 * count, so a stuck `sending` row can never silence the signal) but is only a
 * quieting pre-read: the authoritative rule runs inside the claim.
 */
function heartbeatOwed(db: Db, nowMs: number): boolean {
  const last = db
    .select({ sentAt: digestDeliveries.sentAt })
    .from(digestDeliveries)
    .where(and(eq(digestDeliveries.kind, "heartbeat"), eq(digestDeliveries.status, "sent")))
    .orderBy(desc(digestDeliveries.sentAt))
    .limit(1)
    .all()[0];
  const lastSentAt = last?.sentAt ?? null;
  if (lastSentAt === null) return true;
  const sentMs = Date.parse(lastSentAt);
  if (!Number.isFinite(sentMs)) return true;
  return nowMs - sentMs >= WEEK_MS;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
