import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import { refreshRuns } from "../src/db/schema.js";
import {
  SUPERSEDED_MESSAGE,
  claimRefreshRun,
  digestFreshnessFor,
  refreshHealth,
  renewRefreshRun,
  settleRefreshRun,
} from "../src/jobs/refresh-run.js";
import { TEST_TZ, insertRefreshRun, testDb, testFileDb } from "./factories.js";

/** A base instant and two derived ones straddling the 10-minute lease. */
const T0 = "2026-07-19T07:00:00.000Z";
const WITHIN_LEASE = "2026-07-19T07:05:00.000Z"; // +5 min
const PAST_LEASE = "2026-07-19T07:11:00.000Z"; // +11 min

const at = (iso: string) => new Date(iso);

describe("claimRefreshRun / settleRefreshRun (ADR 0042)", () => {
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

  it("the OLD holder settling AFTER a takeover corrupts nothing: both rows keep their own outcome", () => {
    // A claims, its lease expires, B takes over. Then BOTH settle — A late.
    const a = claimRefreshRun(opened.db, { now: at(T0), playersTotal: 2 });
    if (!a.claimed) throw new Error("expected A");
    const b = claimRefreshRun(opened.db, { now: at(PAST_LEASE), playersTotal: 3 });
    if (!b.claimed) throw new Error("expected B");

    // B (the winner) settles ok; A (the resurrected zombie) settles late as partial.
    settleRefreshRun(opened.db, {
      runId: b.runId,
      now: at("2026-07-19T07:12:00.000Z"),
      status: "ok",
      counts: { playersRefreshed: 3, playersTotal: 3, statLinesInserted: 5, statLinesUpdated: 1 },
    });
    settleRefreshRun(opened.db, {
      runId: a.runId,
      now: at("2026-07-19T07:20:00.000Z"),
      status: "partial",
      counts: { playersRefreshed: 1, playersTotal: 2, statLinesInserted: 2, statLinesUpdated: 0 },
    });

    const rows = opened.db.select().from(refreshRuns).orderBy(desc(refreshRuns.startedAt), desc(refreshRuns.id)).all();
    expect(rows).toHaveLength(2);
    // A's late settle only ever touched A's own row — B's ok is intact.
    const rowB = rows.find((r) => r.id === b.runId);
    const rowA = rows.find((r) => r.id === a.runId);
    expect(rowB).toMatchObject({ status: "ok", playersRefreshed: 3, statLinesInserted: 5 });
    expect(rowA).toMatchObject({ status: "partial", playersRefreshed: 1 });

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
      counts: { playersRefreshed: 0, playersTotal: 1, statLinesInserted: 0, statLinesUpdated: 0 },
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

describe("digestFreshnessFor boundary (ADR 0042)", () => {
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

describe("refreshHealth derivation (ADR 0042)", () => {
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
});

describe("refresh run claim across two file-db connections (ADR 0042)", () => {
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
