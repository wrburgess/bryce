import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players, statLines } from "../db/schema.js";
import { hostDate, isInSeason } from "../domain/season.js";
import { loadActivePlayers, loadCalendars } from "../jobs/refresh.js";
import type { RenderLine, RenderPlayer } from "./render.js";

/**
 * Pure Digest assembly (ADR 0030): everything the next Digest WOULD report —
 * unreported Stat Lines for active Players plus the In Season "no new stats"
 * tail. Read-only: no send, no marking, no delivery rows. runDigest consumes
 * this; the preview surfaces (REST + MCP) expose it directly.
 */

export interface AssembleDeps {
  now: () => Date;
  tz: string;
}

export interface DigestAssembly {
  /** Host-timezone date the assembly covers. */
  date: string;
  lines: RenderLine[];
  noNewStats: RenderPlayer[];
  /** stat_lines.id of every line the Digest would mark as reported. */
  reportedIds: number[];
  /** Distinct players with new lines. */
  playerCount: number;
}

export async function assembleDigest(db: Db, deps: AssembleDeps): Promise<DigestAssembly> {
  const { now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const date = hostDate(now(), tz);

  // One join, not one query per player (rules/backend.md).
  const unreported = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(and(isNull(statLines.digestDeliveryId), eq(players.active, true)));

  const lines: RenderLine[] = unreported.map(({ line, player }) => ({
    player: toRenderPlayer(player),
    gameId: line.gameId,
    statType: line.statType,
    gameDate: line.gameDate,
    gameNumber: line.gameNumber,
    isHome: line.isHome,
    opponentName: line.opponentName,
    stats: asRecord(line.stats),
  }));

  // "No new stats" tail: In Season active players with no new lines ONLY —
  // an out-of-season player is omitted entirely, not listed.
  const playersWithLines = new Set(unreported.map(({ player }) => player.id));
  const noNewStats: RenderPlayer[] = activePlayers
    .filter((p) => !playersWithLines.has(p.id))
    .filter((p) => isInSeason(p, calendars, now(), tz))
    .map(toRenderPlayer);

  return {
    date,
    lines,
    noNewStats,
    reportedIds: unreported.map(({ line }) => line.id),
    playerCount: playersWithLines.size,
  };
}

export function toRenderPlayer(player: PlayerRow): RenderPlayer {
  return {
    fullName: player.fullName,
    level: player.level,
    milbLevel: player.milbLevel,
    teamName: player.teamName,
    schoolName: player.schoolName,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
