import { and, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow, StatLineRow } from "../db/schema.js";
import { players, statLines } from "../db/schema.js";
import type { CalendarEntry } from "../domain/season.js";
import { hostDate, isInSeason, sportIdForPlayer } from "../domain/season.js";
import type { ResolvedWindow, WindowSpec } from "../domain/window.js";
import { resolveWindow } from "../domain/window.js";
import { levelAbbrev, levelRank } from "../mlb/levels.js";
import type { Aggregate } from "../stats/aggregate.js";
import { aggregate } from "../stats/aggregate.js";
import { loadActivePlayers, loadCalendars } from "../jobs/refresh.js";
import { ipToOuts, qualityStart } from "./rates.js";
import type { RenderPlayer } from "./render.js";

/**
 * Windowed Digest assembly. Selection is BY DATE WINDOW, not by novelty — the
 * report consumes nothing and stamps nothing, so re-running a window is always
 * safe (supersedes ADR 0030's novelty model).
 *
 * Rows group by (player, LEVEL), because a window can span a promotion and a
 * blended slash line across levels describes nobody (src/mlb/levels.ts: "Level
 * is a mutable location, never identity"). A 1d window groups by game instead,
 * so a doubleheader stays two rows.
 *
 * Read-only. runDigest consumes this; the preview surfaces (REST + MCP) expose
 * it directly.
 */

export interface DigestRow {
  player: RenderPlayer;
  /** "MLB" | "AAA" | ... — from the stat line's sportId, never players.level. */
  lvl: string;
  lvlRank: number;
  /** Game number for a 1d doubleheader row; null otherwise. */
  gameNumber: number | null;
  agg: Aggregate;
  /** Count of quality starts in the window; always 0 for batters. */
  qualityStarts: number;
}

export interface DigestAssembly {
  window: ResolvedWindow;
  batters: DigestRow[];
  pitchers: DigestRow[];
  /** Distinct players with lines in the window (zero rows are not counted). */
  playerCount: number;
  /** Stored lines the window selected, fielding rows included. */
  statLineCount: number;
}

export interface AssembleDeps {
  now: () => Date;
  tz: string;
  spec: WindowSpec;
}

interface Split {
  line: StatLineRow;
  player: PlayerRow;
  stats: Record<string, unknown>;
}

export async function assembleDigest(db: Db, deps: AssembleDeps): Promise<DigestAssembly> {
  const { now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const window = resolveWindow(deps.spec, now(), tz, seasonStartFor(calendars, now(), tz));

  // One join, not one query per player (rules/backend.md).
  const rows = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(
      and(
        eq(players.active, true),
        // Regular season only: ingestion also allows postseason types, and a
        // YTD line blending playoff and regular-season stats is not a season line.
        eq(statLines.gameType, "R"),
        gte(statLines.gameDate, window.from),
        lte(statLines.gameDate, window.to),
      ),
    );

  const splits: Split[] = rows.map(({ line, player }) => ({
    line,
    player,
    stats: asRecord(line.stats),
  }));

  const playersWithLines = new Set(splits.map((s) => s.player.id));

  // A player with no games still appears, as a zero row — this replaces the old
  // "no new stats" tail, and inherits its In Season filter: a player whose
  // season is over is omitted entirely, not listed at zero for months.
  //
  // The filter can only ever touch a player with ZERO games in the window, so it
  // cannot hide anyone who actually played: a pitcher whose season ended in
  // September still has splits inside a `ytd` window and is built from those.
  const idlePlayers = activePlayers.filter(
    (p) => !playersWithLines.has(p.id) && isInSeason(p, calendars, now(), tz),
  );

  const batting = mergeFieldingIntoBatting(splits).map(withPlateAppearances);
  const pitching = splits.filter((s) => s.line.statType === "pitching");

  return {
    window,
    batters: buildRows(batting, window, "batting", idlePlayers.filter(isBatter)),
    pitchers: buildRows(pitching, window, "pitching", idlePlayers.filter((p) => !isBatter(p))),
    playerCount: playersWithLines.size,
    statLineCount: splits.length,
  };
}

/**
 * Which table an IDLE player's zero row belongs in. Position is the only signal
 * available — he left no stat line to read a role from.
 *
 * A pitcher who did not pitch must not render as a batter: 0 PA / 0 H / 0 HR
 * reads as "he had a terrible week", not "he did not pitch", and three of the
 * watched players are pitchers. An unknown position falls to batting, which is
 * the larger population and the harmless default.
 *
 * There is deliberately no two-way handling: a two-way player who actually
 * played appears in both tables from his real splits, and this path fires only
 * when he has no games at all.
 */
function isBatter(player: PlayerRow): boolean {
  return player.position !== "P";
}

/**
 * ADR 0033: a fielding row never renders standalone. Its error count merges
 * into the same (player, game) batting split, synthesizing an all-zero batting
 * split when the player has no batting row for that game.
 *
 * Only `errors` crosses over. The rest of a fielding row (putOuts, assists,
 * innings) is not a batting stat, and carrying it would leak fielding counters
 * into a batting aggregate.
 */
function mergeFieldingIntoBatting(splits: Split[]): Split[] {
  const batting = splits
    .filter((s) => s.line.statType === "batting")
    // Copied, not aliased: the merge below writes `errors` onto these, and
    // `splits` is still read afterwards for statLineCount and playerCount.
    .map((s) => ({ ...s, stats: { ...s.stats } }));
  const byGame = new Map<string, Split>();
  for (const split of batting) {
    byGame.set(`${split.line.playerId}:${split.line.gameId}`, split);
  }
  for (const split of splits) {
    if (split.line.statType !== "fielding") continue;
    const key = `${split.line.playerId}:${split.line.gameId}`;
    const errors = numberOr0(split.stats.errors);
    const target = byGame.get(key);
    if (target !== undefined) {
      target.stats.errors = errors;
      continue;
    }
    const synthesized: Split = { ...split, stats: { errors } };
    byGame.set(key, synthesized);
    batting.push(synthesized);
  }
  return batting;
}

/**
 * PA from the source when present, else AB + BB + HBP — computed PER GAME,
 * before aggregation. The fixed-format batting line carried this fallback at
 * display time, where one game was one row; a window SUMS, so it has to happen
 * at the grain the fallback is true at.
 *
 * Deriving it after summing would silently undercount a window whose games
 * disagree: if even one game reports plateAppearances the sum is non-zero, the
 * fallback never fires, and every game that omitted it contributes nothing.
 */
function withPlateAppearances(split: Split): Split {
  if (numberOr0(split.stats.plateAppearances) > 0) return split;
  const derived =
    numberOr0(split.stats.atBats) +
    numberOr0(split.stats.baseOnBalls) +
    numberOr0(split.stats.hitByPitch);
  return derived === 0 ? split : { ...split, stats: { ...split.stats, plateAppearances: derived } };
}

/**
 * Group the window's splits into rows and aggregate each group.
 *
 * `idlePlayers` are the active players with no line in the window; each becomes
 * a zero row. The caller decides which table they belong to (batters), so the
 * policy is visible at the call site rather than buried in a statType branch.
 */
function buildRows(
  splits: Split[],
  window: ResolvedWindow,
  statType: "batting" | "pitching",
  idlePlayers: PlayerRow[],
): DigestRow[] {
  const groups = new Map<string, Split[]>();
  const gamesPerPlayer = new Map<number, Set<number>>();
  for (const split of splits) {
    const key =
      window.groupBy === "game"
        ? `${split.line.playerId}:${split.line.gameId}`
        : `${split.line.playerId}:${split.line.sportId}`;
    const bucket = groups.get(key) ?? [];
    groups.set(key, bucket);
    bucket.push(split);

    const games = gamesPerPlayer.get(split.line.playerId) ?? new Set<number>();
    gamesPerPlayer.set(split.line.playerId, games);
    games.add(split.line.gameId);
  }

  const rows: DigestRow[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    // A 1d table carries no opponent column, so two games on one date would
    // otherwise render as two identical rows. Gm disambiguates them, and is
    // left null for anyone who played once.
    const doubleheader =
      window.groupBy === "game" && (gamesPerPlayer.get(first.line.playerId)?.size ?? 0) > 1;
    rows.push({
      player: toRenderPlayer(first.player),
      lvl: levelAbbrev(first.line.sportId, first.line.leagueName),
      lvlRank: levelRank(first.line.sportId),
      gameNumber: doubleheader ? first.line.gameNumber : null,
      agg: aggregate(
        statType,
        bucket.map((s) => s.stats),
      ),
      qualityStarts: statType === "pitching" ? countQualityStarts(bucket) : 0,
    });
  }

  for (const player of idlePlayers) {
    // No stat line to read a sportId from, so this is the one place a level
    // legitimately comes from the player row: he played nowhere in the window.
    const sportId = sportIdForPlayer(player) ?? -1;
    rows.push({
      player: toRenderPlayer(player),
      lvl: levelAbbrev(sportId, null),
      lvlRank: levelRank(sportId),
      gameNumber: null,
      agg: aggregate(statType, []),
      qualityStarts: 0,
    });
  }

  return rows.sort(
    (a, b) =>
      a.lvlRank - b.lvlRank ||
      a.player.fullName.localeCompare(b.player.fullName) ||
      (a.gameNumber ?? 0) - (b.gameNumber ?? 0),
  );
}

/**
 * QS is not a source field — it is computed per game and counted here, while
 * the per-game rows are still in hand. A window's QS is a COUNT of qualifying
 * games, never a flag: summed outs and summed earned runs cannot recover it.
 */
function countQualityStarts(bucket: Split[]): number {
  return bucket.filter((s) => {
    const ip = s.stats.inningsPitched;
    // Same coercion as src/stats/aggregate.ts, so this count and the summed
    // outs it sits beside can never disagree about what an IP value means.
    const outs = ipToOuts(typeof ip === "string" ? ip : String(ip));
    return qualityStart(outs, numberOr0(s.stats.earnedRuns)) === 1;
  }).length;
}

/**
 * The current season's regular-season start (sportId 1), or null when no
 * calendar row is cached — in which case `ytd` falls back to January 1
 * (src/domain/window.ts), matching the fail-open posture of season.ts.
 */
function seasonStartFor(calendars: CalendarEntry[], now: Date, tz: string): string | null {
  const season = hostDate(now, tz).slice(0, 4);
  return (
    calendars.find((c) => c.sportId === 1 && c.season === season)?.regularSeasonStart ?? null
  );
}

function toRenderPlayer(player: PlayerRow): RenderPlayer {
  return {
    fullName: player.fullName,
    level: player.level,
    milbLevel: player.milbLevel,
    teamName: player.teamName,
    schoolName: player.schoolName,
  };
}

/** A stat value as a number; a missing or non-numeric value is 0. */
function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
