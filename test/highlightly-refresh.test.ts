import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
import {
  highlightlyBoxScoreCache,
  highlightlyMatchCache,
  highlightlyPlayerCursors,
  players,
  statLines,
} from "../src/db/schema.js";
import { refreshHighlightlyNcaaPlayer, runRefreshForPlayer } from "../src/jobs/refresh.js";
import { admitTargetedRefresh, claimRefreshRun } from "../src/jobs/refresh-run.js";
import { insertPlayer, MID_SEASON, TEST_TZ, fakeClock, testDb, testFileDb } from "./factories.js";

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "99" },
  json: async () => body,
});

function client(): HighlightlyClient {
  return new HighlightlyClient({
    apiKey: "test",
    fetchImpl: async (url) => {
      if (url.includes("/matches?")) return response({
        data: [{
          id: 810, date: "2026-07-18T19:00:00Z", league: "NCAA", season: 2026,
          homeTeam: { id: 10, name: "Tigers" }, awayTeam: { id: 11, name: "Owls" },
          state: { description: "Finished" },
        }],
        pagination: { totalCount: 1, offset: 0, limit: 100 },
      });
      if (url.endsWith("/box-scores/810")) return response([{
        team: { id: 10, name: "Tigers" },
        boxScores: [{ id: 501, fullName: "Gavin Kelly", statistics: [
          { group: "Batting", name: "AB", value: 4 },
          { group: "Batting", name: "H", value: 0 },
          { group: "Pitching", name: "IP", value: "1.0" },
        ] }],
      }]);
      throw new Error(`unexpected URL ${url}`);
    },
  });
}

/**
 * Invoke a hook immediately before one transaction on a wrapped connection.
 * The Highlightly refresh has three ingestion transactions after provider I/O:
 * match cache, box cache, then the atomic source cutover/stat/cursor install.
 */
function beforeTransaction(db: Db, transactionNumber: number, hook: () => void): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
      const transaction = (
        value as (fn: (tx: unknown) => unknown, config?: unknown) => unknown
      ).bind(target);
      return (fn: (tx: unknown) => unknown, config?: unknown): unknown => {
        calls += 1;
        if (calls === transactionNumber) hook();
        return transaction(fn, config);
      };
    },
  }) as Db;
}

describe("Highlightly NCAA refresh", () => {
  it("uses final JSON boxes, preserves provider zeroes, and creates no fielding line", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      const player = await insertPlayer(opened.db, {
        externalId: null, ncaaPlayerSeq: null, level: "ncaa", milbLevel: null,
        highlightlyPlayerId: 501, highlightlyTeamId: 10, ncaaSourceState: "highlightly_active",
      });
      await runRefreshForPlayer({ db: opened.db, client: {} as never,
        highlightlyClient: client(), now: clock.now, tz: TEST_TZ }, player.id);
      const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.source)).toEqual(["highlightly_ncaa", "highlightly_ncaa"]);
      expect(lines.some((line) => line.statType === "fielding")).toBe(false);
      expect(lines.find((line) => line.statType === "batting")?.stats).toMatchObject({ atBats: 4, hits: 0 });
    } finally { opened.close(); }
  });

  it("does not expose a legacy/Highlightly mixture before the complete atomic cutover", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      const player = await insertPlayer(opened.db, {
        externalId: null, ncaaPlayerSeq: 9, level: "ncaa", milbLevel: null,
        highlightlyPlayerId: 501, highlightlyTeamId: 10, ncaaSourceState: "highlightly_pending",
      });
      await opened.db.insert(statLines).values({ playerId: player.id, gameId: 99, source: "ncaa_html_legacy", statType: "fielding", gameDate: "2026-03-01", gameNumber: 1, gameType: "R", sportId: 22, stats: { errors: 1 }, raw: {}, createdAt: MID_SEASON, updatedAt: MID_SEASON });
      await runRefreshForPlayer({ db: opened.db, client: {} as never,
        highlightlyClient: client(), now: clock.now, tz: TEST_TZ }, player.id);
      const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
      expect(lines.some((line) => line.source === "ncaa_html_legacy")).toBe(false);
      const active = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
      expect(active?.ncaaSourceState).toBe("highlightly_active");
    } finally { opened.close(); }
  });

  it("refuses the atomic cutover and cursor when a whole refresh claims after caches land", async () => {
    const file = testFileDb();
    const contender = openDb(file.path);
    const clock = fakeClock(MID_SEASON);
    try {
      const player = await insertPlayer(file.opened.db, {
        externalId: null,
        ncaaPlayerSeq: 9,
        level: "ncaa",
        milbLevel: null,
        highlightlyPlayerId: 501,
        highlightlyTeamId: 10,
        ncaaSourceState: "highlightly_pending",
      });
      await file.opened.db.insert(statLines).values({
        playerId: player.id,
        gameId: 99,
        source: "ncaa_html_legacy",
        statType: "fielding",
        gameDate: "2026-03-01",
        gameNumber: 1,
        gameType: "R",
        sportId: 22,
        stats: { errors: 1 },
        raw: {},
        createdAt: MID_SEASON,
        updatedAt: MID_SEASON,
      });
      const admission = admitTargetedRefresh(file.opened.db, clock.now());
      if (!admission.admitted) throw new Error("expected targeted admission");

      // Both provider caches commit under the targeted generation. Immediately
      // before the third guarded transaction (legacy delete + new stats +
      // source-state activation + cursor), a separate connection claims the
      // whole refresh and invalidates that generation.
      const db = beforeTransaction(file.opened.db, 3, () => {
        const claim = claimRefreshRun(contender.db, { now: clock.now(), playersTotal: 1 });
        if (!claim.claimed) throw new Error("expected whole-refresh claim");
      });
      await expect(refreshHighlightlyNcaaPlayer({
        db,
        client: {} as never,
        highlightlyClient: client(),
        now: clock.now,
        tz: TEST_TZ,
      }, player, 2026, admission.fence)).rejects.toThrow("whole-refresh-running");

      expect(file.opened.db.select().from(highlightlyMatchCache).all()).toEqual([
        expect.objectContaining({ matchId: 810, complete: true, rateRemaining: 99 }),
      ]);
      expect(file.opened.db.select().from(highlightlyBoxScoreCache).all()).toEqual([
        expect.objectContaining({ matchId: 810, complete: true, rateRemaining: 99 }),
      ]);
      expect(file.opened.db.select().from(highlightlyPlayerCursors).all()).toHaveLength(0);
      expect(file.opened.db.select().from(players).where(eq(players.id, player.id)).get()?.ncaaSourceState)
        .toBe("highlightly_pending");
      expect(file.opened.db.select().from(statLines).where(eq(statLines.playerId, player.id)).all())
        .toEqual([expect.objectContaining({ source: "ncaa_html_legacy", gameId: 99 })]);
    } finally {
      contender.close();
      file.cleanup();
    }
  });
});
