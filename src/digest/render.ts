import type { DigestAssembly, DigestRow } from "./assemble.js";
import type { ResolvedWindow } from "../domain/window.js";
import { isLongWindow } from "../domain/window.js";
import type { DigestFreshness } from "../jobs/refresh-run.js";
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

/** "2026-07-30" → "Thu, July 30, 2026" (HC-specified subject date style). */
export function formatSubjectDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

/**
 * What the window is CALLED, in the subject and the body heading.
 *
 * A 1d window is a single date, so it keeps the established
 * "Sun, July 19, 2026" style — this is the artifact the HC receives daily, and
 * dropping the weekday and year to a bare "Jul 19" would be a quiet
 * information regression. Every other spec is a RANGE, which `window.label`
 * already describes.
 *
 * The two are not competing sources of truth: `window.label` owns range
 * descriptions, `formatSubjectDate` owns a single date.
 *
 * Note the date is `window.to` — the last COMPLETED day, so a run on July 19
 * is titled July 18. The title names the content, not the run.
 */
function windowTitle(window: ResolvedWindow): string {
  return window.spec === "1d" ? formatSubjectDate(window.to) : window.label;
}

/**
 * Escape the four characters that are unsafe in the two contexts a name reaches
 * in this renderer: an element text node and a double-quoted attribute value.
 * A raw apostrophe (`O'Reilly`) is deliberately NOT escaped — it is safe in both
 * of those contexts, and every value here is emitted in one of them (`<td>`
 * text, `text-align: "..."`), never in a single-quoted attribute. Non-ASCII
 * letters (accents, wide characters) pass through untouched — the digest is a
 * UTF-8 mail part (#65 / ADR 0039).
 */
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

/**
 * "Bryce Harper" -> "B Harper"; a single-word name is left alone. The first
 * name is reduced to its initial BY DESIGN, so an accent living in the first
 * name ("Acuña Jr." -> "A Jr.") is legitimately dropped with the rest of that
 * token — that is abbreviation, not corruption. The accent is preserved
 * wherever it lands in a retained token ("Ronald Acuña Jr." -> "R Acuña Jr.");
 * #65's fidelity fixtures assert that rendered form.
 */
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
    // BB%/K% are display-only derived rates, shown only on the >=21d windows —
    // a single week's plate appearances are too few for a rate to mean much.
    // They are recomputed from summed counters like every other rate (deriveRate).
    ...(isLongWindow(window.spec)
      ? ([
          { header: "BB%", align: "right", value: rate("walkPct") },
          { header: "K%", align: "right", value: rate("kPct") },
        ] as Column[])
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
    // A COUNT of qualifying games, not a per-game flag: QS is not a source
    // field and cannot be recovered from summed outs and earned runs.
    { header: "QS", align: "right", value: (r) => String(r.qualityStarts) },
    { header: "S", align: "right", value: counter("saves") },
    { header: "BS", align: "right", value: counter("blownSaves") },
    { header: "HLD", align: "right", value: counter("holds") },
    // RW/RL are relief decisions, likewise COUNTS across the window — a
    // starter's win or loss is never surfaced here (see isReliefAppearance).
    { header: "RW", align: "right", value: (r) => String(r.reliefWins) },
    { header: "RL", align: "right", value: (r) => String(r.reliefLosses) },
  ];
}

const GUTTER = "  ";

/**
 * Row index to draw the MLB / Other-Levels rule at: after the last MLB
 * (lvlRank===0) row, but only when the table has BOTH an MLB row and a
 * non-MLB row. null => no rule (one side absent).
 */
function mlbDividerIndex(rows: DigestRow[]): number | null {
  const lastMlb = rows.reduce((idx, r, i) => (r.lvlRank === 0 ? i : idx), -1);
  const hasOther = rows.some((r) => r.lvlRank > 0);
  return lastMlb >= 0 && hasOther ? lastMlb + 1 : null;
}

function textTable(columns: Column[], rows: DigestRow[], dividerAfter: number | null = null): string[] {
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  // Column widths use String#length (UTF-16 code units), which equals the
  // monospace display width for the Latin (incl. NFC-accented) names both
  // sources actually emit. It would UNDER-count an East-Asian wide glyph
  // (`鈴木`.length === 2, but it occupies 4 columns), misaligning that one
  // row. That case is deliberately out of scope (#65 / ADR 0039): the MLB and
  // NCAA sources return Latin transliterations only, the HTML part (the primary
  // artifact) aligns via <td> regardless of glyph width, and a full
  // East-Asian-width table would align characters the data cannot contain. Such
  // a name still round-trips intact — only its plain-text column may be ragged.
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
  const lines = [line(columns.map((c) => c.header)), ...cells.map(line)];
  if (dividerAfter !== null && dividerAfter > 0 && dividerAfter < rows.length) {
    const maxLineWidth = lines.reduce((max, l) => Math.max(max, l.length), 0);
    // +1 skips the header line so the rule lands after the last MLB data row.
    lines.splice(1 + dividerAfter, 0, "-".repeat(maxLineWidth));
  }
  return lines;
}

function htmlTable(columns: Column[], rows: DigestRow[], dividerAfter: number | null = null): string {
  const cell = (tag: "th" | "td", align: Column["align"], value: string): string =>
    `<${tag} style="text-align: ${align}; padding: 2px 6px">${escapeHtml(value)}</${tag}>`;
  const head = columns.map((col) => cell("th", col.align, col.header)).join("");
  const bodyRows = rows.map(
    (row) => `<tr>${columns.map((col) => cell("td", col.align, col.value(row))).join("")}</tr>`,
  );
  if (dividerAfter !== null && dividerAfter > 0 && dividerAfter < rows.length) {
    bodyRows.splice(
      dividerAfter,
      0,
      `<tr><td colspan="${columns.length}" style="padding: 0"><hr style="border: none; border-top: 1px solid #ccc; margin: 4px 0" /></td></tr>`,
    );
  }
  return `<table cellspacing="0" cellpadding="0"><thead><tr>${head}</tr></thead><tbody>${bodyRows.join("")}</tbody></table>`;
}

interface Table {
  title: string;
  columns: Column[];
  rows: DigestRow[];
}

/**
 * The hybrid-degrade banner (ADR 0042): a one-line staleness/incompleteness
 * warning prepended to a digest whose data a recent refresh could not vouch for.
 * A `fresh` reading (or no reading passed at all — a preview, an on-demand
 * report) yields null: no banner. The digest is NEVER suppressed; the warning
 * annotates the same email that would have gone out silently.
 */
function freshnessBanner(
  freshness: DigestFreshness,
  contentDate: string,
): { text: string; html: string } | null {
  if (freshness.state === "fresh") return null;
  const text =
    freshness.state === "stale"
      ? `⚠️ Data as of last successful refresh: ${freshness.asOf ?? "never"}; ` +
        `no refresh has run since ${contentDate} — stats may be non-final.`
      : `⚠️ Last refresh was incomplete (${freshness.playersRefreshed} of ` +
        `${freshness.playersTotal} watched players refreshed) — some players may be missing.`;
  return { text, html: `<p>${escapeHtml(text)}</p>` };
}

export function renderDigest(assembly: DigestAssembly, freshness?: DigestFreshness): RenderedMail {
  const { window } = assembly;
  const title = windowTitle(window);
  const heading = title;

  // An empty table is omitted rather than rendered as a bare heading: a watch
  // list with no pitchers should not carry an empty Pitchers section daily.
  const tables: Table[] = [
    { title: "Batters", columns: battingColumns(window), rows: assembly.batters },
    { title: "Pitchers", columns: pitchingColumns(window), rows: assembly.pitchers },
  ].filter((t) => t.rows.length > 0);

  // The banner prepends to BOTH bodies (the subject is untouched — it names the
  // content day, and a warning is not part of the day's identity).
  const banner = freshness === undefined ? null : freshnessBanner(freshness, window.to);
  const textParts: string[] = banner === null ? [heading, ""] : [banner.text, "", heading, ""];
  const htmlParts: string[] =
    banner === null
      ? [`<h1>${escapeHtml(heading)}</h1>`]
      : [banner.html, `<h1>${escapeHtml(heading)}</h1>`];

  if (tables.length === 0) {
    // Still sent: "send daily even when empty" survives the redesign (ADR 0030).
    textParts.push("No games in this window.", "");
    htmlParts.push("<p>No games in this window.</p>");
  }

  for (const table of tables) {
    const divider = mlbDividerIndex(table.rows);
    textParts.push(table.title, ...textTable(table.columns, table.rows, divider), "");
    htmlParts.push(
      `<h2>${escapeHtml(table.title)}</h2>`,
      htmlTable(table.columns, table.rows, divider),
    );
  }

  return {
    subject: `MLB Daily Tracker - ${title}`,
    text: `${textParts.join("\n").trimEnd()}\n`,
    html: htmlParts.join("\n"),
  };
}

/**
 * Escape a cell for a GFM table cell (ADR 0037). In order: `\` (so a later
 * escape is not itself re-escaped), `|` (the column separator — an unescaped
 * one would forge extra columns), CR/LF collapsed to a space (an embedded
 * newline would forge extra ROWS), then `<`/`>` (so an HTML-like value renders
 * as text, not markup, in a Markdown viewer that passes raw HTML through), then
 * the link/image delimiters `!` `[` `]` (so a value like `![x](http://evil/pixel)`
 * renders as literal text, not an auto-loaded image or link, in a Markdown viewer).
 */
function escapeMarkdownCell(s: string): string {
  return s
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("!", "\\!")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

/**
 * One GFM table: a header row, an alignment separator (`---:` right, `:---`
 * left, matching the column's own alignment), then one escaped data row per
 * DigestRow. Column headers are fixed literals, so only data cells are escaped.
 */
function markdownTable(columns: Column[], rows: DigestRow[]): string {
  const headerRow = `| ${columns.map((c) => c.header).join(" | ")} |`;
  const separator = `| ${columns.map((c) => (c.align === "right" ? "---:" : ":---")).join(" | ")} |`;
  const dataRows = rows.map(
    (row) => `| ${columns.map((c) => escapeMarkdownCell(c.value(row))).join(" | ")} |`,
  );
  return [headerRow, separator, ...dataRows].join("\n");
}

/** Minimal inline table styling for the standalone HTML Presentation document. */
const DIGEST_HTML_STYLE =
  "body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:1rem}" +
  "h1{font-size:1.4rem}h2{font-size:1.1rem}" +
  "table{border-collapse:collapse;margin-bottom:1rem}" +
  "th,td{border:1px solid #ddd;padding:2px 8px}" +
  "th{background:#f5f5f5}";

/**
 * The whole Digest as a Markdown Presentation (ADR 0037): a `# ` heading, then a
 * `## Batters`/`## Pitchers` GFM table per NON-empty table. An empty table is
 * omitted (mirrors renderDigest); if both are empty the body is the same "No
 * games in this window." line the email carries.
 */
export function renderDigestMarkdown(assembly: DigestAssembly): string {
  const { window } = assembly;
  // The bare title, mirroring the email's own h1 (no "Bryce - " prefix, #54).
  const parts: string[] = [`# ${windowTitle(window)}`];

  const tables: Table[] = [
    { title: "Batters", columns: battingColumns(window), rows: assembly.batters },
    { title: "Pitchers", columns: pitchingColumns(window), rows: assembly.pitchers },
  ].filter((t) => t.rows.length > 0);

  if (tables.length === 0) {
    parts.push("", "No games in this window.");
  }
  for (const table of tables) {
    parts.push("", `## ${table.title}`, "", markdownTable(table.columns, table.rows));
  }
  return parts.join("\n");
}

/**
 * The whole Digest as a standalone HTML Presentation document (ADR 0037): a
 * `<!doctype html>` page with a charset, a `<title>`, and minimal table CSS,
 * wrapping the SAME `renderDigest().html` fragment the email sends — the tables
 * are rendered (and escaped) exactly once, never re-implemented here.
 */
export function renderDigestHtmlDocument(assembly: DigestAssembly): string {
  // Document metadata (the browser tab / saved-file name) mirrors the email
  // subject; the body h1 is the bare title, from the reused renderDigest fragment.
  const title = escapeHtml(`MLB Daily Tracker - ${windowTitle(assembly.window)}`);
  return (
    "<!doctype html>\n" +
    "<html>\n" +
    `<head><meta charset="utf-8"><title>${title}</title><style>${DIGEST_HTML_STYLE}</style></head>\n` +
    `<body>\n${renderDigest(assembly).html}\n</body>\n` +
    "</html>\n"
  );
}

/**
 * One Digest table as an Export (ADR 0037): the window's own column headers and
 * one stringified row per DigestRow, ready for the CSV writer. Header-only (an
 * empty `rows`) when the table has no rows — the columns still come from the
 * window, so an empty Export is a valid single-header file.
 */
export function digestTableRows(
  assembly: DigestAssembly,
  table: "batters" | "pitchers",
): { headers: string[]; rows: string[][] } {
  const { window } = assembly;
  const columns = table === "batters" ? battingColumns(window) : pitchingColumns(window);
  const source = table === "batters" ? assembly.batters : assembly.pitchers;
  return {
    headers: columns.map((c) => c.header),
    rows: source.map((row) => columns.map((c) => c.value(row))),
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
