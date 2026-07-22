import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { RefreshRunStatus } from "../db/schema.js";
import { refreshRuns } from "../db/schema.js";
import { hostDate } from "../domain/season.js";

/**
 * The durable refresh run (ADR 0042), mirroring the delivery claim of ADR 0034.
 *
 * A Refresh is claim -> sweep -> settle. The claim is a `running` row in
 * `refresh_runs`, taken inside a single `BEGIN IMMEDIATE` transaction so the
 * read that decides eligibility and the write that reserves the run happen under
 * one write lock — the same cross-process exclusion the delivery claim relies on.
 *
 * WHAT MAKES THIS A STREAM, NOT A SLOT. The delivery claim keys a shared
 * `(kind, date)` slot; a refresh run instead owns its OWN row. Two runs never
 * contend for one identity, so a superseded run that settles LATE only ever
 * writes its own older row — it can never corrupt the winner's. The freshness
 * watermark is therefore "the latest run by (started_at, id)", read fresh each
 * time, never a single mutable cell.
 *
 * WHY THE LEASE IS RENEWED. A fixed lease cannot tell a crashed run from a slow
 * one. So `claimed_at` is bumped after every player (`renewRefreshRun`): a
 * healthy long sweep keeps its lease live and blocks a concurrent run; a crashed
 * run stops renewing and its lease expires after REFRESH_LEASE_MS, so the next
 * run may claim without waiting forever.
 *
 * WHY FRESHNESS ANCHORS ON `started_at`, NOT `finished_at`. ADR 0040's finality
 * gate ingests a game only once its date is strictly before host-today, on a
 * forward-moving clock. A run that STARTED after the content day ended therefore
 * saw every one of that day's games as final. `finished_at` cannot prove that: a
 * sweep that began at 23:59 and finished at 00:05 straddles midnight and may have
 * fetched some players while their games were still live. Anchoring on the start
 * is the conservative, provably-correct choice.
 */

/** How long a `running` claim is honored before another run may take over. */
export const REFRESH_LEASE_MS = 10 * 60 * 1000;

/** A terminal outcome — every status except the in-flight `running`. */
export type RefreshTerminalStatus = Exclude<RefreshRunStatus, "running">;

export type ClaimRefreshResult =
  | { claimed: true; runId: number }
  | { claimed: false; reason: "already-running" };

export interface ClaimRefreshArgs {
  now: Date;
  /** How many active players this run intends to sweep — recorded on the row. */
  playersTotal: number;
  leaseMs?: number;
}

/** Settled onto a `running` row a successor reaps because its lease expired. */
export const SUPERSEDED_MESSAGE = "superseded: lease expired, taken over by a newer run";

/**
 * Reserve a refresh run, or refuse `already-running` when another run holds a
 * LIVE lease. Synchronous by construction: the whole decision is one immediate
 * transaction. An EXPIRED `running` row never blocks — it is a crashed run, and
 * refusing behind it would silence Refresh until a human intervened.
 *
 * FENCING (the lease guard for players/stat_lines, not just refresh_runs).
 * Separate run rows keep two runs from corrupting each other's `refresh_runs`
 * row, but they share the `players`/`stat_lines` tables. If a superseded run's
 * in-flight fetch outlived its lease and later wrote, its OLDER data could
 * overwrite the successor's NEWER data while the successor is the freshness
 * winner — a stale-as-fresh bug. So when this claim may proceed (no live lease),
 * it REAPS every expired-lease `running` row FIRST — settling it `failed` with
 * `finished_at = now` — before inserting the new run. A reaped run's next
 * `renewRefreshRun` returns false, and its sweep aborts before its next write
 * (see runRefresh). Reaping also stops a crashed run from lingering as `running`.
 */
export function claimRefreshRun(db: Db, args: ClaimRefreshArgs): ClaimRefreshResult {
  const leaseMs = args.leaseMs ?? REFRESH_LEASE_MS;
  const nowIso = args.now.toISOString();
  // The lease cutoff as an ISO-8601 UTC string: `claimed_at >= cutoff` is a live
  // lease, `< cutoff` (or null) is expired. ISO-8601 UTC strings compare
  // lexicographically, so this is an indexed range scan, not a JS full-table sweep.
  const cutoffIso = new Date(args.now.getTime() - leaseMs).toISOString();

  return db.transaction(
    (tx): ClaimRefreshResult => {
      // ANY live lease refuses. There may be several crashed `running` rows and
      // one healthy one; the healthy one wins admission and the crashed ones are
      // reaped below. LIMIT 1: existence is all this decision needs.
      const live = tx
        .select({ id: refreshRuns.id })
        .from(refreshRuns)
        .where(and(eq(refreshRuns.status, "running"), gte(refreshRuns.claimedAt, cutoffIso)))
        .limit(1)
        .all()[0];
      if (live !== undefined) {
        return { claimed: false, reason: "already-running" };
      }

      // No live lease: fence every expired-lease `running` row BEFORE inserting.
      // Settling them `failed` (a) makes each one's next renew return false so its
      // sweep aborts before overwriting this run's data, and (b) clears crashed
      // runs out of `running` so /health never shows a phantom.
      tx.update(refreshRuns)
        .set({ status: "failed", finishedAt: nowIso, errorMessage: SUPERSEDED_MESSAGE })
        .where(
          and(
            eq(refreshRuns.status, "running"),
            or(isNull(refreshRuns.claimedAt), lt(refreshRuns.claimedAt, cutoffIso)),
          ),
        )
        .run();

      const inserted = tx
        .insert(refreshRuns)
        .values({
          startedAt: nowIso,
          finishedAt: null,
          status: "running",
          claimedAt: nowIso,
          playersRefreshed: 0,
          playersTotal: args.playersTotal,
          statLinesInserted: 0,
          statLinesUpdated: 0,
          errorMessage: null,
          createdAt: nowIso,
        })
        .returning({ id: refreshRuns.id })
        .all()[0];
      if (inserted === undefined) {
        throw new Error("Failed to claim a refresh run");
      }
      return { claimed: true, runId: inserted.id };
    },
    { behavior: "immediate" },
  );
}

/**
 * Bump a run's lease clock — called at the top of each player so a long sweep
 * stays live. Returns true iff the run STILL OWNS its lease (a `running` row was
 * updated); false when the row is no longer `running` — a successor reaped it as
 * `failed` (see claimRefreshRun), so this run has lost ownership and must abort
 * before its next write rather than clobber the successor's newer data.
 */
export function renewRefreshRun(db: Db, runId: number, now: Date): boolean {
  const result = db
    .update(refreshRuns)
    .set({ claimedAt: now.toISOString() })
    .where(and(eq(refreshRuns.id, runId), eq(refreshRuns.status, "running")))
    .run();
  return result.changes > 0;
}

export interface RefreshCounts {
  playersRefreshed: number;
  playersTotal: number;
  statLinesInserted: number;
  statLinesUpdated: number;
}

export interface SettleRefreshArgs {
  runId: number;
  now: Date;
  status: RefreshTerminalStatus;
  counts: RefreshCounts;
  errorMessage?: string | null;
}

/**
 * Stamp a run terminal — its status, `finished_at`, counts, and (on failure) the
 * error — but ONLY while it still owns its row (`status = 'running'`). Ownership
 * is checked ATOMICALLY with the settle, in one conditional UPDATE: a run reaped
 * by a successor (its row already `failed`) settles NOTHING and this returns
 * false. That is what stops a zombie — a run whose lease expired during a long
 * await and was reaped, then resumed — from resurrecting its own row to `ok` and
 * forging a `fresh` watermark over the winner's newer data.
 *
 * Returns true iff this run still owned its row and was settled.
 */
export function settleRefreshRun(db: Db, args: SettleRefreshArgs): boolean {
  const nowIso = args.now.toISOString();
  return db.transaction(
    (tx): boolean => {
      const result = tx
        .update(refreshRuns)
        .set({
          finishedAt: nowIso,
          status: args.status,
          playersRefreshed: args.counts.playersRefreshed,
          playersTotal: args.counts.playersTotal,
          statLinesInserted: args.counts.statLinesInserted,
          statLinesUpdated: args.counts.statLinesUpdated,
          errorMessage: args.errorMessage ?? null,
        })
        .where(and(eq(refreshRuns.id, args.runId), eq(refreshRuns.status, "running")))
        .run();
      return result.changes > 0;
    },
    { behavior: "immediate" },
  );
}

export type DigestFreshnessState = "fresh" | "partial" | "stale";

export interface DigestFreshness {
  state: DigestFreshnessState;
  /** finished_at of the run that dates the data, or null when none ever succeeded. */
  asOf: string | null;
  playersRefreshed: number;
  playersTotal: number;
}

/**
 * The freshness of the data a digest for `contentDate` would carry (ADR 0042).
 *
 * `contentDate` is the digest's content day — `assembly.window.to`, yesterday.
 * The QUALIFYING run is the latest TERMINAL run whose `started_at` host-date is
 * strictly AFTER `contentDate`: only such a run is proven (ADR 0040) to have
 * captured every one of that day's now-final games. Its outcome decides the
 * banner — `ok` is `fresh`, `partial` is `partial` (carrying its own N/M) — and
 * anything else (a failed qualifier, or none at all) is `stale`, dated by the
 * most recent ok/partial run's `finished_at` (or null: "never").
 */
export function digestFreshnessFor(db: Db, contentDate: string, tz: string): DigestFreshness {
  // The LATEST ok/partial by (started_at, id) is authoritative: if IT does not
  // clear the content date, no OLDER success can either. One indexed, LIMIT 1
  // read replaces the old whole-table materialize-and-scan.
  const latest = db
    .select()
    .from(refreshRuns)
    .where(inArray(refreshRuns.status, ["ok", "partial"]))
    .orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id))
    .limit(1)
    .all()[0];

  if (latest === undefined) {
    return { state: "stale", asOf: null, playersRefreshed: 0, playersTotal: 0 };
  }

  // A run that STARTED after the content day ended saw every one of that day's
  // now-final games (ADR 0040's forward-clock finality gate).
  const cleared = hostDate(new Date(latest.startedAt), tz) > contentDate;
  return {
    state: cleared ? (latest.status === "ok" ? "fresh" : "partial") : "stale",
    asOf: latest.finishedAt,
    playersRefreshed: latest.playersRefreshed,
    playersTotal: latest.playersTotal,
  };
}

/**
 * The DERIVED health vocabulary (ADR 0042) — distinct from the stored
 * RefreshRunStatus because `fresh`/`stale` are computed against `now`, not
 * written. Kept here beside the query that produces it so the two never drift.
 */
export type RefreshHealthState = "fresh" | "stale" | "running" | "partial" | "failed";

export interface RefreshHealth {
  state: RefreshHealthState;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  /** finished_at of the latest ok/partial run — when good data last landed. */
  lastSuccessAt: string | null;
  playersRefreshed: number;
  playersTotal: number;
}

/**
 * The refresh block of the health snapshot (ADR 0042), or null when no run has
 * ever been recorded. Ordering is (started_at desc, id desc):
 *   - a LIVE `running` lease ⇒ `running`;
 *   - otherwise the latest TERMINAL run decides — `failed`→`failed`,
 *     `partial`→`partial`, `ok`→`fresh` when it started today (host) else
 *     `stale`; with no terminal run at all (only a CRASHED `running` row whose
 *     lease expired) ⇒ `stale`, never `running`.
 * `lastStartedAt`/`lastFinishedAt` and the counts come from the latest run row;
 * `lastSuccessAt` from the latest ok/partial.
 */
export function refreshHealth(db: Db, now: Date, tz: string): RefreshHealth | null {
  const order = [desc(refreshRuns.startedAt), desc(refreshRuns.id)] as const;

  // The overall latest run row (any status) sources lastStartedAt/lastFinishedAt
  // and the counts, and decides `running` when it is a live lease. Fencing
  // (claimRefreshRun) guarantees a live `running` is always the newest row, so
  // reading the overall latest here preserves the original derivation exactly.
  const latest = db.select().from(refreshRuns).orderBy(...order).limit(1).all()[0];
  if (latest === undefined) return null;

  const nowMs = now.getTime();
  const today = hostDate(now, tz);

  let state: RefreshHealthState;
  if (latest.status === "running" && leaseIsLive(latest.claimedAt, nowMs, REFRESH_LEASE_MS)) {
    state = "running";
  } else {
    // The latest TERMINAL run decides the settled state. None (only a crashed
    // `running` row exists) ⇒ `stale`, never a phantom `running`.
    const latestTerminal = db
      .select()
      .from(refreshRuns)
      .where(inArray(refreshRuns.status, ["ok", "partial", "failed"]))
      .orderBy(...order)
      .limit(1)
      .all()[0];
    if (latestTerminal === undefined) {
      state = "stale";
    } else if (latestTerminal.status === "failed") {
      state = "failed";
    } else if (latestTerminal.status === "partial") {
      state = "partial";
    } else {
      state = hostDate(new Date(latestTerminal.startedAt), tz) >= today ? "fresh" : "stale";
    }
  }

  const lastSuccess = db
    .select({ finishedAt: refreshRuns.finishedAt })
    .from(refreshRuns)
    .where(inArray(refreshRuns.status, ["ok", "partial"]))
    .orderBy(...order)
    .limit(1)
    .all()[0];

  return {
    state,
    lastStartedAt: latest.startedAt,
    lastFinishedAt: latest.finishedAt,
    lastSuccessAt: lastSuccess?.finishedAt ?? null,
    playersRefreshed: latest.playersRefreshed,
    playersTotal: latest.playersTotal,
  };
}

/** A lease is live while it has not expired; an unparseable clock is treated as stale. */
function leaseIsLive(claimedAt: string, nowMs: number, leaseMs: number): boolean {
  const claimedMs = Date.parse(claimedAt);
  if (!Number.isFinite(claimedMs)) return false;
  return nowMs - claimedMs < leaseMs;
}
