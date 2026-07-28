import { and, desc, eq, gt, inArray, isNull, lte, max, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { RefreshRunStatus } from "../db/schema.js";
import { refreshRuns } from "../db/schema.js";
import { hostDate } from "../domain/season.js";

/**
 * The durable refresh run (ADR 0043), mirroring the delivery claim of ADR 0034.
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
  /**
   * The lanes this run sweeps (#192, ADR 0061) — or `undefined` when it swept
   * THE WHOLE WATCH LIST, which includes a lane run whose lanes happened to hold
   * every active Player. The caller decides that (`runRefresh`'s claim-time
   * coverage check); this argument is only the answer. Recorded on the row so
   * the digest's freshness watermark can tell a complete sweep from a partial
   * one; see {@link encodeScopeListIds}.
   */
  scopeListIds?: readonly number[];
  leaseMs?: number;
}

/**
 * The CANONICAL storage form of a run's lane scope (#192, ADR 0061).
 *
 * `undefined` ⇒ `NULL` ⇒ **this run swept every active Player**, which is
 * exactly what every pre-#192 run did, so the migration's NULL backfill needs no
 * interpretation. Otherwise the value is PROVENANCE for a genuinely partial
 * run — which lanes it did cover — never an input to an eligibility test.
 *
 * The form: ids DEDUPED and sorted ASCENDING, comma-delimited, wrapped in
 * LEADING AND TRAILING SENTINEL COMMAS — `,1,3,10,`.
 *
 * WHY THE SENTINELS SURVIVE, now that nothing does containment. Until the
 * Stage-4 loop-back on #192 they were load-bearing for an `instr` test that
 * asked whether the text contained the default lane's id; that test is gone
 * (ADR 0061 decision 8), and with it the prefix trap they closed. What is left
 * is one present-tense reason, not nostalgia: the EMPTY scope must not encode to
 * the empty string. `,,` is visibly "swept zero lanes"; `""` is a value that
 * `if (!row.scopeListIds)` in TypeScript, `ifnull()` in SQL, and most CSV/JSON
 * round-trips cannot tell from `NULL` — and `NULL` here means "swept
 * EVERYTHING". That confusion is the fail-OPEN direction, so the format keeps a
 * shape in which no legal scope is falsy. Canonical ordering and dedupe stay for
 * the same reason they always applied: two runs over the same lanes store the
 * same bytes, so the column is comparable and greppable as provenance.
 */
export function encodeScopeListIds(listIds: readonly number[] | undefined): string | null {
  if (listIds === undefined) return null;
  return `,${[...new Set(listIds)].sort((a, b) => a - b).join(",")},`;
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
  // The lease cutoff as an ISO-8601 UTC string: `claimed_at > cutoff` is a live
  // lease; `<= cutoff` (or null) is expired. ISO-8601 UTC strings compare
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
        .where(and(eq(refreshRuns.status, "running"), gt(refreshRuns.claimedAt, cutoffIso)))
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
            or(isNull(refreshRuns.claimedAt), lte(refreshRuns.claimedAt, cutoffIso)),
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
          // Written at CLAIM time, not at settle: the scope is what this run
          // reserved, and a run that crashes mid-sweep must still be readable as
          // the lane run it was rather than as a whole-list one.
          scopeListIds: encodeScopeListIds(args.scopeListIds),
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
  const cutoffIso = new Date(now.getTime() - REFRESH_LEASE_MS).toISOString();
  const result = db
    .update(refreshRuns)
    .set({ claimedAt: now.toISOString() })
    // A lease is strictly live: exactly at expiry the worker has lost its
    // authority and may not revive itself before a successor happens to reap it.
    .where(and(eq(refreshRuns.id, runId), eq(refreshRuns.status, "running"), gt(refreshRuns.claimedAt, cutoffIso)))
    .run();
  return result.changes > 0;
}

/** A fence carried from admission to every ingestion mutation. */
export type IngestionFence =
  | { kind: "whole-refresh"; runId: number; now: Date; leaseMs?: number }
  | { kind: "targeted-refresh"; admittedAfterRunId: number };

export type GuardedMutationResult<T> =
  | { committed: true; value: T }
  | { committed: false; reason: "lost-ownership" | "whole-refresh-running" };

/**
 * Execute an ingestion write only while its authority is still current.  The
 * predicate and callback share one BEGIN IMMEDIATE transaction; callers must
 * buffer provider I/O before reaching here.
 */
export function withIngestionFence<T>(
  db: Db,
  fence: IngestionFence | undefined,
  mutation: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => T,
): GuardedMutationResult<T> {
  if (fence === undefined) return { committed: true, value: db.transaction(mutation, { behavior: "immediate" }) };
  return db.transaction((tx): GuardedMutationResult<T> => {
    if (fence.kind === "whole-refresh") {
      const cutoffIso = new Date(fence.now.getTime() - (fence.leaseMs ?? REFRESH_LEASE_MS)).toISOString();
      const owned = tx.select({ id: refreshRuns.id }).from(refreshRuns)
        .where(and(eq(refreshRuns.id, fence.runId), eq(refreshRuns.status, "running"), gt(refreshRuns.claimedAt, cutoffIso)))
        .limit(1).all()[0];
      if (owned === undefined) return { committed: false, reason: "lost-ownership" };
    } else {
      // refresh_runs ids are a durable generation: a claim committed after
      // targeted admission has a higher id. BEGIN IMMEDIATE serializes this
      // test with the claim and the mutation, closing the admission TOCTOU.
      const newer = tx.select({ id: refreshRuns.id }).from(refreshRuns)
        .where(gt(refreshRuns.id, fence.admittedAfterRunId)).limit(1).all()[0];
      if (newer !== undefined) return { committed: false, reason: "whole-refresh-running" };
    }
    return { committed: true, value: mutation(tx) };
  }, { behavior: "immediate" });
}

export type TargetedRefreshAdmission =
  | { admitted: true; fence: Extract<IngestionFence, { kind: "targeted-refresh" }> }
  | { admitted: false; reason: "whole-refresh-running" };

/** Atomically reject a targeted refresh behind a live sweep and capture its generation otherwise. */
export function admitTargetedRefresh(db: Db, now: Date, leaseMs = REFRESH_LEASE_MS): TargetedRefreshAdmission {
  const cutoffIso = new Date(now.getTime() - leaseMs).toISOString();
  return db.transaction((tx): TargetedRefreshAdmission => {
    const live = tx.select({ id: refreshRuns.id }).from(refreshRuns)
      .where(and(eq(refreshRuns.status, "running"), gt(refreshRuns.claimedAt, cutoffIso))).limit(1).all()[0];
    if (live !== undefined) return { admitted: false, reason: "whole-refresh-running" };
    const latest = tx.select({ id: max(refreshRuns.id) }).from(refreshRuns).all()[0];
    return { admitted: true, fence: { kind: "targeted-refresh", admittedAfterRunId: latest?.id ?? 0 } };
  }, { behavior: "immediate" });
}

export interface RefreshCounts {
  playersRefreshed: number;
  /**
   * Passed-Over Players so far (#146) — never a Skipped Sweep, which records no
   * run at all. Persisted alongside `playersRefreshed` so the durable Accounting
   * carries the SAME three-way classification the console's Liveness stream
   * shows (ADR 0056), and `refreshed + skipped + failed = playersTotal` holds
   * for a sweep whose loop ran to completion.
   */
  playersSkipped: number;
  /** Collected per-player failures so far (#23), persisted for the same reason. */
  playersFailed: number;
  playersTotal: number;
  statLinesInserted: number;
  statLinesUpdated: number;
}

/**
 * Persist the completed portion of a running sweep. Like terminal settlement,
 * this is fenced by the run's immutable id plus its still-running state: a
 * successor reaps this row and creates a different id, so an old worker can
 * never update the successor's progress.
 *
 * Returns false only when the conditional update matched no owned running row.
 * Database failures deliberately propagate to runRefresh's outer failure
 * boundary rather than being mistaken for lost ownership.
 */
export function updateRefreshRunProgress(db: Db, runId: number, counts: RefreshCounts): boolean {
  const result = db
    .update(refreshRuns)
    .set({
      playersRefreshed: counts.playersRefreshed,
      playersSkipped: counts.playersSkipped,
      playersFailed: counts.playersFailed,
      playersTotal: counts.playersTotal,
      statLinesInserted: counts.statLinesInserted,
      statLinesUpdated: counts.statLinesUpdated,
    })
    .where(and(eq(refreshRuns.id, runId), eq(refreshRuns.status, "running")))
    .run();
  return result.changes > 0;
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
          playersSkipped: args.counts.playersSkipped,
          playersFailed: args.counts.playersFailed,
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
 * The freshness of the data a digest for `contentDate` would carry (ADR 0043).
 *
 * `contentDate` is the digest's content day — `assembly.window.to`, yesterday.
 * The QUALIFYING run is the latest TERMINAL run whose `started_at` host-date is
 * strictly AFTER `contentDate`: only such a run is proven (ADR 0040) to have
 * captured every one of that day's now-final games. Its outcome decides the
 * banner — `ok` is `fresh`, `partial` is `partial` (carrying its own N/M) — and
 * anything else (a failed qualifier, or none at all) is `stale`, dated by the
 * most recent ok/partial run's `finished_at` (or null: "never").
 *
 * A QUALIFYING RUN MUST ALSO HAVE COVERED EVERY ACTIVE PLAYER (#192, ADR 0061
 * decision 8) — `scope_list_ids IS NULL`. Scoping the sweep opened a hole the
 * whole-list sweep did not have: `sk refresh -l Prospects` settling `ok` would
 * otherwise make this banner read `fresh` over a watch list that sweep never
 * touched, a forged completeness claim.
 *
 * THE PREDICATE IS COVERAGE, NOT IDENTITY, and that distinction is the whole
 * finding of the Stage-4 loop-back. This function used to take the default
 * lane's id and ask "did the run's scope contain it?" — a PROXY that holds only
 * while the default lane contains every active Player. It fails the moment
 * anyone uses the lane commands #191 shipped: point the default at a brand-new
 * empty lane and a sweep of zero players certified the whole Watch List as
 * `fresh`. The question this function actually answers is "was every player I am
 * about to report on swept?", so that is the question the column now records
 * (`runRefresh` writes `NULL` for a run whose lanes covered everyone) and this is
 * the question the filter asks. No proxy is left to drift, and the parameter
 * goes away with it.
 */
export function digestFreshnessFor(db: Db, contentDate: string, tz: string): DigestFreshness {
  // The LATEST ELIGIBLE ok/partial by (started_at, id) is authoritative: if IT
  // does not clear the content date, no OLDER success can either. One indexed,
  // LIMIT 1 read replaces the old whole-table materialize-and-scan. An
  // INELIGIBLE newer partial-coverage run is skipped rather than allowed to
  // answer, so a frequent lane sweep can never hide an older complete run's
  // verdict.
  const latest = db
    .select()
    .from(refreshRuns)
    .where(and(inArray(refreshRuns.status, ["ok", "partial"]), isNull(refreshRuns.scopeListIds)))
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
 * The DERIVED health vocabulary (ADR 0043) — distinct from the stored
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
  /**
   * Passed-Over Players on the latest run (#146). Additive: a pre-#146 row
   * reports the backfilled `0` (see drizzle/0011), which means "not recorded".
   */
  playersSkipped: number;
  /** Collected per-player failures on the latest run (#146). Same backfill caveat. */
  playersFailed: number;
  playersTotal: number;
  statLinesInserted: number;
  statLinesUpdated: number;
}

/**
 * The refresh block of the health snapshot (ADR 0043), or null when no run has
 * ever been recorded. Ordering is (started_at desc, id desc):
 *   - a LIVE `running` lease ⇒ `running`;
 *   - otherwise the latest TERMINAL run decides — `failed`→`failed`,
 *     `partial`→`partial`, `ok`→`fresh` when it started today (host) else
 *     `stale`; with no terminal run at all (only a CRASHED `running` row whose
 *     lease expired) ⇒ `stale`, never `running`.
 * `lastStartedAt`/`lastFinishedAt` and the counts come from the latest run row;
 * `lastSuccessAt` from the latest ok/partial.
 *
 * DELIBERATELY SCOPE-BLIND (#192, ADR 0061), unlike {@link digestFreshnessFor}
 * directly above. The two answer different questions, so they take different
 * filters — this is a decision, not an omission. `/health` and the MCP `status`
 * tool answer "what did INGESTION last do on this host?", and adding that
 * function's `scope_list_ids IS NULL` filter here would HIDE a lane run that
 * settled `failed` from the only surface that reports it, suppressing a real
 * operational signal because the failure happened to be scoped. A freshness
 * CLAIM must be narrowed to what it claims for; an operational SIGNAL must not be.
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
    playersSkipped: latest.playersSkipped,
    playersFailed: latest.playersFailed,
    playersTotal: latest.playersTotal,
    statLinesInserted: latest.statLinesInserted,
    statLinesUpdated: latest.statLinesUpdated,
  };
}

/** A lease is live while it has not expired; an unparseable clock is treated as stale. */
function leaseIsLive(claimedAt: string, nowMs: number, leaseMs: number): boolean {
  const claimedMs = Date.parse(claimedAt);
  if (!Number.isFinite(claimedMs)) return false;
  return nowMs - claimedMs < leaseMs;
}
