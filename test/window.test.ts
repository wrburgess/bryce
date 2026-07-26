import { describe, expect, it } from "vitest";
import {
  GAME_COUNT_WINDOW_SPECS,
  WINDOW_SPECS,
  gameCountLimit,
  gameCountTitle,
  isGameCountSpec,
  isLongWindow,
  lastCompletedHostDate,
  parseReportWindowSpec,
  parseWindowSpec,
  resolveWindow,
  shiftDate,
} from "../src/domain/window.js";

const CHICAGO = "America/Chicago";

describe("parseWindowSpec", () => {
  it("accepts every supported spec", () => {
    for (const spec of ["1d", "7d", "14d", "21d", "28d", "35d", "60d", "ytd"]) {
      expect(parseWindowSpec(spec)).toBe(spec);
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(parseWindowSpec("  YTD ")).toBe("ytd");
  });

  it("returns null for anything else so callers fail closed", () => {
    for (const bad of ["", "3d", "30d", "week", "1", "d1"]) {
      expect(parseWindowSpec(bad)).toBeNull();
    }
  });

  it("rejects a game-count token — it is not a date WindowSpec (issue #153)", () => {
    for (const spec of GAME_COUNT_WINDOW_SPECS) {
      expect(parseWindowSpec(spec)).toBeNull();
    }
  });
});

describe("game-count windows (issue #153)", () => {
  it("keeps the game-count tuple disjoint from the date tuple", () => {
    for (const g of GAME_COUNT_WINDOW_SPECS) {
      expect((WINDOW_SPECS as readonly string[]).includes(g)).toBe(false);
    }
    expect(GAME_COUNT_WINDOW_SPECS).toEqual(["last10games", "last30games"]);
  });

  it("isGameCountSpec narrows only the game-count tokens", () => {
    expect(isGameCountSpec("last10games")).toBe(true);
    expect(isGameCountSpec("last30games")).toBe(true);
    for (const d of WINDOW_SPECS) expect(isGameCountSpec(d)).toBe(false);
  });

  it("gameCountLimit and gameCountTitle map to the counts", () => {
    expect(gameCountLimit("last10games")).toBe(10);
    expect(gameCountLimit("last30games")).toBe(30);
    expect(gameCountTitle("last10games")).toBe("Last 10 Games");
    expect(gameCountTitle("last30games")).toBe("Last 30 Games");
  });

  it("parseReportWindowSpec accepts date AND game-count tokens, normalizing, else null", () => {
    for (const spec of [...WINDOW_SPECS, ...GAME_COUNT_WINDOW_SPECS]) {
      expect(parseReportWindowSpec(spec)).toBe(spec);
    }
    expect(parseReportWindowSpec("  LAST10GAMES ")).toBe("last10games");
    for (const bad of ["", "last5games", "10games", "last10"]) {
      expect(parseReportWindowSpec(bad)).toBeNull();
    }
  });

  it("isLongWindow: last30games is long (BB%/K% shown), last10games is not", () => {
    expect(isLongWindow("last30games")).toBe(true);
    expect(isLongWindow("last10games")).toBe(false);
  });

  it("lastCompletedHostDate is yesterday in the host timezone", () => {
    // 2026-07-20 09:00 CDT → the last completed day is July 19.
    expect(lastCompletedHostDate(new Date("2026-07-20T14:00:00Z"), CHICAGO)).toBe("2026-07-19");
    expect(shiftDate("2026-03-09", -6)).toBe("2026-03-03");
  });
});

describe("resolveWindow — anchored on the last completed day", () => {
  // 2026-07-20 14:00 UTC is 09:00 CDT on July 20, so "yesterday" is July 19.
  const morning = new Date("2026-07-20T14:00:00Z");

  it("1d covers yesterday only, grouped by game", () => {
    const w = resolveWindow("1d", morning, CHICAGO);
    expect(w.spec).toBe("1d");
    expect(w.from).toBe("2026-07-19");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("game");
    expect(w.label).toBe("Jul 19");
  });

  it("7d covers the seven days ending yesterday, grouped by player and level", () => {
    const w = resolveWindow("7d", morning, CHICAGO);
    expect(w.spec).toBe("7d");
    expect(w.from).toBe("2026-07-13");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("playerLevel");
    expect(w.label).toBe("Last 7 Days (Jul 13-19)");
  });

  it("14d and 21d span their full inclusive ranges", () => {
    const w14 = resolveWindow("14d", morning, CHICAGO);
    const w21 = resolveWindow("21d", morning, CHICAGO);

    expect(w14.spec).toBe("14d");
    expect(w14.from).toBe("2026-07-06");
    expect(w14.to).toBe("2026-07-19");
    expect(w14.groupBy).toBe("playerLevel");
    expect(w14.label).toBe("Last 14 Days (Jul 6-19)");

    expect(w21.spec).toBe("21d");
    expect(w21.from).toBe("2026-06-29");
    expect(w21.to).toBe("2026-07-19");
    expect(w21.groupBy).toBe("playerLevel");
    expect(w21.label).toBe("Last 21 Days (Jun 29-Jul 19)");
  });

  it("28d, 35d and 60d span their full inclusive ranges", () => {
    const w28 = resolveWindow("28d", morning, CHICAGO);
    const w35 = resolveWindow("35d", morning, CHICAGO);
    const w60 = resolveWindow("60d", morning, CHICAGO);

    expect(w28.spec).toBe("28d");
    expect(w28.from).toBe("2026-06-22"); // 27 days before Jul 19, inclusive
    expect(w28.to).toBe("2026-07-19");
    expect(w28.groupBy).toBe("playerLevel");
    expect(w28.label).toBe("Last 28 Days (Jun 22-Jul 19)");

    expect(w35.spec).toBe("35d");
    expect(w35.from).toBe("2026-06-15"); // 34 days before Jul 19, inclusive
    expect(w35.to).toBe("2026-07-19");
    expect(w35.groupBy).toBe("playerLevel");
    expect(w35.label).toBe("Last 35 Days (Jun 15-Jul 19)");

    expect(w60.spec).toBe("60d");
    expect(w60.from).toBe("2026-05-21"); // 59 days before Jul 19, inclusive
    expect(w60.to).toBe("2026-07-19");
    expect(w60.groupBy).toBe("playerLevel");
    expect(w60.label).toBe("Last 60 Days (May 21-Jul 19)");
  });

  it("ytd runs from the season start through yesterday", () => {
    const w = resolveWindow("ytd", morning, CHICAGO, "2026-03-25");
    expect(w.spec).toBe("ytd");
    expect(w.from).toBe("2026-03-25");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("playerLevel");
    expect(w.label).toBe("Season to Date (Mar 25-Jul 19)");
  });

  it("ytd falls back to January 1 when no season start is known", () => {
    const w = resolveWindow("ytd", morning, CHICAGO, null);
    expect(w.spec).toBe("ytd");
    expect(w.from).toBe("2026-01-01");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("playerLevel");
    expect(w.label).toBe("Season to Date (Jan 1-Jul 19)");
  });
});

describe("resolveWindow — run hour must not shift the window", () => {
  it("resolves identically at 06:00 and 23:00 local on the same date", () => {
    // 11:00Z = 06:00 CDT; 04:00Z next day = 23:00 CDT the same local date.
    // Before the BRYCE_TZ fix the evening case silently advanced a day.
    const early = resolveWindow("7d", new Date("2026-07-20T11:00:00Z"), CHICAGO);
    const late = resolveWindow("7d", new Date("2026-07-21T04:00:00Z"), CHICAGO);
    expect(late).toEqual(early);
    expect(early.to).toBe("2026-07-19");
  });
});

describe("resolveWindow — calendar boundaries", () => {
  it("crosses a month boundary", () => {
    const w = resolveWindow("7d", new Date("2026-08-03T14:00:00Z"), CHICAGO);
    expect(w.spec).toBe("7d");
    expect(w.to).toBe("2026-08-02");
    expect(w.from).toBe("2026-07-27");
    expect(w.groupBy).toBe("playerLevel");
    expect(w.label).toBe("Last 7 Days (Jul 27-Aug 2)");
  });

  it("crosses a year boundary", () => {
    const w = resolveWindow("7d", new Date("2027-01-03T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2027-01-02");
    expect(w.from).toBe("2026-12-27");
  });

  it("crosses the spring-forward DST transition without losing a day", () => {
    // US DST begins 2026-03-08. A 7-day window ending March 9 must start March 3.
    const w = resolveWindow("7d", new Date("2026-03-10T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2026-03-09");
    expect(w.from).toBe("2026-03-03");
  });

  it("crosses the fall-back DST transition without gaining a day", () => {
    // US DST ends 2026-11-01. A 7-day window ending November 2 must start Oct 27.
    const w = resolveWindow("7d", new Date("2026-11-03T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2026-11-02");
    expect(w.from).toBe("2026-10-27");
  });
});

describe("isLongWindow — the >=21d rule that gates BB%/K%", () => {
  it("is false for the short windows", () => {
    for (const spec of ["1d", "7d", "14d"] as const) {
      expect(isLongWindow(spec), spec).toBe(false);
    }
  });

  it("is true for every window >= 21 days, plus ytd", () => {
    for (const spec of ["21d", "28d", "35d", "60d", "ytd"] as const) {
      expect(isLongWindow(spec), spec).toBe(true);
    }
  });

  it("is true for ytd by spec identity, even when its real span is under 21 days", () => {
    // Early in a season ytd's from..to span can be short; it is still a LONG
    // window by identity, so the columns stay uniform across the whole season.
    const w = resolveWindow("ytd", new Date("2026-07-20T14:00:00Z"), CHICAGO, "2026-07-10");
    // The resolved span is only 10 days (Jul 10..Jul 19)...
    expect(w.from).toBe("2026-07-10");
    expect(w.to).toBe("2026-07-19");
    // ...and isLongWindow still returns true.
    expect(isLongWindow(w.spec)).toBe(true);
  });
});
