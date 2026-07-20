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
 * Header → canonical stat key, per category. The digest renderer (and the MLB
 * pipeline it was built for) reads MLB Stats API keys (`atBats`, `hits`,
 * `inningsPitched`, …), so the adapter translates the scraped column headers
 * here — nothing outside `src/ncaa/` knows the page's vocabulary. Headers with
 * no mapping pass through under their page name (still queryable, ignored by
 * the renderer).
 */
const BATTING_HEADER_MAP: Record<string, string> = {
  AB: "atBats",
  R: "runs",
  H: "hits",
  "2B": "doubles",
  "3B": "triples",
  HR: "homeRuns",
  RBI: "rbi",
  BB: "baseOnBalls",
  K: "strikeOuts",
  SO: "strikeOuts",
  SB: "stolenBases",
  CS: "caughtStealing",
  HBP: "hitByPitch",
};

const PITCHING_HEADER_MAP: Record<string, string> = {
  IP: "inningsPitched",
  H: "hits",
  R: "runs",
  ER: "earnedRuns",
  BB: "baseOnBalls",
  SO: "strikeOuts",
  K: "strikeOuts",
  W: "wins",
  L: "losses",
  SV: "saves",
  BF: "battersFaced",
};

/**
 * Translate header-keyed cells into canonical stat keys with numeric values
 * (`inningsPitched` stays a string, matching the MLB game-log shape the
 * renderer expects). Non-numeric cells ("-", "") map to no canonical entry, so
 * the renderer treats them as 0 rather than NaN.
 */
export function canonicalizeStats(
  category: NcaaStatCategory,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const map = category === "batting" ? BATTING_HEADER_MAP : PITCHING_HEADER_MAP;
  const out: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(raw)) {
    const canonical = map[header.toUpperCase()];
    if (canonical === undefined) {
      out[header] = value;
      continue;
    }
    if (canonical === "inningsPitched") {
      // Keep only numeric-looking IP ("6", "6.1"); "-"/"" get no entry, so the
      // renderer falls back to "0.0 IP" instead of "- IP".
      const ip = typeof value === "number" ? String(value) : value;
      if (typeof ip === "string" && /^\d+(\.\d+)?$/.test(ip)) out[canonical] = ip;
      continue;
    }
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : NaN;
    if (Number.isFinite(n)) out[canonical] = n;
  }
  return out;
}

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
    stats: canonicalizeStats(category, row.stats),
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
