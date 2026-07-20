import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, statLines } from "../src/db/schema.js";
import { upsertStatLines } from "../src/jobs/refresh.js";
import { insertDelivery, insertPlayer, insertStatLine, testDb } from "./factories.js";

describe("stat_lines schema invariants (ADR 0029)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("rejects a duplicate [player_id, game_id, stat_type] at the DATABASE level", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "batting" });
    await expect(
      insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "batting" }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("stores a doubleheader as two rows: same date, two gamePks", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 777001,
      gameDate: "2026-06-01",
      gameNumber: 1,
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 777002,
      gameDate: "2026-06-01",
      gameNumber: 2,
    });
    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.gameDate)).toEqual(["2026-06-01", "2026-06-01"]);
    expect(new Set(rows.map((r) => r.gameId)).size).toBe(2);
  });

  it("allows batting, pitching, AND fielding lines for the same game", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "batting" });
    await insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "pitching" });
    await insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "fielding" });
    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows).toHaveLength(3);
    // But a SECOND fielding row for the same game hits the unique key.
    await expect(
      insertStatLine(opened.db, { playerId: player.id, gameId: 777001, statType: "fielding" }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a duplicate ncaa_player_seq at the DATABASE level (ADR 0032)", async () => {
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      fullName: "College One",
      schoolName: "LSU",
    });
    await expect(
      insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        fullName: "College Two",
        schoolName: "Texas",
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("allows many MLB rows with a null ncaa_player_seq (nullable identity split)", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertPlayer(opened.db, { externalId: 660271, level: "mlb", milbLevel: null });
    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ncaaPlayerSeq === null)).toBe(true);
  });

  it("upsert on conflict updates stats but preserves digest_delivery_id and created_at", async () => {
    const player = await insertPlayer(opened.db);
    const delivery = await insertDelivery(opened.db);
    const original = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 777001,
      statType: "batting",
      stats: { hits: 1, atBats: 4 },
      digestDeliveryId: delivery.id,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await upsertStatLines(opened.db, [
      {
        playerId: player.id,
        gameId: 777001,
        statType: "batting",
        gameDate: original.gameDate,
        gameNumber: 1,
        gameType: "R",
        isHome: true,
        opponentName: "Charlotte Knights",
        teamName: "Jacksonville Jumbo Shrimp",
        sportId: 11,
        leagueName: "International League",
        stats: { hits: 2, atBats: 4 },
        raw: { corrected: true },
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ]);

    const rows = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, player.id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect((row?.stats as Record<string, unknown>).hits).toBe(2);
    expect(row?.digestDeliveryId).toBe(delivery.id); // correction stays quiet (ADR 0030)
    expect(row?.createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(row?.updatedAt).toBe("2026-07-02T00:00:00.000Z");
  });
});
