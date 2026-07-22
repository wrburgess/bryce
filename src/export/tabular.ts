import type { ReadonlyQueryResult } from "../db/readonly.js";
import type { StatLineView } from "../queries/statLines.js";
import type { CsvCell } from "./csv.js";
import { toCsv } from "./csv.js";

/**
 * Tabular Exports (ADR 0037): a stored stat-line set and an ad-hoc SQL result,
 * each rendered as ONE CSV table. Both defer every cell to `toCsv`, so the
 * formula-injection guard and RFC-4180 quoting are applied uniformly and are
 * tested once, in src/export/csv.ts.
 */

/**
 * The stat-line CSV column order — a fixed constant, never derived from a row,
 * so an EMPTY result still emits this exact header line and the columns never
 * shift with the data. `stats` is the JSON blob as one trailing column.
 */
const STAT_LINE_CSV_HEADERS = [
  "id",
  "playerId",
  "playerName",
  "level",
  "milbLevel",
  "gameId",
  "statType",
  "gameDate",
  "gameNumber",
  "gameType",
  "isHome",
  "opponentName",
  "teamName",
  "sportId",
  "leagueName",
  "stats",
];

export function statLinesToCsv(views: StatLineView[]): string {
  const rows: CsvCell[][] = views.map((v) => [
    v.id,
    v.playerId,
    v.playerName,
    v.level,
    v.milbLevel,
    v.gameId,
    v.statType,
    v.gameDate,
    v.gameNumber,
    v.gameType,
    // boolean|null -> "true"/"false"/empty; the writer takes string|number|null.
    v.isHome === null ? null : String(v.isHome),
    v.opponentName,
    v.teamName,
    v.sportId,
    v.leagueName,
    // Compact JSON so commas/quotes inside it are quoted by the CSV writer, not
    // mistaken for column separators.
    JSON.stringify(v.stats ?? null),
  ]);
  return toCsv(STAT_LINE_CSV_HEADERS, rows);
}

export function sqlResultToCsv(result: ReadonlyQueryResult): string {
  return toCsv(result.columns, result.rows);
}
