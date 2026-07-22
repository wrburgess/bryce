/**
 * A dependency-free RFC-4180 CSV writer with an OWASP formula-injection guard
 * (rules/security.md — normalize hostile input at the boundary). Every value a
 * CSV surface emits — a watch-list player name, a SQL result cell, a column
 * alias — funnels through `csvCell`, so a spreadsheet can never be tricked into
 * treating stored text as a formula, and a comma or quote in a name can never
 * break the column grid.
 *
 * Two independent transforms, applied in this order to STRING cells:
 *   1. Formula guard — a leading `= + - @` TAB or CR turns the cell into a live
 *      formula in Excel/Sheets; prefix a `'` to neutralise it. A plain numeric
 *      literal is exempt, so negative numbers and rates stay usable.
 *   2. RFC-4180 quoting — a field containing `"` `,` CR or LF is wrapped in
 *      double quotes with every embedded `"` doubled.
 * A NUMBER cell is never formula-guarded (it is not attacker-controlled text)
 * and a `null` cell is the empty field.
 */

export type CsvCell = string | number | null;

/**
 * A cell whose leading character makes a spreadsheet evaluate it as a formula.
 * Includes CR *and* LF: a value like "\n=HYPERLINK(...)" is still a live formula
 * once pasted, and RFC-4180 quoting preserves the newline without neutralising it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r\n]/;

/** A plain numeric literal, exempt from the formula guard (e.g. "-5", ".333"). */
const NUMERIC_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Characters that force RFC-4180 quoting of a field. */
const NEEDS_QUOTING = /["\r\n,]/;

function guardFormula(value: string): string {
  return FORMULA_LEAD.test(value) && !NUMERIC_LITERAL.test(value) ? `'${value}` : value;
}

function quoteField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * One cell as its CSV field. Exported for unit coverage of the guard/quote
 * rules in isolation.
 */
export function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return quoteField(guardFormula(value));
}

/**
 * Render `headers` + `rows` as CSV. Every row — the header row included — is
 * terminated by CRLF, so the output always ends with a trailing CRLF and a
 * header-only table is a single terminated line.
 */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const encodeRow = (cells: CsvCell[]): string => cells.map(csvCell).join(",");
  return [headers, ...rows].map((row) => `${encodeRow(row)}\r\n`).join("");
}
