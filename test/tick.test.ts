import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import type { PlayerListRow } from "../src/db/schema.js";
import { digestDeliveries, playerLists, refreshRuns, seasonCalendar } from "../src/db/schema.js";
import type { TickDeps } from "../src/jobs/tick.js";
import { digestIsDue, refreshIsDue, runTick } from "../src/jobs/tick.js";
import { claimRefreshRun, settleRefreshRun } from "../src/jobs/refresh-run.js";
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

    it("pins the EXACT boundary: elapsed === interval is due", () => {
      // `>=`, never `>`. A lane configured for 15 minutes and ticked every 15
      // would otherwise land one tick late forever — the interval is a floor on
      // the gap, not a value the clock must exceed.
      expect(refreshIsDue(minutesAgo(30), 30, NOW)).toBe(true);
      expect(refreshIsDue(minutesAgo(31), 30, NOW)).toBe(true);
      // One millisecond short is NOT due, which is what makes the equality above
      // a real boundary rather than a rounding artifact.
      expect(refreshIsDue(new Date(NOW - 30 * 60_000 + 1).toISOString(), 30, NOW)).toBe(false);
      expect(refreshIsDue(minutesAgo(29), 30, NOW)).toBe(false);
    });

    it("treats an unparseable recorded start as due", () => {
      expect(refreshIsDue("not-a-date", 30, NOW)).toBe(true);
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
      const lane = await insertLane(opened.db, "A", [player]);
      await configureList(opened.db, "A", { refreshIntervalMinutes: 60 }, clock.now());

      recordSweep("2026-07-19T16:30:00.000Z", [lane.id]); // 30 min before now
      expect((await runTick(deps())).refresh).toBeNull();
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(1);

      // Push the clock past the interval and it becomes due.
      clock.set("2026-07-19T17:31:00.000Z");
      expect((await runTick(deps())).refresh?.lanes).toHaveLength(1);
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
