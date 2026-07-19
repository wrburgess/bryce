import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, seasonCalendar, statLines } from "../src/db/schema.js";
import type { RefreshDeps } from "../src/jobs/refresh.js";
import { runRefresh } from "../src/jobs/refresh.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

describe("runRefresh", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
  });

  const seasonBodies = () => ({
    1: makeSeasonBody(),
    11: makeSeasonBody({
      springStartDate: undefined,
      springEndDate: undefined,
      regularSeasonStartDate: "2026-03-27",
      regularSeasonEndDate: "2026-09-20",
      postSeasonStartDate: "2026-09-22",
      postSeasonEndDate: "2026-09-27",
    }),
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: seasonBodies(),
      gameLogs: {},
    });
  });

  afterEach(() => {
    opened.close();
  });

  it("first run backfills the complete season game log", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    const splits = [
      makeSplit({ date: "2026-04-15", game: { gamePk: 900001, gameNumber: 1 } }),
      makeSplit({ date: "2026-04-16", game: { gamePk: 900002, gameNumber: 1 } }),
      makeSplit({ date: "2026-04-17", game: { gamePk: 900003, gameNumber: 1 } }),
    ];
    api.options.gameLogs = { "11:hitting": makeGameLogBody("hitting", splits) };

    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(false);
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.statLinesInserted).toBe(3);
    expect(summary.statLinesUpdated).toBe(0);

    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows).toHaveLength(3);
    const first = rows.find((r) => r.gameId === 900001);
    expect(first?.statType).toBe("batting");
    expect(first?.gameDate).toBe("2026-04-15");
    expect(first?.sportId).toBe(11);
    expect(first?.opponentName).toBe("Charlotte Knights");
    expect((first?.stats as Record<string, unknown>).hits).toBe(1);
    expect(first?.digestDeliveryId).toBeNull();

    // Season calendar cached for the swept sports that are published.
    const cals = await opened.db.select().from(seasonCalendar);
    expect(cals.map((c) => c.sportId).sort((a, b) => a - b)).toEqual([1, 11]);
    expect(cals.find((c) => c.sportId === 1)?.postSeasonEnd).toBe("2026-10-31");
  });

  it("sweeps all 6 sportIds x both stat groups per player", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await runRefresh(deps());
    const gameLogCalls = api.callsMatching(/stats=gameLog/);
    expect(gameLogCalls).toHaveLength(12);
    for (const sportId of [1, 11, 12, 13, 14, 16]) {
      for (const group of ["hitting", "pitching"]) {
        expect(gameLogCalls.some((u) => u.includes(`sportId=${sportId}`) && u.includes(`group=${group}`))).toBe(true);
      }
    }
  });

  it("an identical second run inserts zero new rows (idempotent, ADR 0030)", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    const splits = [
      makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
      makeSplit({ date: "2026-04-16", game: { gamePk: 900002, gameNumber: 1 } }),
    ];
    api.options.gameLogs = { "11:hitting": makeGameLogBody("hitting", splits) };

    await runRefresh(deps());
    const before = await opened.db.select().from(statLines);

    const second = await runRefresh(deps());
    expect(second.statLinesInserted).toBe(0);
    expect(second.statLinesUpdated).toBe(2);

    const after = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(after).toHaveLength(before.length);
    // created_at untouched by the re-run.
    expect(after.map((r) => r.createdAt)).toEqual(before.map((r) => r.createdAt));
  });

  it("a correction updates the row quietly: stats change, digest_delivery_id preserved", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    const original = makeSplit({
      game: { gamePk: 900001, gameNumber: 1 },
      stat: { hits: 1, atBats: 3, strikeOuts: 1 },
    });
    api.options.gameLogs = { "11:hitting": makeGameLogBody("hitting", [original]) };
    await runRefresh(deps());

    // The line gets reported by a digest.
    const delivery = await insertDelivery(opened.db);
    await opened.db
      .update(statLines)
      .set({ digestDeliveryId: delivery.id })
      .where(eq(statLines.playerId, player.id));

    // Official scorer changes a hit to two.
    const corrected = makeSplit({
      game: { gamePk: 900001, gameNumber: 1 },
      stat: { hits: 2, atBats: 3, strikeOuts: 1 },
    });
    api.options.gameLogs = { "11:hitting": makeGameLogBody("hitting", [corrected]) };
    await runRefresh(deps());

    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.stats as Record<string, unknown>).hits).toBe(2);
    expect(rows[0]?.digestDeliveryId).toBe(delivery.id);
  });

  it("a call-up CHANGES the Player row — never creates a second Player", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]),
    };
    await runRefresh(deps());

    // Called up: currentTeam is now the MLB club, and MLB game logs appear.
    api.options.person = makePerson({
      currentTeam: { id: 146, name: "Miami Marlins", link: "/api/v1/teams/146" },
    });
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]),
      "1:hitting": makeGameLogBody("hitting", [
        makeSplit({
          date: "2026-07-18",
          sport: { id: 1, link: "/api/v1/sports/1", abbreviation: "MLB" },
          team: { id: 146, name: "Miami Marlins" },
          game: { gamePk: 910001, gameNumber: 1 },
        }),
      ]),
    };
    const summary = await runRefresh(deps());
    expect(summary.statLinesInserted).toBe(1);

    const playerRows = await opened.db.select().from(players);
    expect(playerRows).toHaveLength(1); // still ONE Player
    expect(playerRows[0]?.id).toBe(player.id);
    expect(playerRows[0]?.level).toBe("mlb");
    expect(playerRows[0]?.milbLevel).toBeNull();
    expect(playerRows[0]?.teamName).toBe("Miami Marlins");

    // History keeps both levels' lines under the same Player.
    const lines = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(lines.map((l) => l.sportId).sort((a, b) => a - b)).toEqual([1, 11]);
  });

  it("filters game types by the ingestion allowlist (spring out, postseason in)", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [
        makeSplit({ gameType: "S", game: { gamePk: 900001, gameNumber: 1 } }),
        makeSplit({ gameType: "E", game: { gamePk: 900002, gameNumber: 1 } }),
        makeSplit({ gameType: "R", game: { gamePk: 900003, gameNumber: 1 } }),
        makeSplit({ gameType: "W", game: { gamePk: 900004, gameNumber: 1 } }),
      ]),
    };
    await runRefresh(deps());
    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows.map((r) => r.gameType).sort()).toEqual(["R", "W"]);
  });

  it("makes ZERO API calls during Offseason Sleep (ADR 0031)", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");

    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("offseason-sleep");
    expect(api.calls).toHaveLength(0);
  });

  it("skips inactive players and players without an externalId", async () => {
    await insertPlayer(opened.db, { externalId: 691185, active: false });
    await insertPlayer(opened.db, {
      externalId: null,
      level: "ncaa",
      milbLevel: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });
    const summary = await runRefresh(deps());
    expect(summary.playersRefreshed).toBe(0);
    expect(api.callsMatching(/\/people\/\d+\?/)).toHaveLength(0);
  });
});
