import { formatOuts } from "../digest/rates.js";
import { formatDateRange, shortDate } from "../domain/window.js";
import type { Column } from "../presentation/table.js";
import {
  escapeHtml,
  htmlDocument,
  htmlTable,
  levelBreakIndexes,
  mlbDividerIndex,
  textTable,
} from "../presentation/table.js";
import type { PlayerCard, PlayerCardPlayer, PlayerCardRow, PlayerCardWindow, PlayerCardWindowSpec } from "./player-card.js";
import { cardWindowIsLong } from "./player-card.js";

/**
 * Player Card Presentations: the console rendering and the standalone HTML
 * document (ADR 0055). Both are PURE functions over an assembled `PlayerCard` —
 * no db, no clock, no I/O — so every surface (CLI, MCP, REST) renders the same
 * bytes for the same card and none of them can drift into its own layout.
 *
 * ONE TABLE PER CARD WINDOW, not the windows side by side (ADR 0055 consequence
 * 1). The payoff is that BB%/K% appear and disappear per window exactly as they
 * do in the Digest, via `cardWindowIsLong`, instead of becoming dashed-out cells.
 *
 * The ~35 stat headers below are the Digest's, in the Digest's order, so the
 * same player reads the same way in both reports. The ACCESSORS are not shared:
 * a `PlayerCardRow` has `aggregate` (not `agg`), and carries no `player`,
 * `gameNumber`, or span fields, because a Card is one player over several
 * windows rather than a cohort over one (ADR 0055 consequence 3).
 *
 * Names are NOT ASCII-folded. This is a human-facing app report rendering player
 * identity for the HC to read, which is exactly the UTF-8 scope of ADR 0047 /
 * `rules/scripting.md`; a mangled `Acu?a` here is the regression.
 */

/** Fallback console width for a redirected pipe or a CI runner (no TTY). */
export const DEFAULT_CARD_WIDTH = 100;

/** The line a window with no rows renders — never a blank table. */
export const NO_GAMES_LINE = "no games in window";

/**
 * A TOTAL map, like `CARD_WINDOW_REPORT_SPEC` in the assembler: a fourth Card
 * Window fails to compile rather than rendering an `undefined` heading.
 */
const CARD_WINDOW_LABELS: Readonly<Record<PlayerCardWindowSpec, string>> = {
  last10: "Last 10 games",
  last30: "Last 30 games",
  ytd: "Year to date",
};

const counter =
  (key: string): Column<PlayerCardRow>["value"] =>
  (row) =>
    String(row.aggregate.counters[key] ?? 0);

/**
 * Rates come from the row's OWN `rates` map — the very values the JSON surface
 * publishes — rather than being recomputed here, so a Presentation cannot
 * disagree with the JSON of the same card about the same number.
 */
const rate =
  (key: string): Column<PlayerCardRow>["value"] =>
  (row) =>
    row.rates[key] ?? "-";

/** OPS renders ".000" rather than "-" on a zero denominator, as in the Digest. */
const ops: Column<PlayerCardRow>["value"] = (row) => {
  const value = row.rates.ops ?? "-";
  return value === "-" ? ".000" : value;
};

/**
 * `Lvl` is kept even for a single-level Card: level is a property of the GAME,
 * so a player promoted mid-window has one row per level and the column is what
 * says which is which. `GP` is the window's real game count for that level.
 */
const LEAD_COLUMNS: ReadonlyArray<Column<PlayerCardRow>> = [
  { header: "Lvl", align: "left", value: (r) => r.lvl },
  { header: "GP", align: "right", value: (r) => String(r.aggregate.games) },
];

function battingColumns(spec: PlayerCardWindowSpec): Column<PlayerCardRow>[] {
  return [
    ...LEAD_COLUMNS,
    { header: "PA", align: "right", value: counter("plateAppearances") },
    // Left-aligned like the Digest's: rate values are fixed width, so they stay
    // aligned either way, and a right-padded OPS header floats off its column.
    { header: "OPS", align: "left", value: ops },
    // Display-only derived rates, on the LONG windows only — ten games is too
    // few a sample for a rate to mean much, thirty is not.
    ...(cardWindowIsLong(spec)
      ? ([
          { header: "BB%", align: "right", value: rate("walkPct") },
          { header: "K%", align: "right", value: rate("kPct") },
        ] as Column<PlayerCardRow>[])
      : []),
    { header: "H", align: "right", value: counter("hits") },
    { header: "BB", align: "right", value: counter("baseOnBalls") },
    { header: "K", align: "right", value: counter("strikeOuts") },
    { header: "2B", align: "right", value: counter("doubles") },
    { header: "3B", align: "right", value: counter("triples") },
    { header: "HR", align: "right", value: counter("homeRuns") },
    { header: "RBI", align: "right", value: counter("rbi") },
    { header: "R", align: "right", value: counter("runs") },
    { header: "SB", align: "right", value: counter("stolenBases") },
    { header: "CS", align: "right", value: counter("caughtStealing") },
    // Merged in from the same game's fielding row (ADR 0033).
    { header: "E", align: "right", value: counter("errors") },
  ];
}

function pitchingColumns(): Column<PlayerCardRow>[] {
  return [
    ...LEAD_COLUMNS,
    { header: "IP", align: "right", value: (r) => formatOuts(r.aggregate.outs) },
    { header: "ER", align: "right", value: counter("earnedRuns") },
    { header: "K", align: "right", value: counter("strikeOuts") },
    { header: "K/9", align: "right", value: rate("strikeoutsPer9Inn") },
    { header: "BB", align: "right", value: counter("baseOnBalls") },
    { header: "HA", align: "right", value: counter("hits") },
    { header: "HRA", align: "right", value: counter("homeRuns") },
    { header: "ERA", align: "right", value: rate("era") },
    { header: "WHIP", align: "right", value: rate("whip") },
    // Per-game COUNTS the summed aggregate cannot recover (ADR 0036) — the
    // three fields #141 added to the assembler.
    { header: "QS", align: "right", value: (r) => String(r.qualityStarts) },
    { header: "S", align: "right", value: counter("saves") },
    { header: "BS", align: "right", value: counter("blownSaves") },
    { header: "HLD", align: "right", value: counter("holds") },
    { header: "RW", align: "right", value: (r) => String(r.reliefWins) },
    { header: "RL", align: "right", value: (r) => String(r.reliefLosses) },
  ];
}

/** "MLB - Philadelphia Phillies"; an NCAA player shows his school in the same slot (ADR 0032). */
function describePlayer(player: PlayerCardPlayer): string {
  return [player.level.toUpperCase(), player.milbLevel, player.teamName, player.schoolName]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(" - ");
}

/**
 * "Last 30 games - 12 games (Jul 3-18)". The window's own from..to range is
 * honest for a Card because it covers ONE player, which is exactly why ADR 0055
 * dropped the Digest's per-row `Span`.
 */
function windowHeading(window: PlayerCardWindow): string {
  const label = CARD_WINDOW_LABELS[window.spec];
  const games = `${window.actualGames} ${window.actualGames === 1 ? "game" : "games"}`;
  if (window.from === null || window.to === null) return `${label} - ${games}`;
  const range = window.from === window.to ? shortDate(window.from) : formatDateRange(window.from, window.to);
  return `${label} - ${games} (${range})`;
}

interface CardSection {
  title: string;
  columns: Column<PlayerCardRow>[];
  rows: PlayerCardRow[];
}

/**
 * A window's NON-empty sections. An absent section is omitted entirely rather
 * than rendered as an empty table — a batter's Card should not carry a
 * headed-but-empty Pitching table in every window.
 */
function sectionsOf(window: PlayerCardWindow): CardSection[] {
  return [
    { title: "Batting", columns: battingColumns(window.spec), rows: window.batters },
    { title: "Pitching", columns: pitchingColumns(), rows: window.pitchers },
  ].filter((section) => section.rows.length > 0);
}

export interface PlayerCardTextOptions {
  /**
   * Terminal width. The CLI passes `process.stdout.columns`, which is
   * `undefined` under a redirected pipe or on CI — hence the fallback. It sizes
   * the header rule ONLY: tables are never truncated or reflowed, so a narrow
   * width can never corrupt column alignment.
   */
  width?: number;
}

export function renderPlayerCardText(card: PlayerCard, options: PlayerCardTextOptions = {}): string {
  const meta = describePlayer(card.player);
  const heading = meta.length > 0 ? [card.player.fullName, meta] : [card.player.fullName];

  const body: string[] = [];
  for (const window of card.windows) {
    body.push(windowHeading(window), "");
    const sections = sectionsOf(window);
    if (sections.length === 0) {
      body.push(NO_GAMES_LINE, "");
      continue;
    }
    for (const section of sections) {
      body.push(
        section.title,
        ...textTable(section.columns, section.rows, mlbDividerIndex(section.rows), levelBreakIndexes(section.rows)),
        "",
      );
    }
  }

  const width = Math.max(1, options.width ?? DEFAULT_CARD_WIDTH);
  const contentWidth = [...heading, ...body].reduce((max, line) => Math.max(max, line.length), 0);
  const rule = "=".repeat(Math.max(1, Math.min(width, contentWidth)));
  return `${[...heading, rule, "", ...body].join("\n").trimEnd()}\n`;
}

/**
 * Card CSS. A `<style>` BLOCK, never `style=` attributes: this is a standalone
 * document, so it does NOT inherit `rules/frontend.md`'s mailer exception the
 * way the Digest's email body does — which is why `htmlTable` is asked for
 * `styling: "class"` below.
 *
 * The `@media print` block is what replaces the PDF renderer #141 asked for
 * (ADR 0055): a page break between Card Windows, repeating table headers across
 * pages, and grayscale-safe black-on-white, so browser print -> Save as PDF
 * produces the paginated document, with zero new dependencies.
 */
export const PLAYER_CARD_HTML_STYLE =
  "body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:1rem;color:#111}" +
  "h1{font-size:1.5rem;margin-bottom:0.2rem}h2{font-size:1.15rem}h3{font-size:1rem;margin-bottom:0.3rem}" +
  ".player-meta{margin-top:0;color:#555}" +
  ".card-window{margin-bottom:1.5rem}" +
  ".empty-window{font-style:italic;color:#555}" +
  "table{border-collapse:collapse;margin-bottom:1rem}" +
  "th,td{border:1px solid #ddd;padding:2px 8px}" +
  "th{background:#f5f5f5}" +
  ".ta-left{text-align:left}.ta-right{text-align:right}" +
  "td.level-divider{padding:0}" +
  "td.level-divider hr{border:none;border-top:1px solid #ccc;margin:4px 0}" +
  "@media print{" +
  "body{margin:0;color:#000;background:#fff}" +
  ".card-window{page-break-after:always;break-after:page}" +
  ".card-window:last-child{page-break-after:auto;break-after:auto}" +
  "thead{display:table-header-group}" +
  "tr{page-break-inside:avoid;break-inside:avoid}" +
  "th{background:#fff;border-bottom:2px solid #000}" +
  "th,td{border-color:#000}" +
  ".player-meta,.empty-window{color:#000}" +
  "}";

export function renderPlayerCardHtml(card: PlayerCard): string {
  const meta = describePlayer(card.player);
  // EVERY dynamic value is escaped, not just the player's name: a team or school
  // name carrying `<`, `&`, or `"` comes from an external source and is the
  // realistic case. The <title> is escaped by `htmlDocument`, which owns it.
  const parts: string[] = [`<h1>${escapeHtml(card.player.fullName)}</h1>`];
  if (meta.length > 0) parts.push(`<p class="player-meta">${escapeHtml(meta)}</p>`);

  for (const window of card.windows) {
    parts.push('<section class="card-window">', `<h2>${escapeHtml(windowHeading(window))}</h2>`);
    const sections = sectionsOf(window);
    if (sections.length === 0) {
      parts.push(`<p class="empty-window">${escapeHtml(NO_GAMES_LINE)}</p>`);
    }
    for (const section of sections) {
      parts.push(
        `<h3>${escapeHtml(section.title)}</h3>`,
        htmlTable(
          section.columns,
          section.rows,
          mlbDividerIndex(section.rows),
          levelBreakIndexes(section.rows),
          { styling: "class" },
        ),
      );
    }
    parts.push("</section>");
  }

  return htmlDocument(`${card.player.fullName} - Player Card`, PLAYER_CARD_HTML_STYLE, parts.join("\n"));
}
