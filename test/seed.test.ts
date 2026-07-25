import { describe, expect, it } from "vitest";
import { runSeed } from "../src/cli/seed.js";
import { claimRefreshRun } from "../src/jobs/refresh-run.js";
import { MlbClient } from "../src/mlb/client.js";
import { FakeStatsApi, MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, makePerson, makeTeam, testDb } from "./factories.js";

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

  it("prints whole-refresh-running for an MLB first refresh deferred by a live sweep", async () => {
    const opened = testDb(); const out: string[] = []; const clock = fakeClock(MID_SEASON);
    try {
      expect(claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 }).claimed).toBe(true);
      const client = new MlbClient({ fetchImpl: new FakeStatsApi({ person: makePerson(), teams: { 564: makeTeam() } }).fetch, delayMs: 0 });
      expect(await runSeed(["add", "--person-id", "691185"], { db: opened.db, client, now: clock.now, tz: TEST_TZ, write: (line) => out.push(line) })).toBe(0);
      expect(out).toContain("refresh skipped reason=whole-refresh-running");
    } finally { opened.close(); }
  });
});
