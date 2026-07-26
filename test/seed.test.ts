import { describe, expect, it } from "vitest";
import { runSeed } from "../src/cli/seed.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
import { claimRefreshRun } from "../src/jobs/refresh-run.js";
import { MlbClient } from "../src/mlb/client.js";
import { FakeStatsApi, MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, insertPlayer, makePerson, makeTeam, testDb } from "./factories.js";

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

  it("promotes by explicit IDs, reports the strict CLI matrix, and refuses a stale NCAA address", async () => {
    const opened = testDb(); const out: string[] = []; const clock = fakeClock(MID_SEASON);
    const client = new MlbClient({ fetchImpl: new FakeStatsApi({ person: makePerson(), teams: { 564: makeTeam() } }).fetch, delayMs: 0 });
    const deps = { db: opened.db, client, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ, write: (line: string) => out.push(line) };
    try {
      expect(await runSeed(["add", "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10"], deps)).toBe(0);
      expect(await runSeed(["promote", "--highlightly-player-id", "501", "--person-id", "691185"], deps)).toBe(0);
      expect(out.at(-1)).toContain("promoted player id=1 personId=691185 name=Maximo Acosta");
      expect(await runSeed(["promote", "--highlightly-player-id", "501"], deps)).toBe(1);
      expect(out.at(-1)).toContain("requires --highlightly-player-id N --person-id N");
      expect(await runSeed(["promote", "--highlightly-player-id", "0", "--person-id", "691185"], deps)).toBe(1);
      expect(out.at(-1)).toContain("positive integer");
      expect(await runSeed(["promote", "--highlightly-player-id", "501", "--person-id", "691185", "--extra", "x"], deps)).toBe(1);
      expect(out.at(-1)).toContain("requires --highlightly-player-id N --person-id N");
      expect(await runSeed(["promote", "--highlightly-player-id", "501", "--person-id", "691185"], deps)).toBe(1);
      expect(out.at(-1)).toContain("no player with highlightlyPlayerId=501");
    } finally { opened.close(); }
  });

  it("exits nonzero and preserves the NCAA row when the professional identity already exists", async () => {
    const opened = testDb(); const out: string[] = []; const clock = fakeClock(MID_SEASON);
    const client = new MlbClient({ fetchImpl: new FakeStatsApi({ person: makePerson(), teams: { 564: makeTeam() } }).fetch, delayMs: 0 });
    const deps = { db: opened.db, client, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ, write: (line: string) => out.push(line) };
    try {
      expect(await runSeed(["add", "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10"], deps)).toBe(0);
      await insertPlayer(opened.db, { externalId: 691185 });
      expect(await runSeed(["promote", "--highlightly-player-id", "501", "--person-id", "691185"], deps)).toBe(1);
      expect(out.at(-1)).toContain("already owned");
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

  it("prints whole-refresh-running for a Highlightly first refresh deferred by a live sweep", async () => {
    const opened = testDb(); const out: string[] = []; const clock = fakeClock(MID_SEASON);
    try {
      expect(claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 }).claimed).toBe(true);
      expect(await runSeed([
        "add", "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10",
      ], {
        db: opened.db,
        client: {} as never,
        highlightlyClient: fakeHighlightlyClient(),
        now: clock.now,
        tz: TEST_TZ,
        write: (line) => out.push(line),
      })).toBe(0);
      expect(out).toContain("refresh skipped reason=whole-refresh-running");
    } finally { opened.close(); }
  });
});
