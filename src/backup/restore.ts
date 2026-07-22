import { basename, dirname, join, resolve } from "node:path";
import { chmodSync, existsSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { acquireDbLock, assertNotBusy } from "../db/lock.js";
import { MIGRATIONS_FOLDER } from "../db/client.js";
import { migrationHistoryCompatibility, readAppliedMigrations } from "../db/pending.js";
import {
  SNAPSHOT_FILE_MODE,
  createSnapshot,
  fsyncDir,
  pruneSnapshots,
} from "./snapshot.js";

/**
 * Restore (ADR 0042): swap a validated Snapshot into place of the live database.
 * This is the destructive operation, so it is guarded end to end:
 *
 *   1. reject a candidate that aliases the live file (path, symlink, or hardlink);
 *   2. take the advisory interlock — refuse if the app is running (DatabaseBusyError);
 *   3. MATERIALIZE the candidate into the live directory (a self-contained SQLite
 *      backup that folds any candidate WAL), CLOSE it, and validate THAT exact
 *      closed file — the validated bytes are the installed bytes;
 *   4. safety-Snapshot the current live database (abort before any swap if it fails);
 *   5. WAL-safe, rollback-capable swap: checkpoint(TRUNCATE) → move live+sidecars
 *      aside → rename the validated temp into place → fsync the directory → only
 *      then delete the held-aside originals. Any failure restores the originals.
 *
 * The restore CLI never opens or migrates the live database (that would re-apply
 * a bad migration and self-deadlock on the interlock) — it calls this service.
 */

export const EXPECTED_TABLES = [
  "players",
  "stat_lines",
  "digest_deliveries",
  "season_calendar",
  "__drizzle_migrations",
] as const;

export class SnapshotNotFoundError extends Error {
  constructor(path: string) {
    super(`no snapshot file at ${path}`);
    this.name = "SnapshotNotFoundError";
  }
}

export class CandidateAliasError extends Error {
  constructor(candidatePath: string, liveDbPath: string) {
    super(`refusing to restore: ${candidatePath} aliases the live database ${liveDbPath}`);
    this.name = "CandidateAliasError";
  }
}

export class IntegrityCheckFailedError extends Error {
  constructor(detail: string) {
    super(`snapshot failed integrity_check: ${detail}`);
    this.name = "IntegrityCheckFailedError";
  }
}

export class ForeignKeyCheckFailedError extends Error {
  readonly violations: number;
  constructor(violations: number) {
    super(`snapshot failed foreign_key_check: ${violations} violation(s)`);
    this.name = "ForeignKeyCheckFailedError";
    this.violations = violations;
  }
}

export class MissingExpectedTablesError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`snapshot is missing expected table(s): ${missing.join(", ")}`);
    this.name = "MissingExpectedTablesError";
    this.missing = missing;
  }
}

export class IncompatibleSchemaError extends Error {
  constructor(reason: string) {
    super(`snapshot schema is incompatible with this build: ${reason}`);
    this.name = "IncompatibleSchemaError";
  }
}

/** Stages a test may fault-inject to prove the swap rolls back cleanly. */
export type RestoreStage = "checkpoint" | "rename" | "dir-fsync";

export interface RestoreArgs {
  liveDbPath: string;
  candidatePath: string;
  backupDir: string;
  keepLast: number;
  now: () => Date;
  migrationsFolder?: string;
  /** Test seam: called at each swap stage; throw to simulate a fault there. */
  fault?: (stage: RestoreStage) => void;
  log?: (message: string) => void;
}

export interface RestoreResult {
  restoredFrom: string;
  /** The safety Snapshot taken of the pre-restore live DB, or null if it did not exist. */
  safetySnapshot: string | null;
  installedPath: string;
}

/** The set of typed, caller-recoverable restore failures (for CLI error mapping). */
export function isKnownRestoreError(err: unknown): err is Error {
  return (
    err instanceof SnapshotNotFoundError ||
    err instanceof CandidateAliasError ||
    err instanceof IntegrityCheckFailedError ||
    err instanceof ForeignKeyCheckFailedError ||
    err instanceof MissingExpectedTablesError ||
    err instanceof IncompatibleSchemaError
  );
}

function assertNotAlias(candidatePath: string, liveDbPath: string): void {
  const candAbs = resolve(candidatePath);
  const liveAbs = resolve(liveDbPath);
  if (candAbs === liveAbs) throw new CandidateAliasError(candidatePath, liveDbPath);

  // Follow symlinks: a candidate that is a symlink TO the live file is an alias.
  let candReal = candAbs;
  let liveReal = liveAbs;
  try {
    candReal = realpathSync(candidatePath);
  } catch {
    // candidate missing is handled by the caller's existence check
  }
  try {
    liveReal = realpathSync(liveDbPath);
  } catch {
    // live file may not exist yet (fresh-install restore)
  }
  if (candReal === liveReal) throw new CandidateAliasError(candidatePath, liveDbPath);

  // Hardlink: two names, one inode.
  if (existsSync(candidatePath) && existsSync(liveDbPath)) {
    const cs = statSync(candidatePath);
    const ls = statSync(liveDbPath);
    if (cs.ino !== 0 && cs.ino === ls.ino && cs.dev === ls.dev) {
      throw new CandidateAliasError(candidatePath, liveDbPath);
    }
  }
}

/** Validate the closed, materialized copy — never the mutable source. */
function validateMaterialized(path: string, migrationsFolder: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new IntegrityCheckFailedError(String(integrity));

    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new ForeignKeyCheckFailedError(fkViolations.length);
    }

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    const missing = EXPECTED_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) throw new MissingExpectedTablesError(missing);

    const compat = migrationHistoryCompatibility(readAppliedMigrations(db), migrationsFolder);
    if (!compat.compatible) throw new IncompatibleSchemaError(compat.reason);
  } finally {
    db.close();
  }
}

interface HeldAside {
  original: string;
  aside: string;
}

/** Remove a database file and its WAL/SHM sidecars, best-effort. */
function rmWithSidecars(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
    } catch {
      // best-effort
    }
  }
}

export async function restoreSnapshot(args: RestoreArgs): Promise<RestoreResult> {
  const { liveDbPath, candidatePath, backupDir, keepLast, now } = args;
  const migrationsFolder = args.migrationsFolder ?? MIGRATIONS_FOLDER;
  const fault = args.fault ?? (() => {});
  const log = args.log ?? (() => {});

  if (!existsSync(candidatePath)) throw new SnapshotNotFoundError(candidatePath);
  assertNotAlias(candidatePath, liveDbPath);

  // Interlock: register this restore's presence, then refuse if ANY other live
  // app process is registered against the database (DatabaseBusyError). Restore
  // must run alone; the registry lets the server + jobs coexist normally but
  // detects them here.
  const lock = acquireDbLock(liveDbPath, now);
  try {
    assertNotBusy(liveDbPath);
  } catch (err) {
    lock?.release();
    throw err;
  }

  const liveDir = dirname(liveDbPath);
  const stamp = `${now().getTime()}-${process.pid}`;
  const tempInstall = join(liveDir, `.bryce-restore-${stamp}.db`);
  const heldAside: HeldAside[] = [];

  try {
    // (3) Materialize a self-contained copy into the live directory, then validate it.
    const src = new Database(candidatePath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(tempInstall);
    } finally {
      src.close();
    }
    validateMaterialized(tempInstall, migrationsFolder);
    // Validation opened the copy read-only, which leaves transient WAL/SHM
    // sidecars beside it. The main file IS the validated bytes we install; drop
    // the empty sidecars so only it is renamed into place.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(tempInstall + suffix)) rmSync(tempInstall + suffix, { force: true });
    }
    chmodSync(tempInstall, SNAPSHOT_FILE_MODE);

    // (4) Safety-Snapshot the current live DB (abort before any swap if it fails).
    let safetySnapshot: string | null = null;
    if (existsSync(liveDbPath)) {
      const liveForBackup = new Database(liveDbPath);
      try {
        safetySnapshot = (await createSnapshot(liveForBackup, backupDir, now)).name;
      } finally {
        liveForBackup.close();
      }
    }

    // (5) WAL-safe, rollback-capable swap.
    fault("checkpoint");
    if (existsSync(liveDbPath)) {
      const ckpt = new Database(liveDbPath);
      try {
        ckpt.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        ckpt.close();
      }
    }

    // Move the current live main file and its sidecars aside (recoverable).
    for (const suffix of ["", "-wal", "-shm"]) {
      const original = liveDbPath + suffix;
      if (existsSync(original)) {
        const aside = `${original}.restore-old-${process.pid}`;
        if (existsSync(aside)) rmSync(aside, { force: true });
        renameSync(original, aside);
        heldAside.push({ original, aside });
      }
    }

    fault("rename");
    renameSync(tempInstall, liveDbPath);

    fault("dir-fsync");
    fsyncDir(liveDir);
    chmodSync(liveDbPath, SNAPSHOT_FILE_MODE);

    // Committed: drop the held-aside originals.
    for (const held of heldAside) {
      try {
        rmSync(held.aside, { force: true });
      } catch {
        // best-effort cleanup of the old file
      }
    }
    heldAside.length = 0;

    // Retention is best-effort: a failed prune logs and continues (ADR 0042).
    try {
      pruneSnapshots(backupDir, keepLast);
    } catch (err) {
      log(`retention prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      restoredFrom: basename(candidatePath),
      safetySnapshot,
      installedPath: liveDbPath,
    };
  } catch (err) {
    // Roll back: remove any partially-installed file (and its sidecars), then
    // restore the held-aside originals.
    rmWithSidecars(tempInstall);
    for (const held of heldAside) {
      try {
        // If the rename had already put the new file at `original`, clear it first.
        if (existsSync(held.original)) rmSync(held.original, { force: true });
        renameSync(held.aside, held.original);
      } catch {
        // best-effort: leave the .restore-old file for manual recovery
      }
    }
    throw err;
  } finally {
    lock?.release();
  }
}
