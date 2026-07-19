import Database from "better-sqlite3";

/**
 * Read-only SQL execution for the MCP sql_query tool (ADR 0027). Defense in
 * depth (rules/security.md — fail closed):
 *
 *   1. an allowlisted first keyword (SELECT / WITH / EXPLAIN / VALUES),
 *   2. better-sqlite3's compiled-statement `stmt.readonly` verdict (catches
 *      anything the keyword check would miss), and
 *   3. in production the connection itself is opened read-only
 *      (`openReadonlyDb`), so even a guard bypass cannot write.
 *
 * Single statement only (better-sqlite3 `prepare` rejects multi-statement
 * strings), row-capped, and size-capped.
 */

export const READONLY_ROW_CAP = 200;
export const READONLY_MAX_RESULT_BYTES = 256 * 1024;

const ALLOWED_FIRST_KEYWORD = /^(select|with|explain|values)\b/i;

export class ReadonlyQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadonlyQueryError";
  }
}

export type SqlParam = string | number | null;
export type SqlValue = string | number | null;

export interface ReadonlyQueryResult {
  columns: string[];
  rows: SqlValue[][];
  rowCount: number;
  /** True when the row cap cut the result off. */
  truncated: boolean;
}

export function runReadonlyQuery(
  sqlite: Database.Database,
  sqlText: string,
  params: readonly SqlParam[] = [],
): ReadonlyQueryResult {
  const text = sqlText.trim();
  if (text.length === 0) {
    throw new ReadonlyQueryError("empty SQL statement");
  }
  if (!ALLOWED_FIRST_KEYWORD.test(text)) {
    throw new ReadonlyQueryError(
      "only read queries are allowed (SELECT, WITH, EXPLAIN, VALUES)",
    );
  }
  for (const param of params) {
    if (param !== null && typeof param !== "string" && typeof param !== "number") {
      throw new ReadonlyQueryError("params must be strings, numbers, or null");
    }
  }

  let stmt: Database.Statement;
  try {
    // better-sqlite3 rejects multi-statement strings at prepare time.
    stmt = sqlite.prepare(text);
  } catch (err) {
    throw new ReadonlyQueryError(
      `invalid SQL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stmt.readonly) {
    throw new ReadonlyQueryError("statement is not read-only");
  }
  if (!stmt.reader) {
    // Read-only but returns no rows: nothing to execute, nothing to return.
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  const columns = stmt.columns().map((c) => c.name);
  stmt.raw(true);
  const rows: SqlValue[][] = [];
  let truncated = false;
  let bytes = 0;
  try {
    for (const raw of stmt.iterate(...params)) {
      if (rows.length >= READONLY_ROW_CAP) {
        truncated = true;
        break;
      }
      const row = (raw as unknown[]).map(normalizeValue);
      bytes += approximateSize(row);
      if (bytes > READONLY_MAX_RESULT_BYTES) {
        throw new ReadonlyQueryError(
          `result too large (over ${READONLY_MAX_RESULT_BYTES} bytes); narrow the query`,
        );
      }
      rows.push(row);
    }
  } catch (err) {
    if (err instanceof ReadonlyQueryError) throw err;
    // Bind/step failures (wrong param count, runtime SQL errors) stay typed.
    throw new ReadonlyQueryError(
      `query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

/** SQLite values that don't survive JSON: BLOBs become base64, bigints strings. */
function normalizeValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return String(value);
}

function approximateSize(row: SqlValue[]): number {
  let size = 2;
  for (const value of row) {
    size += value === null ? 4 : String(value).length + 2;
  }
  return size;
}

export interface OpenedReadonlyDb {
  sqlite: Database.Database;
  close: () => void;
}

/**
 * A second, genuinely read-only connection to the live database file for
 * production wiring — SQLite itself refuses writes on it, independent of the
 * statement guard above.
 */
export function openReadonlyDb(databasePath: string): OpenedReadonlyDb {
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  return { sqlite, close: () => sqlite.close() };
}
