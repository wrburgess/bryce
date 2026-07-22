import { describe, expect, it } from "vitest";
import type { ReadonlyQueryResult } from "../src/db/readonly.js";
import { sqlResultToCsv, statLinesToCsv } from "../src/export/tabular.js";
import type { StatLineView } from "../src/queries/statLines.js";

/**
 * The tabular Export shapers (ADR 0037). The header row is a FIXED constant, so
 * an empty result is still a valid single-header file; `isHome`, `null`, and the
 * `stats` JSON blob get the documented encoding; and both shapers inherit the
 * CSV writer's guard/quoting.
 */

const HEADER =
  "id,playerId,playerName,level,milbLevel,gameId,statType,gameDate,gameNumber,gameType,isHome,opponentName,teamName,sportId,leagueName,stats";

function view(overrides: Partial<StatLineView> = {}): StatLineView {
  return {
    id: 1,
    playerId: 2,
    playerName: "Maximo Acosta",
    level: "milb",
    milbLevel: "Triple-A",
    gameId: 900500,
    statType: "batting",
    gameDate: "2026-07-18",
    gameNumber: 1,
    gameType: "R",
    isHome: true,
    opponentName: "Charlotte Knights",
    teamName: "Jacksonville Jumbo Shrimp",
    sportId: 11,
    leagueName: "International League",
    stats: { hits: 2, atBats: 4 },
    ...overrides,
  };
}

describe("statLinesToCsv", () => {
  it("emits the FIXED header line even for an empty result (never derived from a row)", () => {
    expect(statLinesToCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("encodes isHome true/false/null as true/false/empty", () => {
    const csv = statLinesToCsv([
      view({ id: 1, isHome: true }),
      view({ id: 2, isHome: false }),
      view({ id: 3, isHome: null }),
    ]);
    const lines = csv.split("\r\n");
    // isHome is the 11th column (index 10).
    expect(lines[1]?.split(",")[10]).toBe("true");
    expect(lines[2]?.split(",")[10]).toBe("false");
    expect(lines[3]?.split(",")[10]).toBe("");
  });

  it("renders every other null as an empty field", () => {
    const csv = statLinesToCsv([view({ milbLevel: null, opponentName: null, teamName: null, leagueName: null })]);
    const row = csv.split("\r\n")[1]!.split(",");
    expect(row[4]).toBe(""); // milbLevel
  });

  it("serialises stats as compact JSON, quoted because it holds commas and quotes", () => {
    const csv = statLinesToCsv([view({ stats: { a: 1, b: "x,y" } })]);
    expect(csv).toContain('"{""a"":1,""b"":""x,y""}"');
  });

  it("renders a null stats blob as the JSON literal null", () => {
    const csv = statLinesToCsv([view({ stats: null })]);
    const row = csv.split("\r\n")[1]!;
    expect(row.endsWith(",null")).toBe(true);
  });

  it("formula-guards a dangerous player name flowing into a cell", () => {
    const csv = statLinesToCsv([view({ playerName: "=DANGER" })]);
    expect(csv).toContain(",'=DANGER,");
    expect(csv).not.toContain(",=DANGER,");
  });
});

describe("sqlResultToCsv", () => {
  it("renders columns and rows, numbers as text and null as empty", () => {
    const result: ReadonlyQueryResult = {
      columns: ["a", "b"],
      rows: [["x", 1], [null, 2]],
      rowCount: 2,
      truncated: false,
    };
    expect(sqlResultToCsv(result)).toBe("a,b\r\nx,1\r\n,2\r\n");
  });

  it("formula-guards a dangerous cell VALUE and a dangerous column ALIAS", () => {
    const result: ReadonlyQueryResult = {
      columns: ["=evil", "plain"],
      rows: [["=danger", "@bad"]],
      rowCount: 1,
      truncated: false,
    };
    expect(sqlResultToCsv(result)).toBe("'=evil,plain\r\n'=danger,'@bad\r\n");
  });

  it("emits a header-only file for an empty result set", () => {
    const result: ReadonlyQueryResult = { columns: ["a"], rows: [], rowCount: 0, truncated: false };
    expect(sqlResultToCsv(result)).toBe("a\r\n");
  });
});
