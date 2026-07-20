import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players, statLines } from "../db/schema.js";
import { hostDate, isInSeason } from "../domain/season.js";
import { findDeliveryId } from "../jobs/delivery-claim.js";
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
  /**
   * Widen the novelty predicate to ALSO include the lines already reported by
   * this delivery — what a forced replay needs so its test email carries the
   * same content the real send did, rather than rendering "no new stats"
   * (ADR 0030: a successful send stamps every line it reported). Null/omitted
   * is the ordinary predicate: unreported lines only.
   */
  includeDeliveryId?: number | null;
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

  // Novelty (ADR 0030): unreported lines, plus — for a forced replay — the ones
  // this delivery already reported.
  const includeDeliveryId = deps.includeDeliveryId ?? null;
  const novelty =
    includeDeliveryId === null
      ? isNull(statLines.digestDeliveryId)
      : or(isNull(statLines.digestDeliveryId), eq(statLines.digestDeliveryId, includeDeliveryId));

  // One join, not one query per player (rules/backend.md).
  const unreported = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(and(novelty, eq(players.active, true)));

  // Fielding rows never render standalone (ADR 0033): each one's errors merge
  // into the same player+game batting line, synthesizing an all-zeros batting
  // line when no batting row exists for that game. They are still counted in
  // reportedIds below, so the Digest marks them reported with everything else.
  const lines: RenderLine[] = [];
  const battingByGame = new Map<string, RenderLine>();
  const fieldingRows: typeof unreported = [];
  for (const { line, player } of unreported) {
    if (line.statType === "fielding") {
      fieldingRows.push({ line, player });
      continue;
    }
    const rendered: RenderLine = {
      player: toRenderPlayer(player),
      gameId: line.gameId,
      statType: line.statType,
      gameDate: line.gameDate,
      gameNumber: line.gameNumber,
      isHome: line.isHome,
      opponentName: line.opponentName,
      stats: asRecord(line.stats),
    };
    lines.push(rendered);
    if (line.statType === "batting") {
      battingByGame.set(`${line.playerId}:${line.gameId}`, rendered);
    }
  }
  for (const { line, player } of fieldingRows) {
    const errors = errorCount(asRecord(line.stats));
    const key = `${line.playerId}:${line.gameId}`;
    const batting = battingByGame.get(key);
    if (batting !== undefined) {
      batting.stats = { ...batting.stats, errors };
      continue;
    }
    const synthesized: RenderLine = {
      player: toRenderPlayer(player),
      gameId: line.gameId,
      statType: "batting",
      gameDate: line.gameDate,
      gameNumber: line.gameNumber,
      isHome: line.isHome,
      opponentName: line.opponentName,
      stats: { errors },
    };
    lines.push(synthesized);
    battingByGame.set(key, synthesized);
  }

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

/**
 * The `includeDeliveryId` a preview should use. A forced send reads the id off
 * its claim; a preview holds none, so it looks today's digest slot up instead
 * (null when there is none, which is the ordinary predicate). Shared by BOTH
 * preview surfaces (REST + MCP) so the two cannot drift — `includeDeliveryId`
 * is optional, so a surface that forgot it would fail open and silently return
 * an empty forced preview.
 */
export function previewDeliveryId(
  db: Db,
  deps: { now: () => Date; tz: string },
  force: boolean,
): number | null {
  if (!force) return null;
  return findDeliveryId(db, "digest", hostDate(deps.now(), deps.tz));
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

/** The fielding stat record's error count; a missing/non-numeric value is 0. */
function errorCount(stats: Record<string, unknown>): number {
  const v = stats.errors;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
