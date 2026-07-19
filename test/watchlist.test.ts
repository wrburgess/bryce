import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, statLines } from "../src/db/schema.js";
import { MlbApiError, MlbClient } from "../src/mlb/client.js";
import type { WatchlistDeps } from "../src/watchlist/service.js";
import {
  PlayerNotFoundError,
  UnknownPersonError,
  addPlayer,
  deactivatePlayer,
  listPlayers,
  searchPlayers,
} from "../src/watchlist/service.js";
import {
  FakeStatsApi,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

describe("watch-list service", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): WatchlistDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: {
        "11:hitting": makeGameLogBody("hitting", [
          makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
          makeSplit({ date: "2026-04-16", game: { gamePk: 900002, gameNumber: 1 } }),
        ]),
      },
    });
  });

  afterEach(() => {
    opened.close();
  });

  describe("addPlayer", () => {
    it("creates the Player row and runs his first Refresh (season backfill)", async () => {
      const result = await addPlayer(deps(), 691185);

      expect(result.action).toBe("added");
      expect(result.player).toMatchObject({
        externalId: 691185,
        fullName: "Maximo Acosta",
        level: "milb",
        milbLevel: "Triple-A",
        teamName: "Jacksonville Jumbo Shrimp",
        position: "SS",
        active: true,
      });
      expect(result.refresh).toEqual({ skipped: false, inserted: 2, updated: 0 });

      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      const lines = await opened.db.select().from(statLines);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.gameId).sort()).toEqual([900001, 900002]);
    });

    it("skips the first Refresh during Offseason Sleep", async () => {
      await insertCalendars2026(opened.db);
      await addPlayer(deps(), 691185); // a watched level exists before winter
      clock.set(OFFSEASON);

      api.options.person = makePerson({ id: 700000, fullName: "Winter Add" });
      const result = await addPlayer(deps(), 700000);

      expect(result.action).toBe("added");
      expect(result.refresh).toEqual({ skipped: true, inserted: 0, updated: 0 });
      const winterAdd = (
        await opened.db.select().from(players).where(eq(players.externalId, 700000))
      )[0];
      const lines = await opened.db.select().from(statLines);
      expect(lines.filter((l) => l.playerId === winterAdd?.id)).toHaveLength(0);
    });

    it("duplicate add is a no-op update: same row, re-activated, no second refresh", async () => {
      await addPlayer(deps(), 691185);
      await deactivatePlayer(deps(), 691185);
      const linesBefore = await opened.db.select().from(statLines);
      const callsBefore = api.calls.length;

      api.options.person = makePerson({ fullName: "Maximo Acosta Jr." });
      const result = await addPlayer(deps(), 691185);

      expect(result.action).toBe("updated");
      expect(result.refresh).toBeNull();
      // Identity fields refreshed and the player re-activated on the SAME row.
      expect(result.player).toMatchObject({ fullName: "Maximo Acosta Jr.", active: true });
      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fullName: "Maximo Acosta Jr.", active: true });
      // Identity fetch only — no game-log sweep on a duplicate add.
      const newCalls = api.calls.slice(callsBefore);
      expect(newCalls.some((u) => u.includes("stats=gameLog"))).toBe(false);
      expect(await opened.db.select().from(statLines)).toHaveLength(linesBefore.length);
    });

    it("throws UnknownPersonError when the API has no person for the id", async () => {
      api.options.person = undefined;
      await expect(addPlayer(deps(), 424242)).rejects.toBeInstanceOf(UnknownPersonError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("surfaces an MlbApiError from the Stats API untouched", async () => {
      const failing = new MlbClient({
        fetchImpl: () =>
          Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
        delayMs: 0,
      });
      const promise = addPlayer({ ...deps(), client: failing }, 691185);
      await expect(promise).rejects.toBeInstanceOf(MlbApiError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });
  });

  describe("deactivatePlayer", () => {
    it("flips active off and keeps the row and his history", async () => {
      await addPlayer(deps(), 691185);
      const player = await deactivatePlayer(deps(), 691185);

      expect(player.active).toBe(false);
      expect(player.fullName).toBe("Maximo Acosta");
      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.active).toBe(false);
      expect((await opened.db.select().from(statLines)).length).toBeGreaterThan(0);
    });

    it("throws PlayerNotFoundError for an unknown personId", async () => {
      await expect(deactivatePlayer(deps(), 424242)).rejects.toBeInstanceOf(PlayerNotFoundError);
    });
  });

  describe("listPlayers", () => {
    it("defaults to active players only, ordered by id", async () => {
      const active = await insertPlayer(opened.db, { fullName: "Active Guy" });
      await insertPlayer(opened.db, { fullName: "Gone Guy", active: false });

      const defaultList = await listPlayers(opened.db);
      expect(defaultList.map((p) => p.fullName)).toEqual(["Active Guy"]);
      expect(defaultList[0]?.id).toBe(active.id);

      expect((await listPlayers(opened.db, "inactive")).map((p) => p.fullName)).toEqual([
        "Gone Guy",
      ]);
      expect((await listPlayers(opened.db, "all")).map((p) => p.fullName)).toEqual([
        "Active Guy",
        "Gone Guy",
      ]);
    });
  });

  describe("searchPlayers", () => {
    it("maps search hits with team/level resolution", async () => {
      api.options.searchResults = [
        makePerson(), // AAA player, team 564
        makePerson({
          id: 660271,
          fullName: "Big Leaguer",
          currentTeam: { id: 146, name: "Miami Marlins", link: "/api/v1/teams/146" },
        }),
        makePerson({ id: 555555, fullName: "Free Agent", currentTeam: undefined }),
      ];
      api.options.teams = { 564: makeTeam(), 146: makeMlbTeam() };

      const results = await searchPlayers(deps(), "somebody");
      expect(results).toEqual([
        {
          personId: 691185,
          fullName: "Maximo Acosta",
          position: "SS",
          level: "milb",
          milbLevel: "Triple-A",
          teamName: "Jacksonville Jumbo Shrimp",
        },
        {
          personId: 660271,
          fullName: "Big Leaguer",
          position: "SS",
          level: "mlb",
          milbLevel: null,
          teamName: "Miami Marlins",
        },
        // No resolvable team: defaults to mlb with no team (next Refresh corrects it).
        {
          personId: 555555,
          fullName: "Free Agent",
          position: "SS",
          level: "mlb",
          milbLevel: null,
          teamName: null,
        },
      ]);
    });

    it("returns empty for no matches and surfaces MlbApiError", async () => {
      api.options.searchResults = [];
      expect(await searchPlayers(deps(), "nobody")).toEqual([]);

      const failing = new MlbClient({
        fetchImpl: () =>
          Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
        delayMs: 0,
      });
      await expect(searchPlayers({ client: failing }, "x")).rejects.toBeInstanceOf(MlbApiError);
    });

    it("caches team lookups within one search call", async () => {
      api.options.searchResults = [
        makePerson({ id: 1001, fullName: "Teammate One" }),
        makePerson({ id: 1002, fullName: "Teammate Two" }),
      ];
      await searchPlayers(deps(), "teammate");
      expect(api.callsMatching(/\/teams\/564$/)).toHaveLength(1);
    });
  });

  it("service history stays queryable after deactivation (kept, not deleted)", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await deactivatePlayer(deps(), player.externalId ?? 0);
    const lines = await opened.db.select().from(statLines);
    expect(lines).toHaveLength(1);
  });
});
