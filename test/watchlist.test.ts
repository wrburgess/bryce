import { describe, expect, it } from "vitest";
import { HighlightlyIdentityMismatchError } from "../src/highlightly/client.js";
import { addHighlightlyNcaaPlayer, deactivatePlayer } from "../src/watchlist/service.js";
import { MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, testDb } from "./factories.js";

describe("watchlist NCAA identity", () => {
  it("adds by explicit Highlightly identity", async () => {
    const opened = testDb();
    try {
      const result = await addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      expect(result.player).toMatchObject({ level: "ncaa", highlightlyPlayerId: 501, ncaaPlayerSeq: null });
    } finally { opened.close(); }
  });

  it("rejects a name/team assertion that does not match Highlightly", async () => {
    const opened = testDb();
    try {
      await expect(addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "Wrong", teamId: 10 })).rejects.toBeInstanceOf(HighlightlyIdentityMismatchError);
    } finally { opened.close(); }
  });

  it("deactivates by Highlightly ID while retaining the row", async () => {
    const opened = testDb();
    try {
      await addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      const player = await deactivatePlayer({ db: opened.db, now: fakeClock(MID_SEASON).now }, { kind: "highlightly", playerId: 501 });
      expect(player.active).toBe(false);
    } finally { opened.close(); }
  });
});
