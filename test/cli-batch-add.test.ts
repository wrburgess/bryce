import { describe, expect, it } from "vitest";
import { runBatchAdd } from "../src/cli/batch-add.js";
import { MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, testDb } from "./factories.js";

describe("players:batch-add CLI", () => {
  it("stages an explicit Highlightly identity", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runBatchAdd([
        "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10",
      ], {
        db: opened.db,
        client: {} as never,
        highlightlyClient: fakeHighlightlyClient(),
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
        write: (line) => out.push(line),
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("highlightlyPlayerId=501");
    } finally { opened.close(); }
  });

  it("rejects the removed sequence flag", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runBatchAdd(["--ncaa-seqs", "1"], {
        db: opened.db, client: {} as never, now: fakeClock(MID_SEASON).now, tz: TEST_TZ, write: (line) => out.push(line),
      });
      expect(code).toBe(1);
      expect(out[0]).toContain("unknown flag");
    } finally { opened.close(); }
  });
});
