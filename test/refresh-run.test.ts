import { desc, eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import {
  highlightlyBoxScoreCache,
  highlightlyMatchCache,
  highlightlyPlayerCursors,
  players,
  refreshRuns,
  seasonCalendar,
  statLines,
} from "../src/db/schema.js";
import { runRefresh } from "../src/jobs/refresh.js";
import {
  SUPERSEDED_MESSAGE,
  claimRefreshRun,
  admitTargetedRefresh,
  digestFreshnessFor,
  encodeScopeListIds,
  refreshHealth,
  renewRefreshRun,
  settleRefreshRun,
  updateRefreshRunProgress,
  withIngestionFence,
} from "../src/jobs/refresh-run.js";
import { resolveDefaultList } from "../src/lists/service.js";
import { TEST_TZ, insertList, insertRefreshRun, testDb, testFileDb } from "./factories.js";

/** A base instant and two derived ones straddling the 10-minute lease. */
const T0 = "2026-07-19T07:00:00.000Z";
const WITHIN_LEASE = "2026-07-19T07:05:00.000Z"; // +5 min
const PAST_LEASE = "2026-07-19T07:11:00.000Z"; // +11 min
const NCAA_T0 = "2026-05-19T07:00:00.000Z";
const NCAA_PAST_LEASE = "2026-05-19T07:11:00.000Z";

const at = (iso: string) => new Date(iso);

describe("claimRefreshRun / settleRefreshRun (ADR 0043)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("inserts a running row with started_at == claimed_at and the players total", () => {
    const claim = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 4 });
    expect(claim.claimed).toBe(true);

    const rows = opened.db.select().from(refreshRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "running",
      startedAt: T0,
      claimedAt: T0,
      finishedAt: null,
      playersTotal: 4,
      playersRefreshed: 0,
    });
  });

  it("refuses `already-running` while ANY row holds a live lease", () => {
    const first = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    expect(first.claimed).toBe(true);

    // Still within the lease: a second claim is refused, and no second row lands.
    const second = claimRefreshRun(opened.db, { now: at(WITHIN_LEASE), playersTotal: 2 });
    expect(second).toEqual({ claimed: false, reason: "already-running" });
    expect(opened.db.select().from(refreshRuns).all()).toHaveLength(1);
  });

  it("renewal keeps a long run live: a would-be-expired lease is bumped and still blocks", () => {
    const first = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!first.claimed) throw new Error("expected claim");

    // A healthy long sweep renews at +5 min — so at +11 min (which WOULD be past
    // the original lease) the lease is only 6 minutes old and still live.
    renewRefreshRun(opened.db, first.runId, at(WITHIN_LEASE));
    const contender = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 2 });
    expect(contender).toEqual({ claimed: false, reason: "already-running" });
  });

  it("a run that STOPS renewing expires and is reaped `failed` by the next claim", () => {
    const first = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!first.claimed) throw new Error("expected claim");

    // No renewal: at +11 min the lease has expired, so a new run may claim — and
    // the claim FENCES the crashed run by settling its row `failed` BEFORE
    // inserting its own, so a superseded run can never write past its lease.
    const recovered = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 2 });
    if (!recovered.claimed) throw new Error("expected recovery claim");

    // Only ONE `running` row now — the fresh claim; the crashed one was reaped.
    const running = opened.db.select().from(refreshRuns).where(eq(refreshRuns.status, "running")).all();
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(recovered.runId);

    // The crashed row is now `failed`, stamped finished with the superseded note.
    const reaped = opened.db.select().from(refreshRuns).where(eq(refreshRuns.id, first.runId)).all()[0];
    expect(reaped).toMatchObject({
      status: "failed",
      finishedAt: PAST_LEASE,
      errorMessage: SUPERSEDED_MESSAGE,
    });
  });

  it("treats the exact lease boundary as expired for claim and reap", () => {
    const first = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 1 });
    if (!first.claimed) throw new Error("expected claim");
    const boundary = claimRefreshRun(opened.db, { now: at("2026-07-19T07:10:00.000Z"), playersTotal: 1 });
    expect(boundary).toMatchObject({ claimed: true });
    expect(opened.db.select().from(refreshRuns).where(eq(refreshRuns.id, first.runId)).all()[0])
      .toMatchObject({ status: "failed", errorMessage: SUPERSEDED_MESSAGE });
  });

  it("claimRefreshRun reaps an expired-lease `running` row to `failed` before inserting the new run", () => {
    // A crashed run left `running` with a long-stale lease, and no live lease
    // exists, so the next claim proceeds — and must fence the zombie first.
    const first = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!first.claimed) throw new Error("expected claim");

    const second = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 3 });
    if (!second.claimed) throw new Error("expected second claim");

    // The reap happened INSIDE the claim txn, before the insert: the old row is
    // terminal, the new row is the sole `running` one.
    const reaped = opened.db.select().from(refreshRuns).where(eq(refreshRuns.id, first.runId)).all()[0];
    expect(reaped?.status).toBe("failed");
    expect(reaped?.finishedAt).toBe(PAST_LEASE);
    expect(reaped?.errorMessage).toBe(SUPERSEDED_MESSAGE);
    const fresh = opened.db.select().from(refreshRuns).where(eq(refreshRuns.id, second.runId)).all()[0];
    expect(fresh).toMatchObject({ status: "running", finishedAt: null, playersTotal: 3 });
  });

  it("renewRefreshRun returns true while a run owns its live lease, false once reaped", () => {
    // +20 min: well past the lease even after a +5 min renew (which pushes
    // expiry to +15 min), so the successor's claim genuinely reaps the owner.
    const PAST_RENEWED_LEASE = "2026-07-19T07:20:00.000Z";
    const owner = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!owner.claimed) throw new Error("expected claim");

    // Still `running`: renew succeeds and reports continued ownership.
    expect(renewRefreshRun(opened.db, owner.runId, at(WITHIN_LEASE))).toBe(true);

    // A successor claims after the renewed lease expires, reaping the owner's row.
    const successor = claimRefreshRun(opened.db, { now: at(PAST_RENEWED_LEASE), playersTotal: 2 });
    if (!successor.claimed) throw new Error("expected successor");

    // The owner has lost the lease: its next renew updates nothing → false.
    expect(renewRefreshRun(opened.db, owner.runId, at(PAST_RENEWED_LEASE))).toBe(false);
    // And a renew of a wholly unknown id is likewise false (nothing to own).
    expect(renewRefreshRun(opened.db, 999_999, at(PAST_RENEWED_LEASE))).toBe(false);
  });

  it("does not let an expired but unreaped worker renew itself at the exact lease boundary", () => {
    const claim = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 1 });
    if (!claim.claimed) throw new Error("expected claim");
    expect(renewRefreshRun(opened.db, claim.runId, at("2026-07-19T07:10:00.000Z"))).toBe(false);
    expect(opened.db.select().from(refreshRuns).where(eq(refreshRuns.id, claim.runId)).all()[0]?.claimedAt).toBe(T0);
  });

  it("rejects a guarded whole-refresh mutation after the owner is reaped", () => {
    const a = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 1 });
    if (!a.claimed) throw new Error("expected claim");
    claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 1 });
    const result = withIngestionFence(opened.db, { kind: "whole-refresh", runId: a.runId, now: at(PAST_LEASE) }, () => "written");
    expect(result).toEqual({ committed: false, reason: "lost-ownership" });
  });

  it("captures a targeted generation and rejects its write when a sweep claims first", () => {
    const targeted = admitTargetedRefresh(opened.db, at(T0));
    if (!targeted.admitted) throw new Error("expected targeted admission");
    const sweep = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 1 });
    if (!sweep.claimed) throw new Error("expected sweep claim");
    const result = withIngestionFence(opened.db, targeted.fence, () => "written");
    expect(result).toEqual({ committed: false, reason: "whole-refresh-running" });
  });

  it("persists live progress only while the run still owns its running row", () => {
    const claim = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 3 });
    if (!claim.claimed) throw new Error("expected claim");
    const counts = { playersRefreshed: 1, playersSkipped: 1, playersFailed: 1, playersTotal: 3, statLinesInserted: 4, statLinesUpdated: 2 };

    expect(updateRefreshRunProgress(opened.db, claim.runId, counts)).toBe(true);
    expect(opened.db.select().from(refreshRuns).all()[0]).toMatchObject(counts);

    settleRefreshRun(opened.db, { runId: claim.runId, now: at(WITHIN_LEASE), status: "partial", counts });
    expect(updateRefreshRunProgress(opened.db, claim.runId, {
      playersRefreshed: 3, playersSkipped: 0, playersFailed: 0, playersTotal: 3, statLinesInserted: 9, statLinesUpdated: 9,
    })).toBe(false);
    expect(opened.db.select().from(refreshRuns).all()[0]).toMatchObject(counts);
  });

  it("a live and an expired running row coexist: the LIVE one wins admission", async () => {
    // A crashed run from long ago (expired lease) plus a healthy in-flight run.
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: "2026-07-19T06:00:00.000Z",
      claimedAt: "2026-07-19T06:00:00.000Z", // over an hour stale
      finishedAt: null,
    });
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: WITHIN_LEASE,
      claimedAt: WITHIN_LEASE, // live at PAST_LEASE (6 min old)
      finishedAt: null,
    });

    const contender = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 2 });
    expect(contender).toEqual({ claimed: false, reason: "already-running" });
  });

  it("a reaped zombie's late settle is REFUSED, never resurrecting its row into a success", () => {
    // A claims, its lease expires, B takes over (reaping A to `failed`). Then BOTH
    // settle — A late. A's settle owns nothing, so it must change NOTHING and
    // return false: a zombie cannot forge a success over B's newer data.
    const a = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!a.claimed) throw new Error("expected A");
    const b = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 3 });
    if (!b.claimed) throw new Error("expected B");

    // B (the winner) still owns its row → settles ok and returns true.
    expect(
      settleRefreshRun(opened.db, {
        runId: b.runId,
        now: at("2026-07-19T07:12:00.000Z"),
        status: "ok",
        counts: { playersRefreshed: 3, playersSkipped: 0, playersFailed: 0, playersTotal: 3, statLinesInserted: 5, statLinesUpdated: 1 },
      }),
    ).toBe(true);
    // A was reaped by B's claim, so its late settle owns nothing → false, no write.
    expect(
      settleRefreshRun(opened.db, {
        runId: a.runId,
        now: at("2026-07-19T07:20:00.000Z"),
        status: "partial",
        counts: { playersRefreshed: 1, playersSkipped: 0, playersFailed: 1, playersTotal: 2, statLinesInserted: 2, statLinesUpdated: 0 },
      }),
    ).toBe(false);

    const rows = opened.db.select().from(refreshRuns).orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id)).all();
    expect(rows).toHaveLength(2);
    const rowB = rows.find((r) => r.id === b.runId);
    const rowA = rows.find((r) => r.id === a.runId);
    // B's ok is intact; A stays `failed` as reaped — never resurrected to `partial`.
    expect(rowB).toMatchObject({ status: "ok", playersRefreshed: 3, statLinesInserted: 5 });
    expect(rowA).toMatchObject({ status: "failed", errorMessage: SUPERSEDED_MESSAGE });

    // The watermark is the LATEST by (started_at, id) — B, the real winner.
    const fresh = digestFreshnessFor(opened.db, "2026-07-18", TEST_TZ);
    expect(fresh.state).toBe("fresh"); // B started 2026-07-19 (host), > content 07-18, ok
    expect(fresh.playersRefreshed).toBe(3);
  });

  it("settle stamps ok/partial/failed with counts and an error message", () => {
    const okClaim = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 1 });
    if (!okClaim.claimed) throw new Error("expected claim");
    settleRefreshRun(opened.db, {
      runId: okClaim.runId,
      now: at(WITHIN_LEASE),
      status: "failed",
      counts: { playersRefreshed: 0, playersSkipped: 0, playersFailed: 1, playersTotal: 1, statLinesInserted: 0, statLinesUpdated: 0 },
      errorMessage: "MLB Stats API request failed with HTTP 503",
    });
    const row = opened.db.select().from(refreshRuns).all()[0];
    expect(row).toMatchObject({
      status: "failed",
      finishedAt: WITHIN_LEASE,
      errorMessage: "MLB Stats API request failed with HTTP 503",
      playersRefreshed: 0,
      playersTotal: 1,
    });
  });
});

describe("digestFreshnessFor boundary (ADR 0043)", () => {
  let opened: OpenedDb;
  const CONTENT_DATE = "2026-07-18"; // a 1d digest run on 07-19 covers 07-18

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("a run STARTED on the content date itself is stale (not yet after the day ended)", async () => {
    // host date of started_at == 2026-07-18 (12:00Z = 07:00 CDT on 07-18).
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-18T12:00:00.000Z",
      finishedAt: "2026-07-18T12:05:00.000Z",
    });
    const fresh = digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ);
    expect(fresh.state).toBe("stale");
    // asOf falls back to the latest ok/partial finish, so it is dated, not null.
    expect(fresh.asOf).toBe("2026-07-18T12:05:00.000Z");
  });

  it("a run STARTED the next host date is fresh", async () => {
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T12:00:00.000Z", // host date 2026-07-19
      finishedAt: "2026-07-19T12:05:00.000Z",
    });
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
  });

  it("a midnight-straddling run started before midnight is stale for that content date", async () => {
    // Started 2026-07-18 23:50 CDT (= 07-19 04:50 UTC), FINISHED after midnight.
    // Anchoring on finished_at would look fresh; anchoring on started_at (host
    // date 2026-07-18) is correctly stale — it may have swept players live.
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T04:50:00.000Z",
      finishedAt: "2026-07-19T05:10:00.000Z", // 00:10 CDT on 07-19
    });
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
  });

  it("a qualifying PARTIAL run yields partial, carrying its N-of-M counts", async () => {
    await insertRefreshRun(opened.db, {
      status: "partial",
      startedAt: "2026-07-19T12:00:00.000Z",
      finishedAt: "2026-07-19T12:05:00.000Z",
      playersRefreshed: 2,
      playersTotal: 5,
    });
    const fresh = digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ);
    expect(fresh).toMatchObject({ state: "partial", playersRefreshed: 2, playersTotal: 5 });
  });

  it("a qualifying FAILED run is stale, dated by the last good run (or never)", async () => {
    // No successful run ever: stale with asOf null ("never").
    await insertRefreshRun(opened.db, {
      status: "failed",
      startedAt: "2026-07-19T12:00:00.000Z",
      finishedAt: "2026-07-19T12:05:00.000Z",
      playersRefreshed: 0,
      playersTotal: 5,
    });
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ)).toMatchObject({
      state: "stale",
      asOf: null,
    });
  });

  it("breaks a started_at tie deterministically by id (the later-inserted run wins)", async () => {
    // Two qualifying ok runs sharing an exact started_at: the ORDER BY id DESC
    // tie-breaker makes the winner deterministic (the higher id, inserted last),
    // never dependent on storage/scan order.
    const shared = "2026-07-19T12:00:00.000Z"; // host 07-19 > content 07-18
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: shared,
      finishedAt: "2026-07-19T12:05:00.000Z",
      playersRefreshed: 2,
      playersTotal: 9,
    });
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: shared,
      finishedAt: "2026-07-19T12:06:00.000Z",
      playersRefreshed: 7,
      playersTotal: 9,
    });

    const fresh = digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ);
    expect(fresh).toMatchObject({
      state: "fresh",
      asOf: "2026-07-19T12:06:00.000Z", // the SECOND row's finish
      playersRefreshed: 7,
    });
  });

  it("returns stale/never on an empty table", () => {
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ)).toEqual({
      state: "stale",
      asOf: null,
      playersRefreshed: 0,
      playersTotal: 0,
    });
  });
});

/**
 * The coverage-keyed freshness watermark, at the STORAGE layer (#192 / ADR 0061
 * decision 8).
 *
 * Scoping the sweep opens a hole `digestFreshnessFor` did not have before: a
 * `sk refresh -l Prospects` that settles `ok` is a completeness claim about
 * Prospects and about nothing else, so letting it answer the whole watch list's
 * banner would forge `fresh` over players it never touched.
 *
 * These cases pin the READER's half of the contract: a row with a recorded scope
 * certifies nothing, a `NULL` row certifies everything, and the encoder produces
 * a form in which no legal scope is falsy. WHO GETS `NULL` is `runRefresh`'s
 * claim-time coverage decision, and it is tested where that decision lives —
 * `test/refresh-list.test.ts` → *coverage-keyed freshness watermark*. Splitting
 * them that way is deliberate: a `claimRefreshRun` fixture writes the scope by
 * hand, so it can never demonstrate that the job DERIVED the right one.
 */
describe("coverage-keyed freshness watermark, storage layer (#192)", () => {
  let opened: OpenedDb;
  /** host date 2026-07-19, strictly after the content date — a qualifying start. */
  const QUALIFYING_START = "2026-07-19T12:00:00.000Z";
  const CONTENT_DATE = "2026-07-18";

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  /** Claim + settle one run over `scopeListIds`, so the REAL encoder writes the row. */
  const sweep = (
    status: "ok" | "partial" | "failed",
    scopeListIds: readonly number[] | undefined,
    startedAt: string = QUALIFYING_START,
  ): void => {
    const claim = claimRefreshRun(opened.db, {
      now: at(startedAt),
      playersTotal: 2,
      scopeListIds,
    });
    if (!claim.claimed) throw new Error("expected claim");
    settleRefreshRun(opened.db, {
      runId: claim.runId,
      // Five minutes after its own start, so a second sweep in the same case
      // claims cleanly rather than colliding with a live lease.
      now: new Date(at(startedAt).getTime() + 5 * 60 * 1000),
      status,
      counts: { playersRefreshed: 2, playersSkipped: 0, playersFailed: 0, playersTotal: 2, statLinesInserted: 0, statLinesUpdated: 0 },
    });
  };

  it("encodes a scope canonically: deduped, ascending, sentinel-wrapped", () => {
    // Deduping and ordering make two sweeps of the same lanes store the same
    // bytes, so the column is comparable and greppable as provenance.
    expect(encodeScopeListIds(undefined)).toBeNull();
    expect(encodeScopeListIds([3, 1, 10])).toBe(",1,3,10,");
    expect(encodeScopeListIds([2, 2, 2])).toBe(",2,");
    // The one property the FORM still has to carry, now that nothing does
    // substring containment: zero lanes must not encode to the EMPTY STRING.
    // `NULL` here means "swept everything", and `""` is a value that
    // `if (!row.scopeListIds)`, SQL `ifnull()`, and most CSV/JSON round-trips
    // cannot tell from `NULL` — the fail-OPEN direction. `,,` is falsy nowhere.
    expect(encodeScopeListIds([])).toBe(",,");
    expect(encodeScopeListIds([])).not.toBe("");
    expect(Boolean(encodeScopeListIds([]))).toBe(true);
  });

  it("a run with ANY recorded scope certifies nothing, whichever lane it names", async () => {
    // The run is real, recent, and `ok`. It swept less than the whole Watch
    // List, so it answers for nothing the whole-list digest reports — and it is
    // the DEFAULT lane here on purpose, because the predicate this replaced
    // would have called exactly this row `fresh`.
    const defaultLaneId = (await resolveDefaultList(opened.db)).id;
    sweep("ok", [defaultLaneId]);

    expect(opened.db.select().from(refreshRuns).all()[0]?.scopeListIds).toBe(`,${defaultLaneId},`);
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
  });

  it("an UNSCOPED (NULL) run reads fresh: MCP, REST, and every pre-#192 caller unchanged", () => {
    sweep("ok", undefined);

    expect(opened.db.select().from(refreshRuns).all()[0]?.scopeListIds).toBeNull();
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
  });

  it("a HISTORICAL row migrated by drizzle/0013 reads fresh, not stale", async () => {
    // Inserted directly, never through the claim, because that is what a
    // pre-#192 row IS after the additive migration: every other column set and
    // `scope_list_ids` NULL. If `NULL` were ever read as "unknown coverage"
    // rather than "swept everything", every host would go `stale` on upgrade
    // until its next sweep — a silent, self-healing-in-a-day regression that no
    // fresh-database test can see.
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: QUALIFYING_START,
      claimedAt: QUALIFYING_START,
      finishedAt: "2026-07-19T12:05:00.000Z",
      playersRefreshed: 4,
      playersTotal: 4,
    });

    expect(opened.db.select().from(refreshRuns).all()[0]?.scopeListIds).toBeNull();
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ)).toMatchObject({
      state: "fresh",
      playersRefreshed: 4,
    });
  });

  it("a NEWER partial-coverage run never hides an older complete one — it is skipped, not preferred", async () => {
    // The order-by picks the latest ELIGIBLE row, not the latest row that is
    // then tested. A lane sweep runs far more often than a whole-list one, so
    // reading "latest, then filter" would make the banner permanently `stale`
    // on a host that uses lanes at all.
    sweep("ok", undefined);
    const other = await insertList(opened.db, { name: "Prospects" });
    sweep("ok", [other.id], "2026-07-19T18:00:00.000Z");

    expect(opened.db.select().from(refreshRuns).all()).toHaveLength(2);
    expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
  });

  it("a lane-scoped FAILED run DOES surface in refreshHealth — the deliberate split", async () => {
    const other = await insertList(opened.db, { name: "Prospects" });
    sweep("failed", [other.id]);

    // `/health` answers "what did ingestion last do", not "is this lane's digest
    // fresh". Filtering it by lane would hide a real failure from the only
    // surface that reports it, so the two functions take different filters on
    // purpose and this pins it against a well-meaning "fix".
    expect(refreshHealth(opened.db, at("2026-07-19T13:00:00.000Z"), TEST_TZ)?.state).toBe("failed");
  });
});

describe("refreshHealth derivation (ADR 0043)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("is null when no refresh has ever run", () => {
    expect(refreshHealth(opened.db, at(T0), TEST_TZ)).toBeNull();
  });

  it("reports `running` only while the lease is live", async () => {
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: T0,
      claimedAt: T0,
      finishedAt: null,
      playersRefreshed: 1,
      playersTotal: 3,
    });
    expect(refreshHealth(opened.db, at(WITHIN_LEASE), TEST_TZ)?.state).toBe("running");
  });

  it("does NOT report `running` for a crashed run whose lease expired", async () => {
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: T0,
      claimedAt: T0,
      finishedAt: null,
    });
    const health = refreshHealth(opened.db, at(PAST_LEASE), TEST_TZ);
    expect(health?.state).not.toBe("running");
    expect(health?.state).toBe("stale"); // no terminal run to trust
  });

  // #146: the durable Accounting must carry the SAME three-way per-player
  // classification the console's Liveness stream shows, or the two surfaces
  // report different runs. Reading them off `refreshHealth` is what makes
  // `/health` and MCP `status` agree with the terminal for free.
  it("surfaces the passed-over and failed counts of the latest run", async () => {
    await insertRefreshRun(opened.db, {
      status: "partial",
      startedAt: T0,
      claimedAt: T0,
      playersRefreshed: 4,
      playersSkipped: 2,
      playersFailed: 1,
      playersTotal: 7,
      statLinesInserted: 11,
      statLinesUpdated: 3,
    });
    const health = refreshHealth(opened.db, at(WITHIN_LEASE), TEST_TZ);
    expect(health).toMatchObject({
      state: "partial",
      playersRefreshed: 4,
      playersSkipped: 2,
      playersFailed: 1,
      playersTotal: 7,
    });
    // The identity the CLI's terminal line asserts, holding on the durable row.
    expect(
      (health?.playersRefreshed ?? 0) + (health?.playersSkipped ?? 0) + (health?.playersFailed ?? 0),
    ).toBe(health?.playersTotal);
  });

  // A row written before #146 has no recorded value: it reads 0/0. Pinned so a
  // future reader (and any consumer arithmetic) knows a pre-migration row cannot
  // satisfy the refreshed+skipped+failed identity, and that is not a defect.
  it("reports 0/0 for a run that predates the two columns, without inventing a total", async () => {
    await insertRefreshRun(opened.db, {
      status: "partial", startedAt: T0, claimedAt: T0, playersRefreshed: 1, playersTotal: 5,
    });
    const health = refreshHealth(opened.db, at(WITHIN_LEASE), TEST_TZ);
    expect(health).toMatchObject({ playersSkipped: 0, playersFailed: 0, playersTotal: 5 });
    expect(health!.playersRefreshed + health!.playersSkipped + health!.playersFailed).not.toBe(
      health!.playersTotal,
    );
  });
});

describe("refresh run claim across two file-db connections (ADR 0043)", () => {
  it("a second connection sees the durable running row and is refused", () => {
    const file = testFileDb();
    const second = openDb(file.path);
    try {
      const first = claimRefreshRun(file.opened.db, { now: at(T0), playersTotal: 2 });
      expect(first.claimed).toBe(true);

      // A wholly separate connection (the launchd CLI vs the long-lived server):
      // the running row is durable in the FILE, so exclusion survives the process
      // boundary — the real race this design defends against.
      const contender = claimRefreshRun(second.db, { now: at(WITHIN_LEASE), playersTotal: 2 });
      expect(contender).toEqual({ claimed: false, reason: "already-running" });

      // Only one row exists, visible on BOTH connections.
      expect(second.db.select().from(refreshRuns).all()).toHaveLength(1);
      expect(file.opened.db.select().from(refreshRuns).all()).toHaveLength(1);
    } finally {
      second.close();
      file.cleanup();
    }
  });
});

describe("refresh fencing across a real child process (ADR 0048)", () => {
  it("defers a real targeted refresh whose buffered stat write loses to a whole refresh", async () => {
    const file = testFileDb();
    const player = file.opened.db
      .insert(players)
      .values({
        externalId: 7,
        ncaaPlayerSeq: null,
        highlightlyPlayerId: null,
        highlightlyTeamId: null,
        ncaaSourceState: null,
        fullName: "Initial",
        level: "mlb",
        milbLevel: null,
        teamName: null,
        position: null,
        schoolName: null,
        active: true,
        notes: null,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: players.id })
      .get();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT);
      const { runRefreshForPlayer } = await import(process.env.REFRESH);
      const opened = openDb(process.env.DB_PATH);
      const oldSplit = {
        date: "2026-07-18", gameType: "R", isHome: true,
        game: { gamePk: 910001, gameNumber: 1 }, sport: { id: 1 },
        opponent: { name: "Old Opponent" }, team: { name: "Old Club" },
        league: { name: "MLB" }, stat: { hits: 1, atBats: 4 }
      };
      const client = {
        getSeason: async () => null,
        getPerson: async () => {
          process.stdout.write("buffered\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          return { fullName: "OLD", primaryPosition: { abbreviation: "SS" }, currentTeam: { id: 1 } };
        },
        getTeam: async () => ({ sport: { id: 1 }, name: "Old Club" }),
        getGameLog: async ({ group }) => ({ stats: group === "hitting" ? [{ splits: [oldSplit] }] : [] }),
      };
      const result = await runRefreshForPlayer(
        { db: opened.db, client, now: () => new Date(process.env.NOW), tz: "America/Chicago" },
        Number(process.env.PLAYER),
      );
      process.stdout.write(JSON.stringify(result) + "\\n");
      opened.close();
      process.exit(0);
    `], {
      env: {
        ...process.env,
        DB_PATH: file.path,
        NOW: T0,
        PLAYER: String(player.id),
        DB_CLIENT: pathToFileURL(new URL("../src/db/client.ts", import.meta.url).pathname).href,
        REFRESH: pathToFileURL(new URL("../src/jobs/refresh.ts", import.meta.url).pathname).href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
        child.once("exit", (code) => reject(new Error(`child exited before ready (${code}): ${stderr}`)));
      });
      expect(lines[0]).toBe("buffered");

      const freshSplit = {
        date: "2026-07-18", gameType: "R", isHome: true,
        game: { gamePk: 910001, gameNumber: 1 }, sport: { id: 1 },
        opponent: { name: "New Opponent" }, team: { name: "New Club" },
        league: { name: "MLB" }, stat: { hits: 3, atBats: 4 },
      };
      const freshClient = {
        getSeason: async () => ({
          regularSeasonStartDate: "2026-03-25",
          regularSeasonEndDate: "2026-09-27",
          postSeasonStartDate: "2026-09-28",
          postSeasonEndDate: "2026-10-31",
          springStartDate: "2026-02-20",
          springEndDate: "2026-03-24",
        }),
        getPerson: async () => ({ fullName: "NEW", primaryPosition: { abbreviation: "SS" }, currentTeam: { id: 1 } }),
        getTeam: async () => ({ sport: { id: 1 }, name: "New Club" }),
        getGameLog: async ({ group }: { group: string }) => ({
          stats: group === "hitting" ? [{ splits: [freshSplit] }] : [],
        }),
      };
      const whole = await runRefresh({
        db: file.opened.db,
        client: freshClient as never,
        now: () => at(PAST_LEASE),
        tz: TEST_TZ,
      });
      expect(whole).toMatchObject({ skipped: false, status: "ok", statLinesInserted: 1 });

      child.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
      });

      // The public targeted-refresh contract reports the durable deferral, and
      // the successor's data remains both current and digest-fresh.
      expect(JSON.parse(lines[1] ?? "{}")).toEqual({
        skipped: true,
        reason: "whole-refresh-running",
        inserted: 0,
        updated: 0,
        calendarFailures: [],
      });
      const storedPlayer = file.opened.db.select().from(players).where(eq(players.id, player.id)).get();
      expect(storedPlayer).toMatchObject({ fullName: "NEW", teamName: "New Club" });
      const storedLines = file.opened.db.select().from(statLines).where(eq(statLines.playerId, player.id)).all();
      expect(storedLines).toHaveLength(1);
      expect(storedLines[0]).toMatchObject({ gameId: 910001, opponentName: "New Opponent" });
      expect(storedLines[0]?.stats).toMatchObject({ hits: 3, atBats: 4 });
      expect(digestFreshnessFor(file.opened.db, "2026-07-18", TEST_TZ)).toMatchObject({
        state: "fresh",
        playersRefreshed: 1,
        playersTotal: 1,
      });
    } finally {
      child.kill();
      file.cleanup();
    }
  });

  it("rejects a stale real whole-refresh writer after a successor reaps and settles", async () => {
    const file = testFileDb();
    const player = file.opened.db.insert(players).values({ externalId: 7, ncaaPlayerSeq: null, highlightlyPlayerId: null, highlightlyTeamId: null, ncaaSourceState: null, fullName: "Initial", level: "mlb", milbLevel: null, teamName: null, position: null, schoolName: null, active: true, notes: null, createdAt: T0, updatedAt: T0 }).returning({ id: players.id }).get();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT); const { runRefresh } = await import(process.env.REFRESH);
      const oldSplit = { date:'2026-07-18', gameType:'R', isHome:true, game:{gamePk:920001,gameNumber:1}, sport:{id:1}, opponent:{name:'Old Opponent'}, team:{name:'Old Club'}, league:{name:'MLB'}, stat:{hits:1,atBats:4} };
      const opened = openDb(process.env.DB_PATH); const client = { getSeason: async()=>null, getPerson: async()=>{ process.stdout.write('buffered\\n'); await new Promise(r=>process.stdin.once('data',r)); return { fullName:'OLD', primaryPosition:{abbreviation:'SS'}, currentTeam:{id:1} }; }, getTeam: async()=>({sport:{id:1},name:'Old Club'}), getGameLog: async({group})=>({stats:group==='hitting'?[{splits:[oldSplit]}]:[]}) };
      const result = await runRefresh({db:opened.db,client,now:()=>new Date(process.env.NOW),tz:'America/Chicago'}); process.stdout.write(JSON.stringify(result)+'\\n'); opened.close(); process.exit(0);
    `], { env: { ...process.env, DB_PATH:file.path, NOW:T0, PLAYER:String(player.id), DB_CLIENT:pathToFileURL(new URL("../src/db/client.ts",import.meta.url).pathname).href, REFRESH:pathToFileURL(new URL("../src/jobs/refresh.ts",import.meta.url).pathname).href }, stdio:["pipe","pipe","pipe"] });
    try {
      const lines:string[]=[]; child.stdout.setEncoding("utf8"); child.stdout.on("data", (c:string)=>lines.push(...c.trim().split("\n").filter(Boolean)));
      await new Promise<void>((resolve,reject)=>{ child.stdout.once("data",()=>resolve()); child.once("error",reject); });
      const freshSplit = { date:"2026-07-18", gameType:"R", isHome:true, game:{gamePk:920001,gameNumber:1}, sport:{id:1}, opponent:{name:"New Opponent"}, team:{name:"New Club"}, league:{name:"MLB"}, stat:{hits:4,atBats:5} };
      const freshClient = {
        getSeason: async()=>({ regularSeasonStartDate:"2026-03-25", regularSeasonEndDate:"2026-09-27", postSeasonStartDate:"2026-09-28", postSeasonEndDate:"2026-10-31", springStartDate:"2026-02-20", springEndDate:"2026-03-24" }),
        getPerson: async()=>({fullName:"NEW",primaryPosition:{abbreviation:"SS"},currentTeam:{id:1}}),
        getTeam: async()=>({sport:{id:1},name:"New Club"}),
        getGameLog: async({group}:{group:string})=>({stats:group==="hitting"?[{splits:[freshSplit]}]:[]}),
      };
      const whole = await runRefresh({ db:file.opened.db, client:freshClient as never, now:()=>at(PAST_LEASE), tz:TEST_TZ });
      expect(whole).toMatchObject({ status:"ok", statLinesInserted:1 });
      child.stdin.write("release\n");
      await new Promise<void>((resolve,reject)=>child.once("exit", c=>c===0?resolve():reject(new Error(`child ${c}`))));
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({skipped:true,reason:"superseded"});
      const runs = file.opened.db.select().from(refreshRuns).orderBy(refreshRuns.id).all();
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({
        status: "failed",
        errorMessage: SUPERSEDED_MESSAGE,
        playersRefreshed: 0,
      });
      expect(runs[1]).toMatchObject({
        status: "ok",
        playersRefreshed: 1,
        playersTotal: 1,
        statLinesInserted: 1,
      });
      expect(file.opened.db.select().from(players).where(eq(players.id,player.id)).get()).toMatchObject({ fullName:"NEW", teamName:"New Club" });
      const finalLines = file.opened.db.select().from(statLines).where(eq(statLines.playerId, player.id)).all();
      expect(finalLines).toHaveLength(1);
      expect(finalLines[0]).toMatchObject({ gameId:920001, opponentName:"New Opponent", stats:{hits:4,atBats:5} });
      const calendars = file.opened.db.select().from(seasonCalendar).all();
      expect(calendars.length).toBeGreaterThan(0);
      expect(calendars.find((calendar) => calendar.sportId === 1)).toMatchObject({
        season: "2026",
        regularSeasonStart: "2026-03-25",
        regularSeasonEnd: "2026-09-27",
      });
      expect(digestFreshnessFor(file.opened.db,"2026-07-18",TEST_TZ)).toMatchObject({
        state:"fresh", playersRefreshed:1, playersTotal:1,
      });
    } finally {
      child.kill();
      file.cleanup();
    }
  });

  it("refuses a stale calendar write from a reaped whole-refresh child", async () => {
    const file = testFileDb();
    file.opened.db.insert(players).values({
      externalId: 7,
      ncaaPlayerSeq: null,
      highlightlyPlayerId: null,
      highlightlyTeamId: null,
      ncaaSourceState: null,
      fullName: "Initial",
      level: "mlb",
      milbLevel: null,
      teamName: null,
      position: null,
      schoolName: null,
      active: true,
      notes: null,
      createdAt: T0,
      updatedAt: T0,
    }).run();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT);
      const { runRefresh } = await import(process.env.REFRESH);
      const opened = openDb(process.env.DB_PATH);
      const client = {
        getSeason: async (sportId) => {
          if (sportId !== 1) return null;
          process.stdout.write("buffered-calendar\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          return { regularSeasonStartDate: "2026-01-01", regularSeasonEndDate: "2026-01-31" };
        },
        getPerson: async () => ({ fullName: "OLD" }),
        getTeam: async () => ({ sport: { id: 1 }, name: "Old Club" }),
        getGameLog: async () => ({ stats: [] }),
      };
      const result = await runRefresh(
        { db: opened.db, client, now: () => new Date(process.env.NOW), tz: "America/Chicago" },
      );
      process.stdout.write(JSON.stringify(result) + "\\n");
      opened.close();
      process.exit(0);
    `], {
      env: {
        ...process.env,
        DB_PATH: file.path,
        NOW: T0,
        DB_CLIENT: pathToFileURL(new URL("../src/db/client.ts", import.meta.url).pathname).href,
        REFRESH: pathToFileURL(new URL("../src/jobs/refresh.ts", import.meta.url).pathname).href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(lines[0]).toBe("buffered-calendar");

      const successor = await runRefresh({
        db: file.opened.db,
        client: {
          getSeason: async (sportId: number) => sportId === 1 ? {
            regularSeasonStartDate: "2026-03-25",
            regularSeasonEndDate: "2026-09-27",
          } : null,
          getPerson: async () => ({ fullName: "NEW" }),
          getTeam: async () => ({ sport: { id: 1 }, name: "New Club" }),
          getGameLog: async () => ({ stats: [] }),
        } as never,
        now: () => at(PAST_LEASE),
        tz: TEST_TZ,
      });
      expect(successor).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 1 });
      child.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${code}`)));
      });

      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ skipped: true, reason: "superseded" });
      expect(file.opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, 1)).get())
        .toMatchObject({
          regularSeasonStart: "2026-03-25",
          regularSeasonEnd: "2026-09-27",
          fetchedAt: PAST_LEASE,
        });
      expect(file.opened.db.select().from(refreshRuns).orderBy(refreshRuns.id).all()[0])
        .toMatchObject({ status: "failed", errorMessage: SUPERSEDED_MESSAGE });
    } finally {
      child.kill();
      file.cleanup();
    }
  });

  it("fences Highlightly cache writes from a reaped whole-refresh child", async () => {
    const file = testFileDb();
    const player = file.opened.db.insert(players).values({
      externalId: null,
      ncaaPlayerSeq: 9,
      highlightlyPlayerId: 501,
      highlightlyTeamId: 10,
      ncaaSourceState: "highlightly_pending",
      fullName: "Gavin Kelly",
      level: "ncaa",
      milbLevel: null,
      teamName: "Tigers",
      position: null,
      schoolName: "Tigers University",
      active: true,
      notes: null,
      createdAt: T0,
      updatedAt: T0,
    }).returning({ id: players.id }).get();
    file.opened.db.insert(statLines).values({
      playerId: player.id,
      gameId: 99,
      source: "ncaa_html_legacy",
      statType: "fielding",
      gameDate: "2026-03-01",
      gameNumber: 1,
      gameType: "R",
      sportId: 22,
      stats: { errors: 1 },
      raw: {},
      createdAt: T0,
      updatedAt: T0,
    }).run();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT);
      const { runRefresh } = await import(process.env.REFRESH);
      const opened = openDb(process.env.DB_PATH);
      const match = { id: 930001, date: "2026-05-18T19:00:00Z", league: "NCAA", season: 2026, homeTeam: { id: 10, name: "Old Tigers" }, awayTeam: { id: 11, name: "Old Owls" } };
      const providerPlayer = { id: 501, fullName: "Gavin Kelly", statistics: [{ group: "Batting", name: "H", value: 1 }] };
      const highlightlyClient = {
        getFinalTeamMatches: async () => ({ value: [match], remaining: 99 }),
        getBoxScore: async () => {
          process.stdout.write("buffered-highlightly\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          return { value: [{ teamId: 10, players: [providerPlayer] }], remaining: 98 };
        },
      };
      const result = await runRefresh(
        { db: opened.db, client: { getSeason: async () => null }, highlightlyClient, now: () => new Date(process.env.NOW), tz: "America/Chicago" },
      );
      process.stdout.write(JSON.stringify(result) + "\\n");
      opened.close();
      process.exit(0);
    `], {
      env: {
        ...process.env,
        DB_PATH: file.path,
        NOW: NCAA_T0,
        PLAYER: String(player.id),
        DB_CLIENT: pathToFileURL(new URL("../src/db/client.ts",import.meta.url).pathname).href,
        REFRESH: pathToFileURL(new URL("../src/jobs/refresh.ts",import.meta.url).pathname).href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(lines[0]).toBe("buffered-highlightly");
      // The stale whole-refresh actor has crossed the first Highlightly write:
      // its match cache is durable, but its box payload and atomic player
      // cutover are still buffered behind getBoxScore.
      expect(file.opened.db.select().from(highlightlyMatchCache).all()).toEqual([
        expect.objectContaining({
          matchId: 930001,
          rateRemaining: 99,
          payload: expect.objectContaining({ homeTeam: { id: 10, name: "Old Tigers" } }),
        }),
      ]);
      expect(file.opened.db.select().from(highlightlyBoxScoreCache).all()).toHaveLength(0);
      expect(file.opened.db.select().from(highlightlyPlayerCursors).all()).toHaveLength(0);
      expect(file.opened.db.select().from(players).where(eq(players.id, player.id)).get()?.ncaaSourceState)
        .toBe("highlightly_pending");

      const freshMatch = {
        id: 930001,
        date: "2026-05-18T19:00:00Z",
        league: "NCAA",
        season: 2026,
        homeTeam: { id: 10, name: "Fresh Tigers" },
        awayTeam: { id: 11, name: "Fresh Owls" },
      };
      const freshProviderPlayer = {
        id: 501,
        fullName: "Gavin Kelly",
        statistics: [{ group: "Batting", name: "H", value: 4 }],
      };
      const successor = await runRefresh({
        db: file.opened.db,
        client: { getSeason: async () => null } as never,
        highlightlyClient: {
          getFinalTeamMatches: async () => ({ value: [freshMatch], remaining: 80 }),
          getBoxScore: async () => ({
            value: [{ teamId: 10, players: [freshProviderPlayer] }],
            remaining: 79,
          }),
        } as never,
        now: () => at(NCAA_PAST_LEASE),
        tz: TEST_TZ,
      });
      expect(successor).toMatchObject({
        skipped: false,
        status: "ok",
        playersRefreshed: 1,
        statLinesInserted: 1,
      });
      child.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${code}`)));
      });

      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ skipped: true, reason: "superseded" });
      expect(file.opened.db.select().from(highlightlyMatchCache).all()).toEqual([
        expect.objectContaining({
          matchId: 930001,
          rateRemaining: 80,
          payload: expect.objectContaining({ homeTeam: { id: 10, name: "Fresh Tigers" } }),
        }),
      ]);
      expect(file.opened.db.select().from(highlightlyBoxScoreCache).all()).toEqual([
        expect.objectContaining({ matchId: 930001, rateRemaining: 79 }),
      ]);
      expect(file.opened.db.select().from(highlightlyPlayerCursors).all()).toEqual([
        expect.objectContaining({ playerId: player.id, lastCompleteAt: NCAA_PAST_LEASE }),
      ]);
      expect(file.opened.db.select().from(players).where(eq(players.id, player.id)).get()?.ncaaSourceState)
        .toBe("highlightly_active");
      const finalLines = file.opened.db.select().from(statLines).where(eq(statLines.playerId, player.id)).all();
      expect(finalLines).toEqual([
        expect.objectContaining({
          source: "highlightly_ncaa",
          gameId: 930001,
          teamName: "Fresh Tigers",
          stats: { hits: 4 },
        }),
      ]);
      expect(file.opened.db.select().from(refreshRuns).orderBy(refreshRuns.id).all()).toEqual([
        expect.objectContaining({ status: "failed", errorMessage: SUPERSEDED_MESSAGE }),
        expect.objectContaining({ status: "ok", playersRefreshed: 1, statLinesInserted: 1 }),
      ]);
    } finally {
      child.kill();
      file.cleanup();
    }
  });

  it("fences Highlightly cutover and cursor writes from a reaped whole-refresh child", async () => {
    const file = testFileDb();
    const player = file.opened.db.insert(players).values({
      externalId: null,
      ncaaPlayerSeq: 9,
      highlightlyPlayerId: 501,
      highlightlyTeamId: 10,
      ncaaSourceState: "highlightly_pending",
      fullName: "Gavin Kelly",
      level: "ncaa",
      milbLevel: null,
      teamName: "Tigers",
      position: null,
      schoolName: "Tigers University",
      active: true,
      notes: null,
      createdAt: NCAA_T0,
      updatedAt: NCAA_T0,
    }).returning({ id: players.id }).get();
    file.opened.db.insert(statLines).values({
      playerId: player.id,
      gameId: 99,
      source: "ncaa_html_legacy",
      statType: "fielding",
      gameDate: "2026-03-01",
      gameNumber: 1,
      gameType: "R",
      sportId: 22,
      stats: { errors: 1 },
      raw: {},
      createdAt: NCAA_T0,
      updatedAt: NCAA_T0,
    }).run();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT);
      const { runRefresh } = await import(process.env.REFRESH);
      const opened = openDb(process.env.DB_PATH);
      const highlightlyClient = {
        getFinalTeamMatches: async () => {
          process.stdout.write("buffered-cutover\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          return { value: [], remaining: 99 };
        },
      };
      const result = await runRefresh({
        db: opened.db,
        client: { getSeason: async () => null },
        highlightlyClient,
        now: () => new Date(process.env.NOW),
        tz: "America/Chicago",
      });
      process.stdout.write(JSON.stringify(result) + "\\n");
      opened.close();
      process.exit(0);
    `], {
      env: {
        ...process.env,
        DB_PATH: file.path,
        NOW: NCAA_T0,
        DB_CLIENT: pathToFileURL(new URL("../src/db/client.ts",import.meta.url).pathname).href,
        REFRESH: pathToFileURL(new URL("../src/jobs/refresh.ts",import.meta.url).pathname).href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(lines[0]).toBe("buffered-cutover");

      const successor = await runRefresh({
        db: file.opened.db,
        client: { getSeason: async () => null } as never,
        highlightlyClient: {
          getFinalTeamMatches: async () => ({ value: [], remaining: 80 }),
        } as never,
        now: () => at(NCAA_PAST_LEASE),
        tz: TEST_TZ,
      });
      expect(successor).toMatchObject({
        skipped: false,
        status: "ok",
        playersRefreshed: 1,
        statLinesInserted: 0,
      });
      child.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${code}`)));
      });

      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ skipped: true, reason: "superseded" });
      expect(file.opened.db.select().from(highlightlyMatchCache).all()).toHaveLength(0);
      expect(file.opened.db.select().from(highlightlyBoxScoreCache).all()).toHaveLength(0);
      expect(file.opened.db.select().from(highlightlyPlayerCursors).all()).toEqual([
        expect.objectContaining({ playerId: player.id, lastCompleteAt: NCAA_PAST_LEASE }),
      ]);
      expect(file.opened.db.select().from(players).where(eq(players.id, player.id)).get())
        .toMatchObject({ ncaaSourceState: "highlightly_active", updatedAt: NCAA_PAST_LEASE });
      expect(file.opened.db.select().from(statLines).where(eq(statLines.playerId, player.id)).all())
        .toHaveLength(0);
      expect(file.opened.db.select().from(refreshRuns).orderBy(refreshRuns.id).all()).toEqual([
        expect.objectContaining({ status: "failed", errorMessage: SUPERSEDED_MESSAGE }),
        expect.objectContaining({ status: "ok", playersRefreshed: 1 }),
      ]);
    } finally {
      child.kill();
      file.cleanup();
    }
  });

  it("refuses a targeted write buffered before a whole sweep claims", async () => {
    const file = testFileDb();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openDb } = await import(process.env.DB_CLIENT);
      const { admitTargetedRefresh, withIngestionFence } = await import(process.env.REFRESH_RUN);
      const opened = openDb(process.env.DB_PATH);
      const admission = admitTargetedRefresh(opened.db, new Date(process.env.NOW));
      process.stdout.write(JSON.stringify(admission) + "\\n");
      process.stdin.once("data", () => {
        const result = admission.admitted
          ? withIngestionFence(opened.db, admission.fence, () => "stale-write")
          : admission;
        process.stdout.write(JSON.stringify(result) + "\\n");
        opened.close();
        process.exit(0);
      });
    `], {
      env: {
        ...process.env,
        DB_PATH: file.path,
        NOW: T0,
        DB_CLIENT: pathToFileURL(new URL("../src/db/client.ts", import.meta.url).pathname).href,
        REFRESH_RUN: pathToFileURL(new URL("../src/jobs/refresh-run.ts", import.meta.url).pathname).href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
        child.once("exit", (code) => reject(new Error(`child exited before ready (${code}): ${stderr}`)));
      });
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ admitted: true });

      // This is the deterministic barrier: child has buffered its admission;
      // parent now claims in a separate process before releasing the write.
      expect(claimRefreshRun(file.opened.db, { now: at(T0), playersTotal: 1 }).claimed).toBe(true);
      child.stdin.write("write\n");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
      });
      expect(JSON.parse(lines[1] ?? "{}")).toEqual({ committed: false, reason: "whole-refresh-running" });
    } finally {
      child.kill();
      file.cleanup();
    }
  });
});
