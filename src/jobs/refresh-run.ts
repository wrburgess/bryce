import { desc, eq, ne } from "drizzle-orm";
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

/**
 * Reserve a refresh run, or refuse `already-running` when another run holds a
 * LIVE lease. Synchronous by construction: the whole decision is one immediate
 * transaction. An EXPIRED `running` row never blocks — it is a crashed run, and
 * refusing behind it would silence Refresh until a human intervened.
 */
export function claimRefreshRun(db: Db, args: ClaimRefreshArgs): ClaimRefreshResult {
  const leaseMs = args.leaseMs ?? REFRESH_LEASE_MS;
  const nowIso = args.now.toISOString();
  const nowMs = args.now.getTime();

  return db.transaction(
    (tx): ClaimRefreshResult => {
      const running = tx
        .select()
        .from(refreshRuns)
        .where(eq(refreshRuns.status, "running"))
        .all();

      // ANY live lease refuses — there may be several crashed `running` rows and
      // one healthy one; the healthy one wins admission and the crashed ones are
      // ignored.
      if (running.some((r) => leaseIsLive(r.claimedAt, nowMs, leaseMs))) {
        return { claimed: false, reason: "already-running" };
      }

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

/** Bump a run's lease clock — called after each player so a long sweep stays live. */
export function renewRefreshRun(db: Db, runId: number, now: Date): void {
  db.update(refreshRuns)
    .set({ claimedAt: now.toISOString() })
    .where(eq(refreshRuns.id, runId))
    .run();
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
 * Stamp a run terminal: its status, `finished_at`, counts, and (on failure) the
 * error. A run settles its OWN row, so a late settle by a superseded run is
 * harmless — it touches nothing the winner owns.
 */
export function settleRefreshRun(db: Db, args: SettleRefreshArgs): void {
  const nowIso = args.now.toISOString();
  db.transaction(
    (tx) => {
      tx.update(refreshRuns)
        .set({
          finishedAt: nowIso,
          status: args.status,
          playersRefreshed: args.counts.playersRefreshed,
          playersTotal: args.counts.playersTotal,
          statLinesInserted: args.counts.statLinesInserted,
          statLinesUpdated: args.counts.statLinesUpdated,
          errorMessage: args.errorMessage ?? null,
        })
        .where(eq(refreshRuns.id, args.runId))
        .run();
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
  const terminal = db
    .select()
    .from(refreshRuns)
    .where(ne(refreshRuns.status, "running"))
    .orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id))
    .all();

  const qualifying = terminal.find((r) => hostDate(new Date(r.startedAt), tz) > contentDate);
  if (qualifying?.status === "ok" || qualifying?.status === "partial") {
    return {
      state: qualifying.status === "ok" ? "fresh" : "partial",
      asOf: qualifying.finishedAt,
      playersRefreshed: qualifying.playersRefreshed,
      playersTotal: qualifying.playersTotal,
    };
  }

  const lastSuccess = terminal.find((r) => r.status === "ok" || r.status === "partial");
  return {
    state: "stale",
    asOf: lastSuccess?.finishedAt ?? null,
    playersRefreshed: lastSuccess?.playersRefreshed ?? 0,
    playersTotal: lastSuccess?.playersTotal ?? 0,
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
  const rows = db
    .select()
    .from(refreshRuns)
    .orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id))
    .all();
  const latest = rows[0];
  if (latest === undefined) return null;

  const nowMs = now.getTime();
  const today = hostDate(now, tz);
  const lastSuccess = rows.find((r) => r.status === "ok" || r.status === "partial") ?? null;

  let state: RefreshHealthState;
  if (latest.status === "running" && leaseIsLive(latest.claimedAt, nowMs, REFRESH_LEASE_MS)) {
    state = "running";
  } else {
    const latestTerminal = rows.find((r) => r.status !== "running") ?? null;
    if (latestTerminal === null) {
      // Only a crashed `running` row exists: no completed refresh to trust.
      state = "stale";
    } else if (latestTerminal.status === "failed") {
      state = "failed";
    } else if (latestTerminal.status === "partial") {
      state = "partial";
    } else {
      state = hostDate(new Date(latestTerminal.startedAt), tz) >= today ? "fresh" : "stale";
    }
  }

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
