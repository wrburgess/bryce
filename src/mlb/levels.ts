/**
 * sportId <-> Level / MiLB Level mapping (see docs/domain/CONTEXT.md: Level is a
 * mutable location, never identity).
 */

export type Level = "mlb" | "milb" | "ncaa";

export interface LevelInfo {
  level: Level;
  milbLevel: string | null;
}

/** Every sportId the Refresh sweeps for an MLB/MiLB Player. */
export const SPORT_IDS = [1, 11, 12, 13, 14, 16] as const;

/** MLB Stats API sportId for College Baseball (NCAA) — no data source in Phase 1. */
export const NCAA_SPORT_ID = 22;

const SPORT_ID_TO_LEVEL: Record<number, LevelInfo> = {
  1: { level: "mlb", milbLevel: null },
  11: { level: "milb", milbLevel: "Triple-A" },
  12: { level: "milb", milbLevel: "Double-A" },
  13: { level: "milb", milbLevel: "High-A" },
  14: { level: "milb", milbLevel: "Single-A" },
  16: { level: "milb", milbLevel: "Rookie" },
  [NCAA_SPORT_ID]: { level: "ncaa", milbLevel: null },
};

const MILB_LEVEL_TO_SPORT_ID: Record<string, number> = {
  "Triple-A": 11,
  "Double-A": 12,
  "High-A": 13,
  "Single-A": 14,
  Rookie: 16,
};

/** Display order of MiLB Level subgroups in the digest, top of the ladder first. */
export const MILB_LEVEL_ORDER = ["Triple-A", "Double-A", "High-A", "Single-A", "Rookie"] as const;

export function levelForSportId(sportId: number): LevelInfo | null {
  return SPORT_ID_TO_LEVEL[sportId] ?? null;
}

export function sportIdForLevel(level: Level, milbLevel: string | null): number | null {
  if (level === "mlb") return 1;
  if (level === "ncaa") return NCAA_SPORT_ID;
  if (milbLevel === null) return null;
  return MILB_LEVEL_TO_SPORT_ID[milbLevel] ?? null;
}

/**
 * Display abbreviation for the level a GAME was played at (windowed Digest
 * spec). Derived from the stat line's sportId, never from players.level —
 * a player's level is where he is today, and a window can span a promotion.
 *
 * sportId 16 covers every rookie/complex league, so league_name is the only
 * thing separating the Dominican Summer League from the domestic complexes.
 */
const SPORT_ID_ABBREV: Record<number, string> = {
  1: "MLB",
  11: "AAA",
  12: "AA",
  13: "A+",
  14: "A",
  16: "R",
  [NCAA_SPORT_ID]: "NCAA",
};

const LADDER: readonly number[] = [1, 11, 12, 13, 14, 16, NCAA_SPORT_ID];

export function levelAbbrev(sportId: number, leagueName: string | null): string {
  if (sportId === 16 && leagueName === "Dominican Summer League") return "DSL";
  return SPORT_ID_ABBREV[sportId] ?? "?";
}

/** Sort rank: MLB first, NCAA last, unknown ids after everything. */
export function levelRank(sportId: number): number {
  const index = LADDER.indexOf(sportId);
  return index === -1 ? LADDER.length : index;
}
