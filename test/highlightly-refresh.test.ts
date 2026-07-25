import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HighlightlyClient } from "../src/highlightly/client.js";
import { players, statLines } from "../src/db/schema.js";
import { runRefreshForPlayer } from "../src/jobs/refresh.js";
import { insertPlayer, MID_SEASON, TEST_TZ, fakeClock, testDb } from "./factories.js";

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
});
