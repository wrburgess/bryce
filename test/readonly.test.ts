import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  READONLY_ROW_CAP,
  ReadonlyQueryError,
  openReadonlyDb,
  runReadonlyQuery,
} from "../src/db/readonly.js";
import type { TempFileDb } from "./factories.js";
import { insertPlayer, insertStatLine, testFileDb } from "./factories.js";

describe("runReadonlyQuery", () => {
  let temp: TempFileDb;
  let readonly: ReturnType<typeof openReadonlyDb>;

  beforeEach(async () => {
    temp = testFileDb();
    const player = await insertPlayer(temp.opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(temp.opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    readonly = openReadonlyDb(temp.path);
  });

  afterEach(() => {
    readonly.close();
    temp.cleanup();
  });

  it("runs SELECT with params and returns columns and rows", async () => {
    const result = runReadonlyQuery(
      readonly.sqlite,
      "SELECT full_name, level FROM players WHERE full_name = ?",
      ["Maximo Acosta"],
    );
    expect(result.columns).toEqual(["full_name", "level"]);
    expect(result.rows).toEqual([["Maximo Acosta", "milb"]]);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("runs WITH (CTE) and EXPLAIN", () => {
    const cte = runReadonlyQuery(
      readonly.sqlite,
      "WITH names(n) AS (SELECT full_name FROM players) SELECT n FROM names",
    );
    expect(cte.rows).toEqual([["Maximo Acosta"]]);

    const explain = runReadonlyQuery(readonly.sqlite, "EXPLAIN QUERY PLAN SELECT * FROM players");
    expect(explain.rowCount).toBeGreaterThan(0);
  });

  it("rejects INSERT / UPDATE / DELETE / DDL / PRAGMA", () => {
    const attempts = [
      "INSERT INTO players (full_name, level, created_at, updated_at) VALUES ('x','mlb','t','t')",
      "UPDATE players SET full_name = 'hacked'",
      "DELETE FROM players",
      "CREATE TABLE evil (id integer)",
      "DROP TABLE players",
      "ALTER TABLE players ADD COLUMN evil text",
      "PRAGMA journal_mode = DELETE",
      "PRAGMA user_version",
    ];
    for (const sql of attempts) {
      expect(() => runReadonlyQuery(readonly.sqlite, sql), sql).toThrow(ReadonlyQueryError);
    }
    // Nothing changed.
    const check = runReadonlyQuery(readonly.sqlite, "SELECT count(*) FROM players");
    expect(check.rows).toEqual([[1]]);
  });

  it("rejects a write dressed up behind an allowed keyword (stmt.readonly guard)", () => {
    // First keyword passes the allowlist; the compiled statement does not.
    expect(() =>
      runReadonlyQuery(
        readonly.sqlite,
        "WITH x(n) AS (SELECT 1) DELETE FROM players WHERE id IN (SELECT n FROM x)",
      ),
    ).toThrow("statement is not read-only");
  });

  it("rejects multi-statement strings", () => {
    expect(() => runReadonlyQuery(readonly.sqlite, "SELECT 1; SELECT 2")).toThrow(
      ReadonlyQueryError,
    );
    expect(() =>
      runReadonlyQuery(readonly.sqlite, "SELECT 1; DROP TABLE players"),
    ).toThrow(ReadonlyQueryError);
  });

  it("rejects empty SQL, bad param types, and a wrong param count", () => {
    expect(() => runReadonlyQuery(readonly.sqlite, "   ")).toThrow(ReadonlyQueryError);
    expect(() =>
      runReadonlyQuery(readonly.sqlite, "SELECT ?", [{ evil: true } as unknown as string]),
    ).toThrow(ReadonlyQueryError);
    expect(() => runReadonlyQuery(readonly.sqlite, "SELECT ? AS a, ? AS b", ["only-one"])).toThrow(
      ReadonlyQueryError,
    );
  });

  it("caps rows at READONLY_ROW_CAP and flags truncation", () => {
    const result = runReadonlyQuery(
      readonly.sqlite,
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 500) SELECT x FROM cnt",
    );
    expect(result.rowCount).toBe(READONLY_ROW_CAP);
    expect(result.rows).toHaveLength(READONLY_ROW_CAP);
    expect(result.truncated).toBe(true);
  });

  it("rejects an oversized result (size sanity, not just row count)", () => {
    expect(() => runReadonlyQuery(readonly.sqlite, "SELECT randomblob(500000)")).toThrow(
      ReadonlyQueryError,
    );
  });

  it("the readonly connection refuses writes even when the guard is bypassed", () => {
    // Straight to better-sqlite3, skipping runReadonlyQuery entirely.
    expect(() => readonly.sqlite.prepare("DELETE FROM players").run()).toThrow(
      /readonly|attempt to write/i,
    );
    const check = runReadonlyQuery(readonly.sqlite, "SELECT count(*) FROM players");
    expect(check.rows).toEqual([[1]]);
  });
});

describe("openReadonlyDb", () => {
  it("refuses a missing file (fileMustExist)", () => {
    expect(() => openReadonlyDb("/nonexistent/bryce.db")).toThrow();
  });
});
