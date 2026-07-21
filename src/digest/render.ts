import type { DigestAssembly, DigestRow } from "./assemble.js";
import type { ResolvedWindow } from "../domain/window.js";
import type { Level } from "../mlb/levels.js";
import { deriveRate } from "../stats/aggregate.js";
import { formatOuts } from "./rates.js";

/**
 * Digest rendering: HTML + plain-text parts, readable in iPhone Mail.
 *
 * A window renders as TWO TABLES — Batters and Pitchers — each row carrying a
 * `Lvl` column (windowed Digest spec). That replaces the old level-section
 * grouping: level is a property of the GAME, so a player who was promoted
 * mid-window has one row per level, and a section heading could not say that.
 *
 * The stat set is the ADR 0033 fixed format — every stat always shown, zeros
 * included, in the established order — transposed from comma-joined prose into
 * columns. Both parts render from one `Column[]`, so text and HTML cannot
 * diverge in content.
 */

export interface RenderPlayer {
  fullName: string;
  level: Level;
  milbLevel: string | null;
  teamName: string | null;
  /** NCAA school; shown where teamName is shown for ncaa-level Players (ADR 0032). */
  schoolName: string | null;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface Column {
  header: string;
  /** Right-aligned for numbers, left for names. */
  align: "left" | "right";
  value: (row: DigestRow) => string;
}

/** "Bryce Harper" -> "B Harper"; a single-word name is left alone. */
function abbreviate(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length < 2 ? fullName : `${parts[0]![0]} ${parts.slice(1).join(" ")}`;
}

const counter =
  (key: string): Column["value"] =>
  (row) =>
    String(row.agg.counters[key] ?? 0);

const rate =
  (key: string): Column["value"] =>
  (row) =>
    deriveRate(row.agg, key);

/**
 * AVG/OBP/SLG from the SUMMED counters. A zero denominator renders ".000"
 * rather than deriveRate's "-": an idle player's row reads as a zero line, and
 * a pinch-runner with no at-bats did bat .000, which is the conventional
 * baseball display.
 */
const slashLine: Column["value"] = (row) =>
  ["avg", "obp", "slg"]
    .map((key) => {
      const value = deriveRate(row.agg, key);
      return value === "-" ? ".000" : value;
    })
    .join("/");

const PLAYER_COLUMNS: Column[] = [
  { header: "Player", align: "left", value: (r) => abbreviate(r.player.fullName) },
  { header: "Lvl", align: "left", value: (r) => r.lvl },
];

/**
 * The two layouts differ in exactly two ways: a 1d window carries `Gm` (to tell
 * a doubleheader's two rows apart, since there is no opponent column) and no
 * `GP`, which would always be 1; an aggregated window carries `GP` and, for
 * batters, a leading slash line.
 */
function leadColumns(window: ResolvedWindow, statType: "batting" | "pitching"): Column[] {
  if (window.groupBy === "game") {
    return [
      {
        header: "Gm",
        align: "right",
        value: (r) => (r.gameNumber === null ? "" : String(r.gameNumber)),
      },
    ];
  }
  const gp: Column = { header: "GP", align: "right", value: (r) => String(r.agg.games) };
  return statType === "batting"
    // Left, unlike every other non-name column: slash lines are fixed width, so
    // they stay aligned either way, and a right-padded "Batting" header floats
    // away from the column it names.
    ? [gp, { header: "Batting", align: "left", value: slashLine }]
    : [gp];
}

function battingColumns(window: ResolvedWindow): Column[] {
  return [
    ...PLAYER_COLUMNS,
    ...leadColumns(window, "batting"),
    // PA is a summed counter; assemble.ts derives it per game when the
    // source omits it, so the fallback lives at the grain it is true at.
    { header: "PA", align: "right", value: counter("plateAppearances") },
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

function pitchingColumns(window: ResolvedWindow): Column[] {
  return [
    ...PLAYER_COLUMNS,
    ...leadColumns(window, "pitching"),
    { header: "IP", align: "right", value: (r) => formatOuts(r.agg.outs) },
    { header: "ER", align: "right", value: counter("earnedRuns") },
    { header: "K", align: "right", value: counter("strikeOuts") },
    { header: "K/9", align: "right", value: rate("strikeoutsPer9Inn") },
    { header: "BB", align: "right", value: counter("baseOnBalls") },
    { header: "HA", align: "right", value: counter("hits") },
    { header: "HRA", align: "right", value: counter("homeRuns") },
    { header: "ERA", align: "right", value: rate("era") },
    { header: "WHIP", align: "right", value: rate("whip") },
    { header: "S", align: "right", value: counter("saves") },
    { header: "HLD", align: "right", value: counter("holds") },
    // A COUNT of qualifying games, not a per-game flag: QS is not a source
    // field and cannot be recovered from summed outs and earned runs.
    { header: "QS", align: "right", value: (r) => String(r.qualityStarts) },
  ];
}

const GUTTER = "  ";

function textTable(columns: Column[], rows: DigestRow[]): string[] {
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    cells.reduce((max, rowCells) => Math.max(max, rowCells[i]!.length), col.header.length),
  );
  const line = (values: string[]): string =>
    values
      .map((value, i) =>
        columns[i]!.align === "left" ? value.padEnd(widths[i]!) : value.padStart(widths[i]!),
      )
      .join(GUTTER)
      // Trailing pad on the last column is invisible noise in a mail client.
      .trimEnd();
  return [line(columns.map((c) => c.header)), ...cells.map(line)];
}

function htmlTable(columns: Column[], rows: DigestRow[]): string {
  const cell = (tag: "th" | "td", align: Column["align"], value: string): string =>
    `<${tag} style="text-align: ${align}; padding: 2px 6px">${escapeHtml(value)}</${tag}>`;
  const head = columns.map((col) => cell("th", col.align, col.header)).join("");
  const body = rows
    .map(
      (row) => `<tr>${columns.map((col) => cell("td", col.align, col.value(row))).join("")}</tr>`,
    )
    .join("");
  return `<table cellspacing="0" cellpadding="0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

interface Table {
  title: string;
  columns: Column[];
  rows: DigestRow[];
}

export function renderDigest(assembly: DigestAssembly): RenderedMail {
  const { window } = assembly;
  const heading = `Bryce - ${window.label}`;

  // An empty table is omitted rather than rendered as a bare heading: a watch
  // list with no pitchers should not carry an empty Pitchers section daily.
  const tables: Table[] = [
    { title: "Batters", columns: battingColumns(window), rows: assembly.batters },
    { title: "Pitchers", columns: pitchingColumns(window), rows: assembly.pitchers },
  ].filter((t) => t.rows.length > 0);

  const textParts: string[] = [heading, ""];
  const htmlParts: string[] = [`<h1>${escapeHtml(heading)}</h1>`];

  if (tables.length === 0) {
    // Still sent: "send daily even when empty" survives the redesign (ADR 0030).
    textParts.push("No games in this window.", "");
    htmlParts.push("<p>No games in this window.</p>");
  }

  for (const table of tables) {
    textParts.push(table.title, ...textTable(table.columns, table.rows), "");
    htmlParts.push(`<h2>${escapeHtml(table.title)}</h2>`, htmlTable(table.columns, table.rows));
  }

  return {
    subject: `Bryce - ${window.label}`,
    text: `${textParts.join("\n").trimEnd()}\n`,
    html: htmlParts.join("\n"),
  };
}

export function renderHeartbeat(args: {
  date: string;
  playerCount: number;
  nextOpeningDay: string | null;
}): RenderedMail {
  const { date, playerCount, nextOpeningDay } = args;
  const resume = nextOpeningDay ?? "TBD";
  const body = `alive; ${playerCount} players watched; games resume ~${resume}`;
  return {
    subject: `Bryce heartbeat - ${date}`,
    text: `${body}\n`,
    html: `<p>${escapeHtml(body)}</p>`,
  };
}
