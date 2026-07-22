import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players, statLines } from "../db/schema.js";

/**
 * Read-side Stat Line queries for the API/MCP surfaces. Zod-validated bounds
 * at the boundary; one join, never a query per row (rules/backend.md). No new
 * indexes: single-user volumes make the existing unique keys plenty
 * (deliberate — do not add a migration for this).
 */

export const STAT_LINES_MAX_LIMIT = 200;
export const STAT_LINES_DEFAULT_LIMIT = 50;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The raw filter fields, exposed as a `ZodRawShape` so other boundaries can
 * COMPOSE them (e.g. add a `format` param) without re-declaring the bounds or
 * fighting the fact that the refined schema is a wrapped type. The refinement
 * that pairs them (`refineFromTo`) is exported beside the shape so a composed
 * schema keeps identical validation.
 */
export const StatLineFilterShape = {
  playerId: z.coerce.number().int().positive().optional(),
  level: z.enum(["mlb", "milb", "ncaa"]).optional(),
  from: z.string().trim().regex(ISO_DATE, "expected YYYY-MM-DD").optional(),
  to: z.string().trim().regex(ISO_DATE, "expected YYYY-MM-DD").optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(STAT_LINES_MAX_LIMIT)
    .default(STAT_LINES_DEFAULT_LIMIT),
};

/** `from` must not be after `to`; shared by every schema built on the shape. */
export function refineFromTo(
  q: { from?: string | undefined; to?: string | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "from must be <= to" });
  }
}

export const StatLineQuerySchema = z.object(StatLineFilterShape).superRefine(refineFromTo);

export type StatLineQuery = z.infer<typeof StatLineQuerySchema>;

export interface StatLineView {
  id: number;
  playerId: number;
  playerName: string;
  level: "mlb" | "milb" | "ncaa";
  milbLevel: string | null;
  gameId: number;
  statType: "batting" | "pitching" | "fielding";
  gameDate: string;
  gameNumber: number;
  gameType: string;
  isHome: boolean | null;
  opponentName: string | null;
  teamName: string | null;
  sportId: number;
  leagueName: string | null;
  stats: unknown;
}

/**
 * Query Stat Lines, newest first (date, then doubleheader game number).
 * `input` is unvalidated boundary data — the schema owns the bounds.
 */
export async function queryStatLines(db: Db, input: unknown): Promise<StatLineView[]> {
  const q = StatLineQuerySchema.parse(input);
  const conditions = [];
  if (q.playerId !== undefined) conditions.push(eq(statLines.playerId, q.playerId));
  if (q.level !== undefined) conditions.push(eq(players.level, q.level));
  if (q.from !== undefined) conditions.push(gte(statLines.gameDate, q.from));
  if (q.to !== undefined) conditions.push(lte(statLines.gameDate, q.to));

  const rows = await db
    .select({ line: statLines, playerName: players.fullName, level: players.level, milbLevel: players.milbLevel })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(statLines.gameDate), desc(statLines.gameNumber), statLines.statType)
    .limit(q.limit);

  return rows.map(({ line, playerName, level, milbLevel }) => ({
    id: line.id,
    playerId: line.playerId,
    playerName,
    level,
    milbLevel,
    gameId: line.gameId,
    statType: line.statType,
    gameDate: line.gameDate,
    gameNumber: line.gameNumber,
    gameType: line.gameType,
    isHome: line.isHome,
    opponentName: line.opponentName,
    teamName: line.teamName,
    sportId: line.sportId,
    leagueName: line.leagueName,
    stats: line.stats,
  }));
}

/** One Player row by internal id, or null. */
export async function getPlayer(db: Db, playerId: number): Promise<PlayerRow | null> {
  const row = (await db.select().from(players).where(eq(players.id, playerId)))[0];
  return row ?? null;
}
