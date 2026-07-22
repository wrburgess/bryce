import { basename, dirname, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { acquireRestoreLock } from "../db/lock.js";
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
 *   5. WAL-safe swap with a SINGLE atomic rename: checkpoint(TRUNCATE) folds the
 *      live WAL into the main file, then `renameSync(validatedTemp, liveDbPath)`
 *      atomically REPLACES the live file (POSIX rename never leaves the path
 *      absent), then stale live `-wal`/`-shm` are removed. The safety Snapshot —
 *      not a move-aside copy — is the rollback source, so a crash mid-swap leaves
 *      the live path present and either fully-old or fully-new, never blank.
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

  // Two-flag interlock (restore side): publish an exclusive restore marker, then
  // refuse if any live opener is registered (DatabaseBusyError). An opener that
  // starts after this point publishes its presence then sees our marker and
  // refuses to open — so no opener ever holds the file while we rename it.
  const lock = acquireRestoreLock(liveDbPath, now);

  const liveDir = dirname(liveDbPath);
  mkdirSync(liveDir, { recursive: true });
  const stamp = `${now().getTime()}-${process.pid}`;
  const tempInstall = join(liveDir, `.bryce-restore-${stamp}.db`);
  const liveExisted = existsSync(liveDbPath);
  let renamed = false;

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
    // This Snapshot — not a move-aside copy — is the rollback source.
    let safetySnapshot: string | null = null;
    if (liveExisted) {
      const liveForBackup = new Database(liveDbPath);
      try {
        safetySnapshot = (await createSnapshot(liveForBackup, backupDir, now)).name;
      } finally {
        liveForBackup.close();
      }
    }

    // (5) WAL-safe swap via a SINGLE atomic rename. Checkpoint(TRUNCATE) first so
    // the live WAL is folded into (and truncated from) the main file — after this
    // any lingering `-wal` is zero-byte and applies nothing on the next open.
    fault("checkpoint");
    if (liveExisted) {
      const ckpt = new Database(liveDbPath);
      try {
        ckpt.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        ckpt.close();
      }
    }

    // The atomic replace: renameSync REPLACES liveDbPath in one step on POSIX, so
    // the path is never absent (this closes the blank-DB window a move-aside would
    // open between moving the old file away and renaming the new one in).
    fault("rename");
    renameSync(tempInstall, liveDbPath);
    renamed = true;

    fault("dir-fsync");
    fsyncDir(liveDir);
    chmodSync(liveDbPath, SNAPSHOT_FILE_MODE);

    // The old live sidecars are now stale — the installed file has none.
    for (const suffix of ["-wal", "-shm"]) {
      const stale = liveDbPath + suffix;
      try {
        if (existsSync(stale)) rmSync(stale, { force: true });
      } catch {
        // best-effort
      }
    }

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
    if (!renamed) {
      // The atomic swap never happened: the live file is untouched. Drop the
      // validated temp (and its sidecars); nothing else changed.
      rmWithSidecars(tempInstall);
    } else if (!liveExisted) {
      // Fresh-install case: the install rename completed, then a later step
      // faulted. Leaving the installed DB behind while reporting failure would
      // half-install a fresh database, so remove it and restore the "absent"
      // pre-state (the caller can re-run once the fault is resolved).
      rmWithSidecars(liveDbPath);
    }
    // else (renamed && liveExisted): the atomic replace already completed and the
    // restored data is valid and present; the safety Snapshot is the recovery
    // source. We never leave the live path blank.
    throw err;
  } finally {
    lock?.release();
  }
}
