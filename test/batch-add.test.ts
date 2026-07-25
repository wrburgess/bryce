import { describe, expect, it } from "vitest";
import { MlbClient } from "../src/mlb/client.js";
import { batchAddPlayers } from "../src/watchlist/service.js";
import { FakeStatsApi, MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, makePerson, makeTeam, testDb } from "./factories.js";

describe("batchAddPlayers", () => {
  it("stages a complete Highlightly NCAA identity without an inline refresh", async () => {
    const opened = testDb();
    const api = new FakeStatsApi({ person: makePerson(), teams: { 564: makeTeam() } });
    try {
      const result = await batchAddPlayers({
        db: opened.db,
        client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
        highlightlyClient: fakeHighlightlyClient(),
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
      }, { entries: [{ highlightlyPlayerId: 501, canonicalName: "C Guy", teamId: 10 }] });
      expect(result.summary).toMatchObject({ added: 1, failed: 0, total: 1 });
      expect(result.entries[0]).toMatchObject({ status: "added", player: { highlightlyPlayerId: 501, level: "ncaa" } });
    } finally {
      opened.close();
    }
  });

  it("rejects the retired sequence form before a write", async () => {
    const opened = testDb();
    try {
      await expect(batchAddPlayers({
        db: opened.db,
        client: {} as never,
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
      }, { entries: [{ ncaaPlayerSeq: 2649785 }] })).rejects.toThrow();
    } finally {
      opened.close();
    }
  });
});
