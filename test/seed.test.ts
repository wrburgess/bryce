import { describe, expect, it } from "vitest";
import { runSeed } from "../src/cli/seed.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
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

  it("finds and adds a unique NCAA player by name", async () => {
    const opened = testDb();
    const out: string[] = [];
    const client = new HighlightlyClient({
      apiKey: "test",
      fetchImpl: async (url) => {
        if (url.includes("/players?")) return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ data: [{ id: 501, fullName: "Roch Cholowsky" }], pagination: { totalCount: 1, offset: 0, limit: 10 } }) };
        if (url.includes("/matches?")) return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ data: [], pagination: { totalCount: 0, offset: 0, limit: 100 } }) };
        return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ id: 501, fullName: "Roch Cholowsky", team: { id: 10, name: "Bruins", league: "NCAA" }, statistics: [] }) };
      },
    });
    try {
      expect(await runSeed(["add", "--ncaa", "--name", "Roch Cholowsky"], {
        db: opened.db, client: {} as never, highlightlyClient: client, now: fakeClock(MID_SEASON).now, tz: TEST_TZ, write: (line) => out.push(line),
      })).toBe(0);
      expect(out[0]).toContain("highlightlyPlayerId=501 name=Roch Cholowsky");
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
