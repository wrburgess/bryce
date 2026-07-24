import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import type { NewStatLineRow } from "../src/db/schema.js";
import { playerTags, players, refreshRuns, seasonCalendar, statLines } from "../src/db/schema.js";
import type { RefreshDeps } from "../src/jobs/refresh.js";
import {
  deriveRefreshStatus,
  runRefresh,
  runRefreshForPlayer,
  writePlayerRefresh,
} from "../src/jobs/refresh.js";
import { SUPERSEDED_MESSAGE, claimRefreshRun } from "../src/jobs/refresh-run.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendar,
  insertCalendars2026,
  insertPlayer,
  insertRefreshRun,
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

/**
 * A db proxy that makes any write to `player_tags` throw inside ANY transaction,
 * so ONLY the best-effort `syncDerivedTags` transaction fails (#23, MF5) — the
 * atomic identity+stats write and the claim/settle transactions, which never
 * touch `player_tags`, run untouched. Content-based (by table), not
 * count-based, so it is robust to the exact transaction ordering.
 */
function tagWritesThrow(db: Db, err: Error): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "transaction") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const realTransaction = (
        value as (fn: (tx: unknown) => unknown, config?: unknown) => unknown
      ).bind(target);
      return (fn: (tx: unknown) => unknown, config?: unknown): unknown =>
        realTransaction((tx: unknown) => {
          const txProxy = new Proxy(tx as object, {
            get(t, p) {
              const v: unknown = Reflect.get(t, p);
              if (p === "insert" || p === "delete") {
                return (table: unknown) => {
                  if (table === playerTags) throw err;
                  return (v as (arg: unknown) => unknown).call(t, table);
                };
              }
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
          return fn(txProxy);
        }, config);
    },
  }) as Db;
}

/**
 * A db proxy that makes `insert(seasonCalendar)` throw — an UNEXPECTED,
 * NON-collected failure in the calendar phase (the seasonCalendar upsert sits
 * OUTSIDE refreshCalendars' getSeason try/catch). It must escape to runRefresh's
 * MF1 outer boundary. Claim/settle transactions touch `refresh_runs`, never
 * `season_calendar`, so they run untouched.
 */
function calendarWriteThrows(db: Db, err: Error): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === seasonCalendar) throw err;
          return (value as (arg: unknown) => unknown).call(target, table);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

/** A minimal NewStatLineRow for the direct writePlayerRefresh atomicity test (MF4). */
function statRow(playerId: number, gameId: number): NewStatLineRow {
  return {
    playerId,
    gameId,
    statType: "batting",
    gameDate: "2026-04-15",
    gameNumber: 1,
    gameType: "R",
    isHome: true,
    opponentName: "Charlotte Knights",
    teamName: "Jacksonville Jumbo Shrimp",
    sportId: 11,
    leagueName: "International League",
    stats: { hits: 1 },
    raw: { stat: { hits: 1 } },
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
  };
}

describe("runRefresh", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
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
    ncaaApi = new FakeNcaaApi();
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

    // Season calendar cached for the swept sports that are published.
    const cals = await opened.db.select().from(seasonCalendar);
    expect(cals.map((c) => c.sportId).sort((a, b) => a - b)).toEqual([1, 11]);
    expect(cals.find((c) => c.sportId === 1)?.postSeasonEnd).toBe("2026-10-31");
  });

  it("re-derives a player's tags from his refreshed level/position (the sweep moves level:)", async () => {
    // Inserted as Rookie, but the refresh resolves his current team to Triple-A
    // (makePerson/makeTeam) — proving the wired syncDerivedTags re-derives from
    // the UPDATED columns, not the stale ones.
    const player = await insertPlayer(opened.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Rookie",
      position: null,
    });
    await runRefresh(deps());

    const tags = await opened.db.select().from(playerTags).where(eq(playerTags.playerId, player.id));
    const keys = new Set(tags.map((t) => `${t.namespace}:${t.value}`));
    expect(keys.has("level:aaa")).toBe(true);
    expect(keys.has("level:rookie")).toBe(false);
    expect(keys.has("pos:ss")).toBe(true);
    expect(keys.has("prospect:prospect")).toBe(true);
  });

  it("sweeps all 6 sportIds x all three stat groups per player", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await runRefresh(deps());
    const gameLogCalls = api.callsMatching(/stats=gameLog/);
    expect(gameLogCalls).toHaveLength(18);
    for (const sportId of [1, 11, 12, 13, 14, 16]) {
      for (const group of ["hitting", "pitching", "fielding"]) {
        expect(gameLogCalls.some((u) => u.includes(`sportId=${sportId}`) && u.includes(`group=${group}`))).toBe(true);
      }
    }
  });

  it("ingests fielding game logs as fielding stat lines, idempotently", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [
        makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
      ]),
      "11:fielding": makeGameLogBody("fielding", [
        makeSplit({
          game: { gamePk: 900001, gameNumber: 1 },
          stat: { errors: 2, assists: 3, putOuts: 1, chances: 6 },
        }),
      ]),
    };

    const summary = await runRefresh(deps());
    expect(summary.statLinesInserted).toBe(2); // one batting + one fielding row

    const rows = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    const fielding = rows.find((r) => r.statType === "fielding");
    expect(fielding?.gameId).toBe(900001);
    expect((fielding?.stats as Record<string, unknown>).errors).toBe(2);
    // The ADR 0029 key keeps batting and fielding as distinct rows of the same game.
    expect(rows.filter((r) => r.gameId === 900001)).toHaveLength(2);

    // Second identical run: zero inserts, both rows refreshed in place.
    const second = await runRefresh(deps());
    expect(second.statLinesInserted).toBe(0);
    expect(second.statLinesUpdated).toBe(2);
    expect(await opened.db.select().from(statLines)).toHaveLength(2);
  });

  it("tolerates an absent fielding game log exactly like an empty hitting/pitching log", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    // Only hitting is routed; fielding (and pitching) fall to the silent-empty body.
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [
        makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
      ]),
    };

    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(false);
    expect(summary.statLinesInserted).toBe(1);
    const rows = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    expect(rows.map((r) => r.statType)).toEqual(["batting"]);
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

  it("a correction updates the row quietly: stats change, created_at preserved", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    const original = makeSplit({
      game: { gamePk: 900001, gameNumber: 1 },
      stat: { hits: 1, atBats: 3, strikeOuts: 1 },
    });
    api.options.gameLogs = { "11:hitting": makeGameLogBody("hitting", [original]) };
    await runRefresh(deps());

    // Capture when the row was first stored: a correction must not make it
    // look newly created.
    const [stored] = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    const originalCreatedAt = stored?.createdAt;

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
    expect(rows[0]?.createdAt).toBe(originalCreatedAt);
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

  it("skips a game dated today (may be in progress); ingests it once the date has passed", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    // host-today = 2026-07-19 (MID_SEASON in America/Chicago). The 2026-07-19
    // split is a live capture — 1-for-2 through a few innings; the 2026-07-18
    // one is yesterday's final line.
    clock.set(MID_SEASON);
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [
        makeSplit({ date: "2026-07-18", game: { gamePk: 900001, gameNumber: 1 } }),
        makeSplit({
          date: "2026-07-19",
          game: { gamePk: 900002, gameNumber: 1 },
          stat: { hits: 1, atBats: 2, summary: "1-2 (in progress)" },
        }),
      ]),
    };

    const first = await runRefresh(deps());
    expect(first.statLinesInserted).toBe(1); // only yesterday's final line
    const afterFirst = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(afterFirst.map((r) => r.gameId)).toEqual([900001]); // today's live game stayed out

    // Next day the 2026-07-19 game is final; a re-run ingests it with the final
    // stat line — the correction the date gate deliberately waits for.
    clock.set("2026-07-20T17:00:00Z"); // host-today = 2026-07-20
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [
        makeSplit({ date: "2026-07-18", game: { gamePk: 900001, gameNumber: 1 } }),
        makeSplit({
          date: "2026-07-19",
          game: { gamePk: 900002, gameNumber: 1 },
          stat: { hits: 3, atBats: 4, summary: "3-4 (final)" },
        }),
      ]),
    };

    const second = await runRefresh(deps());
    expect(second.statLinesInserted).toBe(1); // the once-skipped game inserts now
    const afterSecond = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(afterSecond.map((r) => r.gameId).sort((a, b) => a - b)).toEqual([900001, 900002]);
    const finalLine = afterSecond.find((r) => r.gameId === 900002);
    expect((finalLine?.stats as Record<string, unknown>).hits).toBe(3);
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

  it("ingests NCAA players, skips inactive and non-NCAA null-externalId players", async () => {
    // NCAA baseball is In Season in March (opens 2026-02-13).
    clock.set("2026-03-15T17:00:00Z");
    // Inactive MLB player: never loaded.
    await insertPlayer(opened.db, { externalId: 691185, active: false });
    // Defensive: an active non-NCAA row with no externalId is still skipped.
    await insertPlayer(opened.db, {
      externalId: null,
      level: "mlb",
      milbLevel: null,
      fullName: "Orphan Guy",
    });
    // Active NCAA player: now ingested via the NCAA path (was previously skipped).
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });
    ncaaApi.options.pages = {
      "2649785:batting": makeNcaaGameLogHtml({
        fullName: "College Guy",
        schoolName: "LSU",
        rows: [
          { date: "2026-03-14", opponentName: "Florida", isHome: true, contestId: 5001, stats: { AB: 4, H: 2, HR: 1, RBI: 3 } },
        ],
      }),
      "2649785:pitching": makeNcaaGameLogHtml({
        fullName: "College Guy",
        schoolName: "LSU",
        rows: [],
      }),
      "2649785:fielding": makeNcaaGameLogHtml({
        fullName: "College Guy",
        schoolName: "LSU",
        rows: [],
      }),
    };

    const summary = await runRefresh(deps());
    // Only the NCAA player is refreshed; MLB identity fetches never happen.
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.statLinesInserted).toBe(1);
    expect(api.callsMatching(/\/people\/\d+\?/)).toHaveLength(0);

    const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, ncaa.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.sportId).toBe(22);
    expect(lines[0]?.gameId).toBe(5001);
    expect(lines[0]?.statType).toBe("batting");
  });
});

/**
 * The persisted freshness run (ADR 0043, issue #34 AC #1). Every whole-watch-list
 * Refresh records its start, completion, outcome and error state on its own row.
 */
describe("runRefresh records a freshness run (ADR 0043)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): RefreshDeps => ({
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
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: {},
    });
    ncaaApi = new FakeNcaaApi();
  });

  afterEach(() => {
    opened.close();
  });

  it("records a completed run as `ok` when every watched player is refreshed", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });

    const summary = await runRefresh(deps());
    expect(summary).toMatchObject({ skipped: false, playersRefreshed: 1 });
    expect(summary.runId).not.toBeNull();

    const runs = await opened.db.select().from(refreshRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "ok",
      playersRefreshed: 1,
      playersTotal: 1,
      startedAt: MID_SEASON.replace("Z", ".000Z"),
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(runs[0]?.errorMessage).toBeNull();
  });

  it("records `partial` when a watched player is skipped", async () => {
    // One refreshable player and one active MLB row with no externalId, which
    // refreshOnePlayer skips (result null) — so 1 of 2 were refreshed.
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, level: "mlb", milbLevel: null, fullName: "No Id Guy" });

    const summary = await runRefresh(deps());
    expect(summary.playersRefreshed).toBe(1);

    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]).toMatchObject({ status: "partial", playersRefreshed: 1, playersTotal: 2 });
  });

  // #23 BEHAVIOR CHANGE (was "records `failed` AND re-throws"): a per-player
  // fetch error is now COLLECTED and the sweep continues, rather than re-thrown.
  // With the only player failing (refreshed=0, failed>0) the run settles `failed`
  // — a blocked run — and RETURNS a structured summary instead of throwing.
  it("collects a per-player fetch error and settles `failed` WITHOUT re-throwing (single player)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    // Calendars still resolve; only the per-player person fetch explodes.
    const realFetch = api.fetch;
    const boomClient = new MlbClient({
      fetchImpl: (url: string) =>
        url.includes("/people/") ? Promise.reject(new Error("mlb person boom")) : realFetch(url),
      delayMs: 0,
    });

    const summary = await runRefresh({ ...deps(), client: boomClient });
    expect(summary.skipped).toBe(false);
    expect(summary.status).toBe("failed");
    expect(summary.playersRefreshed).toBe(0);
    expect(summary.playersFailed).toBe(1);
    expect(summary.playerFailures).toEqual([
      { playerId: expect.any(Number), reason: expect.stringContaining("mlb person boom") },
    ]);
    // No partial write for the failed player (buffer-before-write).
    expect(await opened.db.select().from(statLines)).toHaveLength(0);

    // The run's OWN row records the failure with the composed message.
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", playersRefreshed: 0 });
    expect(runs[0]?.errorMessage).toContain("mlb person boom");
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it("records NOTHING during Offseason Sleep", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");

    const summary = await runRefresh(deps());
    expect(summary).toMatchObject({ skipped: true, reason: "offseason-sleep", runId: null });
    expect(await opened.db.select().from(refreshRuns)).toHaveLength(0);
  });

  it("aborts WITHOUT settling when its lease is superseded mid-sweep (ADR 0043 fencing)", async () => {
    // Two watched players, so the sweep has two loop iterations. Player 0 is
    // fetched; DURING that fetch a successor run B claims — reaping run A's row
    // `failed` because A's lease has expired. At player 1's top-of-loop renew, A
    // no longer owns its lease, so the sweep ABORTS: it must not settle its own
    // row `ok` (B already stamped it `failed`), and B must remain the newest run.
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });

    let reaped = false;
    // A far-future clock for B's claim so A's just-renewed lease reads as expired.
    const bClaimAt = new Date("2026-07-19T17:11:00.000Z"); // MID_SEASON + 11 min
    const fencingClient = new MlbClient({
      fetchImpl: (url: string) => {
        // On player 0's identity fetch (getPerson → `/people/691185?hydrate=…`),
        // let a successor take over. The gameLog path is `/people/691185/stats?…`,
        // so keying on the `?` right after the id isolates the identity call.
        if (!reaped && url.includes("/people/691185?")) {
          reaped = true;
          const b = claimRefreshRun(opened.db, { now: bClaimAt, playersTotal: 2 });
          if (!b.claimed) throw new Error("expected successor B to claim");
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh({ ...deps(), client: fencingClient });
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });
    expect(summary.runId).not.toBeNull();
    // A superseded abort is NOT a player failure (#23): the aborting player is
    // handed to the successor, never counted/collected against this run.
    expect(summary.status).toBeNull();
    expect(summary.playersFailed).toBe(0);
    expect(summary.playerFailures).toEqual([]);

    const runs = await opened.db.select().from(refreshRuns);
    expect(runs).toHaveLength(2);
    // Run A (its id is surfaced on the summary) was reaped `failed`, never `ok`.
    const runA = runs.find((r) => r.id === summary.runId);
    expect(runA).toMatchObject({ status: "failed", errorMessage: SUPERSEDED_MESSAGE });
    // B is the sole `running` row — the watermark winner that took over.
    const running = runs.filter((r) => r.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).not.toBe(summary.runId);
    // Crucially, A never settled `ok`: no ok row exists at all.
    expect(runs.some((r) => r.status === "ok")).toBe(false);
  });

  it("no-ops `already-running` under a concurrent live lease, recording no new run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    // A sibling run claimed moments ago (live lease at MID_SEASON).
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: MID_SEASON,
      claimedAt: MID_SEASON,
      finishedAt: null,
    });

    const summary = await runRefresh(deps());
    expect(summary).toMatchObject({ skipped: true, reason: "already-running", runId: null });
    // No API calls, and no second run row: the pre-existing running row stands alone.
    expect(api.calls).toHaveLength(0);
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
  });
});

/**
 * The pure status rule (#23 SC1/MF7, P1): every (refreshed, skipped, failed,
 * calendarBlocksFresh) branch, table-tested directly. NOTE the R=0,S>0,F>0 cell
 * resolves to `failed`, per the authoritative rule "`failed` iff refreshed=0 AND
 * failed>0" (skips never rescue a run that refreshed nobody and hit failures).
 * The `cb` (calendarBlocksFresh) column downgrades an otherwise-`ok` run to
 * `partial` but NEVER overrides a `failed` (blocked) run.
 */
describe("deriveRefreshStatus truth table (#23 SC1/MF7, P1)", () => {
  const cases = [
    { r: 0, s: 0, f: 0, cb: false, expected: "ok", note: "zero active players — vacuous ok" },
    { r: 3, s: 0, f: 0, cb: false, expected: "ok", note: "every player refreshed" },
    { r: 3, s: 2, f: 0, cb: false, expected: "partial", note: "some skipped, none failed" },
    { r: 0, s: 2, f: 0, cb: false, expected: "partial", note: "all skipped, none refreshed" },
    { r: 0, s: 0, f: 2, cb: false, expected: "failed", note: "all failed, none refreshed" },
    { r: 3, s: 0, f: 2, cb: false, expected: "partial", note: "some refreshed, some failed" },
    { r: 0, s: 2, f: 2, cb: false, expected: "failed", note: "none refreshed + failures (skips don't rescue)" },
    { r: 3, s: 2, f: 2, cb: false, expected: "partial", note: "refreshed + skipped + failed" },
    // P1: a blocking calendar failure downgrades ok → partial, never forces failed.
    { r: 3, s: 0, f: 0, cb: true, expected: "partial", note: "clean run BUT a watched calendar blocks fresh → downgrade to partial" },
    { r: 0, s: 0, f: 0, cb: true, expected: "partial", note: "no players but a watched calendar blocks fresh → partial" },
    { r: 0, s: 0, f: 2, cb: true, expected: "failed", note: "blocked run: calendarBlocksFresh does NOT override failed" },
    { r: 3, s: 2, f: 0, cb: true, expected: "partial", note: "already partial by skips, calendar-block keeps it partial" },
  ] as const;
  for (const c of cases) {
    it(`R=${c.r} S=${c.s} F=${c.f} cb=${c.cb} → ${c.expected} (${c.note})`, () => {
      expect(
        deriveRefreshStatus({ refreshed: c.r, skipped: c.s, failed: c.f, calendarBlocksFresh: c.cb }),
      ).toBe(c.expected);
    });
  }
});

/**
 * MF4 — the direct writePlayerRefresh atomicity proof: a failure DURING a later
 * upsert chunk, after the identity UPDATE inside the SAME BEGIN IMMEDIATE
 * transaction, must roll BOTH back byte-for-byte.
 */
describe("writePlayerRefresh atomicity (#23 MF4)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("rolls the identity UPDATE back when a later upsert chunk fails", async () => {
    const player = await insertPlayer(opened.db, {
      externalId: 691185,
      fullName: "Original Name",
      position: "SS",
    });
    // A pre-existing stat row that must be byte-for-byte unchanged afterwards.
    const pre = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 800001,
      stats: { hits: 9 },
    });

    // 50 clean NEW rows fill chunk 1; chunk 2 (row 50) references a NON-EXISTENT
    // player, so SQLite's FK check (foreign_keys=ON) rejects it — AFTER the
    // identity UPDATE and chunk-1 upsert already ran inside the same transaction.
    const rows: NewStatLineRow[] = [];
    for (let i = 0; i < 50; i += 1) rows.push(statRow(player.id, 810000 + i));
    rows.push(statRow(9_999_999, 899999)); // chunk 2: FOREIGN KEY constraint failed

    expect(() =>
      writePlayerRefresh(opened.db, {
        playerId: player.id,
        identity: { fullName: "Changed Name", position: "1B", updatedAt: "2026-07-19T00:00:00.000Z" },
        rows,
      }),
    ).toThrow();

    // Identity UNCHANGED — BEGIN IMMEDIATE rolled it back with the failed upsert.
    const after = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
    expect(after?.fullName).toBe("Original Name");
    expect(after?.position).toBe("SS");

    // Pre-existing row unchanged, and NONE of the attempted chunk-1 rows persisted.
    const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.id).toBe(pre.id);
    expect((lines[0]?.stats as Record<string, unknown>).hits).toBe(9);
  });

  it("commits identity + stats together on the happy path", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185, fullName: "Before" });
    writePlayerRefresh(opened.db, {
      playerId: player.id,
      identity: { fullName: "After", updatedAt: "2026-07-19T00:00:00.000Z" },
      rows: [statRow(player.id, 700001), statRow(player.id, 700002)],
    });
    const after = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
    expect(after?.fullName).toBe("After");
    const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    expect(lines.map((l) => l.gameId).sort((a, b) => a - b)).toEqual([700001, 700002]);
  });
});

/**
 * #23 — the core "continue after per-player and calendar failures" behavior:
 * isolation, status/observability, calendar collect-and-continue, self-healing
 * retries, and best-effort tags.
 */
describe("runRefresh — continue after failures (#23)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
  });

  /** A client that rejects any URL matching `pattern`, else delegates to the fake. */
  const failing = (pattern: RegExp, message: string): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) =>
        pattern.test(url) ? Promise.reject(new Error(message)) : api.fetch(url),
      delayMs: 0,
    });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
    ncaaApi = new FakeNcaaApi();
  });

  afterEach(() => {
    opened.close();
  });

  it("isolates a middle player's getPerson failure: neighbors refresh, no partial write, partial status", async () => {
    const a = await insertPlayer(opened.db, { externalId: 691185, fullName: "A" });
    const b = await insertPlayer(opened.db, { externalId: 660271, fullName: "B" });
    const c = await insertPlayer(opened.db, { externalId: 700000, fullName: "C" });

    // Only B's identity fetch (/people/660271?…) explodes; his game-log path is
    // /people/660271/stats?…, so keying on the `?` right after the id isolates it.
    const summary = await runRefresh({ ...deps(), client: failing(/\/people\/660271\?/, "b person down") });

    expect(summary.status).toBe("partial");
    expect(summary.playersRefreshed).toBe(2);
    expect(summary.playersFailed).toBe(1);
    expect(summary.playerFailures).toEqual([
      { playerId: b.id, reason: expect.stringContaining("b person down") },
    ]);

    // Neighbors A and C landed their line; B wrote NOTHING (buffer-before-write),
    // and B's identity is untouched (still "B", the insert value).
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, a.id))).toHaveLength(1);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, c.id))).toHaveLength(1);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, b.id))).toHaveLength(0);
    expect((await opened.db.select().from(players).where(eq(players.id, b.id)))[0]?.fullName).toBe("B");

    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]).toMatchObject({ status: "partial", playersRefreshed: 2, playersTotal: 3 });
    expect(runs[0]?.errorMessage).toContain("b person down");
  });

  it("isolates a middle player's getGameLog failure: neighbors refresh, no partial write", async () => {
    const a = await insertPlayer(opened.db, { externalId: 691185, fullName: "A" });
    const b = await insertPlayer(opened.db, { externalId: 660271, fullName: "B" });
    const c = await insertPlayer(opened.db, { externalId: 700000, fullName: "C" });

    // B's game-log fetch (/people/660271/stats?…) throws AFTER his identity
    // resolves — proving the buffered write never lands a partial for B.
    const summary = await runRefresh({ ...deps(), client: failing(/\/people\/660271\/stats/, "b gamelog down") });

    expect(summary.status).toBe("partial");
    expect(summary.playersRefreshed).toBe(2);
    expect(summary.playerFailures).toEqual([
      { playerId: b.id, reason: expect.stringContaining("b gamelog down") },
    ]);
    // Identity buffered but NOT written (the whole transaction never ran): B's
    // fullName is still the insert value, and he has zero stat lines.
    expect((await opened.db.select().from(players).where(eq(players.id, b.id)))[0]?.fullName).toBe("B");
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, b.id))).toHaveLength(0);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, a.id))).toHaveLength(1);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, c.id))).toHaveLength(1);
  });

  it("an ok run carries empty failure arrays and a null error message", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const summary = await runRefresh(deps());
    expect(summary.status).toBe("ok");
    expect(summary.calendarFailures).toEqual([]);
    expect(summary.playerFailures).toEqual([]);
    expect(summary.playersFailed).toBe(0);
    expect(summary.playersSkipped).toBe(0);
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.errorMessage).toBeNull();
  });

  it("a skip-only partial records a NULL error message, never '0 failed' (MF2)", async () => {
    // One refreshable, one active MLB row with no externalId (skipped by dispatch).
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, level: "mlb", milbLevel: null, fullName: "No Id Guy" });

    const summary = await runRefresh(deps());
    expect(summary.status).toBe("partial");
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.playersSkipped).toBe(1);
    expect(summary.playersFailed).toBe(0);
    expect(summary.playerFailures).toEqual([]);
    const runs = await opened.db.select().from(refreshRuns);
    // NOT the nonsensical "0 player(s) failed; 0 calendar fetch(es) failed".
    expect(runs[0]).toMatchObject({ status: "partial" });
    expect(runs[0]?.errorMessage).toBeNull();
  });

  it("a safe partial records playerFailures AND a composed error message", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const b = await insertPlayer(opened.db, { externalId: 660271 });

    const summary = await runRefresh({ ...deps(), client: failing(/\/people\/660271\?/, "b boom") });
    expect(summary.status).toBe("partial");
    expect(summary.playerFailures).toEqual([{ playerId: b.id, reason: expect.stringContaining("b boom") }]);
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.errorMessage).toContain("b boom");
    expect(runs[0]?.errorMessage).toContain("player(s) failed");
  });

  it("collects a getSeason failure, leaves that sportId's cached row untouched, still refreshes, and records the error even on an ok run (MF2)", async () => {
    // A cached sportId 1 calendar with sentinel values that must SURVIVE a failed
    // re-fetch (distinct from makeSeasonBody's 2026-03-25 / a fresh fetchedAt).
    await insertCalendar(opened.db, {
      sportId: 1,
      season: "2026",
      regularSeasonStart: "2026-02-02",
      fetchedAt: "2020-01-01T00:00:00.000Z",
    });
    await insertPlayer(opened.db, { externalId: 691185 });

    // getSeason for sportId 1 throws; sportId 11 (and the player) still resolve.
    const failSeason1 = new MlbClient({
      fetchImpl: (url: string) => {
        const u = new URL(url);
        return u.pathname.endsWith("/seasons") && u.searchParams.get("sportId") === "1"
          ? Promise.reject(new Error("season 1 down"))
          : api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh({ ...deps(), client: failSeason1 });

    // The player still refreshed (calendar fetch never blocks ingest) → ok.
    expect(summary.status).toBe("ok");
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.calendarFailures).toEqual([
      { sportId: 1, reason: expect.stringContaining("season 1 down") },
    ]);

    // sportId 1's cached row is byte-for-byte untouched by the failed re-fetch.
    const cal1 = (await opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, 1)))[0];
    expect(cal1?.regularSeasonStart).toBe("2026-02-02");
    expect(cal1?.fetchedAt).toBe("2020-01-01T00:00:00.000Z");
    // sportId 11 (published) was still fetched and cached despite sportId 1 failing.
    expect((await opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, 11)))[0]).toBeDefined();

    // MF2: an OK-status run that hit a calendar failure STILL records it.
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.errorMessage).toContain("calendar fetch(es) failed");
  });

  it("continues past a getSeason failure at the first / middle / last swept sportId", async () => {
    for (const failSportId of [1, 12, 16]) {
      opened.close();
      opened = testDb();
      clock = fakeClock(MID_SEASON);
      await insertPlayer(opened.db, { externalId: 691185 });
      const client = new MlbClient({
        fetchImpl: (url: string) => {
          const u = new URL(url);
          return u.pathname.endsWith("/seasons") && u.searchParams.get("sportId") === String(failSportId)
            ? Promise.reject(new Error(`season ${failSportId} down`))
            : api.fetch(url);
        },
        delayMs: 0,
      });
      const summary = await runRefresh({ ...deps(), client });
      // The player refreshes regardless of WHICH sportId's calendar fetch failed.
      expect(summary.playersRefreshed, `sportId ${failSportId}`).toBe(1);
      expect(summary.calendarFailures.map((f) => f.sportId), `sportId ${failSportId}`).toContain(failSportId);
    }
  });

  // P1: a calendar failure must not settle `ok` when it would leave the digest
  // silently incomplete (isInSeason returns false with no calendar row, so idle
  // players at that level are omitted with no freshness warning).
  const failGetSeason = (sportId: number, message: string): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) => {
        const u = new URL(url);
        return u.pathname.endsWith("/seasons") && u.searchParams.get("sportId") === String(sportId)
          ? Promise.reject(new Error(message))
          : api.fetch(url);
      },
      delayMs: 0,
    });

  it("downgrades ok→`partial` when a WATCHED sport's calendar fails with NO cached fallback (P1)", async () => {
    // Default player is Triple-A → sportId 11, a WATCHED sport. No calendar is
    // seeded, so failing sportId 11's getSeason leaves no cached row → the digest
    // would drop idle Triple-A players silently, so the run must settle `partial`.
    await insertPlayer(opened.db, { externalId: 691185 });

    const summary = await runRefresh({ ...deps(), client: failGetSeason(11, "season 11 down") });
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.playersFailed).toBe(0);
    expect(summary.status).toBe("partial"); // NOT ok — the digest would be silently incomplete
    expect(summary.calendarFailures).toEqual([
      { sportId: 11, reason: expect.stringContaining("season 11 down") },
    ]);
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.status).toBe("partial");
  });

  it("stays `ok` when a WATCHED sport's calendar fails BUT a cached row exists (P1 fallback)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 }); // Triple-A → sportId 11
    // A cached sportId 11 calendar the digest can still fall back on.
    await insertCalendar(opened.db, {
      sportId: 11,
      season: "2026",
      regularSeasonStart: "2026-03-27",
      regularSeasonEnd: "2026-09-20",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
      fetchedAt: "2020-01-01T00:00:00.000Z",
    });

    const summary = await runRefresh({ ...deps(), client: failGetSeason(11, "season 11 down") });
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.status).toBe("ok"); // cached fallback keeps the digest correct
    expect(summary.calendarFailures).toEqual([
      { sportId: 11, reason: expect.stringContaining("season 11 down") },
    ]);
    // The cached sportId 11 row is byte-for-byte untouched by the failed re-fetch.
    const cal11 = (await opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, 11)))[0];
    expect(cal11?.fetchedAt).toBe("2020-01-01T00:00:00.000Z");
    // The failure is still RECORDED even on the ok run (MF2 interaction).
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.errorMessage).toContain("calendar fetch(es) failed");
  });

  it("stays `ok` when an UNWATCHED sport's calendar fails with no cached row (P1)", async () => {
    // Player is Triple-A (sportId 11). sportId 1 (MLB) is NOT watched, so its
    // missing calendar cannot drop any watched idle player → no downgrade.
    await insertPlayer(opened.db, { externalId: 691185 });

    const summary = await runRefresh({ ...deps(), client: failGetSeason(1, "season 1 down") });
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.status).toBe("ok");
    expect(summary.calendarFailures).toEqual([
      { sportId: 1, reason: expect.stringContaining("season 1 down") },
    ]);
  });

  it("downgrades to `partial` when the cached row EXISTS but lacks USABLE dates (P1a)", async () => {
    // The existence-only check would wrongly pass: a cached sportId 11 row is
    // present but its regular-season START is null, so isInSeason (and the
    // digest) cannot use it — the run must settle `partial`, not `ok`.
    await insertPlayer(opened.db, { externalId: 691185 }); // Triple-A → sportId 11
    // A valid MLB (sportId 1) calendar keeps the pipeline awake at the sleep check.
    await insertCalendar(opened.db);
    await insertCalendar(opened.db, {
      sportId: 11,
      season: "2026",
      regularSeasonStart: null, // UNUSABLE: no start date
      regularSeasonEnd: "2026-09-20",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
      fetchedAt: "2020-01-01T00:00:00.000Z",
    });

    const summary = await runRefresh({ ...deps(), client: failGetSeason(11, "season 11 down") });
    expect(summary.playersRefreshed).toBe(1);
    // Existence-only would say ok; the usable-dates check says partial.
    expect(summary.status).toBe("partial");
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs[0]?.status).toBe("partial");
  });

  it("keys the freshness block on the POST-refresh level (a call-up into a calendar-failed sport → `partial`) (P1b)", async () => {
    // Player starts Triple-A (sportId 11) but is CALLED UP to MLB (sportId 1)
    // DURING the run — refreshPlayer resolves his current team to the MLB club.
    // getSeason for sportId 1 throws with no usable calendar. PRE-refresh
    // watchedSportIds would be {11} and miss it; POST-refresh it is {1}, so the
    // settle-time check correctly blocks and the run settles `partial`.
    const player = await insertPlayer(opened.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Triple-A",
    });
    // A valid Triple-A calendar: awake at the sleep check AND usable for sportId 11
    // (so ONLY the post-refresh sportId 1 can be the blocker).
    await insertCalendar(opened.db, {
      sportId: 11,
      season: "2026",
      regularSeasonStart: "2026-03-27",
      regularSeasonEnd: "2026-09-20",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    // The refresh resolves him to the MLB club (team 146 → sportId 1).
    api.options.person = makePerson({
      currentTeam: { id: 146, name: "Miami Marlins", link: "/api/v1/teams/146" },
    });

    const summary = await runRefresh({ ...deps(), client: failGetSeason(1, "season 1 down") });

    // He was called up (post-refresh level mlb → sportId 1)...
    const row = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
    expect(row?.level).toBe("mlb");
    expect(row?.milbLevel).toBeNull();
    // ...and the sportId 1 calendar failure (no usable row) blocks fresh → partial.
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.status).toBe("partial");
    expect(summary.calendarFailures.map((f) => f.sportId)).toContain(1);
  });

  it("heals a failed player on the next run: partial → retry → ok, no dup rows, created_at preserved (SC3)", async () => {
    const a = await insertPlayer(opened.db, { externalId: 691185 });
    const b = await insertPlayer(opened.db, { externalId: 660271 });

    const first = await runRefresh({ ...deps(), client: failing(/\/people\/660271\?/, "b down") });
    expect(first.status).toBe("partial");
    expect(first.playersRefreshed).toBe(1);
    expect(first.playersFailed).toBe(1);
    const aFirst = await opened.db.select().from(statLines).where(eq(statLines.playerId, a.id));
    expect(aFirst).toHaveLength(1);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, b.id))).toHaveLength(0);
    const aCreatedAt = aFirst[0]?.createdAt;
    const aUpdatedAtBefore = aFirst[0]?.updatedAt; // captured BEFORE the retry

    // Retry clean at a LATER clock: both refresh → ok. A's row is updated IN
    // PLACE (same created_at, no duplicate), and its updated_at ADVANCES; B's
    // row now lands.
    clock.set("2026-07-20T17:00:00Z");
    const second = await runRefresh(deps());
    expect(second.status).toBe("ok");
    expect(second.playersFailed).toBe(0);
    const aSecond = await opened.db.select().from(statLines).where(eq(statLines.playerId, a.id));
    expect(aSecond).toHaveLength(1); // no duplicate
    expect(aSecond[0]?.createdAt).toBe(aCreatedAt); // created_at preserved
    // updated_at ADVANCED on the in-place re-upsert (ISO strings sort lexically).
    expect(aSecond[0]?.updatedAt).not.toBe(aUpdatedAtBefore);
    expect(aSecond[0]!.updatedAt > aUpdatedAtBefore!).toBe(true);
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, b.id))).toHaveLength(1);
  });

  it("heals a fully blocked run on retry: failed → retry → ok (SC3)", async () => {
    const a = await insertPlayer(opened.db, { externalId: 691185 });
    const first = await runRefresh({ ...deps(), client: failing(/\/people\//, "all down") });
    expect(first.status).toBe("failed");
    expect(await opened.db.select().from(statLines)).toHaveLength(0);

    const second = await runRefresh(deps());
    expect(second.status).toBe("ok");
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, a.id))).toHaveLength(1);
  });

  it("keeps a player refreshed when tag sync fails, emits a diagnostic, and heals next run (MF5)", async () => {
    // Inserted as Rookie / no position; a successful refresh moves him and would
    // re-derive tags — the perfect signal that identity committed but tags did not.
    const player = await insertPlayer(opened.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Rookie",
      position: null,
    });

    // Collect into a local array: mockRestore() resets errSpy.mock.calls, so the
    // captured lines must outlive the spy.
    const stderrLines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    let summary;
    try {
      summary = await runRefresh({ ...deps(), db: tagWritesThrow(opened.db, new Error("tag boom")) });
    } finally {
      errSpy.mockRestore();
    }

    // The tag failure did NOT fail the player: refreshed, run outcome intact.
    expect(summary.status).toBe("ok");
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.playersFailed).toBe(0);
    expect(summary.playerFailures).toEqual([]);

    // Identity + stat lines committed despite the tag failure.
    expect((await opened.db.select().from(players).where(eq(players.id, player.id)))[0]?.position).toBe("SS");
    expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id))).toHaveLength(1);

    // No derived tags landed (the sync threw), and a diagnostic was emitted.
    expect(await opened.db.select().from(playerTags).where(eq(playerTags.playerId, player.id))).toHaveLength(0);
    expect(stderrLines.join("")).toContain("tag sync failed");

    // A clean re-run HEALS the tags (no fault this time).
    const healed = await runRefresh(deps());
    expect(healed.status).toBe("ok");
    const tags = await opened.db.select().from(playerTags).where(eq(playerTags.playerId, player.id));
    expect(tags.some((t) => t.namespace === "level" && t.value === "aaa")).toBe(true);
  });

  it("settles `failed` AND re-throws on an UNEXPECTED throw in the calendar phase (MF1 outer boundary)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const boom = new Error("calendar db write boom");
    // The seasonCalendar upsert throws — an unexpected fault OUTSIDE the collected
    // getSeason boundary. It must reach the MF1 outer catch, not be swallowed.
    const faultDb = calendarWriteThrows(opened.db, boom);

    // (b) The unexpected error PROPAGATES to the caller...
    await expect(runRefresh({ ...deps(), db: faultDb })).rejects.toThrow("calendar db write boom");

    // (a) ...AND the run's own row is settled `failed`, never stranded `running`.
    // (Removing the outer catch keeps (b) passing but leaves this row `running`,
    // so this assertion is what genuinely guards the boundary.)
    const runs = await opened.db.select().from(refreshRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(runs[0]?.errorMessage).toContain("calendar db write boom");
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it("runRefreshForPlayer surfaces a getSeason failure in a NON-empty calendarFailures (MF3)", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    // The MLB single-player path fetches the calendar; sportId 1's getSeason
    // throws, so the result must REPORT it rather than claim clean success.
    const failSeason1 = new MlbClient({
      fetchImpl: (url: string) => {
        const u = new URL(url);
        return u.pathname.endsWith("/seasons") && u.searchParams.get("sportId") === "1"
          ? Promise.reject(new Error("season 1 down"))
          : api.fetch(url);
      },
      delayMs: 0,
    });

    const result = await runRefreshForPlayer({ ...deps(), client: failSeason1 }, player.id);
    expect(result.skipped).toBe(false);
    // The player still refreshed (he never depended on the DB calendar)...
    expect(result.inserted).toBeGreaterThan(0);
    // ...but the calendar failure is SURFACED, not dropped.
    expect(result.calendarFailures).toEqual([
      { sportId: 1, reason: expect.stringContaining("season 1 down") },
    ]);
  });
});
