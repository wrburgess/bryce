import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";
import type Database from "better-sqlite3";
import { MIGRATIONS_FOLDER, openDb } from "./client.js";
import type { DbLock } from "./lock.js";
import { acquireOpenLock } from "./lock.js";
import { hasExistingSchema, hasPendingMigrations } from "./pending.js";
import { createSnapshot, pruneSnapshots } from "../backup/snapshot.js";
import { syncUntaggedDerivedTags } from "../tags/service.js";

/**
 * The async startup seam (ADR 0042). `openDb` stays synchronous; entrypoints
 * (server, db:backup, refresh, digest, seed, migrate) call `startupDb` instead,
 * which:
 *
 *   1. acquires the advisory interlock for the process lifetime;
 *   2. opens WITHOUT migrating;
 *   3. if a backup dir is configured, the path is on disk, the database already
 *      carries a schema, AND a migration is pending → takes a pre-migration
 *      Snapshot (better-sqlite3 `.backup()` is Promise-based, hence the async
 *      seam) and prunes to keepLast;
 *   4. THEN migrates.
 *
 * A failed pre-migration Snapshot ABORTS the migration (the safety guarantee is
 * the whole point). A successful-Snapshot-then-failed-prune logs and continues
 * (retention is best-effort cleanup). A schema-less first run has "all pending"
 * but nothing to lose, so it skips the Snapshot and just migrates.
 */

export interface StartupOptions {
  /** Enables the pre-migration Snapshot when set (production wires config.backupDir). */
  backupDir?: string;
  /** Retention target; required to prune after a Snapshot. */
  keepLast?: number;
  /** Migrations directory; defaults to the production folder. Injectable for tests. */
  migrationsFolder?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface StartedDb {
  db: Db;
  sqlite: Database.Database;
  /** The advisory interlock (null for an in-memory database). */
  lock: DbLock | null;
  /** The pre-migration Snapshot taken this startup, or null if none was needed. */
  snapshot: string | null;
  /** Close the database AND release the interlock. */
  close: () => void;
}

export async function startupDb(
  databasePath: string,
  options: StartupOptions = {},
): Promise<StartedDb> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  // Two-flag interlock (opener side): publish our presence, then refuse if a
  // restore is in progress. Throws DatabaseBusyError before opening the file, so
  // an opener never opens the database while restore is renaming underneath it.
  const lock = acquireOpenLock(databasePath, now);
  let opened;
  try {
    opened = openDb(databasePath, { migrate: false, migrationsFolder });
  } catch (err) {
    lock?.release();
    throw err;
  }

  try {
    let snapshot: string | null = null;
    const shouldSnapshot =
      options.backupDir !== undefined &&
      databasePath !== ":memory:" &&
      hasExistingSchema(opened.sqlite) &&
      hasPendingMigrations(opened.sqlite, migrationsFolder);

    if (shouldSnapshot) {
      // If THIS fails, the throw below aborts the migration — no migrate runs.
      snapshot = (await createSnapshot(opened.sqlite, options.backupDir as string, now)).name;
      if (options.keepLast !== undefined) {
        try {
          pruneSnapshots(options.backupDir as string, options.keepLast);
        } catch (err) {
          log(`retention prune failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    migrate(opened.db, { migrationsFolder });

    // Self-healing backfill of derived tags (Phase A of #29). Applying the 0006
    // migration only CREATES an empty player_tags table; a later Refresh repairs
    // only ACTIVE, in-season players, so existing inactive players — and everyone
    // during Offseason Sleep — would stay untagged indefinitely, leaving the tag
    // list/selector surfaces incomplete. Rather than gate on the WHOLE table being
    // empty (which permanently skips the rest if a prior backfill crashed after
    // some players committed, or a first-add's Refresh threw before deriving),
    // derive tags for every player that currently lacks a source='derived' row.
    // This resumes a partial run and repairs any straggler; every valid player
    // derives at least one derived tag, so it is a genuine NO-OP once all are
    // tagged (and on a fresh/empty DB).
    syncUntaggedDerivedTags(opened.db, now());

    return {
      db: opened.db,
      sqlite: opened.sqlite,
      lock,
      snapshot,
      close: () => {
        try {
          opened.close();
        } finally {
          lock?.release();
        }
      },
    };
  } catch (err) {
    try {
      opened.close();
    } finally {
      lock?.release();
    }
    throw err;
  }
}
