import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { startupDb } from "../src/db/startup.js";
import {
  hasPendingMigrations,
  migrationHistoryCompatibility,
  pendingMigrations,
  readAppliedMigrations,
} from "../src/db/pending.js";
import { playerTags, players } from "../src/db/schema.js";
import { listSnapshots } from "../src/backup/snapshot.js";
import type { TempDir, TempMigrations } from "./backup-helpers.js";
import {
  FUTURE_MILLIS,
  appendMigration,
  copyProdMigrations,
  makeMigrationsDir,
  makeTempDir,
} from "./backup-helpers.js";
import { syncDerivedTags } from "../src/tags/service.js";
import { fakeClock, insertPlayer, insertPlayerTag, insertStatLine } from "./factories.js";

const CLOCK = fakeClock("2026-07-22T12:00:00Z").now;

function tableExists(started: { sqlite: Database.Database }, name: string): boolean {
  return (
    started.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

/**
 * The pre-migration Snapshot hook (ADR 0042): startupDb snapshots an EXISTING
 * database before a pending migration applies, but never on a schema-less first
 * run, never for :memory:, and never without a backup dir — and a FAILED
 * pre-migration Snapshot aborts the migration.
 */
describe("startupDb pre-migration snapshot", () => {
  let live: TempDir;
  let backups: TempDir;
  let migrations: TempMigrations;
  let dbPath: string;

  beforeEach(() => {
    live = makeTempDir();
    backups = makeTempDir();
    migrations = copyProdMigrations();
    dbPath = join(live.path, "bryce.db");
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
    migrations.cleanup();
  });

  it("skips the snapshot on a schema-less first run (nothing to lose), then migrates", async () => {
    const started = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    try {
      expect(started.snapshot).toBeNull();
      expect(listSnapshots(backups.path)).toHaveLength(0);
      // The schema is present — the file was migrated.
      expect(tableExists(started, "players")).toBe(true);
    } finally {
      started.close();
    }
  });

  it("snapshots an existing database before applying a pending migration", async () => {
    // Bring the file up to head, then append a new pending migration.
    const first = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    await first.db.insert(players).values({
      externalId: 691185,
      fullName: "Maximo Acosta",
      level: "milb",
      active: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    first.close();

    appendMigration(migrations.dir, {
      tag: "0005_add_widgets",
      when: FUTURE_MILLIS,
      sql: "CREATE TABLE widgets (id integer primary key);",
    });

    const started = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    try {
      expect(started.snapshot).not.toBeNull();
      const snaps = listSnapshots(backups.path);
      expect(snaps).toHaveLength(1);
      // The migration applied AFTER the snapshot was taken.
      expect(tableExists(started, "widgets")).toBe(true);
    } finally {
      started.close();
    }
  });

  it("takes NO snapshot when nothing is pending", async () => {
    const first = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    first.close();

    const second = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    try {
      expect(second.snapshot).toBeNull();
      expect(listSnapshots(backups.path)).toHaveLength(0);
    } finally {
      second.close();
    }
  });

  it("never snapshots without a backup dir, but still migrates the pending migration", async () => {
    const first = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    first.close();
    appendMigration(migrations.dir, {
      tag: "0005_add_widgets",
      when: FUTURE_MILLIS,
      sql: "CREATE TABLE widgets (id integer primary key);",
    });

    const started = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    try {
      expect(started.snapshot).toBeNull();
      expect(listSnapshots(backups.path)).toHaveLength(0);
      expect(tableExists(started, "widgets")).toBe(true);
    } finally {
      started.close();
    }
  });

  it("never snapshots for an in-memory database", async () => {
    const started = await startupDb(":memory:", {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    try {
      expect(started.snapshot).toBeNull();
      expect(started.lock).toBeNull();
      expect(listSnapshots(backups.path)).toHaveLength(0);
    } finally {
      started.close();
    }
  });

  it("ABORTS the migration when the pre-migration snapshot fails", async () => {
    const first = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    first.close();
    appendMigration(migrations.dir, {
      tag: "0005_add_widgets",
      when: FUTURE_MILLIS,
      sql: "CREATE TABLE widgets (id integer primary key);",
    });

    // A backup "dir" that is actually a FILE — mkdir fails, so createSnapshot throws.
    const notADir = join(live.path, "not-a-dir");
    writeFileSync(notADir, "regular file");

    await expect(
      startupDb(dbPath, {
        backupDir: notADir,
        keepLast: 10,
        migrationsFolder: migrations.dir,
        now: CLOCK,
      }),
    ).rejects.toThrow();

    // The bad migration must NOT have applied — the safety guarantee held.
    const reopened = openDb(dbPath, { migrate: false, migrationsFolder: migrations.dir });
    try {
      expect(
        reopened.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='widgets'").get(),
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});

/**
 * The ordered-prefix migration model (resolution #8): "pending" is the ordered
 * suffix migrate() would apply — NOT hash-set membership — and "compatible" is a
 * valid ordered prefix, rejecting gapped, reordered, unknown, and future
 * histories.
 */
describe("ordered-prefix migration model", () => {
  let live: TempDir;

  beforeEach(() => {
    live = makeTempDir();
  });

  afterEach(() => {
    live.cleanup();
  });

  const migA = { tag: "0000_a", when: 1000, sql: "CREATE TABLE a (id integer primary key);" };
  const migB = { tag: "0001_b", when: 2000, sql: "CREATE TABLE b (id integer primary key);" };
  const migC = { tag: "0002_c", when: 3000, sql: "CREATE TABLE c (id integer primary key);" };

  it("treats a later migration with DUPLICATE content as pending (ordered, not hash-set)", () => {
    // A' has identical SQL to A → identical sha256 hash, but a later `when`.
    const dupSql = "CREATE TABLE dup (id integer primary key);";
    const withOne = makeMigrationsDir([{ tag: "0000_dup", when: 1000, sql: dupSql }]);
    const withTwo = makeMigrationsDir([
      { tag: "0000_dup", when: 1000, sql: dupSql },
      { tag: "0001_dup2", when: 2000, sql: dupSql },
    ]);
    try {
      const path = join(live.path, "dup.db");
      const opened = openDb(path, { migrationsFolder: withOne.dir });
      try {
        // Applied one; the second (same content) is still PENDING under the ordered model.
        expect(hasPendingMigrations(opened.sqlite, withOne.dir)).toBe(false);
        expect(hasPendingMigrations(opened.sqlite, withTwo.dir)).toBe(true);
        expect(pendingMigrations(opened.sqlite, withTwo.dir)).toHaveLength(1);
      } finally {
        opened.close();
      }
    } finally {
      withOne.cleanup();
      withTwo.cleanup();
    }
  });

  it("accepts an older snapshot (valid prefix) and rejects a future one", () => {
    const buildAB = makeMigrationsDir([migA, migB]);
    const buildABC = makeMigrationsDir([migA, migB, migC]);
    try {
      const path = join(live.path, "prefix.db");
      const opened = openDb(path, { migrationsFolder: buildABC.dir }); // applies A,B,C
      try {
        const appliedABC = readAppliedMigrations(opened.sqlite);
        // A snapshot with A,B,C against a build that only knows A,B → future, rejected.
        expect(migrationHistoryCompatibility(appliedABC, buildAB.dir).compatible).toBe(false);
        // The first two rows (A,B) are a valid prefix of A,B,C → compatible.
        expect(migrationHistoryCompatibility(appliedABC.slice(0, 2), buildABC.dir).compatible).toBe(true);
      } finally {
        opened.close();
      }
    } finally {
      buildAB.cleanup();
      buildABC.cleanup();
    }
  });

  it("rejects a candidate whose first-migration hash matches but timestamp is newer than head (finding #5)", () => {
    const buildAB = makeMigrationsDir([migA, migB]);
    try {
      const files = readMigrationFiles({ migrationsFolder: buildAB.dir });
      const a = files[0];
      // Same hash as A, but a folderMillis newer than head (B's 2000). Drizzle
      // decides "pending" from folderMillis, so on reopen it would treat every
      // migration as applied and skip B — restoring a schema missing B's columns.
      // Hash-only compatibility would wrongly ACCEPT this; folderMillis rejects it.
      const tampered = [{ hash: a!.hash, folderMillis: 9999 }];
      expect(migrationHistoryCompatibility(tampered, buildAB.dir).compatible).toBe(false);
    } finally {
      buildAB.cleanup();
    }
  });

  it("rejects a gapped or reordered history (hash mismatch at position)", () => {
    const buildABC = makeMigrationsDir([migA, migB, migC]);
    try {
      const files = readMigrationFiles({ migrationsFolder: buildABC.dir });
      const [a, b, c] = files;
      // Gap: applied A then C, skipping B — position 1 hash mismatches build's B.
      const gapped = [
        { hash: a!.hash, folderMillis: a!.folderMillis },
        { hash: c!.hash, folderMillis: c!.folderMillis },
      ];
      expect(migrationHistoryCompatibility(gapped, buildABC.dir).compatible).toBe(false);
      // Reordered: B before A.
      const reordered = [
        { hash: b!.hash, folderMillis: b!.folderMillis },
        { hash: a!.hash, folderMillis: a!.folderMillis },
      ];
      expect(migrationHistoryCompatibility(reordered, buildABC.dir).compatible).toBe(false);
      // Unknown: a hash this build has never seen.
      const unknown = [{ hash: "deadbeef".repeat(8), folderMillis: 1000 }];
      expect(migrationHistoryCompatibility(unknown, buildABC.dir).compatible).toBe(false);
    } finally {
      buildABC.cleanup();
    }
  });
});

describe("startupDb derived-tag backfill (Phase A of #29)", () => {
  let live: TempDir;
  let migrations: TempMigrations;
  let dbPath: string;

  beforeEach(() => {
    live = makeTempDir();
    migrations = copyProdMigrations();
    dbPath = join(live.path, "bryce.db");
  });

  afterEach(() => {
    live.cleanup();
    migrations.cleanup();
  });

  it("backfills derived tags for pre-existing players (incl a DSL case) after a 0006 upgrade, no manual rebuild", async () => {
    // Bring the file to head (through 0006), then insert players carrying NO
    // tags — exactly the state a real DB is in the instant the migration created
    // the empty player_tags table (the first startup's backfill saw zero players
    // and no-oped).
    const first = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    const aaa = await insertPlayer(first.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Triple-A",
      position: "SS",
    });
    const inactive = await insertPlayer(first.db, {
      externalId: 700000,
      level: "milb",
      milbLevel: "Double-A",
      position: "1B",
      active: false,
    });
    const dsl = await insertPlayer(first.db, {
      externalId: 700001,
      level: "milb",
      milbLevel: "Rookie",
      position: null,
    });
    await insertStatLine(first.db, {
      playerId: dsl.id,
      sportId: 16,
      leagueName: "Dominican Summer League",
      gameDate: "2026-07-01",
    });
    expect(first.db.select().from(playerTags).all()).toHaveLength(0);
    first.close();

    // Re-open: migrate() is a no-op, but the one-time self-healing backfill runs.
    const started = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    try {
      const tagsFor = (id: number): Set<string> =>
        new Set(
          started.db
            .select()
            .from(playerTags)
            .where(eq(playerTags.playerId, id))
            .all()
            .map((t) => `${t.namespace}:${t.value}`),
        );
      expect(tagsFor(aaa.id).has("level:aaa")).toBe(true);
      // Inactive players are backfilled too — a Refresh would never reach them.
      expect(tagsFor(inactive.id).has("level:aa")).toBe(true);
      // The DSL case derives level:dsl from the latest stat line, not level:rookie.
      const dslTags = tagsFor(dsl.id);
      expect(dslTags.has("level:dsl")).toBe(true);
      expect(dslTags.has("level:rookie")).toBe(false);
    } finally {
      started.close();
    }
  });

  it("self-heals only the players missing a derived tag (resumes a partial prior run), and is a no-op once all tagged", async () => {
    const first = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    // Player A already has derived tags (a completed prior sync); player B has
    // none (a prior backfill crashed, or his first-add Refresh threw, before
    // deriving). The whole-table-empty guard would have permanently skipped both.
    const a = await insertPlayer(first.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Triple-A",
      position: "SS",
    });
    syncDerivedTags(first.db, a.id, CLOCK());
    const b = await insertPlayer(first.db, {
      externalId: 700000,
      level: "milb",
      milbLevel: "Double-A",
      position: "1B",
    });
    // Snapshot A's derived row ids: the sweep must not rewrite an already-tagged
    // player (it skips him entirely), and B has no derived tags yet.
    const aRowIdsBefore = first.db
      .select()
      .from(playerTags)
      .where(and(eq(playerTags.playerId, a.id), eq(playerTags.source, "derived")))
      .all()
      .map((t) => t.id)
      .sort((x, y) => x - y);
    expect(aRowIdsBefore.length).toBeGreaterThan(0);
    expect(
      first.db
        .select()
        .from(playerTags)
        .where(eq(playerTags.playerId, b.id))
        .all(),
    ).toHaveLength(0);
    first.close();

    const started = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    try {
      // B is healed.
      const bDerived = started.db
        .select()
        .from(playerTags)
        .where(and(eq(playerTags.playerId, b.id), eq(playerTags.source, "derived")))
        .all();
      expect(bDerived.length).toBeGreaterThan(0);
      // A's derived rows are UNTOUCHED (same row ids — no delete+reinsert).
      const aRowIdsAfter = started.db
        .select()
        .from(playerTags)
        .where(and(eq(playerTags.playerId, a.id), eq(playerTags.source, "derived")))
        .all()
        .map((t) => t.id)
        .sort((x, y) => x - y);
      expect(aRowIdsAfter).toEqual(aRowIdsBefore);
    } finally {
      started.close();
    }

    // A further startup, now that everyone is tagged, writes NOTHING: the whole
    // player_tags table is byte-identical (same row ids) across the no-op sweep.
    const snapshotIds = (): number[] => {
      const s = openDb(dbPath, { migrate: false, migrationsFolder: migrations.dir });
      try {
        return s.db
          .select()
          .from(playerTags)
          .all()
          .map((t) => t.id)
          .sort((x, y) => x - y);
      } finally {
        s.close();
      }
    };
    const before = snapshotIds();
    const third = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    third.close();
    expect(snapshotIds()).toEqual(before);
  });

  it("is a NO-OP on a fresh/empty DB and does not re-fire once tags exist", async () => {
    // Fresh/empty DB: schema created, no players → backfill no-op, zero tags.
    const first = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    expect(first.db.select().from(playerTags).all()).toHaveLength(0);
    const player = await insertPlayer(first.db, {
      externalId: 691185,
      level: "milb",
      milbLevel: "Triple-A",
      position: "SS",
    });
    first.close();

    // Second startup backfills once (players present, tags empty).
    const second = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    expect(second.db.select().from(playerTags).all().length).toBeGreaterThan(0);
    // A manual tag added AFTER the backfill must survive a later startup — the
    // guard (tags already present) keeps the backfill from re-firing/clobbering.
    await insertPlayerTag(second.db, {
      playerId: player.id,
      namespace: "status",
      value: "rostered",
      source: "manual",
    });
    second.close();

    const third = await startupDb(dbPath, { migrationsFolder: migrations.dir, now: CLOCK });
    try {
      const manual = third.db
        .select()
        .from(playerTags)
        .where(eq(playerTags.source, "manual"))
        .all()
        .map((t) => `${t.namespace}:${t.value}`);
      expect(manual).toEqual(["status:rostered"]);
    } finally {
      third.close();
    }
  });
});
