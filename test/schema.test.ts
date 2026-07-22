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
import { insertPlayer, insertStatLine, testDb, testFileDb } from "./factories.js";

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

  it("upsert on conflict updates stats but preserves created_at", async () => {
    const player = await insertPlayer(opened.db);
    const original = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 777001,
      statType: "batting",
      stats: { hits: 1, atBats: 4 },
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

  it("adds reconciled_at as a nullable column without touching a settled row", () => {
    // 0003 is one additive ALTER TABLE ... ADD COLUMN (ADR 0034 amendment). The
    // host self-heals its schema at openDb with live data in it (ADR 0028), so
    // the pre-existing row must survive byte-for-byte, and the new column must
    // read null — "we did not reconcile this" is the correct history for every
    // delivery that settled before the capability existed.
    const dir = mkdtempSync(join(tmpdir(), "bryce-migrate-"));
    const sqlite = new Database(join(dir, "bryce.db"));
    try {
      applyMigration(sqlite, "0000_gray_brood.sql");
      applyMigration(sqlite, "0001_overconfident_sally_floyd.sql");
      applyMigration(sqlite, "0002_ambiguous_vapor.sql");
      sqlite
        .prepare(
          `INSERT INTO digest_deliveries
             (kind, date_covered, sent_at, player_count, stat_line_count, status, claimed_at,
              attempt_count, provider_message_id, error_message, created_at)
           VALUES ('digest', '2026-07-18', '2026-07-18T17:00:00.000Z', 3, 7, 'sent',
                   '2026-07-18T17:00:00.000Z', 2, 'pm-existing-1', NULL, '2026-07-18T17:00:00.000Z')`,
        )
        .run();

      applyMigration(sqlite, "0003_reconciled_at.sql");

      const row = sqlite.prepare("SELECT * FROM digest_deliveries").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        kind: "digest",
        date_covered: "2026-07-18",
        sent_at: "2026-07-18T17:00:00.000Z",
        player_count: 3,
        stat_line_count: 7,
        status: "sent",
        claimed_at: "2026-07-18T17:00:00.000Z",
        attempt_count: 2,
        provider_message_id: "pm-existing-1",
      });
      expect(row.reconciled_at).toBeNull();

      // Nullable with no default: the column carries no opinion of its own.
      // The declared type is compared case-insensitively on purpose. This
      // build normalizes `text` (as the migration writes it) to `TEXT` in
      // PRAGMA table_info, but that normalization is not a documented
      // guarantee, and the property under test is the column's TYPE and
      // NULLABILITY — never its spelling.
      const column = (
        sqlite.prepare("PRAGMA table_info(digest_deliveries)").all() as Array<Record<string, unknown>>
      ).find((c) => c.name === "reconciled_at");
      expect(column).toMatchObject({ notnull: 0, dflt_value: null });
      expect(String(column?.type).toUpperCase()).toBe("TEXT");
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops digest_delivery_id via a table rebuild that keeps every other guarantee", () => {
    // 0004 is the one DESTRUCTIVE migration: SQLite cannot DROP COLUMN in place,
    // so drizzle rebuilds stat_lines (create new / copy / drop old / rename). A
    // rebuild can silently lose what the old table enforced. The property that
    // MUST survive is stat_lines_player_game_type_uq — ADR 0029's per-game
    // identity, the thing that makes a doubleheader two rows and the refresh
    // upsert idempotent. If the rebuild drops it, the digest double-counts and
    // refresh inserts duplicates, both silently. This applies 0004 to a
    // POPULATED table and proves the column is gone AND the invariant enforces.
    const dir = mkdtempSync(join(tmpdir(), "bryce-migrate-"));
    const sqlite = new Database(join(dir, "bryce.db"));
    try {
      applyMigration(sqlite, "0000_gray_brood.sql");
      applyMigration(sqlite, "0001_overconfident_sally_floyd.sql");
      applyMigration(sqlite, "0002_ambiguous_vapor.sql");
      applyMigration(sqlite, "0003_reconciled_at.sql");

      // A player to satisfy the foreign key, a delivery to stamp a line with,
      // and two stat lines — one of them carrying digest_delivery_id, so the
      // copy has a non-null value in the doomed column to drop.
      sqlite
        .prepare(
          `INSERT INTO players (id, full_name, level, active, created_at, updated_at)
           VALUES (1, 'Maximo Acosta', 'milb', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO digest_deliveries
             (id, kind, date_covered, sent_at, player_count, stat_line_count, status, created_at)
           VALUES (5, 'digest', '2026-07-18', '2026-07-18T17:00:00.000Z', 1, 1, 'sent', '2026-07-18T17:00:00.000Z')`,
        )
        .run();
      // 900001 sets game_number explicitly; 900002 OMITS it, so the pre-migration
      // DEFAULT of 1 fills it. Asserting 900002.game_number === 1 after the
      // rebuild then proves the default carried through the copy — reading an
      // inserted literal would prove nothing.
      sqlite
        .prepare(
          `INSERT INTO stat_lines
             (player_id, game_id, stat_type, game_date, game_number, game_type, sport_id,
              stats, raw, digest_delivery_id, created_at, updated_at)
           VALUES (1, 900001, 'batting', '2026-07-18', 2, 'R', 11, '{"hits":2}', '{}', 5,
                   '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO stat_lines
             (player_id, game_id, stat_type, game_date, game_type, sport_id,
              stats, raw, digest_delivery_id, created_at, updated_at)
           VALUES (1, 900002, 'batting', '2026-07-18', 'R', 11, '{"hits":2}', '{}', NULL,
                   '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
        )
        .run();

      applyMigration(sqlite, "0004_steep_justin_hammer.sql");

      // The column is gone.
      const columns = (
        sqlite.prepare("PRAGMA table_info(stat_lines)").all() as Array<Record<string, unknown>>
      ).map((c) => c.name);
      expect(columns).not.toContain("digest_delivery_id");

      // Every row survived the copy, values intact.
      const rows = sqlite
        .prepare("SELECT * FROM stat_lines ORDER BY game_id")
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ game_id: 900001, player_id: 1, stat_type: "batting" });
      expect(rows[0]?.game_number).toBe(2); // explicit value copied intact
      expect(rows[1]?.game_id).toBe(900002);
      expect(rows[1]?.game_number).toBe(1); // the DEFAULT applied pre-rebuild survived the copy

      // The unique index exists...
      const indexes = (
        sqlite.prepare("PRAGMA index_list(stat_lines)").all() as Array<Record<string, unknown>>
      ).map((i) => i.name);
      expect(indexes).toContain("stat_lines_player_game_type_uq");

      // ...and ENFORCES. A duplicate (player_id, game_id, stat_type) is rejected.
      // "index present" and "index enforcing" are different failures; this pins
      // the one that matters.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO stat_lines
               (player_id, game_id, stat_type, game_date, game_number, game_type, sport_id,
                stats, raw, created_at, updated_at)
             VALUES (1, 900001, 'batting', '2026-07-18', 1, 'R', 11, '{}', '{}',
                     '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);

      // The foreign key to players survived the rebuild.
      const fks = sqlite.prepare("PRAGMA foreign_key_list(stat_lines)").all() as Array<
        Record<string, unknown>
      >;
      expect(fks.some((f) => f.table === "players" && f.to === "id")).toBe(true);

      // A NOT NULL the rebuild had to re-declare still bites.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO stat_lines
               (player_id, game_id, stat_type, game_date, game_type, sport_id, stats, raw,
                created_at, updated_at)
             VALUES (1, 900003, 'batting', '2026-07-18', 'R', 11, NULL, '{}',
                     '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/NOT NULL constraint failed/);

      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds refresh_runs (ADR 0042) without disturbing existing data, and its CHECKs enforce", () => {
    // 0005 is one additive CREATE TABLE. The host self-heals its schema at
    // openDb with live data in it (ADR 0028), so a pre-existing delivery must
    // survive byte-for-byte, and the new table must be queryable with its
    // invariants (status enum, finished-iff-terminal, non-negative counts) live.
    const dir = mkdtempSync(join(tmpdir(), "bryce-migrate-"));
    const sqlite = new Database(join(dir, "bryce.db"));
    try {
      for (const f of [
        "0000_gray_brood.sql",
        "0001_overconfident_sally_floyd.sql",
        "0002_ambiguous_vapor.sql",
        "0003_reconciled_at.sql",
        "0004_steep_justin_hammer.sql",
      ]) {
        applyMigration(sqlite, f);
      }
      sqlite
        .prepare(
          `INSERT INTO digest_deliveries
             (kind, date_covered, sent_at, player_count, stat_line_count, status, created_at)
           VALUES ('digest', '2026-07-18', '2026-07-18T17:00:00.000Z', 3, 7, 'sent', '2026-07-18T17:00:00.000Z')`,
        )
        .run();

      applyMigration(sqlite, "0005_fuzzy_barracuda.sql");

      // The pre-existing delivery is untouched by the additive migration.
      const delivery = sqlite.prepare("SELECT * FROM digest_deliveries").get() as Record<string, unknown>;
      expect(delivery).toMatchObject({
        kind: "digest",
        date_covered: "2026-07-18",
        stat_line_count: 7,
        status: "sent",
      });

      // refresh_runs exists and accepts a valid running row, then a settled one.
      sqlite
        .prepare(
          `INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)
           VALUES ('2026-07-19T07:00:00.000Z', NULL, 'running', '2026-07-19T07:00:00.000Z', '2026-07-19T07:00:00.000Z')`,
        )
        .run();
      const run = sqlite.prepare("SELECT * FROM refresh_runs").get() as Record<string, unknown>;
      expect(run).toMatchObject({ status: "running", finished_at: null, players_refreshed: 0 });

      // A terminal status REQUIRES finished_at (the iff CHECK)...
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)
             VALUES ('x', NULL, 'ok', 'x', 'x')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      // ...an unknown status is refused...
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)
             VALUES ('x', 'y', 'bogus', 'x', 'x')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      // ...and a negative count is refused.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, players_refreshed, created_at)
             VALUES ('x', 'y', 'ok', 'x', -1, 'x')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);

      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
