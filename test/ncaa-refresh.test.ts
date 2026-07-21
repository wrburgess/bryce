import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, seasonCalendar, statLines } from "../src/db/schema.js";
import type { DigestDeps } from "../src/jobs/digest.js";
import { runDigest } from "../src/jobs/digest.js";
import type { RefreshDeps } from "../src/jobs/refresh.js";
import { runRefresh } from "../src/jobs/refresh.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  CapturingMailer,
  FakeNcaaApi,
  FakeStatsApi,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendar,
  insertCalendars2026,
  insertPlayer,
  makeGameLogBody,
  makeMlbTeam,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/** NCAA is In Season in mid-March (opens 2026-02-13). */
const NCAA_IN_SEASON = "2026-03-15T17:00:00Z";

const battingPage = (fullName: string, schoolName: string) =>
  makeNcaaGameLogHtml({
    fullName,
    schoolName,
    rows: [
      { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 2, HR: 1, RBI: 2 } },
      { date: "2026-03-14", opponentName: "Georgia", isHome: false, contestId: 6002, stats: { AB: 3, H: 1, HR: 0, RBI: 0 } },
    ],
  });

const pitchingPage = (fullName: string, schoolName: string) =>
  makeNcaaGameLogHtml({
    fullName,
    schoolName,
    rows: [
      { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { IP: "6.0", H: 4, ER: 1, BB: 2, SO: 8, W: 1 } },
    ],
  });

const fieldingPage = (fullName: string, schoolName: string) =>
  makeNcaaGameLogHtml({
    fullName,
    schoolName,
    rows: [
      { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { PO: 2, A: 3, E: 1 } },
    ],
  });

describe("runRefresh — NCAA ingest path (ADR 0032)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(NCAA_IN_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: {},
    });
    ncaaApi = new FakeNcaaApi({
      pages: {
        "2649785:batting": battingPage("College Guy", "LSU"),
        "2649785:pitching": pitchingPage("College Guy", "LSU"),
        "2649785:fielding": fieldingPage("College Guy", "LSU"),
      },
    });
  });

  afterEach(() => {
    opened.close();
  });

  const insertNcaa = (overrides = {}) =>
    insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "College Guy",
      schoolName: "LSU",
      ...overrides,
    });

  it("ingests batting + pitching + fielding rows and seeds the sportId 22 calendar", async () => {
    const player = await insertNcaa();
    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(false);
    expect(summary.playersRefreshed).toBe(1);
    // 2 batting + 1 pitching + 1 fielding game rows.
    expect(summary.statLinesInserted).toBe(4);

    const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.sportId === 22)).toBe(true);
    expect(lines.filter((l) => l.statType === "batting")).toHaveLength(2);
    expect(lines.filter((l) => l.statType === "pitching")).toHaveLength(1);
    expect(lines.filter((l) => l.statType === "fielding")).toHaveLength(1);
    // The scraped E header reaches storage as the canonical errors key.
    const fielding = lines.find((l) => l.statType === "fielding");
    expect((fielding?.stats as Record<string, unknown>).errors).toBe(1);
    // Game 6001 carries batting, pitching, AND fielding lines under the ADR 0029 key.
    expect(lines.filter((l) => l.gameId === 6001)).toHaveLength(3);

    // The NCAA calendar row was seeded from the bundled dates.
    const cal = (
      await opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, 22))
    )[0];
    expect(cal?.regularSeasonStart).toBe("2026-02-13");
    expect(cal?.regularSeasonEnd).toBe("2026-06-22");
  });

  it("is idempotent: a second identical run inserts zero new rows", async () => {
    await insertNcaa();
    await runRefresh(deps());
    const before = await opened.db.select().from(statLines);

    const second = await runRefresh(deps());
    expect(second.statLinesInserted).toBe(0);
    expect(second.statLinesUpdated).toBe(4);
    const after = await opened.db.select().from(statLines);
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.createdAt)).toEqual(before.map((r) => r.createdAt));
  });

  it("a corrected page updates stats quietly without adding a row", async () => {
    const player = await insertNcaa();
    await runRefresh(deps());

    // Official scorer bumps the HR to 2 on game 6001.
    ncaaApi.options.pages!["2649785:batting"] = makeNcaaGameLogHtml({
      fullName: "College Guy",
      schoolName: "LSU",
      rows: [
        { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 3, HR: 2, RBI: 4 } },
        { date: "2026-03-14", opponentName: "Georgia", isHome: false, contestId: 6002, stats: { AB: 3, H: 1, HR: 0, RBI: 0 } },
      ],
    });
    await runRefresh(deps());

    const line = (
      await opened.db
        .select()
        .from(statLines)
        .where(eq(statLines.playerId, player.id))
    ).find((l) => l.gameId === 6001 && l.statType === "batting");
    expect((line?.stats as Record<string, unknown>).homeRuns).toBe(2);
    const all = await opened.db.select().from(statLines).where(eq(statLines.playerId, player.id));
    expect(all).toHaveLength(4); // no new row from the correction
  });

  it("refreshes the school when the page shows a transfer", async () => {
    const player = await insertNcaa();
    await runRefresh(deps());

    ncaaApi.options.pages = {
      "2649785:batting": battingPage("College Guy", "Texas"),
      "2649785:pitching": pitchingPage("College Guy", "Texas"),
      "2649785:fielding": fieldingPage("College Guy", "Texas"),
    };
    await runRefresh(deps());

    const row = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
    expect(row?.schoolName).toBe("Texas");
    // Still ONE player row — a transfer changes the row, never creates a second.
    expect(await opened.db.select().from(players)).toHaveLength(1);
  });

  it("makes ZERO NCAA calls during Offseason Sleep", async () => {
    await insertNcaa();
    await insertCalendars2026(opened.db);
    // Seed the NCAA calendar so the sleep math sees NCAA is over by December.
    await insertCalendar(opened.db, {
      sportId: 22,
      season: "2026",
      regularSeasonStart: "2026-02-13",
      regularSeasonEnd: "2026-06-22",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    clock.set("2026-12-05T18:00:00Z");

    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(true);
    expect(ncaaApi.calls).toHaveLength(0);
  });

  it("leaves the MLB path untouched in a mixed watch list", async () => {
    await insertNcaa();
    await insertPlayer(opened.db, { externalId: 691185, level: "milb", milbLevel: "Triple-A" });
    api.options.gameLogs = {
      "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]),
    };

    const summary = await runRefresh(deps());
    expect(summary.playersRefreshed).toBe(2);
    // The MLB player's Stats API line landed alongside the NCAA lines.
    const mlbLine = (await opened.db.select().from(statLines)).find((l) => l.gameId === 900001);
    expect(mlbLine?.sportId).toBe(11);
    // NCAA calls hit only the NCAA client; MLB game logs hit only the Stats API.
    expect(ncaaApi.callsMatching(/game_by_game/).length).toBeGreaterThan(0);
    expect(api.callsMatching(/stats=gameLog/).length).toBeGreaterThan(0);
  });

  it("skips NCAA ingest (no HTTP) when the season is not bundled", async () => {
    await insertNcaa();
    clock.set("2099-03-15T17:00:00Z"); // no bundled 2099 season
    const summary = await runRefresh(deps());
    expect(summary.playersRefreshed).toBe(0);
    expect(ncaaApi.calls).toHaveLength(0);
    expect(await opened.db.select().from(statLines)).toHaveLength(0);
  });

  it("stops scraping after the NCAA season ends while MLB keeps the pipeline awake (#15)", async () => {
    await insertNcaa();
    // A watched MLB player keeps the pipeline genuinely awake (not just the
    // no-watched-openings fail-open path); externalId null → refresh skips him
    // with zero Stats API calls, so no MLB fixtures are needed.
    await insertPlayer(opened.db, { fullName: "Awake Anchor", level: "mlb", externalId: null });
    await insertCalendars2026(opened.db); // MLB in season through the fall — pipeline awake
    // Bundled 2026 NCAA end is 2026-06-22; grace runs through 2026-06-29.
    clock.set("2026-08-15T17:00:00Z");

    const summary = await runRefresh(deps());
    expect(summary.skipped).toBe(false); // the pipeline itself is awake
    expect(summary.playersRefreshed).toBe(0);
    expect(ncaaApi.calls).toHaveLength(0);
    expect(await opened.db.select().from(statLines)).toHaveLength(0);
  });

  it("keeps scraping through the post-season grace window, then stops at its boundary", async () => {
    await insertNcaa();
    // Same awake-anchor as above: a watched MLB player (skipped by refresh via
    // null externalId) keeps the pipeline awake on its own merits.
    await insertPlayer(opened.db, { fullName: "Awake Anchor", level: "mlb", externalId: null });
    await insertCalendars2026(opened.db);

    // Last grace day (end 2026-06-22 + 7): still fetching for late corrections.
    clock.set("2026-06-29T17:00:00Z");
    const inGrace = await runRefresh(deps());
    expect(inGrace.playersRefreshed).toBe(1);
    expect(ncaaApi.calls.length).toBeGreaterThan(0);

    // One day past the grace window: zero NCAA HTTP.
    ncaaApi.calls.length = 0;
    clock.set("2026-06-30T17:00:00Z");
    const pastGrace = await runRefresh(deps());
    expect(pastGrace.playersRefreshed).toBe(0);
    expect(ncaaApi.calls).toHaveLength(0);
  });

  it("digest renders ingested NCAA lines with real numbers, not zeros", async () => {
    await insertNcaa();
    await runRefresh(deps());

    const mailer = new CapturingMailer();
    const digestDeps: DigestDeps = {
      db: opened.db,
      mailer,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
      // A 7d window covers both scraped game dates; 1d would see only one.
      spec: "7d",
    };
    await runDigest(digestDeps);

    expect(mailer.sent).toHaveLength(1);
    const text = mailer.sent[0]!.text;
    const cells = (startsWith: string, from = 0): string[] =>
      (text.slice(from).split("\n").find((l) => l.startsWith(startsWith)) ?? "")
        .trim()
        .split(/\s+/);

    // Regression: the scraped AB/H/HR/E headers must reach the aggregate as
    // canonical keys, PA is derived at ingest (no PA column on the page), and
    // the game 6001 fielding row's E merges into the batting row (ADR 0033) —
    // one batting row for two games, never a third fielding row.
    // KNOWN GAP, pinned deliberately: SLG is .000 because the stats.ncaa.org
    // game log carries no totalBases column, so there is nothing to sum. AVG
    // and OBP are right; SLG and OPS are not derivable for an NCAA row until
    // src/ncaa/normalize.ts computes total bases at ingest. The windowed-digest
    // design puts NCAA aggregation out of scope for this iteration, and the old
    // prose format hid this by never showing a slash line at all.
    expect(cells("C Guy").slice(0, 8)).toEqual(["C", "Guy", "NCAA", "2", ".429/.429/.000", "7", "3", "0"]);
    expect(cells("C Guy").slice(-1)).toEqual(["1"]); // E, merged from fielding
    expect(cells("C Guy", text.indexOf("Pitchers"))).toEqual(
      ["C", "Guy", "NCAA", "1", "6.0", "1", "8", "12.00", "2", "4", "0", "1.50", "1.00", "0", "0", "1"],
    );
    expect(text.split("\n").filter((l) => l.startsWith("C Guy"))).toHaveLength(2);
  });
});
