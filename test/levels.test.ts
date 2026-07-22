import { describe, expect, it } from "vitest";
import { levelAbbrev, levelRank, SPORT_IDS, NCAA_SPORT_ID } from "../src/mlb/levels.js";

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
  it("orders MLB first and NCAA last with strictly increasing ranks", () => {
    const ladder = [1, 11, 12, 13, 14, 16, 22];
    const ranks = ladder.map(levelRank);
    // Verify strictly increasing order across all adjacent pairs
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]!).toBeLessThan(ranks[i + 1]!);
    }
  });

  it("sorts an unknown sport id last", () => {
    expect(levelRank(999)).toBeGreaterThan(levelRank(22));
  });

  it("ensures every sportId in SPORT_IDS and NCAA_SPORT_ID has a valid abbreviation and rank", () => {
    const unknownRank = levelRank(999); // The rank assigned to unknown ids

    // Test SPORT_IDS entries
    for (let i = 0; i < SPORT_IDS.length; i++) {
      const sportId = SPORT_IDS[i]!;
      const abbrev =
        sportId === 16
          ? levelAbbrev(sportId, "Arizona Complex League")
          : levelAbbrev(sportId, null);
      expect(abbrev).not.toBe("?");
      expect(levelRank(sportId)).toBeLessThan(unknownRank);
    }

    // Test NCAA_SPORT_ID
    expect(levelAbbrev(NCAA_SPORT_ID, null)).not.toBe("?");
    expect(levelRank(NCAA_SPORT_ID)).toBeLessThan(unknownRank);
  });
});
