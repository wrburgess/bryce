import { and, desc, eq, exists, gt, gte, inArray, isNull, like, lte, max, not, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { RefreshRunRow, RefreshRunStatus } from "../db/schema.js";
import { listMembers, players, refreshRuns } from "../db/schema.js";
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
 *
 * AND `started_at` IS THE SELECTION WATERMARK, NOT THE CLAIM INSTANT (PR #203
 * Reviewer P1). Every coverage question this file answers is really "what did
 * this run's player selection see?", and the sweep selects its players BEFORE it
 * claims — `runRefresh` loads calendars in between, several database reads wide.
 * Stamping the CLAIM instant onto `started_at` therefore backdates the run's
 * knowledge: a Player enrolled into a swept lane inside that gap has a
 * `created_at` EARLIER than the recorded start, so the membership test below
 * reads him as covered while `activePlayers` — fixed before he existed to the
 * query — never fetched him. That is the same forged `fresh` the membership test
 * exists to refuse, arrived at through the run's own clock. So the caller passes
 * the instant it took its selection snapshot (`ClaimRefreshArgs.startedAt`) and
 * THAT is what the row records; `claimed_at` remains the claim instant, because
 * it is the LEASE clock and a lease may only ever be measured from when it was
 * actually taken. `started_at <= claimed_at` from here on — a DATABASE CHECK
 * since drizzle/0014, because an ordering this much is riding on is not a
 * guarantee while it lives only in this file (rules/backend.md) — and everything
 * that reads `started_at` treats an earlier value conservatively: a freshness
 * claim gets weaker, never stronger, and the tick's next sweep comes sooner.
 */

/** How long a `running` claim is honored before another run may take over. */
export const REFRESH_LEASE_MS = 10 * 60 * 1000;

/** A terminal outcome — every status except the in-flight `running`. */
export type RefreshTerminalStatus = Exclude<RefreshRunStatus, "running">;

export type ClaimRefreshResult =
  | { claimed: true; runId: number }
  | { claimed: false; reason: "already-running" };

export interface ClaimRefreshArgs {
  /**
   * The CLAIM instant: the lease clock (`claimed_at`), the reap cutoff, and the
   * row's `created_at`. Never the coverage anchor — see {@link startedAt}.
   */
  now: Date;
  /**
   * When this run took its PLAYER SELECTION snapshot — recorded as `started_at`,
   * which is the anchor every coverage and freshness test keys on (see this
   * file's header). `runRefresh` reads its clock immediately before
   * `selectSweepPlayers` and passes THAT instant, because the sweep's knowledge
   * of who is active and who is on a lane is frozen there, not at the claim.
   *
   * Optional, defaulting to {@link now}, for a caller whose selection IS its
   * claim — a fixture claiming a bare run, and nothing in `src/`. The default is
   * the conservative direction only for such a caller: any real gap between
   * selection and claim MUST be declared, or the row overstates what the run
   * knew. It is never clamped against `now`; a caller that passes a LATER
   * instant is stating a falsehood no guard here can repair.
   */
  startedAt?: Date;
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
 * THE SENTINELS ARE LOAD-BEARING AGAIN (#193, ADR 0062 decision 2). This column
 * was demoted to "provenance that nothing parses back" at the end of #192; #193
 * promotes it to a QUERYABLE COVERAGE RECORD, because the question "did a run
 * cover lane L?" is now asked twice — by the digest's per-lane freshness banner
 * and by the tick's refresh due-ness clock — and both are answered from this one
 * column by {@link latestCoveringRun}. The fencing commas are what make that
 * containment test exact: `LIKE '%,1,%'` matches `,1,3,` and NOT `,11,`, whereas
 * an unfenced `LIKE '%1%'` would read lane 11's sweep as covering lane 1 and
 * forge a `fresh` banner over players nobody fetched. A test pins that exact pair.
 *
 * The empty-scope reason stands unchanged beside it: the EMPTY scope must not
 * encode to the empty string. `,,` is visibly "swept zero lanes"; `""` is a value
 * that `if (!row.scopeListIds)` in TypeScript, `ifnull()` in SQL, and most
 * CSV/JSON round-trips cannot tell from `NULL` — and `NULL` here means "swept
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
  // The coverage anchor is the caller's SELECTION instant, which is at or before
  // the claim (see the header). Kept separate from `nowIso` on purpose: every
  // lease decision in this function — the live-lease refusal, the reap cutoff,
  // this row's own `claimed_at` — must read the CLAIM instant, or an earlier
  // anchor would make a brand-new claim look expired to its own successor.
  const startedIso = (args.startedAt ?? args.now).toISOString();
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
          // The SELECTION watermark (PR #203 Reviewer P1), not this instant.
          startedAt: startedIso,
          finishedAt: null,
          status: "running",
          // The lease, always measured from the claim itself.
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
 * THE latest ok/partial run whose sweep COVERED `laneId` (#193, ADR 0062
 * decision 2) — the one place the coverage predicate is authored.
 *
 * `null` asks the WHOLE-WATCH-LIST question ("did a run sweep every active
 * Player?") and accepts only `scope_list_ids IS NULL`. A lane id asks the
 * narrower one ("did a run sweep this lane?") and accepts either a whole-list
 * run — which covers every lane by definition — or a scoped run whose fenced id
 * list contains it.
 *
 * TWO CALLERS, ONE PREDICATE, and that is the point rather than a tidiness
 * preference. {@link digestFreshnessFor} asks it to decide whether a lane's
 * digest may claim `fresh`, and the tick (`src/jobs/tick.ts`) asks it to decide
 * whether a lane's refresh interval has elapsed. Re-authoring the `LIKE` at
 * either call site is how the fencing quietly stops matching at one of them —
 * `rules/scripting.md`, and the exact defect shape this repo keeps finding.
 *
 * NAMING A LANE IS NOT COVERING ITS MEMBERS (PR #203 Reviewer P2). A scoped run
 * records the lane ID, never the players it selected, so the id test alone is
 * IDENTITY one level down — the very thing this predicate exists to refuse. Add
 * an active Player to lane L after L's sweep began and the old run still names
 * L, while `assembleDigest` now reports a player it never fetched: a forged
 * `fresh`. So a SCOPED run covers L only while NO current active member of L
 * joined at or after that run's `started_at`.
 *
 * WHICH IS THE SELECTION WATERMARK, and that is what makes this test sound (PR
 * #203 Reviewer P1). `started_at` is stamped from the clock read immediately
 * before the sweep's selection query, never from the later claim — `runRefresh`
 * loads calendars in between, so a claim-instant anchor would leave every
 * enrollment inside that gap comparing as "before the run started" and reading
 * as covered by a selection that never saw it. A join is `>=`, not `>`: the
 * watermark is read just before the selection query, so a member added in that
 * same instant may never have been in it.
 *
 * DELIBERATELY SCOPED TO SCOPED RUNS. A whole-list run (`scope_list_ids IS
 * NULL`) swept every THEN-ACTIVE Player, and its claim is about players rather
 * than lanes — moving one of those players onto a lane afterwards changes no
 * fact about what it fetched. Widening the membership test to NULL rows would
 * silently retighten the pre-existing #192 / ADR 0061 whole-list behavior this
 * change has no business touching (a fresh enrollment would flip every lane
 * banner to `stale` on a host that never scopes a sweep at all). A genuinely NEW
 * active Player is a different matter and is already handled elsewhere: he is
 * absent from the run's `players_total`, and the next sweep re-answers.
 *
 * The degradation is CONSERVATIVE BY CONSTRUCTION — it can only demote a claim,
 * never manufacture one. When the newest scoped run stops covering, the query
 * falls through to an older covering run or to `undefined`, so the banner reads
 * `stale` and the tick reads the lane as due and re-sweeps it. Self-healing:
 * that sweep starts after the join, so it covers again.
 *
 * `failed` runs never cover, and the anchor is `started_at`, not `finished_at`
 * (see this file's header): a run that STARTED after the content day ended saw
 * every one of that day's now-final games.
 *
 * ORDERING IS (started_at desc, id desc) OVER THE ELIGIBLE SET, never over every
 * run. A newer INELIGIBLE run — another lane's sweep — must not be allowed to
 * answer and hide an older covering one, which is the per-lane twin of the
 * invariant #192 pinned for whole-list coverage.
 *
 * ORDERING BY THE WATERMARK STAYS RIGHT once `started_at` is the selection
 * instant rather than the claim (PR #203 Reviewer P1): each candidate is judged
 * on ITS OWN watermark by the correlated `EXISTS` above, so every row that
 * survives is a claim its own selection can prove, and the latest watermark is
 * the strongest of them. It is deliberately NOT `id` order — id is claim order,
 * and a run that claimed later can have selected earlier.
 */
export function latestCoveringRun(db: Db, laneId: number | null): RefreshRunRow | undefined {
  // A non-integer id would be interpolated into the LIKE pattern below, so it is
  // refused here rather than allowed to build a pattern that matches nothing (or,
  // worse, something). Every real caller passes a `player_lists.id`; this exists
  // so the function is safe in isolation, not because a caller is suspected.
  if (laneId !== null && !Number.isSafeInteger(laneId)) {
    throw new Error(`latestCoveringRun: laneId must be an integer, got ${String(laneId)}`);
  }
  const covers =
    laneId === null
      ? isNull(refreshRuns.scopeListIds)
      : or(
          // A whole-list run covers every lane by definition, and no membership
          // test applies to it (see the doc comment: its claim is about players,
          // not lanes).
          isNull(refreshRuns.scopeListIds),
          and(
            // The fenced containment test. `,1,` matches `,1,3,` and NOT `,11,`,
            // which is the whole reason `encodeScopeListIds` keeps its sentinel
            // commas. The pattern is a bound parameter, never spliced SQL.
            like(refreshRuns.scopeListIds, `%,${laneId},%`),
            // ...AND the lane's membership has not moved under it. A CORRELATED
            // EXISTS on the run row's own `started_at`, never a materialized id
            // list (rules/backend.md): it stays constant-size however many
            // members the lane holds, and SQLite short-circuits on the first
            // offending row. `players.active` is the master gate (ADR 0046
            // decision 2) and the join reproduces the sweep's OWN selection
            // predicate (`selectSweepPlayers`: active AND a member of a scoped
            // lane), so an INACTIVE player added afterwards spoils nothing —
            // the sweep would not have fetched him and the digest does not
            // report him.
            not(
              exists(
                db
                  .select({ x: sql`1` })
                  .from(listMembers)
                  .innerJoin(players, eq(players.id, listMembers.playerId))
                  .where(
                    and(
                      eq(listMembers.listId, laneId),
                      eq(players.active, true),
                      // Both columns are `Date#toISOString()` bytes — the app
                      // writes them (`insertMemberships`, `claimRefreshRun`) and
                      // so does drizzle/0012's backfill
                      // (`strftime('%Y-%m-%dT%H:%M:%fZ')`) — so this string
                      // comparison is a chronological one.
                      gte(listMembers.createdAt, refreshRuns.startedAt),
                    ),
                  ),
              ),
            ),
          ),
        );
  return db
    .select()
    .from(refreshRuns)
    .where(and(inArray(refreshRuns.status, ["ok", "partial"]), covers))
    .orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id))
    .limit(1)
    .all()[0];
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
 * THE PREDICATE IS COVERAGE, NOT IDENTITY (#192, ADR 0061 decision 8). Scoping
 * the sweep opened a hole the whole-list sweep did not have: `sk refresh -l
 * Prospects` settling `ok` must not make this banner read `fresh` over players
 * that sweep never touched. So the question asked is always "was every player I
 * am about to report on swept?" — never "which lane was named?".
 *
 * AND NOT LANE IDENTITY EITHER (PR #203 Reviewer P2). A run's lane id is a
 * second identity, one level down: a scoped run records the lane, never its
 * members, so a player who joined the lane AFTER that sweep began is reported by
 * `assembleDigest` and was never fetched. {@link latestCoveringRun} therefore
 * expires a scoped run's coverage of a lane whose active membership grew at or
 * after its `started_at`, which lands here as an honest `stale` rather than a
 * forged `fresh`. The `null` (whole-list) question is untouched.
 *
 * `laneId` IS WHICH PLAYERS THE DIGEST IS ABOUT (#193, ADR 0062). Bare `sk
 * digest` now assembles the DEFAULT LANE's members rather than the whole Watch
 * List, and a named-lane 1d send assembles that lane's — so demanding a
 * whole-list sweep would leave every lane digest permanently `stale` on a host
 * whose lanes do not happen to hold everyone. Passing the lane narrows the claim
 * to exactly what the email claims for; `null` keeps the whole-list read for a
 * caller reporting on every active Player. Narrowing is safe in the direction
 * that matters: a whole-list run still covers every lane, so it still answers.
 */
export function digestFreshnessFor(
  db: Db,
  contentDate: string,
  tz: string,
  laneId: number | null = null,
): DigestFreshness {
  // The LATEST COVERING ok/partial by (started_at, id) is authoritative: if IT
  // does not clear the content date, no OLDER success can either. One indexed,
  // LIMIT 1 read replaces the old whole-table materialize-and-scan. An
  // INELIGIBLE newer run — one that did not cover this lane — is skipped rather
  // than allowed to answer, so another lane's frequent sweep can never hide this
  // lane's older covering run's verdict.
  const latest = latestCoveringRun(db, laneId);

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
 * ever been recorded. Ordering is (id desc):
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
 *
 * "LATEST" HERE IS CLAIM ORDER (`id`), not the `started_at` watermark, and the
 * two stopped being interchangeable when `started_at` became the SELECTION
 * instant (PR #203 Reviewer P1). A run selects before it claims, so a run that
 * claimed later CAN carry an earlier `started_at` — two overlapping sweeps where
 * the second one's selection-to-claim gap outlasts the first one's entire run.
 * Ordering by the watermark would then rank a settled predecessor above the live
 * successor and this function would report `fresh` (with the predecessor's
 * counts) while a sweep is in flight. `id` is the durable generation the claim
 * transaction already serializes — the same fact `admitTargetedRefresh` fences
 * on — so it answers "the latest run" exactly. {@link latestCoveringRun} keeps
 * the watermark ordering, because it asks a different question: not which run is
 * newest, but which PROVABLE coverage claim is strongest.
 */
export function refreshHealth(db: Db, now: Date, tz: string): RefreshHealth | null {
  const order = [desc(refreshRuns.id)] as const;

  // The overall latest run row (any status) sources lastStartedAt/lastFinishedAt
  // and the counts, and decides `running` when it is a live lease. Fencing
  // (claimRefreshRun) guarantees a live `running` is always the newest CLAIM, so
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
