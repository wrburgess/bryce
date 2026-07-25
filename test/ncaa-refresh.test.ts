import { describe, expect, it } from "vitest";
import { HighlightlyMigrationRequiredError } from "../src/highlightly/client.js";
import { runRefreshForPlayer } from "../src/jobs/refresh.js";
import { MID_SEASON, TEST_TZ, fakeClock, insertPlayer, testDb } from "./factories.js";

describe("retired NCAA HTML refresh", () => {
  it("requires an explicit Highlightly attachment before a legacy NCAA row can refresh", async () => {
    const opened = testDb();
    try {
      const player = await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        ncaaSourceState: "legacy_html",
      });
      await expect(runRefreshForPlayer({
        db: opened.db,
        client: {} as never,
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
      }, player.id)).rejects.toBeInstanceOf(HighlightlyMigrationRequiredError);
    } finally {
      opened.close();
    }
  });
});
