import type Database from "better-sqlite3";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { MIGRATIONS_FOLDER } from "./client.js";

/**
 * The migration bookkeeping Drizzle keeps and the ordered-prefix model built on
 * top of it (ADR 0042).
 *
 * Drizzle records applied migrations in `__drizzle_migrations(hash, created_at)`
 * where `created_at` is the journal's `when` (folderMillis). Its own migrate()
 * applies every build migration whose `folderMillis` is greater than the newest
 * applied `created_at` — so "pending" here is computed the SAME way migrate()
 * decides, never a naive hash-set difference (which would re-apply or skip the
 * wrong rows on a duplicate-content or reordered history).
 *
 * "Compatible candidate" (used by Restore) is the stronger, ordered-prefix
 * criterion: a snapshot's applied history must be a valid ordered PREFIX of this
 * build's migration list — an older snapshot (fewer, matching) is compatible and
 * self-heals on reopen; a future snapshot (more than this build knows) or a
 * gapped/reordered/unknown history is rejected.
 */

export const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface AppliedMigration {
  hash: string;
  folderMillis: number;
}

function migrationsTableExists(sqlite: Database.Database): boolean {
  const row = sqlite
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  return row !== undefined;
}

/** Applied migrations, oldest first. Empty when the bookkeeping table is absent. */
export function readAppliedMigrations(sqlite: Database.Database): AppliedMigration[] {
  if (!migrationsTableExists(sqlite)) return [];
  const rows = sqlite
    .prepare(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at ASC, id ASC`)
    .all() as Array<{ hash: unknown; created_at: unknown }>;
  return rows.map((r) => ({ hash: String(r.hash), folderMillis: Number(r.created_at) }));
}

/**
 * True when the database already carries an application schema — any non-internal
 * table. A brand-new, schema-less file returns false, so `startupDb` can skip the
 * pre-migration Snapshot on a genuine first run (nothing to lose) while still
 * snapshotting an existing database before a risky migration.
 */
export function hasExistingSchema(sqlite: Database.Database): boolean {
  const row = sqlite
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return Number(row.n) > 0;
}

/** The ordered suffix of build migrations that migrate() would apply next. */
export function pendingMigrations(
  sqlite: Database.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): MigrationMeta[] {
  const build = readMigrationFiles({ migrationsFolder });
  const applied = readAppliedMigrations(sqlite);
  if (applied.length === 0) return build;
  const lastMillis = Math.max(...applied.map((a) => a.folderMillis));
  return build.filter((m) => m.folderMillis > lastMillis);
}

export function hasPendingMigrations(
  sqlite: Database.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): boolean {
  return pendingMigrations(sqlite, migrationsFolder).length > 0;
}

export type MigrationCompatibility =
  | { compatible: true }
  | { compatible: false; reason: string };

/**
 * Is `applied` (a candidate snapshot's history, oldest first) a valid ordered
 * prefix of this build's migration list? Older-but-matching → yes; more than
 * this build knows (future) or any out-of-order/unknown hash → no.
 */
export function migrationHistoryCompatibility(
  applied: AppliedMigration[],
  migrationsFolder: string = MIGRATIONS_FOLDER,
): MigrationCompatibility {
  const build = readMigrationFiles({ migrationsFolder });
  if (applied.length > build.length) {
    return {
      compatible: false,
      reason: `candidate has ${applied.length} applied migration(s) but this build knows only ${build.length}`,
    };
  }
  for (let i = 0; i < applied.length; i += 1) {
    const expected = build[i];
    const got = applied[i];
    // Compare BOTH the hash AND the folderMillis (created_at): Drizzle decides
    // "pending" from folderMillis, so a candidate whose first hash matches but
    // whose created_at is newer than this build's head would otherwise pass
    // compatibility, then startup would skip the remaining migrations and leave
    // the restored schema missing current columns.
    if (
      expected === undefined ||
      got === undefined ||
      expected.hash !== got.hash ||
      expected.folderMillis !== got.folderMillis
    ) {
      return {
        compatible: false,
        reason: `applied migration #${i} does not match this build's ordered history (hash/timestamp)`,
      };
    }
  }
  return { compatible: true };
}
