import type { NewStatLineRow } from "../db/schema.js";
import { NCAA_SPORT_ID } from "../mlb/levels.js";
import type { NcaaGameLogRow } from "./parse.js";
import type { NcaaStatCategory } from "./seasons.js";

/**
 * Turn parsed NCAA game-log rows into Stat Line rows (ADR 0032, ADR 0029).
 *
 * Game ID is the source contest id when the page exposes one; when it does not
 * we synthesize a deterministic 31-bit id from the row's identity so the ADR
 * 0029 upsert key stays stable across re-fetches. Hash-derived ids are flagged
 * inside `raw` (gameIdSource) so nothing downstream mistakes one for a real
 * contest id.
 */

const NCAA_GAME_TYPE = "R";

/**
 * Normalize every parsed row for one player + one stat category into Stat Line
 * rows, assigning per-date game numbers (1-based) for doubleheaders.
 */
export function normalizeGameLog(params: {
  playerId: number;
  seq: number;
  category: NcaaStatCategory;
  rows: NcaaGameLogRow[];
  timestamp: string;
}): NewStatLineRow[] {
  const { playerId, seq, category, rows, timestamp } = params;
  const seenOnDate = new Map<string, number>();
  return rows.map((row) => {
    const indexOnDate = seenOnDate.get(row.date) ?? 0;
    seenOnDate.set(row.date, indexOnDate + 1);
    return normalizeRow({ playerId, seq, category, row, indexOnDate, timestamp });
  });
}

function normalizeRow(params: {
  playerId: number;
  seq: number;
  category: NcaaStatCategory;
  row: NcaaGameLogRow;
  indexOnDate: number;
  timestamp: string;
}): NewStatLineRow {
  const { playerId, seq, category, row, indexOnDate, timestamp } = params;
  const gameIdSource = row.contestId !== null ? "contest" : "hash";
  const gameId =
    row.contestId ??
    fnv1a31(`${seq}|${row.date}|${row.opponentName}|${indexOnDate}`);

  return {
    playerId,
    gameId,
    statType: category,
    gameDate: row.date,
    gameNumber: indexOnDate + 1,
    gameType: NCAA_GAME_TYPE,
    isHome: row.isHome,
    opponentName: row.opponentName,
    teamName: null,
    sportId: NCAA_SPORT_ID,
    leagueName: null,
    stats: row.stats,
    raw: { ...row, gameIdSource },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * FNV-1a hash folded to a positive 31-bit integer — deterministic (same input
 * → same id) and collision-resistant enough for a single player's game set,
 * which is all the ADR 0029 key needs.
 */
export function fnv1a31(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff;
}
