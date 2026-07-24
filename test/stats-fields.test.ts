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
    expect(classifyField("fielding", "caughtStealingPercentage")).toBe("rate");
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

  it("classifies the ADR 0033 merged fielding-errors key for batters", () => {
    // No hitting-gamelog fixture carries "errors" (it's merged in from the
    // same game's fielding row), so neither the unit tests above nor the
    // exhaustiveness suite below exercises this key without this assertion.
    expect(classifyField("batting", "errors")).toBe("counter");
  });

  it("returns null instead of a prototype method for inherited property names", () => {
    // A plain object literal's lookups fall through to Object.prototype, so
    // TABLES[statType][key] would return a function (not null) for these
    // keys unless classifyField guards with Object.hasOwn. Any of these
    // ever appearing as a real gamelog stat key would silently defeat the
    // "unknown keys fail closed" contract every caller relies on.
    for (const key of [
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ]) {
      expect(classifyField("batting", key)).toBeNull();
      expect(classifyField("pitching", key)).toBeNull();
      expect(classifyField("fielding", key)).toBeNull();
    }
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
  it("counterKeys and rateKeys return the expected keys", () => {
    expect(counterKeys("batting")).toContain("hits");
    expect(counterKeys("batting")).not.toContain("avg");
    expect(rateKeys("batting")).toContain("avg");
    expect(rateKeys("batting")).not.toContain("hits");
  });

  it("counterKeys and rateKeys are disjoint", () => {
    // Disjointness is also guaranteed by construction (each table is a
    // Record<string, FieldClass>, so a key maps to exactly one class) and
    // cannot fail from a table edit alone. It guards a future refactor that
    // splits the single table into separate counter/rate arrays, where that
    // guarantee would no longer be automatic.
    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const counters = counterKeys(statType);
      const rates = rateKeys(statType);
      expect(counters.length).toBeGreaterThan(0);
      expect(rates.length).toBeGreaterThan(0);
      const counterSet = new Set(counters);
      for (const rate of rates) expect(counterSet.has(rate)).toBe(false);
    }
  });
});
