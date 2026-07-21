import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, statLines } from "../src/db/schema.js";
import { assembleDigest } from "../src/digest/assemble.js";
import {
  TEST_TZ,
  fakeClock,
  insertCalendar,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * Window-selected assembly. Every window ends on the LAST COMPLETED host date,
 * so this clock — 2026-07-20 in America/Chicago — resolves `1d` to 07-19 and
 * `7d` to 07-13..07-19. Using MID_SEASON here would shift every window by a day
 * and make the seeded dates below read as arbitrary.
 */
const RUN_AT = "2026-07-20T17:00:00Z";

describe("assembleDigest — window selection", () => {
  let opened: OpenedDb;
  let clock: ReturnType<typeof fakeClock>;

  const assemble = (spec: "1d" | "7d" | "14d" | "21d" | "ytd") =>
    assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec });

  beforeEach(async () => {
    opened = testDb();
    clock = fakeClock(RUN_AT);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("includes only lines inside the window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-12" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15" });

    const a = await assemble("7d");
    expect(a.window.from).toBe("2026-07-13");
    expect(a.window.to).toBe("2026-07-19");
    expect(a.statLineCount).toBe(1);
    // The one included line is the 07-15 one, not the 07-12 one.
    expect(a.batters[0]?.agg.games).toBe(1);
  });

  it("excludes postseason games from every window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      gameType: "R",
      stats: { hits: 2, atBats: 4 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      gameType: "D",
      stats: { hits: 3, atBats: 4 },
    });

    const a = await assemble("7d");
    expect(a.statLineCount).toBe(1);
    // Not merely the count: the postseason hits never reached the aggregate.
    expect(a.batters[0]?.agg.counters.hits).toBe(2);
  });

  it("splits a promoted player into one row per level", async () => {
    // A 21d window runs 2026-06-29..2026-07-19; both games fall inside it.
    const player = await insertPlayer(opened.db, { fullName: "Walker Jenkins" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      sportId: 11,
      leagueName: "International League",
      stats: { hits: 2, atBats: 4 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-05",
      sportId: 13,
      leagueName: "Midwest League",
      stats: { hits: 1, atBats: 3 },
    });

    const a = await assemble("21d");
    const rows = a.batters.filter((r) => r.player.fullName === "Walker Jenkins");
    expect(rows.map((r) => r.lvl).sort()).toEqual(["A+", "AAA"]);
    // Each level keeps its OWN line — the whole point of the split. A blended
    // row would show 3-for-7 at one label; these are 2-for-4 and 1-for-3.
    const byLevel = new Map(rows.map((r) => [r.lvl, r.agg]));
    expect(byLevel.get("AAA")?.counters.atBats).toBe(4);
    expect(byLevel.get("A+")?.counters.atBats).toBe(3);
  });

  it("takes the level from the stat line's sportId, never from players.level", async () => {
    // Current level says Triple-A; the game in the window was played at High-A.
    const player = await insertPlayer(opened.db, {
      fullName: "Walker Jenkins",
      level: "milb",
      milbLevel: "Triple-A",
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      sportId: 13,
      leagueName: "Midwest League",
    });

    const a = await assemble("7d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.lvl).toBe("A+");
  });

  it("renders a doubleheader as two rows in a 1d window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Yohandy Pena" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 970001,
      gameNumber: 1,
      gameDate: "2026-07-19",
      stats: { hits: 0, atBats: 3 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 970002,
      gameNumber: 2,
      gameDate: "2026-07-19",
      stats: { hits: 2, atBats: 4 },
    });

    const a = await assemble("1d");
    expect(a.batters.map((r) => r.gameNumber)).toEqual([1, 2]);
    expect(a.batters.map((r) => r.agg.counters.hits)).toEqual([0, 2]);
  });

  it("leaves gameNumber null for a single game in a 1d window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-19" });

    const a = await assemble("1d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.gameNumber).toBeNull();
  });

  it("folds a doubleheader into one row in a 7d window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Yohandy Pena" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 970001,
      gameNumber: 1,
      gameDate: "2026-07-19",
      stats: { hits: 0, atBats: 3 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 970002,
      gameNumber: 2,
      gameDate: "2026-07-19",
      stats: { hits: 2, atBats: 4 },
    });

    const a = await assemble("7d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.agg.games).toBe(2);
    expect(a.batters[0]?.gameNumber).toBeNull();
    expect(a.batters[0]?.agg.counters.atBats).toBe(7);
  });

  it("merges fielding errors into the batting row and never makes a fielding table", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Error Prone" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990001,
      statType: "batting",
      gameDate: "2026-07-15",
      stats: { hits: 2, atBats: 4 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990001,
      statType: "fielding",
      gameDate: "2026-07-15",
      stats: { errors: 1, putOuts: 3, assists: 2 },
    });

    const a = await assemble("7d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.agg.counters.errors).toBe(1);
    // The fielding row contributed its errors and NOTHING else: a batting
    // aggregate has no putOuts, and one game was played, not two.
    expect(a.batters[0]?.agg.games).toBe(1);
    expect(a.batters[0]?.agg.counters.putOuts).toBeUndefined();
    expect(a.pitchers).toHaveLength(0);
  });

  it("synthesizes a zero batting row for a fielding row with no batting counterpart", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Late Sub" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990002,
      statType: "fielding",
      gameDate: "2026-07-15",
      stats: { errors: 2, putOuts: 1 },
    });

    const a = await assemble("7d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.agg.counters.errors).toBe(2);
    expect(a.batters[0]?.agg.counters.atBats).toBe(0);
  });

  it("does NOT synthesize a batting row from a pitcher's own fielding row", async () => {
    // Caught by running the real database, not by a fixture: a reliever with a
    // pitching line and its accompanying fielding line was rendering in the
    // Batters table hitting .000/.000/.000 — an appalling week rather than an
    // appearance. The fielding row belongs to the pitching appearance, so there
    // is no batting row to synthesize from it.
    const player = await insertPlayer(opened.db, { fullName: "Riley O'Brien", position: "P" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990003,
      statType: "pitching",
      gameDate: "2026-07-15",
      stats: { inningsPitched: "1.0", strikeOuts: 1, earnedRuns: 0 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990003,
      statType: "fielding",
      gameDate: "2026-07-15",
      stats: { errors: 0, putOuts: 1 },
    });

    const a = await assemble("7d");
    expect(a.pitchers.map((r) => r.player.fullName)).toContain("Riley O'Brien");
    expect(a.batters.map((r) => r.player.fullName)).not.toContain("Riley O'Brien");
  });

  it("counts quality starts across the window", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Zack Wheeler" });
    for (const gameDate of ["2026-07-14", "2026-07-19"]) {
      await insertStatLine(opened.db, {
        playerId: player.id,
        statType: "pitching",
        gameDate,
        stats: { inningsPitched: "7.0", earnedRuns: 2, strikeOuts: 8, hits: 4, baseOnBalls: 1 },
      });
    }

    const a = await assemble("7d");
    expect(a.pitchers).toHaveLength(1);
    expect(a.pitchers[0]?.qualityStarts).toBe(2);
    // Outs sum through baseball notation, never arithmetic.
    expect(a.pitchers[0]?.agg.outs).toBe(42);
  });

  it("counts only the games that meet the quality-start threshold", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Zack Wheeler" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      statType: "pitching",
      gameDate: "2026-07-14",
      stats: { inningsPitched: "7.0", earnedRuns: 2 },
    });
    // 5.2 IP is one out short, and 6.0 with 4 ER is one run over.
    await insertStatLine(opened.db, {
      playerId: player.id,
      statType: "pitching",
      gameDate: "2026-07-16",
      stats: { inningsPitched: "5.2", earnedRuns: 0 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      statType: "pitching",
      gameDate: "2026-07-18",
      stats: { inningsPitched: "6.0", earnedRuns: 4 },
    });

    const a = await assemble("7d");
    expect(a.pitchers[0]?.qualityStarts).toBe(1);
  });

  it("never reports quality starts for a batter", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15" });

    const a = await assemble("7d");
    expect(a.batters[0]?.qualityStarts).toBe(0);
  });

  it("derives a missing plateAppearances PER GAME, before summing", async () => {
    // The trap: derive it after summing and a window whose games disagree is
    // silently short. Game one reports PA, game two does not — a post-sum
    // fallback sees a non-zero total, never fires, and reports 4 instead of 9.
    const player = await insertPlayer(opened.db, { fullName: "Mixed Source" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      stats: { plateAppearances: 4, atBats: 4, hits: 2 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-16",
      stats: { atBats: 4, baseOnBalls: 1, hitByPitch: 0, hits: 1 },
    });

    const a = await assemble("7d");
    expect(a.batters[0]?.agg.counters.plateAppearances).toBe(9);
  });

  it("leaves a zero-PA game alone rather than inventing one", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Pinch Runner" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-15",
      stats: { runs: 1, stolenBases: 1 },
    });

    const a = await assemble("7d");
    expect(a.batters[0]?.agg.counters.plateAppearances).toBe(0);
    expect(a.batters[0]?.agg.counters.runs).toBe(1);
  });

  it("routes an idle PITCHER's zero row to the pitchers table", async () => {
    // A pitcher who did not pitch must never render as a batter: 0 PA / 0 H /
    // 0 HR reads as "he had a terrible week", not "he did not pitch".
    await insertPlayer(opened.db, { fullName: "Zack Wheeler", position: "P" });

    const a = await assemble("7d");
    expect(a.batters).toEqual([]);
    expect(a.pitchers).toHaveLength(1);
    expect(a.pitchers[0]?.player.fullName).toBe("Zack Wheeler");
    expect(a.pitchers[0]?.agg.games).toBe(0);
    expect(a.pitchers[0]?.agg.outs).toBe(0);
    expect(a.pitchers[0]?.qualityStarts).toBe(0);
  });

  it.each([["SS"], ["DH"], ["1B"], ["OF"], [null]])(
    "routes an idle non-pitcher (%s) to the batters table",
    async (position) => {
      await insertPlayer(opened.db, { fullName: "Idle Player", position });

      const a = await assemble("7d");
      expect(a.batters).toHaveLength(1);
      expect(a.pitchers).toEqual([]);
    },
  );

  it("routes each idle player independently", async () => {
    await insertPlayer(opened.db, { fullName: "Idle Batter", position: "SS" });
    await insertPlayer(opened.db, { fullName: "Idle Pitcher", position: "P" });

    const a = await assemble("7d");
    expect(a.batters.map((r) => r.player.fullName)).toEqual(["Idle Batter"]);
    expect(a.pitchers.map((r) => r.player.fullName)).toEqual(["Idle Pitcher"]);
  });

  it("emits no zero row for a player who did appear, even in the other table", async () => {
    // He pitched, so he is built from his splits — the idle path must not also
    // add him to the batters table as a phantom 0-for-0.
    const player = await insertPlayer(opened.db, { fullName: "Zack Wheeler", position: "P" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      statType: "pitching",
      gameDate: "2026-07-15",
      stats: { inningsPitched: "7.0", earnedRuns: 2 },
    });

    const a = await assemble("7d");
    expect(a.pitchers).toHaveLength(1);
    expect(a.batters).toEqual([]);
  });

  it("emits no zero row for a position player who batted", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta", position: "SS" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15" });

    const a = await assemble("7d");
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.agg.games).toBe(1);
  });

  it("emits a zero row for an active player with no games in the window", async () => {
    await insertPlayer(opened.db, { fullName: "Idle Player" });

    const a = await assemble("7d");
    const idle = a.batters.find((r) => r.player.fullName === "Idle Player");
    expect(idle?.agg.games).toBe(0);
    expect(idle?.agg.counters.atBats).toBe(0);
    expect(idle?.lvl).toBe("AAA");
    expect(a.statLineCount).toBe(0);
    expect(a.playerCount).toBe(0);
  });

  it("omits an out-of-season player from the zero rows", async () => {
    // The NCAA 2026 season ended 2026-06-22; this window is mid-July.
    await insertCalendar(opened.db, {
      sportId: 22,
      season: "2026",
      regularSeasonStart: "2026-02-13",
      regularSeasonEnd: "2026-06-22",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      fullName: "College Guy",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      schoolName: "LSU",
    });
    await insertPlayer(opened.db, { fullName: "In Season Guy" });

    const a = await assemble("7d");
    expect(a.batters.map((r) => r.player.fullName)).toEqual(["In Season Guy"]);
  });

  it("omits an inactive player from the zero rows", async () => {
    await insertPlayer(opened.db, { fullName: "Gone Guy", active: false });
    await insertPlayer(opened.db, { fullName: "Still Here" });

    const a = await assemble("7d");
    expect(a.batters.map((r) => r.player.fullName)).toEqual(["Still Here"]);
  });

  it("excludes an inactive player's lines from the window", async () => {
    const gone = await insertPlayer(opened.db, { fullName: "Gone Guy", active: false });
    await insertStatLine(opened.db, { playerId: gone.id, gameDate: "2026-07-15" });

    const a = await assemble("7d");
    expect(a.statLineCount).toBe(0);
    expect(a.batters).toEqual([]);
  });

  it("sorts rows by level ladder then player name", async () => {
    const seed = async (fullName: string, sportId: number, level: "mlb" | "milb") => {
      const player = await insertPlayer(opened.db, {
        fullName,
        level,
        milbLevel: level === "mlb" ? null : "Triple-A",
      });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15", sportId });
    };
    await seed("Zeta Single", 14, "milb");
    await seed("Alpha Triple", 11, "milb");
    await seed("Yankee Major", 1, "mlb");
    await seed("Alpha Single", 14, "milb");

    const a = await assemble("7d");
    expect(a.batters.map((r) => `${r.lvl} ${r.player.fullName}`)).toEqual([
      "MLB Yankee Major",
      "AAA Alpha Triple",
      "A Alpha Single",
      "A Zeta Single",
    ]);
    const ranks = a.batters.map((r) => r.lvlRank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it("labels a Dominican Summer League game DSL and a domestic complex game R", async () => {
    const dsl = await insertPlayer(opened.db, { fullName: "Dsl Guy" });
    await insertStatLine(opened.db, {
      playerId: dsl.id,
      gameDate: "2026-07-15",
      sportId: 16,
      leagueName: "Dominican Summer League",
    });
    const complex = await insertPlayer(opened.db, { fullName: "Complex Guy" });
    await insertStatLine(opened.db, {
      playerId: complex.id,
      gameDate: "2026-07-15",
      sportId: 16,
      leagueName: "Arizona Complex League",
    });

    const a = await assemble("7d");
    expect(a.batters.map((r) => r.lvl).sort()).toEqual(["DSL", "R"]);
  });

  it("anchors ytd on the season's regular-season start", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    // Spring training, before the MLB regular season opened on 2026-03-25.
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-03-01" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-04-15" });

    const a = await assemble("ytd");
    expect(a.window.from).toBe("2026-03-25");
    expect(a.window.to).toBe("2026-07-19");
    expect(a.statLineCount).toBe(1);
  });

  it("writes nothing and is repeatable", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15" });

    const linesBefore = await opened.db.select().from(statLines);
    const deliveriesBefore = await opened.db.select().from(digestDeliveries);

    const first = await assemble("7d");
    const second = await assemble("7d");

    expect(await opened.db.select().from(statLines)).toEqual(linesBefore);
    expect(await opened.db.select().from(digestDeliveries)).toEqual(deliveriesBefore);
    // Re-running a window is always safe because it consumes nothing: the
    // second read reports exactly what the first did.
    expect(second).toEqual(first);
  });
});
