import { describe, expect, it } from "vitest";
import { parseWindowSpec, resolveWindow } from "../src/domain/window.js";

const CHICAGO = "America/Chicago";

describe("parseWindowSpec", () => {
  it("accepts every supported spec", () => {
    for (const spec of ["1d", "7d", "14d", "21d", "ytd"]) {
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
});

describe("resolveWindow — anchored on the last completed day", () => {
  // 2026-07-20 14:00 UTC is 09:00 CDT on July 20, so "yesterday" is July 19.
  const morning = new Date("2026-07-20T14:00:00Z");

  it("1d covers yesterday only, grouped by game", () => {
    const w = resolveWindow("1d", morning, CHICAGO);
    expect(w.from).toBe("2026-07-19");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("game");
  });

  it("7d covers the seven days ending yesterday, grouped by player and level", () => {
    const w = resolveWindow("7d", morning, CHICAGO);
    expect(w.from).toBe("2026-07-13");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("playerLevel");
  });

  it("14d and 21d span their full inclusive ranges", () => {
    expect(resolveWindow("14d", morning, CHICAGO).from).toBe("2026-07-06");
    expect(resolveWindow("21d", morning, CHICAGO).from).toBe("2026-06-29");
  });

  it("ytd runs from the season start through yesterday", () => {
    const w = resolveWindow("ytd", morning, CHICAGO, "2026-03-25");
    expect(w.from).toBe("2026-03-25");
    expect(w.to).toBe("2026-07-19");
  });

  it("ytd falls back to January 1 when no season start is known", () => {
    expect(resolveWindow("ytd", morning, CHICAGO, null).from).toBe("2026-01-01");
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
    expect(w.to).toBe("2026-08-02");
    expect(w.from).toBe("2026-07-27");
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
