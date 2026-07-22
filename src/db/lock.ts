import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * A cooperative advisory PRESENCE registry guarding the live database (ADR 0042).
 *
 * Why a registry and not a single exclusive lock: the existing design runs the
 * long-lived server AND short-lived launchd jobs (Refresh, Digest) as SEPARATE
 * processes against one WAL database on purpose (ADR 0034) — an exclusive,
 * held-for-lifetime lock would forbid that concurrency. So every in-process app
 * opener instead REGISTERS its presence (a `<pid>.json` file under
 * `${dirname(dbPath)}/.bryce.lock/`) for its lifetime and deregisters on close;
 * many can coexist.
 *
 * Restore is the one operation that must run alone. It uses a RACE-FREE two-flag
 * mutual-exclusion protocol against openers (no TOCTOU window):
 *
 *   - Restore publishes an EXCLUSIVE marker (`.bryce.restore.lock`, O_EXCL) FIRST,
 *     THEN checks the presence registry for any live opener — aborting (and
 *     unlinking its marker) if one exists.
 *   - Every opener publishes its own presence entry FIRST, THEN checks for a live
 *     restore marker — refusing to open (`DatabaseBusyError`) if one exists.
 *
 * Because each party publishes its own flag before reading the other's, at least
 * one side always observes the conflict (classic two-flag exclusion): a server or
 * job that starts mid-restore is rejected, and restore refuses if any opener is
 * live — with no window where both proceed. Litestream does NOT cooperate, so the
 * Restore runbook still requires stopping it too.
 *
 * Stale entries self-heal: a `<pid>.json` OR a restore marker whose pid is no
 * longer alive (a crashed process that never released) is ignored and cleaned up,
 * so a crash can never wedge the database shut forever.
 */

export const LOCK_DIRNAME = ".bryce.lock";
/** The exclusive restore marker (a single file, not a per-pid registry entry). */
export const RESTORE_MARKER_FILENAME = ".bryce.restore.lock";

/** The live database is in use by another cooperating process. */
export class DatabaseBusyError extends Error {
  readonly ownerPid: number;
  readonly lockPath: string;

  constructor(ownerPid: number, lockPath: string) {
    super(
      `database is in use by pid ${ownerPid} (registry ${lockPath}); ` +
        `stop the server, the launchd jobs, and Litestream before restoring`,
    );
    this.name = "DatabaseBusyError";
    this.ownerPid = ownerPid;
    this.lockPath = lockPath;
  }
}

export interface LockOwner {
  pid: number;
  startedAt: string;
}

export interface DbLock {
  readonly path: string;
  /** Deregister this process. Idempotent, best-effort. */
  release: () => void;
}

export function lockDirFor(databasePath: string): string {
  return join(dirname(databasePath), LOCK_DIRNAME);
}

export function restoreMarkerPath(databasePath: string): string {
  return join(dirname(databasePath), RESTORE_MARKER_FILENAME);
}

/** True when `pid` names a process that currently exists (permission counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: the process exists, we just may not signal it — still alive.
    if (code === "EPERM") return true;
    // ESRCH (and anything else): no such process.
    return false;
  }
}

function entryPathFor(lockDir: string, pid: number): string {
  return join(lockDir, `${pid}.json`);
}

function readOwner(path: string): LockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      };
    }
  } catch {
    // A corrupt entry has no readable owner; treat as stale below.
  }
  return null;
}

/**
 * Live registered holders of the database, cleaning up any dead-pid entries seen.
 * `excludePid` omits a given pid (a caller checking for OTHER holders than itself).
 */
export function liveHolders(databasePath: string, excludePid?: number): LockOwner[] {
  if (databasePath === ":memory:") return [];
  const lockDir = lockDirFor(databasePath);
  let names: string[];
  try {
    names = readdirSync(lockDir);
  } catch {
    return [];
  }
  const holders: LockOwner[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(lockDir, name);
    const owner = readOwner(path);
    if (owner === null || !isProcessAlive(owner.pid)) {
      // Stale (dead owner or unreadable): clean it up best-effort.
      try {
        unlinkSync(path);
      } catch {
        // someone else may have cleaned it; ignore
      }
      continue;
    }
    if (excludePid !== undefined && owner.pid === excludePid) continue;
    holders.push(owner);
  }
  return holders;
}

/**
 * Refuse if any OTHER live process is registered against the database. Used by
 * Restore before it swaps a Snapshot into place.
 */
export function assertNotBusy(databasePath: string, ownPid: number = process.pid): void {
  const others = liveHolders(databasePath, ownPid);
  const first = others[0];
  if (first !== undefined) {
    throw new DatabaseBusyError(first.pid, lockDirFor(databasePath));
  }
}

/**
 * Register this process's presence for its lifetime. Returns a handle to
 * deregister, or null for an in-memory database (process-private — nothing to
 * interlock). Coexists with other holders by design.
 */
export function acquireDbLock(databasePath: string, now: () => Date = () => new Date()): DbLock | null {
  if (databasePath === ":memory:") return null;
  const lockDir = lockDirFor(databasePath);
  mkdirSync(lockDir, { recursive: true });
  const path = entryPathFor(lockDir, process.pid);
  // "w" (not "wx"): a leftover entry from a previous run of THIS pid is simply
  // overwritten — a reused pid is our own to reclaim.
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return {
    path,
    release: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort deregistration
      }
    },
  };
}

/** The live restore marker's owner, or null if absent / held by a dead pid. */
export function liveRestoreMarker(databasePath: string): LockOwner | null {
  if (databasePath === ":memory:") return null;
  const owner = readOwner(restoreMarkerPath(databasePath));
  if (owner === null) return null;
  return isProcessAlive(owner.pid) ? owner : null;
}

/**
 * Opener side of the two-flag exclusion. Publishes this process's presence FIRST,
 * then refuses (`DatabaseBusyError`) if a live restore marker exists — so an
 * opener that starts mid-restore is rejected instead of opening the file while
 * restore renames underneath it. Returns null for an in-memory database.
 */
export function acquireOpenLock(databasePath: string, now: () => Date = () => new Date()): DbLock | null {
  const lock = acquireDbLock(databasePath, now); // publish our presence flag FIRST
  if (lock === null) return null; // :memory: — nothing to interlock
  const marker = readOwner(restoreMarkerPath(databasePath));
  if (marker !== null && isProcessAlive(marker.pid)) {
    lock.release();
    throw new DatabaseBusyError(marker.pid, restoreMarkerPath(databasePath));
  }
  return lock;
}

/**
 * Restore side of the two-flag exclusion. Atomically publishes an EXCLUSIVE marker
 * FIRST (O_EXCL — a live marker means another restore is in progress), then
 * refuses (`DatabaseBusyError`) if any live opener is registered. On refusal it
 * unlinks its own marker so nothing lingers. Returns null for :memory:.
 */
export function acquireRestoreLock(
  databasePath: string,
  now: () => Date = () => new Date(),
): DbLock | null {
  if (databasePath === ":memory:") return null;
  const dir = dirname(databasePath);
  mkdirSync(dir, { recursive: true });
  const markerPath = restoreMarkerPath(databasePath);

  // Publish our exclusive marker FIRST (with stale-marker self-heal).
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      const fd = openSync(markerPath, "wx", 0o600); // O_CREAT | O_EXCL
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }));
      } finally {
        closeSync(fd);
      }
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readOwner(markerPath);
      if (owner !== null && isProcessAlive(owner.pid)) {
        throw new DatabaseBusyError(owner.pid, markerPath); // another restore in progress
      }
      try {
        unlinkSync(markerPath); // stale (dead owner) — clear and retry
      } catch {
        // raced with another clearer; the retry contends fairly
      }
    }
  }
  if (!created) {
    const owner = readOwner(markerPath);
    throw new DatabaseBusyError(owner?.pid ?? -1, markerPath);
  }

  const releaseMarker = (): void => {
    try {
      const owner = readOwner(markerPath);
      if (owner !== null && owner.pid === process.pid) unlinkSync(markerPath);
    } catch {
      // best-effort
    }
  };

  // Marker published; NOW check the opener registry (restore has no presence entry
  // of its own, so no exclude pid is needed).
  const holders = liveHolders(databasePath);
  const first = holders[0];
  if (first !== undefined) {
    releaseMarker();
    throw new DatabaseBusyError(first.pid, lockDirFor(databasePath));
  }

  return { path: markerPath, release: releaseMarker };
}
