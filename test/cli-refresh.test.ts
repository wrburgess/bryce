import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { RefreshCliDeps } from "../src/cli/refresh.js";
import { runRefreshCli } from "../src/cli/refresh.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendars2026,
  insertPlayer,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * `npm run refresh`. The CLI is a thin presenter, so the risk is not the job
 * (covered in refresh.test.ts) but the WIRING: exit code and failure print
 * (#23, MF6). Each case exercises `runRefreshCli` through its injected deps and
 * asserts the OBSERVABLE effects — the returned code and the captured lines.
 */
describe("refresh CLI (#23, MF6)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;
  let output: string[];
  let errors: string[];

  const deps = (client?: MlbClient): RefreshCliDeps => ({
    db: opened.db,
    client: client ?? new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  });

  const failing = (pattern: RegExp, message: string): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) =>
        pattern.test(url) ? Promise.reject(new Error(message)) : api.fetch(url),
      delayMs: 0,
    });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
    ncaaApi = new FakeNcaaApi();
    output = [];
    errors = [];
  });

  afterEach(() => {
    opened.close();
  });

  it("exits 0 and prints no failures on a clean `ok` run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(deps())).toBe(0);
    expect(output[0]).toContain("status=ok");
    expect(output[0]).toContain("players=1");
    expect(errors).toEqual([]);
  });

  it("exits 0 on a `partial` (skip-only) run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, level: "mlb", milbLevel: null, fullName: "No Id Guy" });
    expect(await runRefreshCli(deps())).toBe(0);
    expect(output[0]).toContain("status=partial");
    expect(output[0]).toContain("skipped=1");
    // No collected failures → no failure line.
    expect(errors).toEqual([]);
  });

  it("exits 0 BUT prints the failure summary on a safe `partial` (a failure alongside a success)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    expect(await runRefreshCli(deps(failing(/\/people\/660271\?/, "b down")))).toBe(0);
    expect(output[0]).toContain("status=partial");
    expect(output[0]).toContain("failed=1");
    // The one-line failure summary is printed even though the exit code is 0.
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("b down");
  });

  it("exits 1 and prints the failure summary on a blocked `failed` run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(deps(failing(/\/people\//, "all down")))).toBe(1);
    expect(output[0]).toContain("status=failed");
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("all down");
  });

  it("exits 0 and reports the reason on a skipped (Offseason Sleep) run", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli(deps())).toBe(0);
    expect(output[0]).toBe("refresh skipped reason=offseason-sleep");
    expect(errors).toEqual([]);
  });
});
