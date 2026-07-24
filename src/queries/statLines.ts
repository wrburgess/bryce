import { and, desc, eq, exists, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { listMembers, players, statLines } from "../db/schema.js";
import { resolveListByName } from "../lists/service.js";

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
 * schema keeps identical validation. Every field carries a `.describe()` so the
 * MCP tool schema surfaces a description for it (#54).
 */
export const StatLineFilterShape = {
  playerId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Internal Bryce player id (players.id, not the MLB personId) to scope results to one player."),
  level: z
    .enum(["mlb", "milb", "ncaa"])
    .optional()
    .describe("Affiliation level filter: mlb, milb, or ncaa."),
  from: z
    .string()
    .trim()
    .regex(ISO_DATE, "expected YYYY-MM-DD")
    .optional()
    .describe("Inclusive earliest game date, YYYY-MM-DD; must be <= to when both are given."),
  to: z
    .string()
    .trim()
    .regex(ISO_DATE, "expected YYYY-MM-DD")
    .optional()
    .describe("Inclusive latest game date, YYYY-MM-DD; must be >= from when both are given."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(STAT_LINES_MAX_LIMIT)
    .default(STAT_LINES_DEFAULT_LIMIT)
    .describe(
      `Maximum rows to return, newest first; 1 to ${STAT_LINES_MAX_LIMIT}, default ${STAT_LINES_DEFAULT_LIMIT}.`,
    ),
  list: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Named player list to scope results to its active members (issue #70); an unknown list is rejected. Omit for all players.",
    ),
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
  if (q.list !== undefined) {
    // Fail closed on an unknown list (UnknownListError), then scope to its
    // members with a correlated EXISTS against list_members keyed by list_id.
    // Constant-size (no per-member bind param, so no SQLite ~999-param ceiling),
    // and an empty list selects nothing naturally — EXISTS is false with no
    // member rows, so no `1 = 0` special-case is needed.
    const list = await resolveListByName(db, q.list);
    // A named-list scope selects the list's ACTIVE members — `players.active`
    // stays the master gate under membership (ADR 0046 decision 2), so a member
    // who was later deactivated must not leak. The main query already joins
    // `players` (for the level filter), so require active here alongside the
    // membership EXISTS.
    conditions.push(eq(players.active, true));
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(listMembers)
          .where(
            and(eq(listMembers.listId, list.id), eq(listMembers.playerId, statLines.playerId)),
          ),
      ),
    );
  }

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
