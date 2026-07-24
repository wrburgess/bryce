import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { playerTags, players, statLines } from "../src/db/schema.js";
import { MlbApiError, MlbClient } from "../src/mlb/client.js";
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../src/ncaa/client.js";
import type { WatchlistDeps } from "../src/watchlist/service.js";
import {
  PlayerNotFoundError,
  UnknownNcaaPlayerError,
  UnknownPersonError,
  addNcaaPlayer,
  addPlayer,
  deactivatePlayer,
  listPlayers,
  searchPlayers,
} from "../src/watchlist/service.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  makeGameLogBody,
  makeMlbTeam,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

describe("watch-list service", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): WatchlistDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
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
    ncaaApi = new FakeNcaaApi();
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
      expect(result.refresh).toEqual({ skipped: false, inserted: 2, updated: 0, calendarFailures: [] });

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
      expect(result.refresh).toEqual({ skipped: true, inserted: 0, updated: 0, calendarFailures: [] });
      const winterAdd = (
        await opened.db.select().from(players).where(eq(players.externalId, 700000))
      )[0];
      const lines = await opened.db.select().from(statLines);
      expect(lines.filter((l) => l.playerId === winterAdd?.id)).toHaveLength(0);
    });

    it("derives tags on add via the completed first Refresh", async () => {
      const result = await addPlayer(deps(), 691185);
      const tags = await opened.db
        .select()
        .from(playerTags)
        .where(eq(playerTags.playerId, result.player.id));
      const keys = new Set(tags.map((t) => `${t.namespace}:${t.value}`));
      expect(keys.has("level:aaa")).toBe(true);
      expect(keys.has("pos:ss")).toBe(true);
      expect(keys.has("prospect:prospect")).toBe(true);
    });

    it("derives tags even under Offseason Sleep, when the first Refresh is skipped", async () => {
      await insertCalendars2026(opened.db);
      await addPlayer(deps(), 691185); // a watched level exists before winter
      clock.set(OFFSEASON);

      api.options.person = makePerson({ id: 700000, fullName: "Winter Add" });
      const result = await addPlayer(deps(), 700000);
      expect(result.refresh).toEqual({ skipped: true, inserted: 0, updated: 0, calendarFailures: [] });

      // Tags still land from the inserted identity columns (SC1: the add-path sync).
      const tags = await opened.db
        .select()
        .from(playerTags)
        .where(eq(playerTags.playerId, result.player.id));
      const keys = new Set(tags.map((t) => `${t.namespace}:${t.value}`));
      expect(keys.has("level:aaa")).toBe(true);
      expect(keys.has("pos:ss")).toBe(true);
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

    it("re-adding an existing UNTAGGED player derives his tags on the updated path", async () => {
      // A row that exists but was never tagged (e.g. a first-add whose Refresh
      // failed before deriving). Re-adding must heal it, not skip derivation.
      const existing = await insertPlayer(opened.db, {
        externalId: 691185,
        milbLevel: "Triple-A",
        position: "SS",
      });
      expect(
        await opened.db.select().from(playerTags).where(eq(playerTags.playerId, existing.id)),
      ).toHaveLength(0);

      const result = await addPlayer(deps(), 691185);
      expect(result.action).toBe("updated");
      const keys = new Set(
        (await opened.db.select().from(playerTags).where(eq(playerTags.playerId, existing.id))).map(
          (t) => `${t.namespace}:${t.value}`,
        ),
      );
      expect(keys.has("level:aaa")).toBe(true);
      expect(keys.has("pos:ss")).toBe(true);
      expect(keys.has("prospect:prospect")).toBe(true);
    });

    it("a first add whose first Refresh throws still derives tags from the committed columns", async () => {
      // The identity fetch (findPerson/getPerson/getTeam) succeeds so the row is
      // inserted, but the game-log fetch fails — refreshPlayer throws before its own
      // syncDerivedTags. The best-effort catch derives from the committed columns.
      const failing = new MlbClient({
        fetchImpl: (url: string) =>
          /\/people\/\d+\/stats(\?|$)/.test(url)
            ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
            : api.fetch(url),
        delayMs: 0,
      });
      await expect(addPlayer({ ...deps(), client: failing }, 691185)).rejects.toBeInstanceOf(
        MlbApiError,
      );

      const player = (
        await opened.db.select().from(players).where(eq(players.externalId, 691185))
      )[0];
      expect(player).toBeDefined();
      const keys = new Set(
        (await opened.db.select().from(playerTags).where(eq(playerTags.playerId, player!.id))).map(
          (t) => `${t.namespace}:${t.value}`,
        ),
      );
      expect(keys.has("level:aaa")).toBe(true);
      expect(keys.has("pos:ss")).toBe(true);
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

  describe("addNcaaPlayer", () => {
    const ncaaPages = (fullName: string, schoolName: string) => ({
      "2649785:batting": makeNcaaGameLogHtml({
        fullName,
        schoolName,
        rows: [
          { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 2, HR: 1 } },
          { date: "2026-03-14", opponentName: "Georgia", isHome: false, contestId: 6002, stats: { AB: 3, H: 1, HR: 0 } },
        ],
      }),
      "2649785:pitching": makeNcaaGameLogHtml({ fullName, schoolName, rows: [] }),
      "2649785:fielding": makeNcaaGameLogHtml({ fullName, schoolName, rows: [] }),
    });

    it("creates the NCAA row, resolves name/school, and backfills his season", async () => {
      clock.set("2026-03-15T17:00:00Z"); // NCAA In Season
      ncaaApi.options.pages = ncaaPages("College Guy", "LSU");

      const result = await addNcaaPlayer(deps(), 2649785);
      expect(result.action).toBe("added");
      expect(result.player).toMatchObject({
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: "College Guy",
        schoolName: "LSU",
        active: true,
      });
      expect(result.refresh).toEqual({ skipped: false, inserted: 2, updated: 0, calendarFailures: [] });

      const lines = await opened.db.select().from(statLines);
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.sportId === 22)).toBe(true);
    });

    it("duplicate add is a no-op identity/school refresh, no second backfill", async () => {
      clock.set("2026-03-15T17:00:00Z");
      ncaaApi.options.pages = ncaaPages("College Guy", "LSU");
      await addNcaaPlayer(deps(), 2649785);
      const linesBefore = await opened.db.select().from(statLines);

      // A transfer: the page now shows a new school.
      ncaaApi.options.pages = ncaaPages("College Guy", "Texas");
      const result = await addNcaaPlayer(deps(), 2649785);
      expect(result.action).toBe("updated");
      expect(result.refresh).toBeNull();
      expect(result.player).toMatchObject({ schoolName: "Texas", active: true });

      expect(await opened.db.select().from(players)).toHaveLength(1);
      expect(await opened.db.select().from(statLines)).toHaveLength(linesBefore.length);
    });

    it("throws UnknownNcaaPlayerError for an unroutable seq", async () => {
      clock.set("2026-03-15T17:00:00Z");
      // No page registered for this seq → the client throws → typed error.
      await expect(addNcaaPlayer(deps(), 111111)).rejects.toBeInstanceOf(UnknownNcaaPlayerError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("maps an upstream HTTP 404 to UnknownNcaaPlayerError (no such player)", async () => {
      clock.set("2026-03-15T17:00:00Z");
      ncaaApi.options.status = 404;
      await expect(addNcaaPlayer(deps(), 2649785)).rejects.toBeInstanceOf(UnknownNcaaPlayerError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("propagates NcaaApiError on an upstream failure — NOT UnknownNcaaPlayerError", async () => {
      clock.set("2026-03-15T17:00:00Z");
      ncaaApi.options.status = 500;
      const promise = addNcaaPlayer(deps(), 2649785);
      await expect(promise).rejects.toBeInstanceOf(NcaaApiError);
      await expect(promise).rejects.not.toBeInstanceOf(UnknownNcaaPlayerError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("propagates UnsupportedNcaaSeasonError for an unbundled year, before any HTTP", async () => {
      clock.set("2030-03-15T17:00:00Z"); // no bundled stats.ncaa.org entry for 2030
      await expect(addNcaaPlayer(deps(), 2649785)).rejects.toBeInstanceOf(
        UnsupportedNcaaSeasonError,
      );
      expect(await opened.db.select().from(players)).toHaveLength(0);
      expect(ncaaApi.calls).toHaveLength(0);
    });

    it("skips the first Refresh during Offseason Sleep but still records identity", async () => {
      // In-season add first, so the NCAA calendar is cached before winter.
      clock.set("2026-03-15T17:00:00Z");
      ncaaApi.options.pages = {
        ...ncaaPages("College Guy", "LSU"),
        "2650000:batting": makeNcaaGameLogHtml({ fullName: "Winter Guy", schoolName: "Duke", rows: [] }),
        "2650000:pitching": makeNcaaGameLogHtml({ fullName: "Winter Guy", schoolName: "Duke", rows: [] }),
        "2650000:fielding": makeNcaaGameLogHtml({ fullName: "Winter Guy", schoolName: "Duke", rows: [] }),
      };
      await addNcaaPlayer(deps(), 2649785);

      clock.set(OFFSEASON); // 2026-12-05, NCAA season long over
      const result = await addNcaaPlayer(deps(), 2650000);
      expect(result.action).toBe("added");
      expect(result.refresh).toEqual({ skipped: true, inserted: 0, updated: 0, calendarFailures: [] });
      expect(result.player.schoolName).toBe("Duke");
      const added = (
        await opened.db.select().from(players).where(eq(players.ncaaPlayerSeq, 2650000))
      )[0];
      expect(
        (await opened.db.select().from(statLines)).filter((l) => l.playerId === added?.id),
      ).toHaveLength(0);
    });
  });

  describe("deactivatePlayer", () => {
    it("deactivates an NCAA player by ncaaPlayerSeq, keeping history", async () => {
      const ncaa = await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        fullName: "College Guy",
        schoolName: "LSU",
      });
      await insertStatLine(opened.db, { playerId: ncaa.id, sportId: 22 });

      const player = await deactivatePlayer(deps(), { ncaaPlayerSeq: 2649785 });
      expect(player.active).toBe(false);
      expect((await opened.db.select().from(players))[0]?.active).toBe(false);
      expect(await opened.db.select().from(statLines)).toHaveLength(1);

      await expect(deactivatePlayer(deps(), { ncaaPlayerSeq: 999999 })).rejects.toBeInstanceOf(
        PlayerNotFoundError,
      );
    });

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

    it("carries schoolName and ncaaPlayerSeq for NCAA rows", async () => {
      await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        fullName: "College Guy",
        schoolName: "LSU",
      });
      const [row] = await listPlayers(opened.db);
      expect(row).toMatchObject({ level: "ncaa", schoolName: "LSU", ncaaPlayerSeq: 2649785 });
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
