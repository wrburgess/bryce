import { describe, expect, it } from "vitest";
import { formatBattingLine, formatPitchingLine } from "../src/digest/render.js";

describe("formatBattingLine (fixed HC format, ADR 0033)", () => {
  it("renders every stat in the fixed order, zeros included", () => {
    const line = formatBattingLine({
      plateAppearances: 4,
      hits: 2,
      strikeOuts: 1,
      doubles: 0,
      triples: 0,
      homeRuns: 1,
      rbi: 3,
      runs: 2,
      stolenBases: 0,
      caughtStealing: 0,
      errors: 0,
      baseOnBalls: 1,
    });
    expect(line).toBe("PA 4, H 2, BB 1, K 1, 2B 0, 3B 0, HR 1, RBI 3, R 2, SB 0, CS 0, E 0");
  });

  it("falls back to AB + BB + HBP when plateAppearances is absent", () => {
    const line = formatBattingLine({ atBats: 4, baseOnBalls: 1, hitByPitch: 1, hits: 2 });
    expect(line).toBe("PA 6, H 2, BB 1, K 0, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 0");
  });

  it("prefers a present plateAppearances over the fallback sum", () => {
    const line = formatBattingLine({ plateAppearances: 5, atBats: 4, baseOnBalls: 0 });
    expect(line).toContain("PA 5,");
  });

  it("renders an all-zeros line for an empty stat record", () => {
    expect(formatBattingLine({})).toBe(
      "PA 0, H 0, BB 0, K 0, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 0",
    );
  });

  it("treats non-numeric junk values as 0, never NaN", () => {
    const line = formatBattingLine({ hits: "2", rbi: null, plateAppearances: "4" });
    expect(line).toBe("PA 0, H 0, BB 0, K 0, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 0");
  });
});

describe("formatPitchingLine (fixed HC format, single-game rates, ADR 0033)", () => {
  it("renders the full fixed order with computed single-game rates and QS", () => {
    const line = formatPitchingLine({
      inningsPitched: "6.1",
      earnedRuns: 2,
      strikeOuts: 8,
      baseOnBalls: 1,
      hits: 4,
      homeRuns: 1,
      saves: 0,
      holds: 0,
    });
    expect(line).toBe(
      "IP 6.1, ER 2, K 8, K/9 11.4, BB 1, HA 4, HRA 1, ERA 2.84, WHIP 0.79, S 0, HLD 0, QS 1",
    );
  });

  it("treats missing saves and holds as 0 (NCAA tracks neither holds nor always saves)", () => {
    const line = formatPitchingLine({ inningsPitched: "6.0", earnedRuns: 1, strikeOuts: 8, baseOnBalls: 2, hits: 4 });
    expect(line).toBe(
      "IP 6.0, ER 1, K 8, K/9 12.0, BB 2, HA 4, HRA 0, ERA 1.50, WHIP 1.00, S 0, HLD 0, QS 1",
    );
  });

  it("renders a save and hold when present", () => {
    const line = formatPitchingLine({ inningsPitched: "1.0", saves: 1, holds: 1, strikeOuts: 2 });
    expect(line).toContain("S 1, HLD 1, QS 0");
  });

  it("QS boundaries: 6.0/3 is a QS, 5.2/0 is not, 7/4 is not", () => {
    expect(
      formatPitchingLine({ inningsPitched: "6.0", earnedRuns: 3 }),
    ).toContain("QS 1");
    expect(
      formatPitchingLine({ inningsPitched: "5.2", earnedRuns: 0 }),
    ).toContain("QS 0");
    expect(
      formatPitchingLine({ inningsPitched: "7", earnedRuns: 4 }),
    ).toContain("QS 0");
  });

  it("renders '-' rates and QS 0 when IP is absent", () => {
    expect(formatPitchingLine({ earnedRuns: 1, strikeOuts: 2, baseOnBalls: 1, hits: 3 })).toBe(
      "IP 0.0, ER 1, K 2, K/9 -, BB 1, HA 3, HRA 0, ERA -, WHIP -, S 0, HLD 0, QS 0",
    );
  });

  it("renders '-' rates when IP is present but zero", () => {
    const line = formatPitchingLine({ inningsPitched: "0.0", earnedRuns: 2, hits: 1 });
    expect(line).toContain("K/9 -");
    expect(line).toContain("ERA -");
    expect(line).toContain("WHIP -");
    expect(line).toContain("QS 0");
  });

  it("treats unparseable IP notation exactly like absent IP", () => {
    const line = formatPitchingLine({ inningsPitched: "6.3", earnedRuns: 1 });
    expect(line).toContain("IP 0.0,");
    expect(line).toContain("ERA -");
  });
});
