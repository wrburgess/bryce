import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { OpenedDb } from "../src/db/client.js";
import {
  STAT_LINES_DEFAULT_LIMIT,
  STAT_LINES_MAX_LIMIT,
  getPlayer,
  queryStatLines,
} from "../src/queries/statLines.js";
import { insertPlayer, insertStatLine, testDb } from "./factories.js";

describe("queryStatLines", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("filters by player and joins the player identity in one query", async () => {
    const acosta = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    const other = await insertPlayer(opened.db, { fullName: "Other Guy" });
    await insertStatLine(opened.db, { playerId: acosta.id, gameDate: "2026-07-10" });
    await insertStatLine(opened.db, { playerId: other.id, gameDate: "2026-07-11" });

    const rows = await queryStatLines(opened.db, { playerId: acosta.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      playerId: acosta.id,
      playerName: "Maximo Acosta",
      level: "milb",
      milbLevel: "Triple-A",
      gameDate: "2026-07-10",
      statType: "batting",
      opponentName: "Charlotte Knights",
    });
    expect((rows[0]?.stats as Record<string, unknown>).hits).toBe(2);
  });

  it("filters by level", async () => {
    const mlb = await insertPlayer(opened.db, { level: "mlb", milbLevel: null, fullName: "MLB Guy" });
    const aaa = await insertPlayer(opened.db, { fullName: "AAA Guy" });
    await insertStatLine(opened.db, { playerId: mlb.id, sportId: 1 });
    await insertStatLine(opened.db, { playerId: aaa.id });

    const rows = await queryStatLines(opened.db, { level: "mlb" });
    expect(rows.map((r) => r.playerName)).toEqual(["MLB Guy"]);
  });

  it("treats from/to as inclusive boundaries", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-09" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-10" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-15" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-16" });

    const rows = await queryStatLines(opened.db, { from: "2026-07-10", to: "2026-07-15" });
    expect(rows.map((r) => r.gameDate).sort()).toEqual(["2026-07-10", "2026-07-15"]);
  });

  it("returns both games of a doubleheader (same date, different gameId)", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880001,
      gameDate: "2026-06-01",
      gameNumber: 1,
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880002,
      gameDate: "2026-06-01",
      gameNumber: 2,
    });

    const rows = await queryStatLines(opened.db, { from: "2026-06-01", to: "2026-06-01" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.gameId))).toEqual(new Set([880001, 880002]));
    // Newest first: game 2 sorts before game 1 on the same date.
    expect(rows.map((r) => r.gameNumber)).toEqual([2, 1]);
  });

  it("applies the limit and defaults it", async () => {
    const player = await insertPlayer(opened.db);
    for (let i = 1; i <= 3; i += 1) {
      await insertStatLine(opened.db, { playerId: player.id, gameDate: `2026-07-0${i}` });
    }
    const limited = await queryStatLines(opened.db, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.gameDate)).toEqual(["2026-07-03", "2026-07-02"]);
    expect(STAT_LINES_DEFAULT_LIMIT).toBeLessThanOrEqual(STAT_LINES_MAX_LIMIT);
  });

  it("rejects a limit above the cap", async () => {
    await expect(
      queryStatLines(opened.db, { limit: STAT_LINES_MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects from > to", async () => {
    await expect(
      queryStatLines(opened.db, { from: "2026-07-20", to: "2026-07-01" }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects malformed dates and non-integer ids", async () => {
    await expect(queryStatLines(opened.db, { from: "07/20/2026" })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(queryStatLines(opened.db, { playerId: "abc" })).rejects.toBeInstanceOf(ZodError);
  });

  it("returns empty for no matches", async () => {
    expect(await queryStatLines(opened.db, {})).toEqual([]);
  });

  it("coerces string inputs (REST query params)", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    const rows = await queryStatLines(opened.db, { playerId: String(player.id), limit: "10" });
    expect(rows).toHaveLength(1);
  });
});

describe("getPlayer", () => {
  it("returns the row by internal id, or null", async () => {
    const opened = testDb();
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    expect((await getPlayer(opened.db, player.id))?.fullName).toBe("Maximo Acosta");
    expect(await getPlayer(opened.db, 9999)).toBeNull();
    opened.close();
  });
});
