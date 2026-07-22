import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { startupDb } from "../src/db/startup.js";
import { players, statLines } from "../src/db/schema.js";
import { createSnapshot, listSnapshots } from "../src/backup/snapshot.js";
import {
  CandidateAliasError,
  ForeignKeyCheckFailedError,
  IncompatibleSchemaError,
  IntegrityCheckFailedError,
  MissingExpectedTablesError,
  SnapshotNotFoundError,
  restoreSnapshot,
} from "../src/backup/restore.js";
import type { RestoreStage } from "../src/backup/restore.js";
import type { TempDir, TempMigrations } from "./backup-helpers.js";
import {
  FUTURE_MILLIS,
  appendMigration,
  copyProdMigrations,
  makeTempDir,
  setMigrationSql,
} from "./backup-helpers.js";
import type { TempFileDb } from "./factories.js";
import { fakeClock, insertPlayer, testFileDb } from "./factories.js";

const CLOCK = fakeClock("2026-07-22T12:00:00Z").now;
const CLOCK2 = fakeClock("2026-07-22T12:05:00Z").now;

const BAD_MIGRATION_SQL =
  "DELETE FROM stat_lines;\n--> statement-breakpoint\nDELETE FROM players;";
const REMEDIATED_SQL = "CREATE TABLE IF NOT EXISTS restore_marker (id integer primary key);";

function countPlayers(dbPath: string, migrationsFolder: string): number {
  const opened = openDb(dbPath, { migrate: false, migrationsFolder });
  try {
    return (opened.sqlite.prepare("SELECT count(*) AS n FROM players").get() as { n: number }).n;
  } finally {
    opened.close();
  }
}

function residualSwapFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (n) => n.includes(".restore-old-") || n.startsWith(".bryce-restore-"),
  );
}

/**
 * The headline restore cycle (ADR 0042, resolution #9): a real migration cycle
 * where a bad migration wipes data, restore rolls the file back to the
 * pre-migration Snapshot, and the app comes up ONLY after the offending
 * migration is remediated — proving the runbook's "fix before restart" step is
 * load-bearing.
 */
describe("restoreSnapshot: bad-migration recovery", () => {
  let live: TempDir;
  let backups: TempDir;
  let migrations: TempMigrations;
  let dbPath: string;
  let snapshotPath: string;

  beforeEach(async () => {
    live = makeTempDir();
    backups = makeTempDir();
    migrations = copyProdMigrations();
    dbPath = join(live.path, "bryce.db");

    // Bring the DB to head and seed data.
    const seeded = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    const player = await seeded.db
      .insert(players)
      .values({
        externalId: 691185,
        fullName: "Maximo Acosta",
        level: "milb",
        active: true,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      })
      .returning();
    await seeded.db.insert(statLines).values({
      playerId: player[0]!.id,
      gameId: 1,
      statType: "batting",
      gameDate: "2026-07-18",
      gameNumber: 1,
      gameType: "R",
      sportId: 11,
      stats: { hits: 2 },
      raw: {},
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    seeded.close();

    // Append a BAD migration and let startupDb snapshot-then-apply it.
    appendMigration(migrations.dir, {
      tag: "0005_bad",
      when: FUTURE_MILLIS,
      sql: BAD_MIGRATION_SQL,
    });
    const damaged = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK,
    });
    expect(damaged.snapshot).not.toBeNull();
    snapshotPath = join(backups.path, damaged.snapshot as string);
    damaged.close();

    // The bad migration wiped the data.
    expect(countPlayers(dbPath, migrations.dir)).toBe(0);
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
    migrations.cleanup();
  });

  it("restores the pre-migration snapshot; the app comes up after remediation", async () => {
    // Remediate the offending migration BEFORE reopening.
    setMigrationSql(migrations.dir, "0005_bad", REMEDIATED_SQL);

    const result = await restoreSnapshot({
      liveDbPath: dbPath,
      candidatePath: snapshotPath,
      backupDir: backups.path,
      keepLast: 10,
      now: CLOCK2,
      migrationsFolder: migrations.dir,
    });
    expect(result.safetySnapshot).not.toBeNull();
    // No stale swap files linger, and the source snapshot is preserved.
    expect(residualSwapFiles(live.path)).toEqual([]);
    expect(existsSync(snapshotPath)).toBe(true);

    // Reopen: the corrected 0005 applies cleanly and the data is back.
    const reopened = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK2,
    });
    try {
      const rows = await reopened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.fullName).toBe("Maximo Acosta");
      expect(await reopened.db.select().from(statLines)).toHaveLength(1);
      // The remediated migration DID apply.
      expect(
        reopened.sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_marker'")
          .get(),
      ).not.toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("PAIRED: reopening WITHOUT remediation re-applies the bad migration (runbook step is load-bearing)", async () => {
    // Restore, but leave the bad migration in place.
    await restoreSnapshot({
      liveDbPath: dbPath,
      candidatePath: snapshotPath,
      backupDir: backups.path,
      keepLast: 10,
      now: CLOCK2,
      migrationsFolder: migrations.dir,
    });
    // Immediately after restore, the good data is present again.
    expect(countPlayers(dbPath, migrations.dir)).toBe(1);

    // Reopening re-runs the still-bad 0005 and wipes the data once more.
    const reopened = await startupDb(dbPath, {
      backupDir: backups.path,
      keepLast: 10,
      migrationsFolder: migrations.dir,
      now: CLOCK2,
    });
    try {
      expect(await reopened.db.select().from(players)).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });
});

/**
 * Guarded validation (resolution #4): the swap never happens on a candidate that
 * fails integrity, FK, expected-tables, or schema-compatibility checks, and the
 * live database is left untouched.
 */
describe("restoreSnapshot: rejects an invalid candidate, live DB untouched", () => {
  let live: TempFileDb;
  let backups: TempDir;

  beforeEach(async () => {
    live = testFileDb();
    backups = makeTempDir();
    await insertPlayer(live.opened.db, { fullName: "Live Player" });
    live.opened.close(); // release our handle; restore owns the file-level swap
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
  });

  function expectLiveUntouched(): void {
    const opened = openDb(live.path, { migrate: false });
    try {
      const rows = opened.sqlite.prepare("SELECT full_name FROM players").all() as Array<{
        full_name: string;
      }>;
      expect(rows.map((r) => r.full_name)).toEqual(["Live Player"]);
    } finally {
      opened.close();
    }
    expect(listSnapshots(backups.path)).toHaveLength(0); // no safety snapshot on a rejected restore
    expect(residualSwapFiles(join(live.path, ".."))).toEqual([]);
  }

  async function restore(candidatePath: string, migrationsFolder?: string): Promise<unknown> {
    return restoreSnapshot({
      liveDbPath: live.path,
      candidatePath,
      backupDir: backups.path,
      keepLast: 10,
      now: CLOCK,
      ...(migrationsFolder !== undefined ? { migrationsFolder } : {}),
    });
  }

  it("throws SnapshotNotFoundError for a missing candidate", async () => {
    await expect(restore(join(backups.path, "does-not-exist.db"))).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
    expectLiveUntouched();
  });

  it("throws MissingExpectedTablesError when the candidate lacks an expected table", async () => {
    const cand = testFileDb();
    cand.opened.sqlite.exec("DROP TABLE season_calendar");
    cand.opened.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    cand.opened.close();
    await expect(restore(cand.path)).rejects.toBeInstanceOf(MissingExpectedTablesError);
    cand.cleanup();
    expectLiveUntouched();
  });

  it("throws ForeignKeyCheckFailedError when the candidate has an orphan FK", async () => {
    const cand = testFileDb();
    // Insert an orphan stat_line (player_id with no players row) with FK enforcement off.
    cand.opened.sqlite.pragma("foreign_keys = OFF");
    cand.opened.sqlite
      .prepare(
        `INSERT INTO stat_lines
           (player_id, game_id, stat_type, game_date, game_number, game_type, sport_id, stats, raw, created_at, updated_at)
         VALUES (999, 1, 'batting', '2026-07-18', 1, 'R', 11, '{}', '{}', 't', 't')`,
      )
      .run();
    cand.opened.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    cand.opened.close();
    await expect(restore(cand.path)).rejects.toBeInstanceOf(ForeignKeyCheckFailedError);
    cand.cleanup();
    expectLiveUntouched();
  });

  it("throws IncompatibleSchemaError for a future snapshot (unknown migration head)", async () => {
    const migrations = copyProdMigrations();
    appendMigration(migrations.dir, {
      tag: "0005_future",
      when: FUTURE_MILLIS,
      sql: "CREATE TABLE future_only (id integer primary key);",
    });
    const candDir = makeTempDir();
    const candPath = join(candDir.path, "future.db");
    const cand = openDb(candPath, { migrationsFolder: migrations.dir });
    cand.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    cand.close();
    // Validate against the PRODUCTION migrations (default) — the candidate knows one more.
    await expect(restore(candPath)).rejects.toBeInstanceOf(IncompatibleSchemaError);
    migrations.cleanup();
    candDir.cleanup();
    expectLiveUntouched();
  });

  it("throws IntegrityCheckFailedError for a byte-corrupted candidate", async () => {
    const cand = testFileDb();
    // Fill several pages so corruption lands on a data/index page, then checkpoint
    // so the bytes live in the main file (not the WAL) before we corrupt it.
    for (let i = 0; i < 400; i += 1) {
      await insertPlayer(cand.opened.db, {
        externalId: 900000 + i,
        fullName: `Filler Player Number ${i} With A Reasonably Long Name`,
        notes: "x".repeat(200),
      });
    }
    cand.opened.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    cand.opened.close();
    // Overwrite a swath starting at page 2 (offset 4096) with 0xFF.
    const fd = openSync(cand.path, "r+");
    try {
      writeSync(fd, Buffer.alloc(3000, 0xff), 0, 3000, 4096);
    } finally {
      closeSync(fd);
    }
    await expect(restore(cand.path)).rejects.toBeInstanceOf(IntegrityCheckFailedError);
    cand.cleanup();
    expectLiveUntouched();
  });
});

/**
 * Alias rejection (should-consider): a candidate that is the live file by path,
 * symlink, or hardlink is refused before anything is touched.
 */
describe("restoreSnapshot: alias rejection", () => {
  let live: TempFileDb;
  let backups: TempDir;

  beforeEach(async () => {
    live = testFileDb();
    backups = makeTempDir();
    await insertPlayer(live.opened.db, { fullName: "Live Player" });
    live.opened.close();
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
  });

  const restore = (candidatePath: string) =>
    restoreSnapshot({
      liveDbPath: live.path,
      candidatePath,
      backupDir: backups.path,
      keepLast: 10,
      now: CLOCK,
    });

  it("rejects the live path itself", async () => {
    await expect(restore(live.path)).rejects.toBeInstanceOf(CandidateAliasError);
  });

  it("rejects a symlink to the live file", async () => {
    const link = join(live.path, "..", "link.db");
    symlinkSync(live.path, link);
    await expect(restore(link)).rejects.toBeInstanceOf(CandidateAliasError);
  });

  it("rejects a hardlink to the live file", async () => {
    const hard = join(live.path, "..", "hardlink.db");
    linkSync(live.path, hard);
    await expect(restore(hard)).rejects.toBeInstanceOf(CandidateAliasError);
  });
});

/**
 * The WAL-safe, rollback-capable swap (resolution #5): a fault at any swap stage
 * restores the held-aside originals and cleans up, leaving the live DB intact.
 */
describe("restoreSnapshot: fault-injected swap rolls back", () => {
  let live: TempFileDb;
  let backups: TempDir;
  let candDir: TempDir;
  let candidatePath: string;

  beforeEach(async () => {
    live = testFileDb();
    backups = makeTempDir();
    candDir = makeTempDir();
    // Live carries "Original"; the candidate snapshot carries "Snapshot Only".
    await insertPlayer(live.opened.db, { fullName: "Original" });
    live.opened.close();

    const src = testFileDb();
    await insertPlayer(src.opened.db, { fullName: "Snapshot Only" });
    candidatePath = (await createSnapshot(src.opened.sqlite, candDir.path, CLOCK)).path;
    src.cleanup();
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
    candDir.cleanup();
  });

  function liveName(): string {
    const opened = openDb(live.path, { migrate: false });
    try {
      return (opened.sqlite.prepare("SELECT full_name FROM players").get() as { full_name: string })
        .full_name;
    } finally {
      opened.close();
    }
  }

  for (const stage of ["checkpoint", "rename", "dir-fsync"] as RestoreStage[]) {
    it(`a fault at "${stage}" leaves the original live DB intact and cleans up`, async () => {
      await expect(
        restoreSnapshot({
          liveDbPath: live.path,
          candidatePath,
          backupDir: backups.path,
          keepLast: 10,
          now: CLOCK,
          fault: (s) => {
            if (s === stage) throw new Error(`injected fault at ${s}`);
          },
        }),
      ).rejects.toThrow(/injected fault/);

      // The live database is unchanged — the rollback restored the original.
      expect(liveName()).toBe("Original");
      // No stale swap artifacts remain in the live directory.
      expect(residualSwapFiles(join(live.path, ".."))).toEqual([]);
    });
  }

  it("succeeds on the happy path: the candidate's data replaces the live DB, safety snapshot taken", async () => {
    const result = await restoreSnapshot({
      liveDbPath: live.path,
      candidatePath,
      backupDir: backups.path,
      keepLast: 10,
      now: CLOCK,
    });
    expect(result.safetySnapshot).not.toBeNull();
    expect(liveName()).toBe("Snapshot Only");
    expect(residualSwapFiles(join(live.path, ".."))).toEqual([]);
    // The safety snapshot (of the pre-restore "Original") is a real, listable snapshot.
    expect(listSnapshots(backups.path)).toHaveLength(1);
  });
});
