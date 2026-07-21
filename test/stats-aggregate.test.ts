import { describe, expect, it } from "vitest";
import { aggregate } from "../src/stats/aggregate.js";

describe("aggregate — counters", () => {
  it("sums counting stats across games and counts games", () => {
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4, homeRuns: 1, rbi: 2 },
      { hits: 0, atBats: 4, homeRuns: 0, rbi: 0 },
    ]);
    expect(agg.games).toBe(2);
    expect(agg.counters.hits).toBe(3);
    expect(agg.counters.atBats).toBe(8);
    expect(agg.counters.homeRuns).toBe(1);
    expect(agg.counters.rbi).toBe(2);
  });

  it("treats a missing or non-numeric counter as zero", () => {
    const agg = aggregate("batting", [{ hits: 2 }, { hits: "-", atBats: 3 }]);
    expect(agg.counters.hits).toBe(2);
    expect(agg.counters.atBats).toBe(3);
  });

  it("returns zeroed counters and zero games for an empty set", () => {
    const agg = aggregate("batting", []);
    expect(agg.games).toBe(0);
    expect(agg.counters.hits).toBe(0);
    expect(agg.counters.atBats).toBe(0);
  });

  it("never sums a rate field into counters", () => {
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4, avg: ".750" },
      { hits: 0, atBats: 4, avg: ".000" },
    ]);
    expect(agg.counters.avg).toBeUndefined();
  });

  it("excludes unknown fields and reports them", () => {
    const agg = aggregate("batting", [{ hits: 1, atBats: 3, warpDrive: 9 }]);
    expect(agg.counters.warpDrive).toBeUndefined();
    expect(agg.unknownFields).toEqual(["warpDrive"]);
  });
});

describe("aggregate — innings are outs-based", () => {
  it("sums baseball notation through outs, not arithmetic", () => {
    // 6.1 + 6.1 = 12.2 in baseball (19 + 19 = 38 outs = 12 2/3).
    const agg = aggregate("pitching", [{ inningsPitched: "6.1" }, { inningsPitched: "6.1" }]);
    expect(agg.outs).toBe(38);
  });

  it("sums thirds that carry into a whole inning", () => {
    // 0.2 + 0.2 = 1.1, not 0.4.
    const agg = aggregate("pitching", [{ inningsPitched: "0.2" }, { inningsPitched: "0.2" }]);
    expect(agg.outs).toBe(4);
  });

  it("treats unparseable innings as zero outs", () => {
    const agg = aggregate("pitching", [{ inningsPitched: "-" }, { inningsPitched: "1.0" }]);
    expect(agg.outs).toBe(3);
  });

  it("leaves outs null for batting, which has no innings concept", () => {
    expect(aggregate("batting", [{ hits: 1 }]).outs).toBeNull();
  });
});
