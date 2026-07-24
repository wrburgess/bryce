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
    // Game 1: (4 H + 2 BB + 1 HBP) / (10 AB + 2 BB + 1 HBP + 1 SF) = 7/14 = .500
    // Game 2: (1 H + 0 BB + 0 HBP) / (4 AB + 0 BB + 0 HBP + 0 SF) = 1/4 = .250
    // Summed: (5 H + 2 BB + 1 HBP) / (14 AB + 2 BB + 1 HBP + 1 SF) = 8/18 = .44444 → .444
    // Averaging the two per-game OBPs gives (.500 + .250) / 2 = .375 — wrong.
    const agg = aggregate("batting", [
      { hits: 4, atBats: 10, baseOnBalls: 2, hitByPitch: 1, sacFlies: 1 },
      { hits: 1, atBats: 4 },
    ]);
    expect(deriveRate(agg, "obp")).toBe(".444");
  });

  it("computes slg from summed total bases and at-bats, and ops as summed obp plus slg", () => {
    // Game 1: SLG 8/10 = .800; OBP 4/10 = .400 (no BB/HBP/SF) → per-game OPS 1.200
    // Game 2: SLG 1/5 = .200; OBP 1/5 = .200 → per-game OPS 0.400
    // Summed: SLG 9/15 = .600; OBP 5/15 = .33333; OPS = .33333 + .600 = .93333 → .933
    // Averaging per-game SLG gives (.800 + .200) / 2 = .500 — wrong.
    // Averaging per-game OPS gives (1.200 + .400) / 2 = .800 — wrong.
    const agg = aggregate("batting", [
      { hits: 4, atBats: 10, totalBases: 8 },
      { hits: 1, atBats: 5, totalBases: 1 },
    ]);
    expect(deriveRate(agg, "slg")).toBe(".600");
    expect(deriveRate(agg, "ops")).toBe(".933");
  });

  it("computes era and whip from summed outs, not per-game averages", () => {
    // 12 + 7 = 19 outs total (4.0 IP + 2.1 IP), 4 ER → 4 * 27 / 19 = 5.68
    const agg = aggregate("pitching", [
      { inningsPitched: "4.0", earnedRuns: 3, hits: 5, baseOnBalls: 1 },
      { inningsPitched: "2.1", earnedRuns: 1, hits: 2, baseOnBalls: 2 },
    ]);
    expect(agg.outs).toBe(19);
    expect(deriveRate(agg, "era")).toBe("5.68"); // 4 * 27 / 19
    expect(deriveRate(agg, "whip")).toBe("1.58"); // (7 + 3) * 3 / 19
  });

  it("computes strikeoutsPer9Inn from summed strikeouts and summed outs", () => {
    // Game 1: 18 outs (6.0 IP), 12 K → 12 * 27 / 18 = 18.00
    // Game 2: 12 outs (4.0 IP), 2 K → 2 * 27 / 12 = 4.50
    // Summed: 30 outs, 14 K → 14 * 27 / 30 = 12.60
    // Averaging the two per-game rates gives (18.00 + 4.50) / 2 = 11.25 — wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", strikeOuts: 12 },
      { inningsPitched: "4.0", strikeOuts: 2 },
    ]);
    expect(deriveRate(agg, "strikeoutsPer9Inn")).toBe("12.60");
  });

  it("computes pitches per SINGLE inning, not per nine", () => {
    // Game 1: 18 outs (6.0 IP), 90 pitches → 90 * 3 / 18 = 15.00 per inning
    //   (a per-9 formula would wrongly give 90 * 27 / 18 = 135.00)
    // Game 2: 12 outs (4.0 IP), 40 pitches → 40 * 3 / 12 = 10.00 per inning
    //   (per-9 would wrongly give 40 * 27 / 12 = 90.00)
    // Summed: 30 outs, 130 pitches → 130 * 3 / 30 = 13.00
    //   A per-9 formula on the summed totals would wrongly give 130 * 27 / 30 = 117.00.
    // Averaging the two correct per-game rates gives (15.00 + 10.00) / 2 = 12.50 — also wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", numberOfPitches: 90 },
      { inningsPitched: "4.0", numberOfPitches: 40 },
    ]);
    expect(deriveRate(agg, "pitchesPerInning")).toBe("13.00");
  });

  it("returns '-' when the denominator is zero", () => {
    const empty = aggregate("batting", []);
    expect(deriveRate(empty, "avg")).toBe("-");
    expect(deriveRate(aggregate("pitching", []), "era")).toBe("-");
  });

  it("derives every rate key the classification declares, via deriveAllRates", () => {
    // Game 1: 18 outs (6.0 IP), 2 ER, 5 H, 1 BB, 7 K, 1 W, 0 L
    // Game 2: 12 outs (4.0 IP), 3 ER, 3 H, 3 BB, 3 K, 0 W, 1 L
    // Summed: 30 outs, 5 ER, 8 H, 4 BB, 10 K, 1 W, 1 L
    // era = 5 * 27 / 30 = 4.50
    // whip = (4 BB + 8 H) * 3 / 30 = 1.20
    // strikeoutsPer9Inn = 10 * 27 / 30 = 9.00
    // walksPer9Inn = 4 * 27 / 30 = 3.60
    // winPercentage = 1 / (1 + 1) = .500
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", earnedRuns: 2, hits: 5, baseOnBalls: 1, strikeOuts: 7, wins: 1 },
      { inningsPitched: "4.0", earnedRuns: 3, hits: 3, baseOnBalls: 3, strikeOuts: 3, losses: 1 },
    ]);
    const rates = deriveAllRates(agg);
    expect(rates.era).toBe("4.50");
    expect(rates.whip).toBe("1.20");
    expect(rates.strikeoutsPer9Inn).toBe("9.00");
    expect(rates.walksPer9Inn).toBe("3.60");
    expect(rates.winPercentage).toBe(".500");
  });
});

describe("deriveRate — batting-only rates", () => {
  it("computes babip from summed hits, homeRuns, atBats, strikeOuts and sacFlies", () => {
    // Game 1: (6 H - 1 HR) / (15 AB - 3 K - 1 HR + 1 SF) = 5/12 = .41667
    // Game 2: (2 H - 0 HR) / (6 AB - 1 K - 0 HR + 0 SF) = 2/5 = .40000
    // Summed:  (8 H - 1 HR) / (21 AB - 4 K - 1 HR + 1 SF) = 7/17 = .41176 → .412
    // Averaging the two per-game BABIPs gives (.41667 + .40000) / 2 = .40833 (.408) — wrong.
    const agg = aggregate("batting", [
      { hits: 6, atBats: 15, strikeOuts: 3, homeRuns: 1, sacFlies: 1 },
      { hits: 2, atBats: 6, strikeOuts: 1, homeRuns: 0, sacFlies: 0 },
    ]);
    expect(deriveRate(agg, "babip")).toBe(".412");
  });

  it("computes atBatsPerHomeRun from summed at-bats and home runs", () => {
    // Game 1: 40 AB / 2 HR = 20.00; Game 2: 9 AB / 3 HR = 3.00
    // Summed: 49 AB / 5 HR = 9.80
    // Averaging the two per-game rates gives (20.00 + 3.00) / 2 = 11.50 — wrong.
    const agg = aggregate("batting", [
      { atBats: 40, homeRuns: 2 },
      { atBats: 9, homeRuns: 3 },
    ]);
    expect(deriveRate(agg, "atBatsPerHomeRun")).toBe("9.80");
  });

  it("computes stolenBasePercentage and caughtStealingPercentage without swapping them", () => {
    // Game 1: SB 8, CS 2 → attempts 10; Game 2: SB 1, CS 3 → attempts 4.
    // Summed: SB 9, CS 5, attempts 14.
    // stolenBasePercentage = 9/14 = .64286 → .643
    // caughtStealingPercentage = 5/14 = .35714 → .357
    // If the two formulas were swapped, stolenBasePercentage would read .357
    // instead of .643 — a clearly distinguishable failure, not an inverted-
    // but-plausible pair.
    // Averaging per-game SB% gives (.800 + .250) / 2 = .525 — also wrong.
    const agg = aggregate("batting", [
      { stolenBases: 8, caughtStealing: 2 },
      { stolenBases: 1, caughtStealing: 3 },
    ]);
    expect(deriveRate(agg, "stolenBasePercentage")).toBe(".643");
    expect(deriveRate(agg, "caughtStealingPercentage")).toBe(".357");
  });

  it("computes groundOutsToAirouts from summed groundOuts and airOuts", () => {
    // Game 1: 10 GO / 3 AO = 3.33; Game 2: 2 GO / 5 AO = 0.40
    // Summed: 12 GO / 8 AO = 1.50
    // Averaging the two per-game rates gives (3.33 + 0.40) / 2 = 1.87 — wrong.
    const agg = aggregate("batting", [
      { groundOuts: 10, airOuts: 3 },
      { groundOuts: 2, airOuts: 5 },
    ]);
    expect(deriveRate(agg, "groundOutsToAirouts")).toBe("1.50");
  });
});

describe("deriveRate — BB%/K% display rates (>=21d email columns)", () => {
  it("renders a walk rate as a 1-decimal percentage of plate appearances", () => {
    // 10 BB / 100 PA = 10.0%.
    const agg = aggregate("batting", [{ baseOnBalls: 10, plateAppearances: 100 }]);
    expect(deriveRate(agg, "walkPct")).toBe("10.0");
  });

  it("renders a strikeout rate as a 1-decimal percentage of plate appearances", () => {
    // 25 K / 100 PA = 25.0%.
    const agg = aggregate("batting", [{ strikeOuts: 25, plateAppearances: 100 }]);
    expect(deriveRate(agg, "kPct")).toBe("25.0");
  });

  it("rounds to one decimal", () => {
    // 7 / 90 = 7.777...% → 7.8.
    const agg = aggregate("batting", [{ baseOnBalls: 7, plateAppearances: 90 }]);
    expect(deriveRate(agg, "walkPct")).toBe("7.8");
  });

  it("computes from SUMMED counters across splits, never averaging per game", () => {
    // Game 1: 5 BB / 20 PA = 25.0%; Game 2: 5 BB / 80 PA = 6.25%.
    // Summed: 10 BB / 100 PA = 10.0%. Averaging the two gives 15.6% — wrong.
    const agg = aggregate("batting", [
      { baseOnBalls: 5, strikeOuts: 5, plateAppearances: 20 },
      { baseOnBalls: 5, strikeOuts: 5, plateAppearances: 80 },
    ]);
    expect(deriveRate(agg, "walkPct")).toBe("10.0");
    expect(deriveRate(agg, "kPct")).toBe("10.0");
    expect(deriveRate(agg, "walkPct")).not.toBe("15.6");
  });

  it("renders '-' for a zero-PA denominator", () => {
    const agg = aggregate("batting", [{ baseOnBalls: 3, strikeOuts: 2 }]);
    expect(deriveRate(agg, "walkPct")).toBe("-");
    expect(deriveRate(agg, "kPct")).toBe("-");
  });

  it("does NOT carry BB%/K% in deriveAllRates — they are display-only, off the JSON payload", () => {
    // They are intentionally not declared as rate keys in fields.ts, so the
    // ">=21d only" rule stays uniform and the JSON never carries them.
    const agg = aggregate("batting", [{ baseOnBalls: 10, strikeOuts: 20, plateAppearances: 100 }]);
    const rates = deriveAllRates(agg);
    expect(rates.walkPct).toBeUndefined();
    expect(rates.kPct).toBeUndefined();
  });
});

describe("deriveRate — pitching-only rates", () => {
  it("computes hitsPer9Inn from summed hits and summed outs", () => {
    // Game 1: 18 outs (6.0 IP), 9 H → 9 * 27 / 18 = 13.50
    // Game 2: 12 outs (4.0 IP), 4 H → 4 * 27 / 12 = 9.00
    // Summed: 30 outs, 13 H → 13 * 27 / 30 = 11.70
    // Averaging the two per-game rates gives (13.50 + 9.00) / 2 = 11.25 — wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", hits: 9 },
      { inningsPitched: "4.0", hits: 4 },
    ]);
    expect(deriveRate(agg, "hitsPer9Inn")).toBe("11.70");
  });

  it("computes homeRunsPer9 from summed home runs allowed and summed outs", () => {
    // Game 1: 18 outs, 3 HR → 3 * 27 / 18 = 4.50
    // Game 2: 12 outs, 1 HR → 1 * 27 / 12 = 2.25
    // Summed: 30 outs, 4 HR → 4 * 27 / 30 = 3.60
    // Averaging the two per-game rates gives (4.50 + 2.25) / 2 = 3.375 (≈3.38) — wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", homeRuns: 3 },
      { inningsPitched: "4.0", homeRuns: 1 },
    ]);
    expect(deriveRate(agg, "homeRunsPer9")).toBe("3.60");
  });

  it("computes runsScoredPer9 from summed runs allowed and summed outs", () => {
    // Game 1: 18 outs, 6 R → 6 * 27 / 18 = 9.00
    // Game 2: 12 outs, 2 R → 2 * 27 / 12 = 4.50
    // Summed: 30 outs, 8 R → 8 * 27 / 30 = 7.20
    // Averaging the two per-game rates gives (9.00 + 4.50) / 2 = 6.75 — wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", runs: 6 },
      { inningsPitched: "4.0", runs: 2 },
    ]);
    expect(deriveRate(agg, "runsScoredPer9")).toBe("7.20");
  });

  it("computes walksPer9Inn from summed walks and summed outs", () => {
    // Game 1: 18 outs, 6 BB → 6 * 27 / 18 = 9.00
    // Game 2: 12 outs, 2 BB → 2 * 27 / 12 = 4.50
    // Summed: 30 outs, 8 BB → 8 * 27 / 30 = 7.20
    // Averaging the two per-game rates gives (9.00 + 4.50) / 2 = 6.75 — wrong.
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", baseOnBalls: 6 },
      { inningsPitched: "4.0", baseOnBalls: 2 },
    ]);
    expect(deriveRate(agg, "walksPer9Inn")).toBe("7.20");
  });

  it("computes strikePercentage from summed strikes and summed pitches", () => {
    // Game 1: 70 strikes / 100 pitches = .700
    // Game 2: 20 strikes / 50 pitches = .400
    // Summed: 90 strikes / 150 pitches = .600
    // Averaging the two per-game rates gives (.700 + .400) / 2 = .550 — wrong.
    const agg = aggregate("pitching", [
      { strikes: 70, numberOfPitches: 100 },
      { strikes: 20, numberOfPitches: 50 },
    ]);
    expect(deriveRate(agg, "strikePercentage")).toBe(".600");
  });

  it("computes strikeoutWalkRatio from summed strikeouts and summed walks", () => {
    // Game 1: 9 K / 2 BB = 4.50; Game 2: 3 K / 6 BB = 0.50
    // Summed: 12 K / 8 BB = 1.50
    // Averaging the two per-game rates gives (4.50 + 0.50) / 2 = 2.50 — wrong.
    const agg = aggregate("pitching", [
      { strikeOuts: 9, baseOnBalls: 2 },
      { strikeOuts: 3, baseOnBalls: 6 },
    ]);
    expect(deriveRate(agg, "strikeoutWalkRatio")).toBe("1.50");
  });

  it("computes winPercentage from summed wins and summed losses", () => {
    // Game 1: 3 W / (3 W + 1 L) = .750; Game 2: 0 W / (0 W + 2 L) = .000
    // Summed: 3 W / (3 W + 3 L) = .500
    // Averaging the two per-game rates gives (.750 + .000) / 2 = .375 — wrong.
    const agg = aggregate("pitching", [
      { wins: 3, losses: 1 },
      { wins: 0, losses: 2 },
    ]);
    expect(deriveRate(agg, "winPercentage")).toBe(".500");
  });
});

describe("deriveRate — fielding rates", () => {
  it("computes fielding from summed putOuts, assists and errors", () => {
    // Game 1: (10 PO + 5 A) / (10 PO + 5 A + 1 E) = 15/16 = .9375
    // Game 2: (2 PO + 1 A) / (2 PO + 1 A + 2 E) = 3/5 = .6000
    // Summed: (12 PO + 6 A) / (12 PO + 6 A + 3 E) = 18/21 = .85714 → .857
    // Averaging the two per-game rates gives (.9375 + .6000) / 2 = .76875 (.769) — wrong.
    const agg = aggregate("fielding", [
      { putOuts: 10, assists: 5, errors: 1 },
      { putOuts: 2, assists: 1, errors: 2 },
    ]);
    expect(deriveRate(agg, "fielding")).toBe(".857");
  });

  it("computes rangeFactorPer9Inn from summed outs and rangeFactorPerGame from summed games, not each other", () => {
    // Game 1: 18 outs (6.0 IP), 10 PO + 5 A = 15 chances → 15 * 27 / 18 = 22.50 per-9
    // Game 2: 12 outs (4.0 IP), 3 PO + 2 A = 5 chances → 5 * 27 / 12 = 11.25 per-9
    // Summed: 30 outs, 20 chances, 2 games.
    // rangeFactorPer9Inn = 20 * 27 / 30 = 18.00
    // rangeFactorPerGame = 20 / 2 = 10.00 — deliberately different from the
    // per-9 figure, so swapping the two formulas is caught. (A games === 1
    // fixture would make them coincide and hide the swap.)
    // Averaging the two per-game per-9 rates gives (22.50 + 11.25) / 2 = 16.875
    // (16.88) — wrong for rangeFactorPer9Inn.
    const agg = aggregate("fielding", [
      { innings: "6.0", putOuts: 10, assists: 5 },
      { innings: "4.0", putOuts: 3, assists: 2 },
    ]);
    expect(deriveRate(agg, "rangeFactorPer9Inn")).toBe("18.00");
    expect(deriveRate(agg, "rangeFactorPerGame")).toBe("10.00");
  });

  it("computes stolenBasePercentage for fielding (catcher SB/CS) from summed counters", () => {
    // Game 1: SB 5, CS 1 → attempts 6, SB% = 5/6 = .8333
    // Game 2: SB 1, CS 2 → attempts 3, SB% = 1/3 = .3333
    // Summed: SB 6, CS 3, attempts 9 → 6/9 = .66667 → .667
    // Averaging the two per-game rates gives (.8333 + .3333) / 2 = .5833 (.583) — wrong.
    const agg = aggregate("fielding", [
      { stolenBases: 5, caughtStealing: 1 },
      { stolenBases: 1, caughtStealing: 2 },
    ]);
    expect(deriveRate(agg, "stolenBasePercentage")).toBe(".667");
    expect(deriveRate(agg, "caughtStealingPercentage")).toBe(".333");
  });
});

describe("every declared rate key has a formula", () => {
  it("derives a non-'-' value for each rate given non-zero denominators", () => {
    // Deliberately NOT 27 outs (9.0 IP) and NOT 1 game. At 27 outs,
    // per9(n, 27) = n * 27 / 27 = n — an identity that would hide a dropped
    // `* 27` (or a per9/perInning mixup landing on the same output). At
    // games === 1, rangeFactorPerGame and rangeFactorPer9Inn can render
    // identically and hide a swap between them. Splitting each innings-based
    // stat type into two unequal-innings games (12 + 7 = 19 outs, well short
    // of 27) with games = 2 avoids both traps, while keeping every counter's
    // total identical to the original single-game fixture so every
    // denominator here stays guaranteed non-zero.
    const inputs = {
      batting: [
        {
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
      ],
      pitching: [
        {
          inningsPitched: "4.0",
          earnedRuns: 2,
          hits: 4,
          baseOnBalls: 1,
          strikeOuts: 5,
          homeRuns: 1,
          runs: 2,
          numberOfPitches: 60,
          strikes: 40,
          wins: 1,
          losses: 0,
          atBats: 16,
          totalBases: 5,
          hitByPitch: 1,
          sacFlies: 0,
          stolenBases: 1,
          caughtStealing: 0,
          groundOuts: 3,
          airOuts: 2,
        },
        {
          inningsPitched: "2.1",
          earnedRuns: 1,
          hits: 2,
          baseOnBalls: 1,
          strikeOuts: 4,
          homeRuns: 0,
          runs: 2,
          numberOfPitches: 40,
          strikes: 25,
          wins: 0,
          losses: 1,
          atBats: 14,
          totalBases: 4,
          hitByPitch: 0,
          sacFlies: 1,
          stolenBases: 0,
          caughtStealing: 1,
          groundOuts: 2,
          airOuts: 2,
        },
      ],
      fielding: [
        { innings: "4.0", putOuts: 3, assists: 2, errors: 1, stolenBases: 1, caughtStealing: 0 },
        { innings: "2.1", putOuts: 2, assists: 1, errors: 0, stolenBases: 0, caughtStealing: 1 },
      ],
    } as const;

    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const agg = aggregate(statType, inputs[statType]);
      for (const key of rateKeys(statType)) {
        expect(deriveRate(agg, key), `${statType}.${key}`).not.toBe("-");
      }
    }
  });
});
