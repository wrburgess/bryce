import { describe, expect, it } from "vitest";
import { runSeed } from "../src/cli/seed.js";
import { MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, testDb } from "./factories.js";

describe("seed Highlightly NCAA commands", () => {
  it("adds an NCAA player with its explicit provider identity", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runSeed(["add", "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10"], {
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ, write: (line) => out.push(line),
      });
      expect(code).toBe(0);
      expect(out[0]).toContain("highlightlyPlayerId=501");
    } finally { opened.close(); }
  });

  it("rejects the retired NCAA sequence flag", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runSeed(["add", "--ncaa-seq", "2649785"], {
        db: opened.db, client: {} as never, now: fakeClock(MID_SEASON).now, tz: TEST_TZ, write: (line) => out.push(line),
      });
      expect(code).toBe(1);
      expect(out[0]).toContain("retired");
    } finally { opened.close(); }
  });
});
