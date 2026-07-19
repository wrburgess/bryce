import { describe, expect, it } from "vitest";
import type { CalendarEntry, WatchedLevel } from "../src/domain/season.js";
import { hostDate, isInSeason, sleepWindow } from "../src/domain/season.js";
import { NCAA_SPORT_ID } from "../src/mlb/levels.js";
import { TEST_TZ } from "./factories.js";

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
