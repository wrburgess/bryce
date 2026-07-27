/**
 * Presentation primitives — the table and document machinery every report's
 * human-readable rendering is built from.
 *
 * Extracted from `src/digest/render.ts` (#141) when the Player Card became the
 * SECOND report needing them. ADR 0055 widened Presentation from "a rendering of
 * a whole Digest" to "a rendering of a whole report", so these live in one
 * report-neutral home rather than being reached for across `src/digest/`.
 *
 * Everything here is a pure function over a caller-supplied `Column<T>[]`: the
 * primitives never know what a row IS, so a Digest row and a Player Card row —
 * which share no fields — drive the same code with no union type and no cast.
 * Column DEFINITIONS stay with their report; only the machinery is shared.
 */

export interface Column<T> {
  header: string;
  /** Right-aligned for numbers, left for names. */
  align: "left" | "right";
  value: (row: T) => string;
}

/**
 * Escape the four characters that are unsafe in the two contexts a value reaches
 * in these renderers: an element text node and a double-quoted attribute value.
 * A raw apostrophe (`O'Reilly`) is deliberately NOT escaped — it is safe in both
 * of those contexts, and every value here is emitted in one of them (`<td>`
 * text, `text-align: "..."`), never in a single-quoted attribute. Non-ASCII
 * letters (accents, wide characters) pass through untouched — these documents
 * are UTF-8 (#65 / ADR 0041).
 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const GUTTER = "  ";

/**
 * Row index to draw the MLB / Other-Levels rule at: after the last MLB
 * (lvlRank===0) row, but only when the table has BOTH an MLB row and a
 * non-MLB row. null => no rule (one side absent).
 */
export function mlbDividerIndex<T extends { lvlRank: number }>(rows: readonly T[]): number | null {
  const lastMlb = rows.reduce((idx, r, i) => (r.lvlRank === 0 ? i : idx), -1);
  const hasOther = rows.some((r) => r.lvlRank > 0);
  return lastMlb >= 0 && hasOther ? lastMlb + 1 : null;
}

/** Indexes before rows that begin a new level. */
export function levelBreakIndexes<T extends { lvlRank: number }>(rows: readonly T[]): number[] {
  return rows.flatMap((row, index) => (index > 0 && row.lvlRank !== rows[index - 1]!.lvlRank ? [index] : []));
}

export function textTable<T>(
  columns: readonly Column<T>[],
  rows: readonly T[],
  dividerAfter: number | null = null,
  levelBreaks: number[] = [],
): string[] {
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  // Column widths use String#length (UTF-16 code units), which equals the
  // monospace display width for the Latin (incl. NFC-accented) names both
  // sources actually emit. It would UNDER-count an East-Asian wide glyph
  // (`鈴木`.length === 2, but it occupies 4 columns), misaligning that one
  // row. That case is deliberately out of scope (#65 / ADR 0041): the MLB and
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
  const maxLineWidth = lines.reduce((max, l) => Math.max(max, l.length), 0);
  for (const index of [...levelBreaks].reverse()) {
    const insertAt = 1 + index;
    const divider = dividerAfter === index ? ["-".repeat(maxLineWidth)] : [];
    lines.splice(insertAt, 0, ...divider, line(columns.map((c) => c.header)));
  }
  return lines;
}

/**
 * How `htmlTable` carries alignment, chosen by the CONSUMING document rather
 * than fixed here, because the two consumers sit on opposite sides of
 * `rules/frontend.md`'s inline-style rule:
 *
 * - `"inline"` (the DEFAULT, so the Digest's bytes are unchanged) emits
 *   `style="text-align: …"` on every cell. The Digest's HTML is an EMAIL BODY,
 *   which is the rule's own documented exception ("Mailer/email templates, which
 *   require inline CSS for email-client compatibility") — refactoring it to
 *   classes would BREAK email-client rendering to satisfy a rule that exempts it.
 * - `"class"` emits `class="ta-left"` / `class="ta-right"` and a class-based
 *   divider, with the declarations living in the document's own `<style>` block.
 *   A standalone document does NOT inherit the mailer exception, so the rule
 *   applies to it and this is how it complies.
 */
export interface HtmlTableOptions {
  styling?: "inline" | "class";
}

export function htmlTable<T>(
  columns: readonly Column<T>[],
  rows: readonly T[],
  dividerAfter: number | null = null,
  levelBreaks: number[] = [],
  options: HtmlTableOptions = {},
): string {
  const styling = options.styling ?? "inline";
  const attribute = (align: Column<T>["align"]): string =>
    styling === "class" ? ` class="ta-${align}"` : ` style="text-align: ${align}; padding: 2px 6px"`;
  const cell = (tag: "th" | "td", align: Column<T>["align"], value: string): string =>
    `<${tag}${attribute(align)}>${escapeHtml(value)}</${tag}>`;
  const dividerRow =
    styling === "class"
      ? `<tr><td colspan="${columns.length}" class="level-divider"><hr /></td></tr>`
      : `<tr><td colspan="${columns.length}" style="padding: 0"><hr style="border: none; border-top: 1px solid #ccc; margin: 4px 0" /></td></tr>`;
  const head = columns.map((col) => cell("th", col.align, col.header)).join("");
  const bodyRows = rows.map(
    (row) => `<tr>${columns.map((col) => cell("td", col.align, col.value(row))).join("")}</tr>`,
  );
  for (const index of [...levelBreaks].reverse()) {
    const divider = dividerAfter === index ? [dividerRow] : [];
    bodyRows.splice(index, 0, ...divider, `<tr>${head}</tr>`);
  }
  return `<table cellspacing="0" cellpadding="0"><thead><tr>${head}</tr></thead><tbody>${bodyRows.join("")}</tbody></table>`;
}

/**
 * The standalone-HTML-document shell every Presentation shares (ADR 0037): a
 * `<!doctype html>` page with a charset, a `<title>`, and the caller's CSS,
 * wrapping an already-rendered body fragment.
 *
 * The title is escaped HERE, so no caller can forget: it is the one dynamic
 * value that is interpolated OUTSIDE `htmlTable` and would otherwise reach the
 * document unescaped by construction.
 */
export function htmlDocument(title: string, style: string, bodyHtml: string): string {
  return (
    "<!doctype html>\n" +
    "<html>\n" +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head>\n` +
    `<body>\n${bodyHtml}\n</body>\n` +
    "</html>\n"
  );
}
