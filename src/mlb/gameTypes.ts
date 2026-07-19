/**
 * Ingestion allowlist for gameType (ADR 0031): regular season and postseason
 * only. Spring training ("S"), exhibitions ("E") and the All-Star game ("A")
 * are deliberately outside the domain — no Stat Lines, ever. Allowlist, not
 * blocklist: an unknown future gameType stays out until reviewed (fail closed).
 */
export const INGESTED_GAME_TYPES: ReadonlySet<string> = new Set([
  "R", // regular season
  "F", // Wild Card
  "D", // Division Series
  "L", // League Championship Series
  "W", // World Series
  "C", // Championship (MiLB finals)
]);

export function isIngestedGameType(gameType: string): boolean {
  return INGESTED_GAME_TYPES.has(gameType);
}
