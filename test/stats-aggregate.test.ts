import { describe, expect, it } from "vitest";
import { aggregate, deriveAllRates, deriveRate } from "../src/stats/aggregate.js";
import { rateKeys } from "../src/stats/fields.js";

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

describe("deriveRate — derived from sums, never averaged", () => {
  it("computes avg from summed hits and at-bats", () => {
    // 3-for-4 then 0-for-1. Correct: 3/5 = .600.
    // Averaging game AVGs gives (.750 + .000)/2 = .375 — the bug this prevents.
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4 },
      { hits: 0, atBats: 1 },
    ]);
    expect(deriveRate(agg, "avg")).toBe(".600");
  });

  it("computes obp including walks, hit-by-pitch and sac flies", () => {
    // (H 4 + BB 2 + HBP 1) / (AB 10 + BB 2 + HBP 1 + SF 1) = 7/14 = .500
    const agg = aggregate("batting", [
      { hits: 4, atBats: 10, baseOnBalls: 2, hitByPitch: 1, sacFlies: 1 },
    ]);
    expect(deriveRate(agg, "obp")).toBe(".500");
  });

  it("computes slg from total bases and ops as obp plus slg", () => {
    const agg = aggregate("batting", [{ hits: 4, atBats: 10, totalBases: 8 }]);
    expect(deriveRate(agg, "slg")).toBe(".800");
    expect(deriveRate(agg, "ops")).toBe("1.200"); // .400 obp + .800 slg
  });

  it("computes era and whip from summed outs, not per-game averages", () => {
    // 13 outs total (6.1 IP), 4 ER → 4 * 27 / 13 = 8.31
    const agg = aggregate("pitching", [
      { inningsPitched: "4.0", earnedRuns: 3, hits: 5, baseOnBalls: 1 },
      { inningsPitched: "2.1", earnedRuns: 1, hits: 2, baseOnBalls: 2 },
    ]);
    expect(agg.outs).toBe(19);
    expect(deriveRate(agg, "era")).toBe("5.68"); // 4 * 27 / 19
    expect(deriveRate(agg, "whip")).toBe("1.58"); // (7 + 3) * 3 / 19
  });

  it("computes strikeouts per nine from summed outs", () => {
    const agg = aggregate("pitching", [{ inningsPitched: "9.0", strikeOuts: 10 }]);
    expect(deriveRate(agg, "strikeoutsPer9Inn")).toBe("10.00");
  });

  it("computes pitches per SINGLE inning, not per nine", () => {
    // 100 pitches over 9.0 IP (27 outs) = 100 / 9 = 11.11 pitches/inning.
    // A per-9 formula (numerator * 27 / outs) would wrongly return 100.00 here
    // — the raw pitch count, unchanged — because outs happens to equal 27.
    const agg = aggregate("pitching", [{ inningsPitched: "9.0", numberOfPitches: 100 }]);
    expect(deriveRate(agg, "pitchesPerInning")).toBe("11.11");
  });

  it("returns '-' when the denominator is zero", () => {
    const empty = aggregate("batting", []);
    expect(deriveRate(empty, "avg")).toBe("-");
    expect(deriveRate(aggregate("pitching", []), "era")).toBe("-");
  });

  it("derives every rate key the classification declares", () => {
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", earnedRuns: 2, hits: 5, baseOnBalls: 1, strikeOuts: 7, wins: 1 },
    ]);
    const rates = deriveAllRates(agg);
    for (const key of ["era", "whip", "strikeoutsPer9Inn", "walksPer9Inn", "winPercentage"]) {
      expect(rates[key]).toBeDefined();
      expect(rates[key]).not.toBe("");
    }
  });
});

describe("every declared rate key has a formula", () => {
  it("derives a non-'-' value for each rate given non-zero denominators", () => {
    const inputs = {
      batting: {
        hits: 4,
        atBats: 10,
        totalBases: 8,
        baseOnBalls: 2,
        hitByPitch: 1,
        sacFlies: 1,
        homeRuns: 1,
        strikeOuts: 2,
        stolenBases: 2,
        caughtStealing: 1,
        groundOuts: 4,
        airOuts: 3,
      },
      pitching: {
        inningsPitched: "9.0",
        earnedRuns: 3,
        hits: 6,
        baseOnBalls: 2,
        strikeOuts: 9,
        homeRuns: 1,
        runs: 4,
        numberOfPitches: 100,
        strikes: 65,
        wins: 1,
        losses: 1,
        atBats: 30,
        totalBases: 9,
        hitByPitch: 1,
        sacFlies: 1,
        stolenBases: 1,
        caughtStealing: 1,
        groundOuts: 5,
        airOuts: 4,
      },
      fielding: {
        innings: "9.0",
        putOuts: 5,
        assists: 3,
        errors: 1,
        stolenBases: 1,
        caughtStealing: 1,
      },
    } as const;

    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const agg = aggregate(statType, [inputs[statType]]);
      for (const key of rateKeys(statType)) {
        expect(deriveRate(agg, key), `${statType}.${key}`).not.toBe("-");
      }
    }
  });
});
