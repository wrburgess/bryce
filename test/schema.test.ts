import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { BUSY_TIMEOUT_MS } from "../src/db/client.js";
import { digestDeliveries, players, statLines } from "../src/db/schema.js";
import { upsertStatLines } from "../src/jobs/refresh.js";
import { insertDelivery, insertPlayer, insertStatLine, testDb, testFileDb } from "./factories.js";

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

/**
 * The delivery claim's storage contract (ADR 0034). The claim is only as good
 * as the columns and the lock behaviour underneath it, so both are asserted
 * against a REAL opened database, not against the schema definition.
 */
describe("digest_deliveries claim columns and lock behaviour (ADR 0034)", () => {
  const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

  function applyMigration(sqlite: Database.Database, file: string): void {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed !== "") sqlite.exec(trimmed);
    }
  }

  it("pins a busy timeout on every opened connection, so a contended claim waits instead of throwing", () => {
    // HONEST LIMITATION: this asserts the effective CONFIGURATION, not that
    // openDb's pragma line is what produced it — better-sqlite3 already
    // defaults busy_timeout to 5000ms, so deleting the pragma leaves this
    // green. It still earns its place: it fails if a future driver default
    // (or an errant `timeout` option) drops below what a contended claim
    // needs. What it CANNOT prove is lock-contention behaviour — that needs a
    // real second process, which the suite has no harness for (see #26).
    const memory = testDb();
    const file = testFileDb();
    try {
      expect(memory.sqlite.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
      expect(file.opened.sqlite.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
      expect(BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      memory.close();
      file.cleanup();
    }
  });

  it("defaults a delivery to attempt_count 0 with no claim and no provider id", async () => {
    const opened = testDb();
    try {
      await opened.db.insert(digestDeliveries).values({
        kind: "digest",
        dateCovered: "2026-07-19",
        status: "sent",
        sentAt: "2026-07-19T17:00:00.000Z",
        createdAt: "2026-07-19T17:00:00.000Z",
      });
      const row = (await opened.db.select().from(digestDeliveries))[0];
      expect(row).toMatchObject({
        attemptCount: 0,
        claimedAt: null,
        providerMessageId: null,
      });
    } finally {
      opened.close();
    }
  });

  it("migrates a database already holding a sent delivery without rewriting the row", () => {
    // The 0002 migration is three ALTER TABLE ... ADD COLUMN statements: an
    // existing `sent` row must survive the widened status enum untouched, since
    // the host self-heals its schema at openDb (ADR 0028) with live data in it.
    const dir = mkdtempSync(join(tmpdir(), "bryce-migrate-"));
    const sqlite = new Database(join(dir, "bryce.db"));
    try {
      applyMigration(sqlite, "0000_gray_brood.sql");
      applyMigration(sqlite, "0001_overconfident_sally_floyd.sql");
      sqlite
        .prepare(
          `INSERT INTO digest_deliveries
             (kind, date_covered, sent_at, player_count, stat_line_count, status, error_message, created_at)
           VALUES ('digest', '2026-07-18', '2026-07-18T17:00:00.000Z', 3, 7, 'sent', NULL, '2026-07-18T17:00:00.000Z')`,
        )
        .run();

      applyMigration(sqlite, "0002_ambiguous_vapor.sql");

      const row = sqlite.prepare("SELECT * FROM digest_deliveries").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        kind: "digest",
        date_covered: "2026-07-18",
        sent_at: "2026-07-18T17:00:00.000Z",
        player_count: 3,
        stat_line_count: 7,
        status: "sent",
        created_at: "2026-07-18T17:00:00.000Z",
      });
      // The new columns land with their documented defaults on the old row.
      expect(row.claimed_at).toBeNull();
      expect(row.attempt_count).toBe(0);
      expect(row.provider_message_id).toBeNull();
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
