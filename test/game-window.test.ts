import { describe, expect, it } from "vitest";
import { assembleGameWindow, rankedGameLinesQuery } from "../src/digest/game-window.js";
import { deriveRate } from "../src/stats/aggregate.js";
import { resolveTagScope } from "../src/tags/service.js";
import {
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertList,
  insertListMember,
  insertPlayer,
  insertPlayerTag,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * Cohort game-count report (issue #153). At MID_SEASON the host date is
 * 2026-07-19, so the last COMPLETED date is 2026-07-18: every game on or before
 * it counts, the in-progress day and any postseason game do not.
 */

const clock = () => fakeClock(MID_SEASON).now;

/** A batting game for a player on a date; each call is a fresh distinct game. */
async function battingGame(
  db: Parameters<typeof insertStatLine>[0],
  playerId: number,
  gameDate: string,
  stats: Record<string, number>,
  extra: Partial<Parameters<typeof insertStatLine>[1]> = {},
): Promise<void> {
  await insertStatLine(db, { playerId, gameDate, statType: "batting", stats, ...extra });
}

describe("cohort game-count report", () => {
  it("aggregates each player's own last N games — honest counts, per-player spans, count-based not date-based", async () => {
    const opened = testDb();
    try {
      const a = await insertPlayer(opened.db, { fullName: "Aaron Able" });
      const b = await insertPlayer(opened.db, { fullName: "Bruce Baker" });
      // A has 12 distinct games; last10games keeps the 10 MOST RECENT (drops the
      // two oldest), so his span starts at the 3rd-oldest date — not "the last
      // ~two weeks" (issue #31's defect), which a date window would give.
      const aDates = [
        "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10",
        "2026-07-11", "2026-07-12", "2026-07-14", "2026-07-15", "2026-07-17", "2026-07-18",
      ];
      for (const d of aDates) await battingGame(opened.db, a.id, d, { hits: 1, atBats: 4 });
      // B has only 4 games — a "past 10" that must report 4, with his real span.
      const bDates = ["2026-06-20", "2026-06-25", "2026-07-01", "2026-07-16"];
      for (const d of bDates) await battingGame(opened.db, b.id, d, { hits: 2, atBats: 4 });

      const report = await assembleGameWindow(opened.db, {
        now: clock(),
        tz: TEST_TZ,
        spec: "last10games",
      });

      const rowA = report.batters.find((r) => r.player.fullName === "Aaron Able")!;
      const rowB = report.batters.find((r) => r.player.fullName === "Bruce Baker")!;
      // A: exactly 10 games (not 12), summed from those 10 (hits 1 each).
      expect(rowA.agg.games).toBe(10);
      expect(rowA.agg.counters.hits).toBe(10);
      expect(rowA.spanFrom).toBe("2026-07-07"); // the 3rd-oldest date, the 10th-most-recent game
      expect(rowA.spanTo).toBe("2026-07-18");
      // B: his real 4, his real span — never implying 10.
      expect(rowB.agg.games).toBe(4);
      expect(rowB.agg.counters.hits).toBe(8);
      expect(rowB.spanFrom).toBe("2026-06-20");
      expect(rowB.spanTo).toBe("2026-07-16");
      // Two players, one report, DIFFERENT spans — the defining property.
      expect(rowA.spanFrom).not.toBe(rowB.spanFrom);
      expect(report.playerCount).toBe(2);
      expect(report.window).toMatchObject({ spec: "last10games", label: "Last 10 Games", groupBy: "playerLevel" });
      // The envelope spans every selected game across the cohort.
      expect(report.window.from).toBe("2026-06-20");
      expect(report.window.to).toBe("2026-07-18");
    } finally {
      opened.close();
    }
  });

  it("counts both games of a doubleheader as two, and a multi-stat-type game as one (ADR 0029)", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Dee Header", position: "SS" });
      // Doubleheader on one date: two distinct game ids, game numbers 1 and 2.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 201, gameDate: "2026-07-18", gameNumber: 1, statType: "batting", stats: { hits: 1, atBats: 4 } });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 202, gameDate: "2026-07-18", gameNumber: 2, statType: "batting", stats: { hits: 2, atBats: 4 } });
      // A companion fielding row on game 201 must NOT add a game — same game.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 201, gameDate: "2026-07-18", gameNumber: 1, statType: "fielding", stats: { errors: 2 } });
      // One earlier single game, for a total of three DISTINCT games.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 210, gameDate: "2026-07-10", gameNumber: 1, statType: "batting", stats: { hits: 3, atBats: 4 } });

      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const row = report.batters.find((r) => r.player.fullName === "Dee Header")!;
      expect(row.agg.games).toBe(3); // doubleheader = 2 games, + 1; the fielding companion adds none
      expect(row.agg.counters.hits).toBe(6); // 1 + 2 + 3
      expect(row.agg.counters.errors).toBe(2); // folded in from the fielding companion (ADR 0033)
    } finally {
      opened.close();
    }
  });

  it("counts a game ONCE even when its companion stat-type rows disagree on the game date (per-game identity is (source, game_id))", async () => {
    // A game's batting and fielding rows are fetched by independent calls and can
    // carry different dates (a suspended-then-resumed game — ADR 0029). The game
    // is still ONE game: keying dedup on (source, game_id) alone, never on the
    // date, so it consumes one slot and its rows are summed once (not twice).
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Sus Pended" });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 990, gameDate: "2026-07-15", gameNumber: 1, statType: "batting", stats: { hits: 2, atBats: 4 } });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 990, gameDate: "2026-07-14", gameNumber: 1, statType: "fielding", stats: { errors: 1 } });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 991, gameDate: "2026-07-10", gameNumber: 1, statType: "batting", stats: { hits: 3, atBats: 4 } });

      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const row = report.batters.find((r) => r.player.fullName === "Sus Pended")!;
      expect(row.agg.games).toBe(2); // 990 and 991 — NOT 3 (990 split by date)
      expect(row.agg.counters.hits).toBe(5); // 2 + 3, the 990 batting row summed once
      expect(row.agg.counters.errors).toBe(1); // the 990 fielding companion folded in once
      expect(row.spanFrom).toBe("2026-07-10");
      expect(row.spanTo).toBe("2026-07-15");
    } finally {
      opened.close();
    }
  });

  it("resolves the N boundary deterministically when two distinct games tie on (date, game_number)", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Tie Breaker" });
      // Nine most-recent games fill slots 1-9.
      const fillers = ["2026-07-18", "2026-07-17", "2026-07-16", "2026-07-15", "2026-07-14", "2026-07-13", "2026-07-12", "2026-07-11", "2026-07-10"];
      for (const d of fillers) await battingGame(opened.db, p.id, d, { hits: 1, atBats: 4 });
      // Two DISTINCT older games tie on the same (date, game_number) — different
      // game ids, inserted in id order. Only ONE may cross the last-10 cutoff.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 501, gameDate: "2026-07-05", gameNumber: 1, statType: "batting", stats: { hits: 5, atBats: 4 } });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 502, gameDate: "2026-07-05", gameNumber: 1, statType: "batting", stats: { hits: 7, atBats: 4 } });

      const first = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const second = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const rowFirst = first.batters.find((r) => r.player.fullName === "Tie Breaker")!;
      // Exactly 10 games — one of the two tying games crossed the cutoff, not both.
      expect(rowFirst.agg.games).toBe(10);
      expect(rowFirst.spanFrom).toBe("2026-07-05");
      // The higher-id tying game (max_id DESC, matching the single-player card) wins.
      expect(rowFirst.agg.counters.hits).toBe(9 + 7);
      // Deterministic: a second run selects the identical set (issue #31 / F3).
      expect(second.batters).toEqual(first.batters);
    } finally {
      opened.close();
    }
  });

  it("splits a mid-window promotion into one row per level, neither containing the other's totals", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Pro Motion" });
      // AAA (sportId 11) then MLB (sportId 1) inside the last 10 games.
      await battingGame(opened.db, p.id, "2026-07-10", { hits: 2, atBats: 4 }, { sportId: 11, leagueName: "International League" });
      await battingGame(opened.db, p.id, "2026-07-12", { hits: 1, atBats: 4 }, { sportId: 11, leagueName: "International League" });
      await battingGame(opened.db, p.id, "2026-07-18", { hits: 3, atBats: 4 }, { sportId: 1, leagueName: "American League" });

      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const rows = report.batters.filter((r) => r.player.fullName === "Pro Motion");
      expect(rows.map((r) => r.lvl)).toEqual(["MLB", "AAA"]); // sorted MLB first
      const mlb = rows.find((r) => r.lvl === "MLB")!;
      const aaa = rows.find((r) => r.lvl === "AAA")!;
      expect(mlb.agg.games).toBe(1);
      expect(mlb.agg.counters.hits).toBe(3);
      expect(mlb.spanFrom).toBe("2026-07-18");
      expect(aaa.agg.games).toBe(2);
      expect(aaa.agg.counters.hits).toBe(3); // 2 + 1, NOT including the MLB game's 3
      expect(aaa.spanFrom).toBe("2026-07-10");
      expect(aaa.spanTo).toBe("2026-07-12");
    } finally {
      opened.close();
    }
  });

  it("splits the Dominican Summer League from a domestic complex league (both sportId 16)", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Com Plex", level: "milb", milbLevel: "Rookie" });
      // Both are sportId 16; only the league name separates DSL from the domestic
      // complex — so grouping by sportId alone (the digest's key) would merge them.
      await battingGame(opened.db, p.id, "2026-07-11", { hits: 2, atBats: 4 }, { sportId: 16, leagueName: "Dominican Summer League" });
      await battingGame(opened.db, p.id, "2026-07-16", { hits: 1, atBats: 4 }, { sportId: 16, leagueName: "Arizona Complex League" });

      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const rows = report.batters.filter((r) => r.player.fullName === "Com Plex");
      expect(rows.map((r) => r.lvl).sort()).toEqual(["DSL", "R"]);
      expect(rows.find((r) => r.lvl === "DSL")?.agg.counters.hits).toBe(2);
      expect(rows.find((r) => r.lvl === "R")?.agg.counters.hits).toBe(1);
    } finally {
      opened.close();
    }
  });

  it("recomputes rates from summed counters, never averaging per-game rates", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Ray Tio" });
      // 1-for-1 (1.000) and 1-for-5 (.200): summed AVG = 2/6 = .333; the mean of
      // the per-game rates would be .600. The summed answer is the correct one.
      await battingGame(opened.db, p.id, "2026-07-12", { hits: 1, atBats: 1 });
      await battingGame(opened.db, p.id, "2026-07-18", { hits: 1, atBats: 5 });
      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const row = report.batters.find((r) => r.player.fullName === "Ray Tio")!;
      expect(row.agg.games).toBe(2);
      expect(deriveRate(row.agg, "avg")).toBe(".333");
    } finally {
      opened.close();
    }
  });

  it("excludes the in-progress host date and postseason games; a postseason-only player never appears", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Reg Ular" });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 601, gameDate: "2026-07-18", statType: "batting", stats: { hits: 2, atBats: 4 } });
      // The current host date (2026-07-19) is in progress — never counted.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 602, gameDate: "2026-07-19", statType: "batting", stats: { hits: 9, atBats: 9 } });
      // Postseason is filtered before the game limit.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 603, gameDate: "2026-07-17", gameType: "F", statType: "batting", stats: { hits: 9, atBats: 9 } });
      // A player with ONLY postseason games has no completed regular game — gone.
      const postOnly = await insertPlayer(opened.db, { fullName: "Post Only" });
      await insertStatLine(opened.db, { playerId: postOnly.id, gameId: 610, gameDate: "2026-07-16", gameType: "F", statType: "batting", stats: { hits: 5, atBats: 5 } });

      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      const row = report.batters.find((r) => r.player.fullName === "Reg Ular")!;
      expect(row.agg.games).toBe(1);
      expect(row.agg.counters.hits).toBe(2);
      expect(row.spanFrom).toBe("2026-07-18");
      expect(report.batters.some((r) => r.player.fullName === "Post Only")).toBe(false);
    } finally {
      opened.close();
    }
  });

  it("scopes the cohort by tags, list, and their intersection; a deactivated player never appears", async () => {
    const opened = testDb();
    try {
      const rostered = await insertPlayer(opened.db, { fullName: "Ross Tered" });
      const listed = await insertPlayer(opened.db, { fullName: "Liz Ted" });
      const both = await insertPlayer(opened.db, { fullName: "Bo Th" });
      const neither = await insertPlayer(opened.db, { fullName: "Nate Ither" });
      const deactivated = await insertPlayer(opened.db, { fullName: "Dee Activated", active: false });
      for (const pl of [rostered, listed, both, neither, deactivated]) {
        await battingGame(opened.db, pl.id, "2026-07-18", { hits: 1, atBats: 4 });
      }
      await insertPlayerTag(opened.db, { playerId: rostered.id, namespace: "status", value: "rostered" });
      await insertPlayerTag(opened.db, { playerId: both.id, namespace: "status", value: "rostered" });
      await insertPlayerTag(opened.db, { playerId: deactivated.id, namespace: "status", value: "rostered" });
      const list = await insertList(opened.db, { name: "MyList" });
      await insertListMember(opened.db, { listId: list.id, playerId: listed.id });
      await insertListMember(opened.db, { listId: list.id, playerId: both.id });

      const names = (report: Awaited<ReturnType<typeof assembleGameWindow>>) =>
        report.batters.map((r) => r.player.fullName).sort();

      // Tag scope: rostered + both (deactivated is gated out by players.active).
      const byTag = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games", tagScope: resolveTagScope("status:rostered") });
      expect(names(byTag)).toEqual(["Bo Th", "Ross Tered"]);

      // List scope: listed + both.
      const byList = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games", listId: list.id, listName: "MyList" });
      expect(names(byList)).toEqual(["Bo Th", "Liz Ted"]);

      // Intersection: only Both.
      const byBoth = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games", listId: list.id, tagScope: resolveTagScope("status:rostered") });
      expect(names(byBoth)).toEqual(["Bo Th"]);

      // No scope: every ACTIVE player (deactivated stays out).
      const all = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      expect(names(all)).toEqual(["Bo Th", "Liz Ted", "Nate Ither", "Ross Tered"]);
      expect(all.batters.some((r) => r.player.fullName === "Dee Activated")).toBe(false);
    } finally {
      opened.close();
    }
  });

  it("a cohort matching no players is an empty report, not an error", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Some One" });
      await battingGame(opened.db, p.id, "2026-07-18", { hits: 1, atBats: 4 });
      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games", tagScope: resolveTagScope("status:scouted") });
      expect(report.batters).toEqual([]);
      expect(report.pitchers).toEqual([]);
      expect(report.playerCount).toBe(0);
      expect(report.statLineCount).toBe(0);
      // With nothing selected the envelope collapses to the last completed date.
      expect(report.window).toMatchObject({ from: "2026-07-18", to: "2026-07-18", spec: "last10games" });
    } finally {
      opened.close();
    }
  });

  it("routes a pitcher to the Pitchers table and counts his quality starts", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Pete Cher", position: "P" });
      // Two starts, both quality (>= 6 IP, <= 3 ER): QS is a COUNT, not a flag.
      await insertStatLine(opened.db, { playerId: p.id, gameId: 701, gameDate: "2026-07-12", statType: "pitching", stats: { inningsPitched: "7.0", earnedRuns: 2, strikeOuts: 8, gamesStarted: 1 } });
      await insertStatLine(opened.db, { playerId: p.id, gameId: 702, gameDate: "2026-07-18", statType: "pitching", stats: { inningsPitched: "6.0", earnedRuns: 1, strikeOuts: 5, gamesStarted: 1 } });
      const report = await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last10games" });
      expect(report.batters).toEqual([]);
      const row = report.pitchers.find((r) => r.player.fullName === "Pete Cher")!;
      expect(row.agg.games).toBe(2);
      expect(row.qualityStarts).toBe(2);
    } finally {
      opened.close();
    }
  });

  it("writes nothing — a read-only report", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Reed Only" });
      await battingGame(opened.db, p.id, "2026-07-18", { hits: 1, atBats: 4 });
      const before = opened.sqlite.prepare("SELECT * FROM stat_lines ORDER BY id").all();
      const deliveriesBefore = (opened.sqlite.prepare("SELECT count(*) AS c FROM digest_deliveries").get() as { c: number }).c;

      await assembleGameWindow(opened.db, { now: clock(), tz: TEST_TZ, spec: "last30games" });

      const after = opened.sqlite.prepare("SELECT * FROM stat_lines ORDER BY id").all();
      const deliveriesAfter = (opened.sqlite.prepare("SELECT count(*) AS c FROM digest_deliveries").get() as { c: number }).c;
      expect(after).toEqual(before); // every stat-line row byte-identical
      expect(deliveriesAfter).toBe(deliveriesBefore); // no delivery row written
      expect(deliveriesAfter).toBe(0);
    } finally {
      opened.close();
    }
  });

  it("selects the whole cohort in ONE index-backed statement — no N+1, no base-table scan (EXPLAIN, scope active)", async () => {
    const opened = testDb();
    try {
      const p = await insertPlayer(opened.db, { fullName: "Ind Ex" });
      await insertPlayerTag(opened.db, { playerId: p.id, namespace: "status", value: "rostered" });
      await battingGame(opened.db, p.id, "2026-07-18", { hits: 1, atBats: 4 });
      // The EXACT statement the engine runs, with a tag scope active (F8c) — so
      // the plan asserted is the real query, not a hand-copied lookalike.
      const { sql, params } = rankedGameLinesQuery(opened.db, {
        limit: 10,
        lastCompleted: "2026-07-18",
        tagScope: resolveTagScope("status:rostered"),
      }).toSQL();
      // better-sqlite3 rejects a multi-statement string at prepare time, so a
      // successful prepare proves this is ONE statement — never a query-per-player.
      const plan = opened.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(params as unknown[])) as Array<{ detail: string }>;
      // Every access to a BASE table (stat_lines / players) is index-backed: the
      // group/rank runs over stat_lines_player_source_game_type_uq and the
      // players join over its primary key — never a bare full scan. (SQLite adds
      // a TEMP B-TREE for the window-function ordering; on this single-user host's
      // small history that is negligible — see the ADR.) The CTE result sets
      // themselves (distinct_games / ranked / subquery) scan as derived tables,
      // which is not a base-table scan.
      const baseScan = /\bSCAN\b/;
      const indexed = /USING (INDEX|COVERING INDEX|INTEGER PRIMARY KEY)/;
      const badBaseScan = plan.find(
        (step) =>
          /\b(stat_lines|players)\b/.test(step.detail) &&
          baseScan.test(step.detail) &&
          !indexed.test(step.detail),
      );
      expect(badBaseScan, JSON.stringify(badBaseScan)).toBeUndefined();
      // And stat_lines is genuinely reached through an index at least once.
      expect(plan.some((step) => /stat_lines/.test(step.detail) && indexed.test(step.detail))).toBe(true);
    } finally {
      opened.close();
    }
  });
});
