import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import type { PlayerListRow } from "../src/db/schema.js";
import { digestDeliveries, playerLists, refreshRuns, seasonCalendar } from "../src/db/schema.js";
import type { TickDeps } from "../src/jobs/tick.js";
import {
  REFRESH_DUE_TOLERANCE_MS,
  TICK_PERIOD_MS,
  digestIsDue,
  refreshIsDue,
  runTick,
} from "../src/jobs/tick.js";
import { DEAD_LANE_MESSAGE } from "../src/jobs/delivery-claim.js";
import { SUPERSEDED_MESSAGE, claimRefreshRun, settleRefreshRun } from "../src/jobs/refresh-run.js";
import { configureList, resolveDefaultList } from "../src/lists/service.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  CapturingMailer,
  FakeStatsApi,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  enrollInDefaultLane,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertLane,
  insertListMember,
  insertPlayer,
  insertStatLine,
  makeSeasonBody,
  onFirstReadComplete,
  testDb,
} from "./factories.js";

/**
 * The Tick (#193 / ADR 0062 decision 3) — one 15-minute job that asks what the
 * lanes owe and runs it, replacing the two fixed launchd agents.
 *
 * The whole file's posture: DUE-SELECTION IS ADVISORY and the durable claims are
 * the gate, so almost every case asserts on a real side effect (a delivery row,
 * a refresh run, a mailed message) rather than on which branch was taken. Where
 * an ordering or a call-shape IS the property — one union sweep rather than one
 * per lane, refresh before digests — a spy on the injected deps is the only
 * honest observable, and those cases say so.
 *
 * MID_SEASON is 2026-07-19 17:00Z = 12:00 in America/Chicago, so a lane
 * configured for any hour up to 12 is due and one configured for 13+ is not.
 * Every hour boundary below is derived from that, never from a literal picked to
 * make a case pass.
 */
const HOST_HOUR_AT_MID_SEASON = 12;

describe("runTick", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;

  /**
   * A tick's deps with an OFFLINE MLB client. Every season fetch answers from
   * the fake, so a sweep completes without touching the network (the harness
   * blocks egress anyway — this keeps the sweep from settling `failed` on a
   * refused connection and muddying the assertion).
   */
  const deps = (overrides: Partial<TickDeps> = {}): TickDeps => ({
    db: opened.db,
    now: clock.now,
    tz: TEST_TZ,
    client: new MlbClient({
      fetchImpl: new FakeStatsApi({
        seasons: { 1: makeSeasonBody(), 11: makeSeasonBody() },
      }).fetch,
      delayMs: 0,
    }),
    mailer,
    to: "hc@example.com",
    from: "bryce@example.com",
    ...overrides,
  });

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
    // The seeded default lane arrives from drizzle/0012 already configured
    // (refresh every 1440 minutes, digest at hour 5). Clearing it makes every
    // case below state its OWN cadence, so a tick that fired is a tick this test
    // asked for.
    await opened.db
      .update(playerLists)
      .set({ refreshIntervalMinutes: null, digestHour: null });
  });

  afterEach(() => {
    opened.close();
  });

  /** The seeded default lane, re-read after a configure. */
  const defaultLane = async (): Promise<PlayerListRow> => resolveDefaultList(opened.db);

  /** Settle one refresh run over `scope`, so the real encoder writes its coverage. */
  const recordSweep = (startedAt: string, scope: readonly number[] | undefined): void => {
    const claim = claimRefreshRun(opened.db, {
      now: new Date(startedAt),
      playersTotal: 1,
      scopeListIds: scope,
    });
    if (!claim.claimed) throw new Error("expected a refresh claim");
    settleRefreshRun(opened.db, {
      runId: claim.runId,
      now: new Date(new Date(startedAt).getTime() + 60_000),
      status: "ok",
      counts: {
        playersRefreshed: 1, playersSkipped: 0, playersFailed: 0,
        playersTotal: 1, statLinesInserted: 0, statLinesUpdated: 0,
      },
    });
  };

  describe("refreshIsDue (pure)", () => {
    const NOW = new Date("2026-07-19T12:00:00.000Z").getTime();
    const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

    it("is due when no covering run has ever happened", () => {
      // Fails toward REFRESHING: one extra sweep costs an API round; silence
      // costs a stale digest nobody is told about.
      expect(refreshIsDue(null, 30, NOW)).toBe(true);
    });

    it("pins the EXACT boundary: elapsed === interval MINUS the tolerance is due", () => {
      // `>=`, never `>`. A lane configured for 15 minutes and ticked every 15
      // would otherwise land one tick late forever — the interval is a floor on
      // the gap, not a value the clock must exceed.
      expect(refreshIsDue(minutesAgo(30), 30, NOW)).toBe(true);
      expect(refreshIsDue(minutesAgo(31), 30, NOW)).toBe(true);

      // The boundary MOVED with the drift fix (#193 self-review): it is now the
      // interval less REFRESH_DUE_TOLERANCE_MS, and it is still exact.
      const boundary = 30 * 60_000 - REFRESH_DUE_TOLERANCE_MS;
      expect(refreshIsDue(new Date(NOW - boundary).toISOString(), 30, NOW)).toBe(true);
      // One millisecond short of THAT is not due, which is what makes the
      // equality above a real boundary rather than a rounding artifact.
      expect(refreshIsDue(new Date(NOW - boundary + 1).toISOString(), 30, NOW)).toBe(false);
      expect(refreshIsDue(minutesAgo(22), 30, NOW)).toBe(false);
      // And the tolerance is HALF the tick period, not a number picked to make a
      // case pass — a full period would let two scheduled sweeps of a 15-minute
      // lane land inside one interval.
      expect(REFRESH_DUE_TOLERANCE_MS).toBe(TICK_PERIOD_MS / 2);
    });

    it("treats an unparseable recorded start as due", () => {
      expect(refreshIsDue("not-a-date", 30, NOW)).toBe(true);
    });

    it("does not DRIFT past the digest hour as launchd jitter accumulates", () => {
      // THE MONOTONIC DRIFT (#193 self-review, MEDIUM 4). The anchor is the
      // previous sweep's ACTUAL `started_at`, and `StartInterval` is approximate
      // — launchd fires late under load and restarts its countdown across
      // sleep/wake — so each sweep records the tick's own lateness. With an
      // exact boundary that lateness is permanent AND cumulative: a sweep two
      // minutes late is not due at the next day's same tick, so it slides a full
      // 15 minutes, every jittered day, in one direction only.
      //
      // Seeded configuration (drizzle/0012, and what the runbook tells operators
      // to set): refresh every 1440 minutes, digest at hour 5. The 03:30 sweep
      // has ~90 minutes of headroom, so ~6 jittered days is all it takes for the
      // sweep to land AFTER the digest and every digest thereafter to banner
      // `stale` over day-old data.
      const INTERVAL_MIN = 1440;
      const DAY_MS = 24 * 60 * 60_000;
      // Day 0's sweep starts at 03:30 host time, on the grid.
      const FIRST_START = new Date("2026-07-19T08:30:00.000Z"); // 03:30 America/Chicago
      const DIGEST_HOUR_MS = FIRST_START.getTime() + 90 * 60_000; // 05:00, the deadline

      /**
       * Fourteen days of ticks on the nominal grid, each fire delayed by its own
       * small jitter. The jitter SHRINKS day over day, which is the adversarial
       * case: every day the tick fires slightly earlier relative to the grid than
       * the previous sweep's recorded start, so an exact boundary is always a
       * few seconds short and always defers a full tick.
       */
      const sweepTimes = (toleranceMs: number): number[] => {
        const starts: number[] = [FIRST_START.getTime()];
        let last = FIRST_START.getTime();
        for (let day = 1; day <= 14; day += 1) {
          // Candidate fires: the grid for this day, every TICK_PERIOD_MS.
          const jitterMs = Math.max(0, 300 - day * 20) * 1000;
          let fire = FIRST_START.getTime() + day * DAY_MS + jitterMs;
          // Walk forward one tick at a time until this lane reads due — which is
          // exactly what the real scheduler does.
          while (!refreshIsDue(new Date(last).toISOString(), INTERVAL_MIN, fire, toleranceMs)) {
            fire += TICK_PERIOD_MS;
          }
          starts.push(fire);
          last = fire;
        }
        return starts;
      };

      // WITHOUT tolerance the drift is real and unbounded — the negative control
      // that proves the case is not vacuous. It crosses 05:00 and never returns.
      const undefended = sweepTimes(0);
      expect(undefended[14]! - undefended[0]! - 14 * DAY_MS).toBeGreaterThan(60 * 60_000);
      expect(undefended.some((t, day) => t - day * DAY_MS >= DIGEST_HOUR_MS)).toBe(true);

      // WITH the shipped tolerance every sweep stays inside its 03:30 slot: the
      // drift never exceeds one jitter, let alone one tick.
      const defended = sweepTimes(REFRESH_DUE_TOLERANCE_MS);
      for (const [day, at] of defended.entries()) {
        const sameDayOffset = at - day * DAY_MS;
        expect(sameDayOffset).toBeGreaterThanOrEqual(FIRST_START.getTime());
        expect(sameDayOffset).toBeLessThan(FIRST_START.getTime() + TICK_PERIOD_MS);
        expect(sameDayOffset).toBeLessThan(DIGEST_HOUR_MS);
      }
    });
  });

  describe("digestIsDue (pure)", () => {
    it("is due once the hour is REACHED, not only when it is equal", () => {
      // A laptop asleep at 05:00 wakes at 09:00 and must still send.
      expect(digestIsDue(5, 5, false)).toBe(true);
      expect(digestIsDue(9, 5, false)).toBe(true);
      expect(digestIsDue(4, 5, false)).toBe(false);
      // Midnight is a legitimate configured hour, due from 00:00 on.
      expect(digestIsDue(0, 0, false)).toBe(true);
    });

    it("is not due once today's slot holds a `sent` row", () => {
      // The `sent` row, not the hour, is what stops the re-send — which is why
      // the hour test can afford to be `>=`.
      expect(digestIsDue(9, 5, true)).toBe(false);
    });
  });

  describe("the refresh side", () => {
    it("sweeps a lane whose interval has elapsed, and records the union of due lanes ONCE", async () => {
      const player = await insertPlayer(opened.db);
      const a = await insertLane(opened.db, "A", [player]);
      const b = await insertLane(opened.db, "B", [player]);
      // An active Player on NEITHER due lane, so the sweep is genuinely partial
      // coverage and records its lane ids. Without him both lanes together hold
      // everyone, the run legitimately records NULL ("swept the whole Watch
      // List"), and the union assertion below would have nothing to read.
      await insertPlayer(opened.db, { fullName: "Off Lane" });
      await configureList(opened.db, "A", { refreshIntervalMinutes: 30 }, clock.now());
      await configureList(opened.db, "B", { refreshIntervalMinutes: 30 }, clock.now());

      const result = await runTick(deps());

      expect(result.refresh?.lanes.map((lane) => lane.id).sort()).toEqual([a.id, b.id].sort());
      const runs = await opened.db.select().from(refreshRuns);
      // ONE run, not one per lane — which matters beyond tidiness: `runRefresh`
      // refuses a second concurrent sweep, so a per-lane loop would sweep A and
      // skip B `already-running`. The recorded scope carries BOTH ids.
      expect(runs).toHaveLength(1);
      expect(runs[0]?.scopeListIds).toBe(`,${[a.id, b.id].sort((x, y) => x - y).join(",")},`);
    });

    it("skips a lane with NO interval configured, and ticks with nothing due", async () => {
      const player = await insertPlayer(opened.db);
      await insertLane(opened.db, "Unscheduled", [player]);

      const result = await runTick(deps());
      expect(result.refresh).toBeNull();
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(0);
      expect(result.ok).toBe(true);
    });

    it("a covering run YOUNGER than the interval is not due; an OLDER one is", async () => {
      const player = await insertPlayer(opened.db);
      const lane = await insertLane(opened.db, "A");
      // ENROLLED BEFORE THE SWEEP, explicitly. Coverage now expires when a lane's
      // active membership grows at or after a scoped run's `started_at` (PR #203
      // Reviewer P2), so a member dated at the factory's default "now" would be a
      // player the 16:30 sweep could not have fetched — this lane would be due
      // for that reason and the interval clock under test would never be
      // consulted. The fixture states the chronology the case assumes.
      await insertListMember(opened.db, {
        listId: lane.id,
        playerId: player.id,
        createdAt: "2026-07-19T16:00:00.000Z",
      });
      await configureList(opened.db, "A", { refreshIntervalMinutes: 60 }, clock.now());

      recordSweep("2026-07-19T16:30:00.000Z", [lane.id]); // 30 min before now
      expect((await runTick(deps())).refresh).toBeNull();
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(1);

      // Push the clock past the interval and it becomes due.
      clock.set("2026-07-19T17:31:00.000Z");
      expect((await runTick(deps())).refresh?.lanes).toHaveLength(1);
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(2);
    });

    it("a lane that GAINS a member reads as due, however recent its sweep (PR #203)", async () => {
      // The tick half of the shared coverage predicate. The digest's banner and
      // this clock read `latestCoveringRun` precisely so they cannot disagree,
      // and the pairing pays off here: the same enrollment that makes the banner
      // honest (`stale`) is what makes the lane due, so the next tick fetches the
      // new member's stats instead of leaving the lane stale until its interval
      // happens to elapse.
      const player = await insertPlayer(opened.db);
      const lane = await insertLane(opened.db, "A");
      await insertListMember(opened.db, {
        listId: lane.id,
        playerId: player.id,
        createdAt: "2026-07-19T16:00:00.000Z",
      });
      await configureList(opened.db, "A", { refreshIntervalMinutes: 60 }, clock.now());
      recordSweep("2026-07-19T16:30:00.000Z", [lane.id]); // only 30 of 60 minutes ago

      // Not due on the clock alone — the control that keeps the assertion below
      // from passing for the ordinary reason.
      expect((await runTick(deps())).refresh).toBeNull();

      const joiner = await insertPlayer(opened.db, { fullName: "Late Joiner" });
      await insertListMember(opened.db, {
        listId: lane.id,
        playerId: joiner.id,
        createdAt: "2026-07-19T16:45:00.000Z",
      });

      expect((await runTick(deps())).refresh?.lanes.map((l) => l.id)).toEqual([lane.id]);
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(2);
    });

    it("a NULL-scope run advances EVERY lane's clock; another lane's run advances none", async () => {
      const player = await insertPlayer(opened.db);
      const a = await insertLane(opened.db, "A", [player]);
      const other = await insertLane(opened.db, "Other", [player]);
      await configureList(opened.db, "A", { refreshIntervalMinutes: 60 }, clock.now());

      // Another lane's recent sweep: it says nothing about lane A.
      recordSweep("2026-07-19T16:50:00.000Z", [other.id]);
      expect((await runTick(deps())).refresh?.lanes.map((l) => l.id)).toEqual([a.id]);

      // A whole-list sweep DOES cover lane A, so A stops being due.
      await opened.db.delete(refreshRuns);
      recordSweep("2026-07-19T16:50:00.000Z", undefined);
      expect((await runTick(deps())).refresh).toBeNull();
    });

    it("hands the sweep a LIVE clock, so a long sweep's lease keeps advancing", async () => {
      // THE FROZEN-CLOCK LEASE BUG (#193 self-review, CRITICAL). `runTick` takes
      // one clock read for its DECISIONS; handing that frozen instant to
      // `runRefresh` as well made every `renewRefreshRun` re-write the tick's
      // START as `claimed_at`, so the stored lease clock never advanced however
      // long the sweep ran. A sweep outliving REFRESH_LEASE_MS was then reaped
      // `failed`/SUPERSEDED by the next tick's own claim and aborted mid-flight
      // — four times an hour, forever, with no covering run ever recorded.
      //
      // Every other tick case in this file uses a sweep that completes in one
      // frozen instant, which is exactly why 1890 green tests missed it: the bug
      // is only observable when the clock MOVES DURING the sweep.
      const players = [
        await insertPlayer(opened.db, { fullName: "Player One" }),
        await insertPlayer(opened.db, { fullName: "Player Two" }),
        await insertPlayer(opened.db, { fullName: "Player Three" }),
      ];
      await insertLane(opened.db, "A", players);
      await configureList(opened.db, "A", { refreshIntervalMinutes: 30 }, clock.now());
      const startedMs = clock.now().getTime();

      // SIX MINUTES PER PLAYER — under the ten-minute lease individually, over it
      // cumulatively, which is the only shape that separates the two clocks.
      // `player-started` is emitted immediately after that player's renew, so
      // advancing here moves the clock strictly between renewals, the way a slow
      // provider does.
      let started = 0;
      let successor: ReturnType<typeof claimRefreshRun> | null = null;
      const onRefreshProgress = (event: { kind: string }): void => {
        if (event.kind !== "player-started") return;
        started += 1;
        clock.set(new Date(startedMs + started * 6 * 60_000).toISOString());
        // On the SECOND player the clock stands twelve minutes past the tick's
        // start: the next 15-minute tick is now overdue, so it fires its own
        // `claimRefreshRun`. That claim is the reaper — it settles every
        // expired-lease `running` row `failed` before inserting its own.
        if (started === 2) {
          successor = claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 });
        }
      };

      const result = await runTick(deps({ onRefreshProgress }));

      // The successor found a LIVE lease and was refused. Under the frozen clock
      // it would have found `claimed_at` still pinned at the tick's start —
      // twelve minutes stale against a ten-minute lease — claimed, and reaped
      // the running sweep out from under itself.
      expect(successor).toEqual({ claimed: false, reason: "already-running" });

      const runs = await opened.db.select().from(refreshRuns);
      expect(runs).toHaveLength(1);
      // The lease clock ADVANCED: the last renewal stamped the third player's
      // instant, not the tick's start. This is the assertion that is red under
      // the bug even without a successor at all.
      expect(Date.parse(runs[0]!.claimedAt!)).toBeGreaterThan(startedMs);
      expect(runs[0]?.errorMessage).not.toBe(SUPERSEDED_MESSAGE);
      // ...and the sweep ran to its own terminal state rather than aborting.
      expect(result.refresh?.summary?.reason).not.toBe("superseded");
      expect(runs[0]?.status).not.toBe("running");
    });

    it("a refused refresh claim does not stop the digests", async () => {
      const player = await insertPlayer(opened.db);
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(
        opened.db,
        lane.name,
        { refreshIntervalMinutes: 30, digestHour: 5 },
        clock.now(),
      );
      // A LIVE lease held by another sweep: the tick's own claim is refused, and
      // that is a `skipped` summary rather than an error.
      claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 });

      const result = await runTick(deps());
      expect(result.refresh?.summary).toMatchObject({ skipped: true, reason: "already-running" });
      expect(result.digests).toHaveLength(1);
      expect(result.digests[0]?.result?.action).toBe("sent");
      expect(result.ok).toBe(true); // a refused claim is benign, not a failure
    });
  });

  describe("the digest side", () => {
    /** The default lane, holding one player with a line in yesterday's window. */
    async function scheduledDefaultLane(digestHour: number): Promise<PlayerListRow> {
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(opened.db, lane.name, { digestHour }, clock.now());
      return resolveDefaultList(opened.db);
    }

    it("invokes a lane at its hour and NOT the hour before", async () => {
      await scheduledDefaultLane(HOST_HOUR_AT_MID_SEASON);
      expect((await runTick(deps())).digests).toHaveLength(1);
      expect(mailer.sent).toHaveLength(1);

      // A lane configured for the NEXT hour is not due at this instant.
      opened.close();
      opened = testDb();
      mailer = new CapturingMailer();
      await insertCalendars2026(opened.db);
      await opened.db.update(playerLists).set({ refreshIntervalMinutes: null, digestHour: null });
      await scheduledDefaultLane(HOST_HOUR_AT_MID_SEASON + 1);
      expect((await runTick(deps())).digests).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("hour 0 is due from midnight on, not rejected as a falsy value", async () => {
      await scheduledDefaultLane(0);
      expect((await runTick(deps())).digests).toHaveLength(1);
    });

    it("an already-`sent` slot is not invoked; a `failed` one IS (the retry)", async () => {
      const lane = await scheduledDefaultLane(HOST_HOUR_AT_MID_SEASON);

      // Today's slot already delivered: nothing to do.
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-07-19", listId: lane.id, status: "sent",
        sentAt: "2026-07-19T11:00:00.000Z", createdAt: "2026-07-19T11:00:00.000Z",
      });
      expect((await runTick(deps())).digests).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);

      // Flip it to `failed` — the acceptance criterion: a failed lane send is
      // retried on a later tick rather than waiting for tomorrow's recovery.
      await opened.db
        .update(digestDeliveries)
        .set({ status: "failed", sentAt: null })
        .where(eq(digestDeliveries.listId, lane.id));
      const retried = await runTick(deps());
      expect(retried.digests).toHaveLength(1);
      expect(retried.digests[0]?.result?.action).toBe("sent");
      expect(mailer.sent).toHaveLength(1);
    });

    it("invokes several due lanes, each on its own slot", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Shared Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      const a = await insertLane(opened.db, "A", [player]);
      const b = await insertLane(opened.db, "B", [player]);
      await configureList(opened.db, "A", { digestHour: 0 }, clock.now());
      await configureList(opened.db, "B", { digestHour: 0 }, clock.now());

      const result = await runTick(deps());
      expect(result.digests.map((d) => d.lane?.id)).toEqual([a.id, b.id]); // liveLists order
      const rows = await opened.db.select().from(digestDeliveries);
      expect(rows.map((r) => r.listId).sort()).toEqual([a.id, b.id].sort());
      expect(mailer.sent).toHaveLength(2);
    });
  });

  describe("Offseason Sleep", () => {
    it("invokes ONE unscoped run for the heartbeat, and no scheduled lane", async () => {
      clock.set(OFFSEASON);
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy", level: "mlb", milbLevel: null,
      });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(opened.db, lane.name, { digestHour: 0 }, clock.now());

      const result = await runTick(deps());
      expect(result.digests).toHaveLength(1);
      // `lane: null` IS the unscoped invocation — one liveness signal per host,
      // never one per lane (ADR 0062 decision 4).
      expect(result.digests[0]?.lane).toBeNull();
      expect(result.digests[0]?.result).toMatchObject({ kind: "heartbeat", action: "sent" });
      const rows = await opened.db.select().from(digestDeliveries);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("heartbeat");
    });

    it("invokes NOTHING when a heartbeat already went out inside the week", async () => {
      clock.set(OFFSEASON);
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy", level: "mlb", milbLevel: null,
      });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(opened.db, lane.name, { digestHour: 0 }, clock.now());
      await insertDelivery(opened.db, {
        kind: "heartbeat", dateCovered: "2026-12-02", listId: lane.id, status: "sent",
        sentAt: "2026-12-02T18:00:00.000Z", createdAt: "2026-12-02T18:00:00.000Z",
      });

      // Three days ago: the claim's own rolling-week rule would refuse anyway.
      // This pre-read exists so ~96 sleeping ticks a day do not each open a
      // claim transaction to be told so.
      const result = await runTick(deps());
      expect(result.digests).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("still RECOVERS a NON-DEFAULT lane's orphaned day while asleep", async () => {
      // ORPHAN RECOVERY IS NOT SUSPENDED BY SLEEP (#193 self-review, MEDIUM 3).
      // Recovery lives INSIDE `runDigest`, above its sleep branch — so a tick
      // that invokes only the unscoped heartbeat during Sleep silently drops the
      // ADR 0034 recovery guarantee this very PR republishes: the DEFAULT lane's
      // drain rate falls from daily to weekly (one heartbeat a week), and a
      // NON-DEFAULT scheduled lane gets ZERO recovery for the whole offseason.
      // A lane whose 2026-09-30 send failed would sit `failed` on /health from
      // October to Opening Day.
      clock.set(OFFSEASON);
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy", level: "mlb", milbLevel: null,
      });
      // The orphaned slot covers 2026-10-01, whose 1d window is the day before —
      // hence the line on 09-30, so the recovered email carries real content.
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-09-30" });
      const lane = await insertLane(opened.db, "Prospects", [player]);
      await configureList(opened.db, "Prospects", { digestHour: 5 }, clock.now());
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-10-01", listId: lane.id, status: "failed",
        sentAt: null, createdAt: "2026-10-01T10:00:00.000Z",
      });
      // A heartbeat already went out this week, so the ONLY invocation this tick
      // can make is the recovery one — nothing else can account for the email.
      await insertDelivery(opened.db, {
        kind: "heartbeat", dateCovered: "2026-12-02", listId: (await defaultLane()).id,
        status: "sent", sentAt: "2026-12-02T18:00:00.000Z", createdAt: "2026-12-02T18:00:00.000Z",
      });

      const result = await runTick(deps());

      // The lane WAS invoked, scoped, and its orphaned day was claimed and mailed.
      expect(result.digests.map((d) => d.lane?.id)).toEqual([lane.id]);
      expect(mailer.sent).toHaveLength(1);
      const orphan = (await opened.db.select().from(digestDeliveries)).find(
        (row) => row.dateCovered === "2026-10-01",
      );
      expect(orphan).toMatchObject({ status: "sent", listId: lane.id });
      // ...and TODAY's offseason digest was still NOT sent: the invocation's own
      // result is the skip, so Sleep still suppresses the regular daily artifact.
      expect(result.digests[0]?.result).toMatchObject({
        action: "skipped", reason: "offseason-sleep",
      });
      expect(
        (await opened.db.select().from(digestDeliveries)).some(
          (row) => row.kind === "digest" && row.dateCovered === "2026-12-05",
        ),
      ).toBe(false);
    });

    it("invokes NO scheduled lane while asleep when nothing is owed", async () => {
      // The negative control for the case above, and the bound on it: recovery
      // is an opportunity, not a reason to invoke every lane on all ~96 sleeping
      // ticks a day. With no orphan the sleeping tick stays as quiet as before.
      clock.set(OFFSEASON);
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy", level: "mlb", milbLevel: null,
      });
      const lane = await insertLane(opened.db, "Prospects", [player]);
      await configureList(opened.db, "Prospects", { digestHour: 5 }, clock.now());
      await insertDelivery(opened.db, {
        kind: "heartbeat", dateCovered: "2026-12-02", listId: (await defaultLane()).id,
        status: "sent", sentAt: "2026-12-02T18:00:00.000Z", createdAt: "2026-12-02T18:00:00.000Z",
      });

      const result = await runTick(deps());
      expect(result.digests).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
      // A lane with a LIVE `sending` row is not an orphan either — another run
      // holds it, and stealing it is what the lease exists to prevent.
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-10-01", listId: lane.id, status: "sending",
        sentAt: null, claimedAt: clock.now().toISOString(), createdAt: "2026-10-01T10:00:00.000Z",
      });
      expect((await runTick(deps())).digests).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("a stuck `sending` heartbeat never satisfies the week", async () => {
      clock.set(OFFSEASON);
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy", level: "mlb", milbLevel: null,
      });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await insertDelivery(opened.db, {
        kind: "heartbeat", dateCovered: "2026-12-02", listId: lane.id, status: "sending",
        claimedAt: "2026-12-02T18:00:00.000Z", createdAt: "2026-12-02T18:00:00.000Z",
      });

      // Only `sent` rows count, or one stuck row would silence the offseason
      // liveness signal indefinitely — the silent loss the design refuses.
      expect((await runTick(deps())).digests).toHaveLength(1);
    });
  });

  describe("ordering, failure isolation, and exit semantics", () => {
    it("completes the refresh BEFORE the first digest invocation", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(
        opened.db, lane.name, { refreshIntervalMinutes: 30, digestHour: 0 }, clock.now(),
      );

      // The ordering is only observable at the seam where both stages act, so
      // the mailer records WHEN it was called relative to the settled run.
      const order: string[] = [];
      const recordingMailer = {
        send: async (...args: Parameters<CapturingMailer["send"]>) => {
          const runs = await opened.db.select().from(refreshRuns);
          // SETTLED, not `ok`: the offline fixture cannot resolve the player's
          // identity, so the sweep legitimately settles a terminal status other
          // than `ok`. The property under test is the ORDER — the run reached a
          // terminal state before the first send — and asserting on the outcome
          // instead would make this case about the fake client.
          order.push(runs[0]?.finishedAt !== null ? "refresh-settled" : "refresh-unsettled");
          return mailer.send(...args);
        },
      };

      const result = await runTick(deps({ mailer: recordingMailer }));
      expect(result.refresh?.summary?.skipped).toBe(false);
      // The digest saw a SETTLED run, which is the property: a due digest
      // reports data this same tick fetched, not data from fifteen minutes ago.
      expect(order).toEqual(["refresh-settled"]);
    });

    it("a THROWING refresh still leaves every due digest attempted", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(
        opened.db, lane.name, { refreshIntervalMinutes: 30, digestHour: 0 }, clock.now(),
      );

      // A provider that rejects EVERY request. `runRefresh` collects per-player
      // and per-calendar failures rather than throwing, so this drives the sweep
      // to a `failed` terminal status — the "the refresh side did not succeed"
      // case an operator actually meets. The `error` arm (an unexpected throw
      // escaping `runRefresh` altogether) is covered separately below, because
      // the two reach the same isolation guarantee by different routes and a
      // test that only exercised one would leave the other unproven.
      const failing = new MlbClient({
        fetchImpl: () => Promise.reject(new Error("network down")),
        delayMs: 0,
      });

      const result = await runTick(deps({ client: failing }));
      expect(result.refresh?.summary?.status).toBe("failed");
      expect(result.refresh?.error).toBeNull();
      // ...and the digest was attempted anyway, and sent.
      expect(result.digests).toHaveLength(1);
      expect(result.digests[0]?.result?.action).toBe("sent");
      expect(mailer.sent).toHaveLength(1);
      // Exit semantics: a failed sweep is exit 1, AFTER all due work ran.
      expect(result.ok).toBe(false);
    });

    it("an UNEXPECTED throw from the sweep is caught, and the digests still run", async () => {
      // The other route to the same isolation guarantee: `runRefresh`'s own
      // failure boundary re-throws a fatal orchestration error (a database
      // fault, say). `runTick` must record it and carry on to the digest side —
      // a broken sweep leaves the digests reporting older data, annotated
      // `stale` by their own banner, which is strictly better than not sending.
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(
        opened.db, lane.name, { refreshIntervalMinutes: 30, digestHour: 0 }, clock.now(),
      );

      // `loadCalendars` is the first thing `runRefresh` awaits after selection,
      // and its throw escapes to `runTick` rather than being collected.
      const exploding = new Proxy(opened.db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
          return (...args: unknown[]): unknown => {
            const builder = (value as (...a: unknown[]) => object).apply(target, args);
            return new Proxy(builder, {
              get(b, p) {
                const bv: unknown = Reflect.get(b, p);
                if (p === "from") {
                  return (table: unknown): unknown => {
                    if (table === seasonCalendar) throw new Error("disk I/O error");
                    return (bv as (t: unknown) => unknown).call(b, table);
                  };
                }
                return typeof bv === "function" ? (bv as (...a: unknown[]) => unknown).bind(b) : bv;
              },
            });
          };
        },
      }) as Db;

      const result = await runTick(deps({ db: exploding }));
      expect(result.refresh?.error).toContain("disk I/O error");
      expect(result.refresh?.summary).toBeNull();
      expect(result.ok).toBe(false);
      // The digest stage was still ENTERED, and its own setup hit the same fault
      // — recorded on its own field rather than escaping `runTick` and erasing
      // the refresh record above. Neither stage can take the other down.
      expect(result.digestError).toContain("disk I/O error");
      expect(result.digests).toEqual([]);
    });

    it("a clean tick reports no stage errors at all", async () => {
      // The negative control for both boundaries: without it, `digestError`
      // could be permanently non-null and the cases above would still pass.
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(opened.db, lane.name, { digestHour: 0 }, clock.now());

      const result = await runTick(deps());
      expect(result.digestError).toBeNull();
      expect(result.refresh).toBeNull();
      expect(result.ok).toBe(true);
    });

    it("ONE lane's throw does not stop the NEXT due lane", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      const a = await insertLane(opened.db, "A", [player]);
      const b = await insertLane(opened.db, "B", [player]);
      await configureList(opened.db, "A", { digestHour: 0 }, clock.now());
      await configureList(opened.db, "B", { digestHour: 0 }, clock.now());

      // Lane A is soft-deleted out from under the tick the instant `liveLists`
      // RESOLVES — after its rows are in hand and before the loop resumes. That
      // is the real interleaving a concurrent `lists delete` produces, and it
      // makes lane A's own `listById` throw UnknownListError from inside the
      // per-lane boundary. A sequential loop without that boundary would abort
      // here and lane B — perfectly healthy — would never be attempted, turning
      // one broken lane into a host-wide outage four times an hour.
      //
      // Hooking `then` (what `await` calls) is how a read's COMPLETION is
      // observed without re-implementing drizzle's execution; the chainable
      // methods are re-wrapped because `.where()`/`.orderBy()` return `this`.
      // Same shape as `enrollWhenPlayersFirstRead` in test/refresh-list.test.ts.
      const racing = onFirstReadComplete(opened.db, () => {
        opened.sqlite
          .prepare("update player_lists set deleted_at = ? where id = ?")
          .run("2026-07-19T00:00:00.000Z", a.id);
      });

      const result = await runTick(deps({ db: racing }));
      // Both lanes were ATTEMPTED — that is the isolation property.
      expect(result.digests).toHaveLength(2);
      expect(result.digests[0]?.lane?.id).toBe(a.id);
      expect(result.digests[1]?.lane?.id).toBe(b.id);
      // Lane B sent despite lane A's failure.
      expect(result.digests[1]?.result?.action).toBe("sent");
      expect(result.ok).toBe(false); // and the tick reports the failure
    });

    it("a FAILED send makes the tick not-ok, with the other lane still sent", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      const a = await insertLane(opened.db, "A", [player]);
      await insertLane(opened.db, "B", [player]);
      await configureList(opened.db, "A", { digestHour: 0 }, clock.now());
      await configureList(opened.db, "B", { digestHour: 0 }, clock.now());

      // The provider rejects lane A's send only.
      let sends = 0;
      const flaky = {
        send: (...args: Parameters<CapturingMailer["send"]>) => {
          sends += 1;
          if (sends === 1) return Promise.reject(new Error("postmark down"));
          return mailer.send(...args);
        },
      };

      const result = await runTick(deps({ mailer: flaky }));
      expect(result.digests[0]?.result).toMatchObject({ action: "failed" });
      expect(result.digests[1]?.result).toMatchObject({ action: "sent" });
      expect(result.ok).toBe(false);
      // Lane A's slot is `failed` and re-claimable, so the next tick retries it.
      const rows = await opened.db.select().from(digestDeliveries);
      expect(rows.find((r) => r.listId === a.id)?.status).toBe("failed");
    });

    it("settles a DELETED lane's abandoned `sending` row, and only that one", async () => {
      // THE PERMANENTLY IN-FLIGHT DELIVERY (#193 self-review, LOW 2). A row left
      // `sending` when its lane is soft-deleted can never settle: the claim's
      // `lane-deleted` requirement is un-forceable so no future claim may re-take
      // it, and `liveLists` never offers the lane again so nothing tries. It is
      // hidden from the per-lane view (live lanes only) yet can still be the
      // HOST-WIDE `lastDelivery` — /health reporting a delivery in flight forever.
      const player = await insertPlayer(opened.db);
      const dead = await insertLane(opened.db, "Dead", [player]);
      const live = await insertLane(opened.db, "Live", [player]);

      // Expired lease (30 minutes ago, against a 10-minute lease) on each lane.
      const expired = new Date(clock.now().getTime() - 30 * 60_000).toISOString();
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-07-18", listId: dead.id, status: "sending",
        sentAt: null, claimedAt: expired, createdAt: expired,
      });
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-07-18", listId: live.id, status: "sending",
        sentAt: null, claimedAt: expired, createdAt: expired,
      });
      // ...and a LIVE lease on the dead lane, for a different date: the run
      // holding it may be at the mail provider right now, and settling it would
      // break ADR 0034's exact-mutual-exclusion guarantee.
      await insertDelivery(opened.db, {
        kind: "digest", dateCovered: "2026-07-17", listId: dead.id, status: "sending",
        sentAt: null, claimedAt: clock.now().toISOString(), createdAt: expired,
      });
      await opened.db
        .update(playerLists)
        .set({ deletedAt: "2026-07-19T00:00:00.000Z" })
        .where(eq(playerLists.id, dead.id));

      const result = await runTick(deps());

      const rows = await opened.db.select().from(digestDeliveries);
      const settled = rows.find((r) => r.listId === dead.id && r.dateCovered === "2026-07-18");
      expect(settled?.status).toBe("failed");
      expect(settled?.sentAt).toBeNull();
      // The error says WHY it is terminal, so an operator does not read it as a
      // provider rejection he can retry.
      expect(settled?.errorMessage).toBe(DEAD_LANE_MESSAGE);

      // The dead lane's LIVE claim is untouched — the lease still rules.
      expect(rows.find((r) => r.listId === dead.id && r.dateCovered === "2026-07-17")?.status)
        .toBe("sending");
      // A LIVE lane's expired row is untouched too: that one is recoverable by
      // the ordinary orphan path, and settling it here would steal its retry.
      expect(rows.find((r) => r.listId === live.id)?.status).toBe("sending");

      // Nothing was mailed to the deleted cohort, and the tick is still clean.
      expect(mailer.sent).toHaveLength(0);
      expect(result.digestError).toBeNull();
    });

    it("a tick with NOTHING due is a clean no-op: no claims, no mail, ok", async () => {
      // Acceptance criterion. Every lane exists but none is scheduled, which is
      // the state a freshly-configured host sits in most of the day.
      const player = await insertPlayer(opened.db);
      await insertLane(opened.db, "A", [player]);

      const result = await runTick(deps());
      expect(result).toMatchObject({ refresh: null, digests: [], ok: true });
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it("threads its `warn` sink into the digest rather than letting it reach stderr", async () => {
      // R6's plumbing, at the job seam: the CLI can only suppress a warning it
      // is given, so a digest that wrote straight to stderr would leak around
      // `--quiet`'s single line no matter what the CLI did.
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, {
        playerId: player.id,
        gameDate: "2026-07-18",
        stats: { hits: 1, atBats: 3, unclassifiedNewField: 4 },
      });
      await enrollInDefaultLane(opened.db, [player]);
      const lane = await defaultLane();
      await configureList(opened.db, lane.name, { digestHour: 0 }, clock.now());

      const warn = vi.fn();
      const result = await runTick(deps({ warn }));
      expect(result.digests[0]?.result?.action).toBe("sent");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unclassifiedNewField"));
    });
  });
});
