import * as cheerio from "cheerio";
import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import { z } from "zod";

/**
 * Parse a stats.ncaa.org game-log page into validated rows (ADR 0032, ADR
 * 0025 boundary rigor). Loud on a malformed/shifted table: a missing game-log
 * table or absent expected columns throws, never silently yields garbage.
 *
 * PROVENANCE / caveat: the live page could not be captured in this environment
 * (Akamai bot protection), so the selectors below are modelled faithfully on
 * the two reference scrapers (billpetti/baseballr `ncaa_game_logs.R` and
 * nathanblumenfeld/collegebaseball `ncaa_scraper.py`) — the game-log table has
 * a Date / Opponent / Result header followed by per-game stat columns, plus a
 * trailing season-totals row. The name/school selectors especially want a
 * live confirmation via `npm run ncaa:probe` on the host. All of this is
 * isolated here so a correction touches one file.
 */

const NcaaGameLogRowSchema = z.object({
  /** ISO date (YYYY-MM-DD), converted from the page's MM/DD/YYYY. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  opponentName: z.string().min(1),
  /** Source contest id from the row's box-score/contest anchor; null when absent. */
  contestId: z.number().int().positive().nullable(),
  result: z.string(),
  /** true = home, false = away, null = neutral / unknown. */
  isHome: z.boolean().nullable(),
  /** Stat cells keyed by column header (e.g. AB, H, HR / IP, ER, SO). */
  stats: z.record(z.string(), z.unknown()),
});
export type NcaaGameLogRow = z.infer<typeof NcaaGameLogRowSchema>;

export interface NcaaGameLogPage {
  fullName: string;
  schoolName: string;
  rows: NcaaGameLogRow[];
}

const FIXED_COLUMNS = new Set(["Date", "Opponent", "Result"]);
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Parse a full game-log HTML page. Throws on a structurally broken table. */
export function parseGameLogPage(html: string): NcaaGameLogPage {
  const $ = cheerio.load(html);

  const fullName = squish($("title").first().text());
  if (fullName.length === 0) {
    throw new Error("NCAA game-log page: could not extract player name");
  }
  const schoolName = squish($(".card-header a").first().text());
  if (schoolName.length === 0) {
    throw new Error("NCAA game-log page: could not extract school name");
  }

  const table = findGameLogTable($);
  if (table === null) {
    throw new Error(
      "NCAA game-log page: no game-log table (expected Date/Opponent/Result columns)",
    );
  }

  const headers = tableHeaders($, table);
  for (const required of FIXED_COLUMNS) {
    if (!headers.includes(required)) {
      throw new Error(`NCAA game-log table missing required column: ${required}`);
    }
  }

  const rows: NcaaGameLogRow[] = [];
  table.find("tbody tr").each((_, tr) => {
    const parsed = parseRow($, $(tr), headers);
    if (parsed !== null) rows.push(NcaaGameLogRowSchema.parse(parsed));
  });

  return { fullName, schoolName, rows };
}

/** The game-log table is the one whose header row carries Date/Opponent/Result. */
function findGameLogTable($: cheerio.CheerioAPI): Cheerio<AnyNode> | null {
  let found: Cheerio<AnyNode> | null = null;
  $("table").each((_, el) => {
    if (found !== null) return;
    const headers = tableHeaders($, $(el));
    if (FIXED_COLUMNS.size <= headers.filter((h) => FIXED_COLUMNS.has(h)).length) {
      found = $(el);
    }
  });
  return found;
}

function tableHeaders($: cheerio.CheerioAPI, table: Cheerio<AnyNode>): string[] {
  const headerCells = table.find("thead tr").first().find("th");
  return headerCells.map((_, th) => squish($(th).text())).get();
}

/**
 * Parse one data row. Returns null for the season-totals row (its Date cell is
 * not a real date) so it is excluded from storage.
 */
function parseRow(
  $: cheerio.CheerioAPI,
  tr: Cheerio<AnyNode>,
  headers: string[],
): NcaaGameLogRow | null {
  const cells = tr.find("td");
  if (cells.length === 0) return null;

  const byHeader = new Map<string, Cheerio<AnyNode>>();
  cells.each((i, td) => {
    const header = headers[i];
    if (header !== undefined) byHeader.set(header, $(td));
  });

  const dateCell = byHeader.get("Date");
  const isoDate = dateCell !== undefined ? toIsoDate(squish(dateCell.text())) : null;
  // A non-date Date cell (e.g. "Totals") marks the season-totals row: excluded.
  if (isoDate === null) return null;

  const opponentCell = byHeader.get("Opponent");
  const opponentText = opponentCell !== undefined ? squish(opponentCell.text()) : "";
  const { opponentName, isHome } = parseOpponent(opponentText);

  const resultCell = byHeader.get("Result");
  const result = resultCell !== undefined ? squish(resultCell.text()) : "";
  const contestId = extractContestId($, tr);

  const stats: Record<string, unknown> = {};
  for (const header of headers) {
    if (FIXED_COLUMNS.has(header)) continue;
    const cell = byHeader.get(header);
    if (cell === undefined) continue;
    stats[header] = coerceStat(squish(cell.text()));
  }

  return { date: isoDate, opponentName, contestId, result, isHome, stats };
}

/**
 * Opponent prefix: leading "@" = away, leading "vs" = home, anything else
 * (including a neutral-site "Team1 @ Team2" form) = unknown.
 */
function parseOpponent(text: string): { opponentName: string; isHome: boolean | null } {
  if (text.startsWith("@")) {
    return { opponentName: squish(text.slice(1)), isHome: false };
  }
  if (/^vs\b/i.test(text)) {
    return { opponentName: squish(text.replace(/^vs\b\.?/i, "")), isHome: true };
  }
  return { opponentName: text, isHome: null };
}

/** First anchor in the row pointing at a box score / contest / game, id parsed out. */
function extractContestId($: cheerio.CheerioAPI, tr: Cheerio<AnyNode>): number | null {
  let id: number | null = null;
  tr.find("a").each((_, a) => {
    if (id !== null) return;
    const href = $(a).attr("href") ?? "";
    if (!/box_score|\/contests?\/|\/game\//.test(href)) return;
    const match = href.match(/(\d+)/g);
    if (match !== null && match.length > 0) {
      const n = Number(match[match.length - 1]);
      if (Number.isInteger(n) && n > 0) id = n;
    }
  });
  return id;
}

/** Integer-looking cells become numbers; everything else (IP "5.1", "-") stays a string. */
function coerceStat(value: string): unknown {
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function toIsoDate(value: string): string | null {
  const m = value.match(MDY);
  if (m === null) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

function squish(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
