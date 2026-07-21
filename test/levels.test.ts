import { describe, expect, it } from "vitest";
import { levelAbbrev, levelRank } from "../src/mlb/levels.js";

describe("levelAbbrev", () => {
  it("abbreviates each rung of the ladder", () => {
    expect(levelAbbrev(1, "National League")).toBe("MLB");
    expect(levelAbbrev(11, "International League")).toBe("AAA");
    expect(levelAbbrev(12, "Southern League")).toBe("AA");
    expect(levelAbbrev(13, "South Atlantic League")).toBe("A+");
    expect(levelAbbrev(14, "Florida State League")).toBe("A");
    expect(levelAbbrev(22, null)).toBe("NCAA");
  });

  it("separates the Dominican Summer League from domestic complex leagues", () => {
    // sportId 16 covers every rookie/complex league, so only league_name tells
    // DSL apart from the ACL/FCL.
    expect(levelAbbrev(16, "Dominican Summer League")).toBe("DSL");
    expect(levelAbbrev(16, "Arizona Complex League")).toBe("R");
    expect(levelAbbrev(16, null)).toBe("R");
  });

  it("renders an unknown sport id without throwing", () => {
    expect(levelAbbrev(999, null)).toBe("?");
  });
});

describe("levelRank", () => {
  it("orders MLB first and NCAA last", () => {
    const ladder = [1, 11, 12, 13, 14, 16, 22];
    const ranks = ladder.map(levelRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(levelRank(1)).toBeLessThan(levelRank(11));
    expect(levelRank(16)).toBeLessThan(levelRank(22));
  });

  it("sorts an unknown sport id last", () => {
    expect(levelRank(999)).toBeGreaterThan(levelRank(22));
  });
});
