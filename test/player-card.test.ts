import { describe, expect, it } from "vitest";
import { AmbiguousPlayerCardNameError, PlayerCardNotFoundError, assemblePlayerCard, cardWindowIsLong } from "../src/reports/player-card.js";
import { MID_SEASON, TEST_TZ, fakeClock, insertCalendars2026, insertPlayer, insertStatLine, testDb } from "./factories.js";

describe("single-player card", () => {
  /**
   * The BB%/K% threshold, which the Card reaches through an explicit
   * PlayerCardWindowSpec -> ReportWindowSpec mapping rather than a cast.
   *
   * VERIFIED to fail against the cast: replacing the mapping's body with
   * `isLongWindow(spec as unknown as ReportWindowSpec)` makes last30 return
   * false (SPAN_DAYS["last30"] is undefined, and `undefined >= 21` is false),
   * and this test goes red — which is the whole reason it exists, since the
   * cast produces a green suite with BB%/K% silently missing from the one
   * window that must show them.
   */
  it("maps every Card Window onto the report window vocabulary for the BB%/K% threshold", () => {
    expect(cardWindowIsLong("last10")).toBe(false);
    expect(cardWindowIsLong("last30")).toBe(true);
    expect(cardWindowIsLong("ytd")).toBe(true);
  });

  it("selects distinct regular-season games before loading companion lines and retains level splits", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      await insertCalendars2026(opened.db);
      const player = await insertPlayer(opened.db, { position: "SS" });
      const other = await insertPlayer(opened.db, { fullName: "Other Player" });
      // Doubleheader: one batting and one fielding companion per game. Neither
      // companion consumes an additional slot in the last-10 game selection.
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 101, gameDate: "2026-07-18", gameNumber: 1, sportId: 11, stats: { hits: 1, atBats: 4, errors: 0 } });
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 101, gameDate: "2026-07-18", gameNumber: 1, sportId: 11, statType: "fielding", stats: { errors: 2 } });
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 102, gameDate: "2026-07-18", gameNumber: 2, sportId: 1, stats: { hits: 2, atBats: 4 } });
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 102, gameDate: "2026-07-18", gameNumber: 2, sportId: 1, statType: "fielding", stats: { errors: 1 } });
      await insertStatLine(opened.db, { playerId: other.id, source: "mlb_stats_api", gameId: 102, gameDate: "2026-07-18", gameNumber: 2, sportId: 1, stats: { hits: 99, atBats: 99 } });
      // Current host-date data is incomplete and must not consume a last-N
      // slot, even though its date would otherwise sort first.
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 104, gameDate: "2026-07-19", stats: { hits: 99, atBats: 99 } });
      // Postseason is filtered before the game limit.
      await insertStatLine(opened.db, { playerId: player.id, source: "mlb_stats_api", gameId: 103, gameDate: "2026-07-19", gameType: "F", stats: { hits: 99, atBats: 99 } });

      const card = assemblePlayerCard(opened.db, { id: player.id, windows: ["last10", "ytd"], now: clock.now, tz: TEST_TZ });
      expect(card.player).toMatchObject({ id: player.id, fullName: "Maximo Acosta" });
      const last10 = card.windows[0]!;
      expect(last10).toMatchObject({ requestedGames: 10, actualGames: 2, from: "2026-07-18", to: "2026-07-18", empty: false });
      expect(last10.batters.map((row) => row.lvl)).toEqual(["MLB", "AAA"]);
      expect(last10.batters.map((row) => row.aggregate.counters.hits)).toEqual([2, 1]);
      expect(last10.batters.find((row) => row.lvl === "AAA")?.aggregate.counters.errors).toBe(2);
      expect(card.windows[1]!.actualGames).toBe(2);
      // Acceptance contract: the bounded identity scan is supported by its
      // player/regular-season/recency index, rather than sorting all history.
      const plan = opened.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id, source, game_id, game_date FROM stat_lines WHERE player_id = ? AND game_type = 'R' ORDER BY game_date DESC, game_number DESC, id DESC").all(player.id) as Array<{ detail: string }>;
      expect(plan.some((step) => step.detail.includes("stat_lines_player_regular_game_order_idx"))).toBe(true);
    } finally { opened.close(); }
  });

  it("handles ytd bounds, empty cards, inactive players, and exact canonical names", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      await insertCalendars2026(opened.db);
      const player = await insertPlayer(opened.db, { fullName: "José Test", active: false });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-02-01", stats: { hits: 8, atBats: 8 } });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-03-27", stats: { hits: 1, atBats: 4 } });
      // July 19 is the host's current date at MID_SEASON, so it is incomplete
      // and must not appear in the YTD card until the following day.
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-19", stats: { hits: 9, atBats: 9 } });
      const ytd = assemblePlayerCard(opened.db, { name: "Jose\u0301  Test", windows: ["ytd"], now: clock.now, tz: TEST_TZ }).windows[0]!;
      expect(ytd).toMatchObject({ actualGames: 1, from: "2026-03-27", to: "2026-03-27", empty: false });
      const idle = await insertPlayer(opened.db, { fullName: "No Games" });
      const empty = assemblePlayerCard(opened.db, { id: idle.id, windows: ["last10"], now: () => new Date("2026-01-02T12:00:00Z"), tz: TEST_TZ }).windows[0]!;
      expect(empty).toMatchObject({ actualGames: 0, empty: true, from: null, to: null });
    } finally { opened.close(); }
  });

  it("keeps pitching rows for a player whose stored position is unknown", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      const player = await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 8181,
        highlightlyPlayerId: null,
        highlightlyTeamId: null,
        ncaaSourceState: "legacy_html",
        fullName: "Unknown Position Pitcher",
        level: "ncaa",
        milbLevel: null,
        position: null,
      });
      await insertStatLine(opened.db, {
        playerId: player.id,
        source: "ncaa_html_legacy",
        gameId: 45,
        statType: "pitching",
        sportId: 22,
        stats: { inningsPitched: "5.0", strikeOuts: 7, hits: 3, earnedRuns: 1 },
      });
      const card = assemblePlayerCard(opened.db, { id: player.id, windows: ["last10"], now: clock.now, tz: TEST_TZ });
      expect(card.windows[0]?.pitchers).toHaveLength(1);
      expect(card.windows[0]?.pitchers[0]?.aggregate.counters.strikeOuts).toBe(7);
      expect(card.windows[0]?.batters).toEqual([]);
    } finally { opened.close(); }
  });

  it("counts quality starts and relief decisions from the SAME implementation the digest uses", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      const pitcher = await insertPlayer(opened.db, { fullName: "Counting Arm", position: "P" });
      // A qualifying start (6.0 IP, 2 ER) ...
      await insertStatLine(opened.db, { playerId: pitcher.id, gameId: 801, gameDate: "2026-07-18", statType: "pitching", stats: { inningsPitched: "6.0", earnedRuns: 2, gamesStarted: 1 } });
      // ... a start that misses the threshold on earned runs (6.0 IP, 4 ER) ...
      await insertStatLine(opened.db, { playerId: pitcher.id, gameId: 802, gameDate: "2026-07-17", statType: "pitching", stats: { inningsPitched: "6.0", earnedRuns: 4, gamesStarted: 1 } });
      // ... a relief win and a relief loss (gamesStarted PRESENT and 0) ...
      await insertStatLine(opened.db, { playerId: pitcher.id, gameId: 803, gameDate: "2026-07-16", statType: "pitching", stats: { inningsPitched: "1.0", earnedRuns: 0, gamesStarted: 0, wins: 1 } });
      await insertStatLine(opened.db, { playerId: pitcher.id, gameId: 804, gameDate: "2026-07-15", statType: "pitching", stats: { inningsPitched: "1.0", earnedRuns: 3, gamesStarted: 0, losses: 1 } });
      // ... and a STARTER's decision, which is never surfaced as a relief one.
      await insertStatLine(opened.db, { playerId: pitcher.id, gameId: 805, gameDate: "2026-07-14", statType: "pitching", stats: { inningsPitched: "7.0", earnedRuns: 1, gamesStarted: 1, wins: 1 } });

      const row = assemblePlayerCard(opened.db, { id: pitcher.id, windows: ["last10"], now: clock.now, tz: TEST_TZ }).windows[0]!.pitchers[0]!;
      expect(row).toMatchObject({ qualityStarts: 2, reliefWins: 1, reliefLosses: 1 });

      // NCAA fail-closed: `gamesStarted` ABSENT is unknown-not-relief, so the
      // decision is not counted. The Digest pins this same semantic in
      // test/digest-preview.test.ts; re-asserting it on the Card is what shows
      // both callers demonstrably share ONE implementation.
      const ncaa = await insertPlayer(opened.db, { fullName: "Ncaa Arm", position: "P" });
      await insertStatLine(opened.db, { playerId: ncaa.id, source: "ncaa_html_legacy", gameId: 811, gameDate: "2026-07-18", sportId: 22, statType: "pitching", stats: { inningsPitched: "2.0", earnedRuns: 0, wins: 1, losses: 1 } });
      const ncaaRow = assemblePlayerCard(opened.db, { id: ncaa.id, windows: ["last10"], now: clock.now, tz: TEST_TZ }).windows[0]!.pitchers[0]!;
      expect(ncaaRow).toMatchObject({ qualityStarts: 0, reliefWins: 0, reliefLosses: 0 });

      // A BATTER's row always reports 0 for all three, matching the Digest.
      const batter = await insertPlayer(opened.db, { fullName: "Plain Batter", position: "SS" });
      await insertStatLine(opened.db, { playerId: batter.id, gameId: 821, gameDate: "2026-07-18", stats: { hits: 2, atBats: 4, wins: 1 } });
      const battingRow = assemblePlayerCard(opened.db, { id: batter.id, windows: ["last10"], now: clock.now, tz: TEST_TZ }).windows[0]!.batters[0]!;
      expect(battingRow).toMatchObject({ qualityStarts: 0, reliefWins: 0, reliefLosses: 0 });
    } finally { opened.close(); }
  });

  it("fails closed for unknown and ambiguous selectors", async () => {
    const opened = testDb();
    try {
      await insertPlayer(opened.db, { fullName: "Same Name" });
      await insertPlayer(opened.db, { fullName: "Same Name" });
      expect(() => assemblePlayerCard(opened.db, { id: 999999, now: () => new Date(MID_SEASON), tz: TEST_TZ })).toThrow(PlayerCardNotFoundError);
      expect(() => assemblePlayerCard(opened.db, { name: "Same Name", now: () => new Date(MID_SEASON), tz: TEST_TZ })).toThrow(AmbiguousPlayerCardNameError);
    } finally { opened.close(); }
  });
});
