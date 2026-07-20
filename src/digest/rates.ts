/**
 * Single-game rate math for the digest's fixed-format pitching line (ADR
 * 0033). Innings pitched uses baseball notation — "6.1" is six innings plus
 * one OUT (6 1/3), never six-and-a-tenth — so every rate converts to outs
 * first. All rates here are per-game (this outing only), never
 * season-cumulative.
 */

const IP_NOTATION = /^(\d+)(?:\.([0-2]))?$/;

/**
 * Outs recorded from a baseball-notation IP string: "6.1" → 19, "7" → 21.
 * The fraction digit must be 0-2 (thirds of an inning); anything else —
 * "6.3", "-", "" — is unparseable and returns null.
 */
export function ipToOuts(ip: string | null | undefined): number | null {
  if (typeof ip !== "string") return null;
  const match = IP_NOTATION.exec(ip.trim());
  if (match === null || match[1] === undefined) return null;
  return Number(match[1]) * 3 + (match[2] !== undefined ? Number(match[2]) : 0);
}

/** Display form of an IP value: the source string passed through when parseable, "0.0" otherwise. */
export function formatIp(ip: unknown): string {
  return typeof ip === "string" && ipToOuts(ip) !== null ? ip.trim() : "0.0";
}

/** numerator / innings, where innings = outs / 3; "-" when no outs were recorded. */
function rate(numerator: number, outs: number | null, digits: number): string {
  if (outs === null || outs === 0) return "-";
  return ((numerator * 3) / outs).toFixed(digits);
}

/** Single-game ERA (ER x 9 / IP) to two decimals, "-" when no outs were recorded. */
export function singleGameEra(earnedRuns: number, outs: number | null): string {
  return rate(earnedRuns * 9, outs, 2);
}

/** Single-game WHIP ((BB + hits allowed) / IP) to two decimals, "-" when no outs were recorded. */
export function singleGameWhip(baseOnBalls: number, hits: number, outs: number | null): string {
  return rate(baseOnBalls + hits, outs, 2);
}

/** Single-game K/9 (K x 9 / IP) to one decimal, "-" when no outs were recorded. */
export function singleGameK9(strikeOuts: number, outs: number | null): string {
  return rate(strikeOuts * 9, outs, 1);
}

/** Quality start: at least 6.0 innings (18 outs) AND no more than 3 earned runs. */
export function qualityStart(outs: number | null, earnedRuns: number): 0 | 1 {
  return outs !== null && outs >= 18 && earnedRuns <= 3 ? 1 : 0;
}
