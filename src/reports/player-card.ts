import type Database from "better-sqlite3";
import type { Db } from "../db/client.js";
import { canonicalizeName } from "../domain/names.js";
import { hostDate, sportIdForPlayer } from "../domain/season.js";
import { levelAbbrev, levelRank } from "../mlb/levels.js";
import { aggregate, deriveAllRates } from "../stats/aggregate.js";
import type { Aggregate } from "../stats/aggregate.js";

/** Player-relative windows are intentionally distinct from date WindowSpec. */
export const PLAYER_CARD_WINDOWS = ["last10", "last30", "ytd"] as const;
export type PlayerCardWindowSpec = (typeof PLAYER_CARD_WINDOWS)[number];

export interface PlayerCardInput {
  id?: number;
  name?: string;
  windows?: readonly PlayerCardWindowSpec[];
  now: () => Date;
  tz: string;
}

export interface PlayerCardPlayer {
  id: number;
  fullName: string;
  level: string;
  milbLevel: string | null;
  teamName: string | null;
  schoolName: string | null;
}

export interface PlayerCardRow {
  lvl: string;
  lvlRank: number;
  aggregate: Aggregate;
  rates: Record<string, string>;
}

export interface PlayerCardWindow {
  spec: PlayerCardWindowSpec;
  requestedGames: number | null;
  actualGames: number;
  from: string | null;
  to: string | null;
  empty: boolean;
  batters: PlayerCardRow[];
  pitchers: PlayerCardRow[];
}

export interface PlayerCard {
  player: PlayerCardPlayer;
  windows: PlayerCardWindow[];
}

export class PlayerCardNotFoundError extends Error {
  constructor(idOrName: number | string) {
    super(typeof idOrName === "number" ? `no player with id=${idOrName}` : `no player named "${idOrName}"`);
    this.name = "PlayerCardNotFoundError";
  }
}

export class AmbiguousPlayerCardNameError extends Error {
  readonly candidates: Array<{ id: number; fullName: string }>;

  constructor(name: string, candidates: Array<{ id: number; fullName: string }>) {
    super(`more than one player named "${name}"; use id instead`);
    this.name = "AmbiguousPlayerCardNameError";
    this.candidates = candidates;
  }
}

type SqliteDb = Db & { $client: Database.Database };

interface RawPlayer {
  id: number;
  full_name: string;
  level: string;
  milb_level: string | null;
  team_name: string | null;
  school_name: string | null;
  position: string | null;
}

interface RawLine {
  id: number;
  source: string;
  game_id: number;
  stat_type: "batting" | "pitching" | "fielding";
  game_date: string;
  game_number: number;
  sport_id: number;
  league_name: string | null;
  stats: string;
}
type ParsedLine = Omit<RawLine, "stats"> & { stats: Record<string, unknown> };

interface GameKey { source: string; gameId: number; gameDate: string }

/**
 * Build one player's card inside ONE synchronous better-sqlite3 read
 * transaction. The driver iterator bounds the game scan to the selected games;
 * no async callback can accidentally commit the snapshot before its reads.
 */
export function assemblePlayerCard(db: Db, input: PlayerCardInput): PlayerCard {
  const sqlite = (db as SqliteDb).$client;
  const specs = input.windows === undefined ? [...PLAYER_CARD_WINDOWS] : [...input.windows];
  // A card is a completed-game report like the Digest: including the current
  // host date would expose a partial day and make results depend on run hour.
  const lastCompletedDate = shiftDate(hostDate(input.now(), input.tz), -1);

  return sqlite.transaction(() => {
    const player = resolvePlayer(sqlite, input);
    const cardPlayer: PlayerCardPlayer = {
      id: player.id,
      fullName: player.full_name,
      level: player.level,
      milbLevel: player.milb_level,
      teamName: player.team_name,
      schoolName: player.school_name,
    };
    return {
      player: cardPlayer,
      windows: specs.map((spec) => assembleWindow(sqlite, player, spec, lastCompletedDate)),
    };
  })();
}

function resolvePlayer(sqlite: Database.Database, input: PlayerCardInput): RawPlayer {
  if (input.id !== undefined) {
    const row = sqlite.prepare("SELECT id, full_name, level, milb_level, team_name, school_name, position FROM players WHERE id = ?").get(input.id) as RawPlayer | undefined;
    if (row === undefined) throw new PlayerCardNotFoundError(input.id);
    return row;
  }
  const name = canonicalizeName(input.name!);
  const rows = sqlite.prepare("SELECT id, full_name, level, milb_level, team_name, school_name, position FROM players WHERE full_name = ? ORDER BY id ASC").all(name) as RawPlayer[];
  if (rows.length === 0) throw new PlayerCardNotFoundError(name);
  if (rows.length > 1) throw new AmbiguousPlayerCardNameError(name, rows.map((row) => ({ id: row.id, fullName: row.full_name })));
  return rows[0]!;
}

function assembleWindow(
  sqlite: Database.Database,
  player: RawPlayer,
  spec: PlayerCardWindowSpec,
  lastCompletedDate: string,
): PlayerCardWindow {
  const bounds = ytdBounds(sqlite, player, lastCompletedDate, spec);
  const games = selectGames(sqlite, player.id, spec === "last10" ? 10 : spec === "last30" ? 30 : null, bounds);
  if (games.length === 0) {
    return { spec, requestedGames: requestedGames(spec), actualGames: 0, from: null, to: null, empty: true, batters: [], pitchers: [] };
  }
  const lines = loadLines(sqlite, player.id, games);
  return {
    spec,
    requestedGames: requestedGames(spec),
    actualGames: games.length,
    from: games.reduce((min, game) => game.gameDate < min ? game.gameDate : min, games[0]!.gameDate),
    to: games.reduce((max, game) => game.gameDate > max ? game.gameDate : max, games[0]!.gameDate),
    empty: false,
    ...buildRows(lines),
  };
}

function requestedGames(spec: PlayerCardWindowSpec): number | null {
  return spec === "last10" ? 10 : spec === "last30" ? 30 : null;
}

function ytdBounds(sqlite: Database.Database, player: RawPlayer, lastCompletedDate: string, spec: PlayerCardWindowSpec): { from: string; to: string } | null {
  if (spec !== "ytd") return null;
  const sportId = sportIdForPlayer({ level: player.level as "mlb" | "milb" | "ncaa", milbLevel: player.milb_level });
  const season = lastCompletedDate.slice(0, 4);
  const start = sportId === null
    ? undefined
    : (sqlite.prepare("SELECT regular_season_start FROM season_calendar WHERE sport_id = ? AND season = ?").get(sportId, season) as { regular_season_start: string | null } | undefined)?.regular_season_start ?? undefined;
  return { from: start ?? `${season}-01-01`, to: lastCompletedDate };
}

function selectGames(sqlite: Database.Database, playerId: number, limit: number | null, bounds: { from: string; to: string } | null): GameKey[] {
  const clauses = ["player_id = ?", "game_type = 'R'"];
  const params: Array<number | string> = [playerId];
  if (bounds !== null) {
    clauses.push("game_date >= ?", "game_date <= ?");
    params.push(bounds.from, bounds.to);
  }
  const sql = `SELECT id, source, game_id, game_date FROM stat_lines WHERE ${clauses.join(" AND ")} ORDER BY game_date DESC, game_number DESC, id DESC`;
  const selected: GameKey[] = [];
  const seen = new Set<string>();
  for (const row of sqlite.prepare(sql).iterate(...params) as Iterable<{ source: string; game_id: number; game_date: string }>) {
    const key = `${row.source}\u0000${row.game_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ source: row.source, gameId: row.game_id, gameDate: row.game_date });
    if (limit !== null && selected.length === limit) break;
  }
  return selected;
}

function loadLines(sqlite: Database.Database, playerId: number, games: readonly GameKey[]): RawLine[] {
  const identitySql = games.map(() => "(source = ? AND game_id = ?)").join(" OR ");
  const params: Array<number | string> = [playerId];
  for (const game of games) params.push(game.source, game.gameId);
  return sqlite.prepare(`SELECT id, source, game_id, stat_type, game_date, game_number, sport_id, league_name, stats FROM stat_lines WHERE player_id = ? AND game_type = 'R' AND (${identitySql})`).all(...params) as RawLine[];
}

function buildRows(lines: RawLine[]): Pick<PlayerCardWindow, "batters" | "pitchers"> {
  const parsed = lines.map((line) => ({ ...line, stats: jsonRecord(line.stats) }));
  const batting = new Map<string, { line: ParsedLine; stats: Record<string, unknown> }>();
  const pitched = new Set(parsed.filter((line) => line.stat_type === "pitching").map(gameKey));
  for (const line of parsed.filter((line) => line.stat_type === "batting")) batting.set(gameKey(line), { line, stats: { ...line.stats } });
  for (const line of parsed.filter((line) => line.stat_type === "fielding")) {
    const key = gameKey(line);
    const target = batting.get(key);
    if (target !== undefined) target.stats.errors = numberOr0(line.stats.errors);
    else if (!pitched.has(key) && line.source !== "highlightly_ncaa") batting.set(key, { line, stats: { errors: numberOr0(line.stats.errors) } });
  }
  // A player-card reports the stat types actually present. In particular,
  // Highlightly NCAA rows can have no reliable `players.position`; routing a
  // null position as a batter would silently discard real pitching lines.
  const batters = groupRows([...batting.values()], "batting");
  const pitchers = groupRows(parsed.filter((line) => line.stat_type === "pitching").map((line) => ({ line, stats: line.stats })), "pitching");
  return { batters, pitchers };
}

function groupRows(
  lines: Array<{ line: ParsedLine; stats: Record<string, unknown> }>,
  statType: "batting" | "pitching",
): PlayerCardRow[] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const metadata = new Map<string, { lvl: string; lvlRank: number }>();
  for (const item of lines) {
    const key = `${item.line.sport_id}\u0000${item.line.league_name ?? ""}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(withPlateAppearances(item.stats, statType));
    groups.set(key, bucket);
    metadata.set(key, { lvl: levelAbbrev(item.line.sport_id, item.line.league_name), lvlRank: levelRank(item.line.sport_id) });
  }
  return [...groups].map(([key, stats]) => {
    const aggregateResult = aggregate(statType, stats);
    return { ...metadata.get(key)!, aggregate: aggregateResult, rates: deriveAllRates(aggregateResult) };
  }).sort((a, b) => a.lvlRank - b.lvlRank || a.lvl.localeCompare(b.lvl));
}

function gameKey(line: { source: string; game_id: number }): string { return `${line.source}\u0000${line.game_id}`; }
function jsonRecord(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function numberOr0(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function withPlateAppearances(stats: Record<string, unknown>, statType: "batting" | "pitching"): Record<string, unknown> {
  if (statType !== "batting" || numberOr0(stats.plateAppearances) > 0) return stats;
  const plateAppearances = numberOr0(stats.atBats) + numberOr0(stats.baseOnBalls) + numberOr0(stats.hitByPitch);
  return plateAppearances === 0 ? stats : { ...stats, plateAppearances };
}

/** Calendar-date arithmetic stays correct at host-timezone DST boundaries. */
function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
