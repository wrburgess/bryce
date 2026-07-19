import { z } from "zod";

/**
 * Zod contracts for the MLB Stats API responses we consume. Loose objects: the
 * API carries far more fields than we read, and `raw` storage keeps everything —
 * but the fields we DO depend on are validated loudly (ADR 0025: a payload
 * mismatch must throw, never silently produce garbage).
 */

export const GameLogSplitSchema = z.looseObject({
  season: z.string(),
  stat: z.record(z.string(), z.unknown()),
  team: z.looseObject({ id: z.number(), name: z.string() }).optional(),
  player: z.looseObject({ id: z.number(), fullName: z.string() }),
  league: z.looseObject({ id: z.number(), name: z.string() }).optional(),
  sport: z.looseObject({ id: z.number() }),
  opponent: z.looseObject({ id: z.number(), name: z.string() }).optional(),
  date: z.string(),
  gameType: z.string(),
  isHome: z.boolean(),
  isWin: z.boolean().optional(),
  game: z.looseObject({ gamePk: z.number(), gameNumber: z.number() }),
});
export type GameLogSplit = z.infer<typeof GameLogSplitSchema>;

export const GameLogResponseSchema = z.looseObject({
  stats: z.array(
    z.looseObject({
      type: z.looseObject({ displayName: z.string() }),
      group: z.looseObject({ displayName: z.string() }),
      splits: z.array(GameLogSplitSchema),
    }),
  ),
});
export type GameLogResponse = z.infer<typeof GameLogResponseSchema>;

export const PersonSchema = z.looseObject({
  id: z.number(),
  fullName: z.string(),
  active: z.boolean().optional(),
  primaryPosition: z
    .looseObject({ abbreviation: z.string().optional(), name: z.string().optional() })
    .optional(),
  /** Present only with hydrate=currentTeam — and even then lacks sport; resolve via getTeam. */
  currentTeam: z
    .looseObject({ id: z.number(), name: z.string(), parentOrgId: z.number().optional() })
    .optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const PeopleResponseSchema = z.looseObject({
  people: z.array(PersonSchema),
});

export const TeamSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  sport: z.looseObject({ id: z.number(), name: z.string().optional() }),
  league: z.looseObject({ id: z.number(), name: z.string() }).optional(),
  parentOrgName: z.string().optional(),
  parentOrgId: z.number().optional(),
});
export type Team = z.infer<typeof TeamSchema>;

export const TeamsResponseSchema = z.looseObject({
  teams: z.array(TeamSchema),
});

export const SeasonSchema = z.looseObject({
  seasonId: z.string(),
  regularSeasonStartDate: z.string().optional(),
  regularSeasonEndDate: z.string().optional(),
  postSeasonStartDate: z.string().optional(),
  postSeasonEndDate: z.string().optional(),
  // MiLB seasons carry no spring dates (verified against a live sportId=11 capture).
  springStartDate: z.string().optional(),
  springEndDate: z.string().optional(),
});
export type Season = z.infer<typeof SeasonSchema>;

export const SeasonsResponseSchema = z.looseObject({
  seasons: z.array(SeasonSchema),
});
