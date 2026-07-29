import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { seasonCalendar } from "../src/db/schema.js";
import type { CalendarEntry, WatchedLevel } from "../src/domain/season.js";
import { hostDate, hostHour, isInSeason, sleepWindow } from "../src/domain/season.js";
import type { RefreshDeps } from "../src/jobs/refresh.js";
import { refreshNcaaCalendar } from "../src/jobs/refresh.js";
import { MlbClient } from "../src/mlb/client.js";
import { NCAA_SPORT_ID } from "../src/mlb/levels.js";
import {
  FakeStatsApi,
  TEST_TZ,
  fakeClock,
  insertPlayer,
  testDb,
} from "./factories.js";

/** Calendars mirroring the real captured 2026 season fixtures. */
const MLB_2026: CalendarEntry = {
  sportId: 1,
  season: "2026",
  regularSeasonStart: "2026-03-25",
  regularSeasonEnd: "2026-09-27",
  postSeasonStart: "2026-09-28",
  postSeasonEnd: "2026-10-31",
  springStart: "2026-02-20",
  springEnd: "2026-03-24",
};

const AAA_2026: CalendarEntry = {
  sportId: 11,
  season: "2026",
  regularSeasonStart: "2026-03-27",
  regularSeasonEnd: "2026-09-20",
  postSeasonStart: "2026-09-22",
  postSeasonEnd: "2026-09-27",
  springStart: null,
  springEnd: null,
};

const NCAA_2026: CalendarEntry = {
  sportId: NCAA_SPORT_ID,
  season: "2026",
  regularSeasonStart: "2026-02-13",
  regularSeasonEnd: "2026-05-25",
  postSeasonStart: "2026-05-29",
  postSeasonEnd: "2026-06-22",
  springStart: null,
  springEnd: null,
};

const CALENDARS = [MLB_2026, AAA_2026];

const MLB_PLAYER: WatchedLevel = { level: "mlb", milbLevel: null };
const AAA_PLAYER: WatchedLevel = { level: "milb", milbLevel: "Triple-A" };
const NCAA_PLAYER: WatchedLevel = { level: "ncaa", milbLevel: null };

/** Noon Chicago time on the given date. */
const chicagoNoon = (date: string): Date => new Date(`${date}T17:00:00Z`);

describe("hostDate", () => {
  it("renders the date in the host timezone, not UTC", () => {
    // 03:00 UTC is still the previous evening in Chicago.
    expect(hostDate(new Date("2026-07-20T03:00:00Z"), TEST_TZ)).toBe("2026-07-19");
    expect(hostDate(new Date("2026-07-20T18:00:00Z"), TEST_TZ)).toBe("2026-07-20");
  });
});

describe("hostHour (#193)", () => {
  /**
   * AN UNTESTED GUARD IS NOT A GUARD (#193 self-review, MEDIUM 2). Before this
   * case, mutating `hourCycle: "h23"` to `"h24"` left the whole suite GREEN: every
   * test that reached `hostHour` did so at 12:00 America/Chicago, where both
   * cycles format `12`, and the offseason cases return before `hostHour` is
   * called at all. On a real host at 00:15 the mutant returns 24, and
   * `digestIsDue(24, h, false)` is TRUE for every legal `digest_hour` (the column
   * CHECKs 0-23) — so every scheduled lane would fire at midnight, every night.
   *
   * The whole day is walked rather than a sampled few: midnight is the mutant's
   * only divergence, and a table that happened to omit it would read as coverage
   * while pinning nothing.
   */
  it("returns 0-23 in the host timezone, across every hour of the day", () => {
    // July: America/Chicago is CDT (UTC-5), so host hour H is 05:00Z + H.
    for (let hour = 0; hour <= 23; hour += 1) {
      const utcHour = (hour + 5) % 24;
      const date = hour + 5 >= 24 ? "2026-07-20" : "2026-07-19";
      const at = new Date(`${date}T${String(utcHour).padStart(2, "0")}:30:00Z`);
      expect(hostHour(at, TEST_TZ)).toBe(hour);
    }
  });

  it("never yields 24 for midnight, and never a non-number", () => {
    // The two guards `hostHour` carries, asserted where each one bites.
    // `hourCycle: "h23"` — the h24 cycle renders midnight as 24, out of the
    // range `digest_hour` is CHECKed to and above every legal configured hour.
    expect(hostHour(new Date("2026-07-19T05:00:00Z"), TEST_TZ)).toBe(0);
    expect(hostHour(new Date("2026-07-19T05:59:59Z"), TEST_TZ)).toBe(0);

    // `en-US` pins the NUMBERING SYSTEM: a locale rendering non-Latin digits
    // (e.g. `ar-EG-u-nu-arab` yields `١٢`) makes `Number()` return NaN, and NaN
    // compares false against every `digest_hour`, so a lane would never fire at
    // all. Asserted as a property over the whole day so the mutant cannot hide
    // in an hour the table skipped.
    for (let hour = 0; hour <= 23; hour += 1) {
      const utcHour = (hour + 5) % 24;
      const date = hour + 5 >= 24 ? "2026-07-20" : "2026-07-19";
      const value = hostHour(new Date(`${date}T${String(utcHour).padStart(2, "0")}:30:00Z`), TEST_TZ);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(23);
    }
  });

  it("reads the HOST timezone, not UTC", () => {
    // The negative control: without it every case above would pass against a
    // function that ignored `tz` entirely and formatted UTC.
    expect(hostHour(new Date("2026-07-19T05:00:00Z"), TEST_TZ)).toBe(0);
    expect(hostHour(new Date("2026-07-19T05:00:00Z"), "UTC")).toBe(5);
  });
});

describe("isInSeason", () => {
  it("mid-summer: both MLB and AAA players are In Season", () => {
    const now = chicagoNoon("2026-07-19");
    expect(isInSeason(MLB_PLAYER, CALENDARS, now, TEST_TZ)).toBe(true);
    expect(isInSeason(AAA_PLAYER, CALENDARS, now, TEST_TZ)).toBe(true);
  });

  it("AAA season over while MLB continues: AAA out, MLB still In Season", () => {
    const now = chicagoNoon("2026-10-01");
    expect(isInSeason(AAA_PLAYER, CALENDARS, now, TEST_TZ)).toBe(false);
    expect(isInSeason(MLB_PLAYER, CALENDARS, now, TEST_TZ)).toBe(true);
  });

  it("before opening day nobody is In Season", () => {
    const now = chicagoNoon("2026-03-01");
    expect(isInSeason(MLB_PLAYER, CALENDARS, now, TEST_TZ)).toBe(false);
    expect(isInSeason(AAA_PLAYER, CALENDARS, now, TEST_TZ)).toBe(false);
  });

  it("a player with no calendar for his sport is not In Season", () => {
    expect(isInSeason(NCAA_PLAYER, CALENDARS, chicagoNoon("2026-07-19"), TEST_TZ)).toBe(false);
  });
});

describe("sleepWindow boundaries (ADR 0031)", () => {
  const watched = [MLB_PLAYER];

  it("day before the World Series ends: awake", () => {
    expect(sleepWindow(CALENDARS, watched, chicagoNoon("2026-10-30"), TEST_TZ).sleeping).toBe(false);
  });

  it("day the World Series ends: still awake", () => {
    expect(sleepWindow(CALENDARS, watched, chicagoNoon("2026-10-31"), TEST_TZ).sleeping).toBe(false);
  });

  it("day after the World Series ends: sleeping", () => {
    expect(sleepWindow(CALENDARS, watched, chicagoNoon("2026-11-01"), TEST_TZ).sleeping).toBe(true);
  });

  it("day before MLB opening day: sleeping", () => {
    expect(sleepWindow(CALENDARS, watched, chicagoNoon("2026-03-24"), TEST_TZ).sleeping).toBe(true);
  });

  it("MLB opening day: awake", () => {
    expect(sleepWindow(CALENDARS, watched, chicagoNoon("2026-03-25"), TEST_TZ).sleeping).toBe(false);
  });

  it("spring training NEVER wakes the pipeline", () => {
    // 2026-03-01 is inside MLB spring (starts 2026-02-20) but before opening day.
    const state = sleepWindow(CALENDARS, watched, chicagoNoon("2026-03-01"), TEST_TZ);
    expect(state.sleeping).toBe(true);
    expect(state.nextOpeningDay).toBe("2026-03-25");
  });

  it("an NCAA watch wakes the pipeline mid-February while MLB-only still sleeps", () => {
    const calendars = [...CALENDARS, NCAA_2026];
    const now = chicagoNoon("2026-02-20");
    expect(sleepWindow(calendars, [MLB_PLAYER], now, TEST_TZ).sleeping).toBe(true);
    expect(sleepWindow(calendars, [MLB_PLAYER, NCAA_PLAYER], now, TEST_TZ).sleeping).toBe(false);
  });

  it("AAA-only watch still sleeps until the AAA opening day", () => {
    // AAA opens 03-27; on 03-26 an AAA-only watch list is still asleep.
    expect(sleepWindow(CALENDARS, [AAA_PLAYER], chicagoNoon("2026-03-26"), TEST_TZ).sleeping).toBe(
      true,
    );
    expect(sleepWindow(CALENDARS, [AAA_PLAYER], chicagoNoon("2026-03-27"), TEST_TZ).sleeping).toBe(
      false,
    );
  });

  it("AAA player after the AAA season but before WS end: pipeline stays awake (sleep anchors on WS end)", () => {
    const state = sleepWindow(CALENDARS, [AAA_PLAYER, MLB_PLAYER], chicagoNoon("2026-10-01"), TEST_TZ);
    expect(state.sleeping).toBe(false);
  });

  it("fails open (awake) with no calendar data for the current year", () => {
    expect(sleepWindow([], watched, chicagoNoon("2026-07-19"), TEST_TZ).sleeping).toBe(false);
    // New calendar year, only last year's calendar cached: awake so Refresh can fetch it.
    const jan2027 = new Date("2027-01-05T18:00:00Z");
    expect(sleepWindow(CALENDARS, watched, jan2027, TEST_TZ).sleeping).toBe(false);
  });

  it("no watched players: never sleeping (empty digest is proof of life)", () => {
    expect(sleepWindow(CALENDARS, [], chicagoNoon("2026-12-05"), TEST_TZ).sleeping).toBe(false);
  });

  it("reports the next opening day while sleeping, null when unpublished", () => {
    const dec = new Date("2026-12-05T18:00:00Z");
    const unpublished = sleepWindow(CALENDARS, watched, dec, TEST_TZ);
    expect(unpublished.sleeping).toBe(true);
    expect(unpublished.nextOpeningDay).toBeNull();

    const withNext = sleepWindow(
      [
        ...CALENDARS,
        { ...MLB_2026, season: "2027", regularSeasonStart: "2027-03-30", regularSeasonEnd: "2027-10-03", postSeasonEnd: "2027-11-01" },
      ],
      watched,
      dec,
      TEST_TZ,
    );
    expect(withNext.nextOpeningDay).toBe("2027-03-30");
  });
});

describe("refreshNcaaCalendar (ADR 0032)", () => {
  let opened: OpenedDb;

  const deps = (now: string): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: new FakeStatsApi().fetch, delayMs: 0 }),
    now: fakeClock(now).now,
    tz: TEST_TZ,
  });

  const ncaaRow = () =>
    opened.db.select().from(seasonCalendar).where(eq(seasonCalendar.sportId, NCAA_SPORT_ID));

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("upserts the sportId 22 row from bundled dates when an NCAA player is watched", async () => {
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });
    await refreshNcaaCalendar(deps("2026-03-15T17:00:00Z"), "2026", [ncaa]);

    const rows = await ncaaRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.regularSeasonStart).toBe("2026-02-13");
    expect(rows[0]?.regularSeasonEnd).toBe("2026-06-22");
    expect(rows[0]?.postSeasonEnd).toBeNull();
  });

  it("writes no NCAA row when no NCAA player is watched", async () => {
    const mlb = await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await refreshNcaaCalendar(deps("2026-03-15T17:00:00Z"), "2026", [mlb]);
    expect(await ncaaRow()).toHaveLength(0);
  });

  it("writes no NCAA row for a season with no bundled lookup", async () => {
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });
    await refreshNcaaCalendar(deps("2099-03-15T17:00:00Z"), "2099", [ncaa]);
    expect(await ncaaRow()).toHaveLength(0);
  });
});
