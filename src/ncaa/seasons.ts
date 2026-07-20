/**
 * Bundled stats.ncaa.org season-lookup table (ADR 0032).
 *
 * stats.ncaa.org keys every request by opaque per-season ids: a
 * `game_sport_year_ctl_id` (the "season id") plus a `year_stat_category_id`
 * for batting vs. pitching. Those ids are not derivable from the calendar
 * year — they are assigned by the NCAA each season — so we bundle them here,
 * one entry per Division-I baseball season we support.
 *
 * Opening/closing dates are the Division-I regular-season window through the
 * College World Series (the last possible game), used to seed the sportId 22
 * row in `season_calendar` so Offseason Sleep and In Season math (ADR 0031)
 * treat NCAA correctly.
 *
 * ANNUAL UPDATE PATH: each January, look up the new season's ids and add an
 * entry below. Find the ids by opening any Division-I player's page on
 * stats.ncaa.org and reading `game_sport_year_ctl_id` (season id) and
 * `year_stat_category_id` (batting/pitching) off a game-log link's query
 * string. A year with no entry here produces no NCAA calendar row and no
 * ingest — NCAA is simply treated as not In Season, logged loudly, never a
 * silent gap.
 */

export interface NcaaSeason {
  /** Calendar year (YYYY). */
  year: string;
  /** stats.ncaa.org game_sport_year_ctl_id for Division-I baseball this season. */
  seasonId: number;
  /** year_stat_category_id selecting the batting game log. */
  battingCategoryId: number;
  /** year_stat_category_id selecting the pitching game log. */
  pitchingCategoryId: number;
  /** Division-I opening day (YYYY-MM-DD). */
  regularSeasonStart: string;
  /** Last possible game (College World Series finish, YYYY-MM-DD). */
  regularSeasonEnd: string;
}

/**
 * Supported Division-I baseball seasons. Dates are the D-I opening day through
 * the CWS finish; extend annually per the note above.
 */
export const NCAA_SEASONS: readonly NcaaSeason[] = [
  {
    year: "2024",
    seasonId: 16580,
    battingCategoryId: 15080,
    pitchingCategoryId: 15081,
    regularSeasonStart: "2024-02-16",
    regularSeasonEnd: "2024-06-24",
  },
  {
    year: "2025",
    seasonId: 16840,
    battingCategoryId: 15687,
    pitchingCategoryId: 15688,
    regularSeasonStart: "2025-02-14",
    regularSeasonEnd: "2025-06-23",
  },
  {
    year: "2026",
    seasonId: 17040,
    battingCategoryId: 15867,
    pitchingCategoryId: 15868,
    regularSeasonStart: "2026-02-13",
    regularSeasonEnd: "2026-06-22",
  },
];

/** The bundled season entry for a calendar year, or null when unsupported. */
export function ncaaSeasonFor(year: string): NcaaSeason | null {
  return NCAA_SEASONS.find((s) => s.year === year) ?? null;
}

export type NcaaStatCategory = "batting" | "pitching";

/** The year_stat_category_id for one category of one bundled season. */
export function categoryId(season: NcaaSeason, category: NcaaStatCategory): number {
  return category === "batting" ? season.battingCategoryId : season.pitchingCategoryId;
}
