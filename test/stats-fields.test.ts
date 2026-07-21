import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyField, counterKeys, rateKeys } from "../src/stats/fields.js";

describe("classifyField", () => {
  it("classifies counting stats as counters", () => {
    expect(classifyField("batting", "hits")).toBe("counter");
    expect(classifyField("batting", "atBats")).toBe("counter");
    expect(classifyField("pitching", "earnedRuns")).toBe("counter");
    expect(classifyField("fielding", "putOuts")).toBe("counter");
  });

  it("classifies rate stats as rates, never counters", () => {
    for (const key of ["avg", "obp", "slg", "ops", "babip"]) {
      expect(classifyField("batting", key)).toBe("rate");
    }
    for (const key of ["era", "whip", "strikeoutsPer9Inn", "winPercentage"]) {
      expect(classifyField("pitching", key)).toBe("rate");
    }
    expect(classifyField("fielding", "fielding")).toBe("rate");
  });

  it("classifies baseball-notation innings separately from counters", () => {
    expect(classifyField("pitching", "inningsPitched")).toBe("innings");
    expect(classifyField("fielding", "innings")).toBe("innings");
  });

  it("excludes per-game text and position codes", () => {
    expect(classifyField("batting", "summary")).toBe("excluded");
    expect(classifyField("pitching", "summary")).toBe("excluded");
    expect(classifyField("fielding", "position")).toBe("excluded");
  });

  it("returns null for an unknown key so callers can fail closed", () => {
    expect(classifyField("batting", "warpDriveEfficiency")).toBeNull();
  });

  it("keeps strikeOuts a counter for pitchers as well as batters", () => {
    // Both sides record strikeOuts; it is a counter in both directions.
    expect(classifyField("batting", "strikeOuts")).toBe("counter");
    expect(classifyField("pitching", "strikeOuts")).toBe("counter");
  });
});

describe("classification is exhaustive against real gamelog payloads", () => {
  // This is the test that catches an MLB schema change instead of silently
  // dropping a stat. Fixtures are the real API responses already in the repo.
  const cases: Array<{ fixture: string; statType: "batting" | "pitching" }> = [
    { fixture: "test/fixtures/mlb/gamelog_hitting_aaa.json", statType: "batting" },
    { fixture: "test/fixtures/mlb/gamelog_pitching_mlb.json", statType: "pitching" },
  ];

  for (const { fixture, statType } of cases) {
    it(`classifies every ${statType} key in ${fixture}`, () => {
      const payload: unknown = JSON.parse(readFileSync(fixture, "utf8"));
      const splits = collectSplits(payload);
      expect(splits.length).toBeGreaterThan(0);

      const unclassified = new Set<string>();
      for (const split of splits) {
        for (const key of Object.keys(split)) {
          if (classifyField(statType, key) === null) unclassified.add(key);
        }
      }
      expect([...unclassified]).toEqual([]);
    });
  }
});

/** Pull every `stat` object out of a gameLog payload, whatever its nesting. */
function collectSplits(payload: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const stat = record.stat;
    if (typeof stat === "object" && stat !== null && !Array.isArray(stat)) {
      out.push(stat as Record<string, unknown>);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  return out;
}

describe("key accessors", () => {
  it("counterKeys and rateKeys are disjoint", () => {
    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const counters = new Set(counterKeys(statType));
      for (const rate of rateKeys(statType)) expect(counters.has(rate)).toBe(false);
    }
  });
});
