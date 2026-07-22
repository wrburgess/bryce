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
 * Restore is the one operation that must run alone: it refuses (`DatabaseBusyError`)
 * while ANY other live pid is registered, so a Snapshot is never swapped under a
 * running app. Litestream does NOT cooperate with this registry, so the Restore
 * runbook still requires stopping the server, the launchd jobs, AND Litestream
 * first — the registry covers the cooperating processes, the runbook the rest.
 *
 * Stale entries self-heal: a `<pid>.json` whose pid is no longer alive (a crashed
 * process that never deregistered) is ignored and cleaned up, so a crash can
 * never wedge the database shut forever.
 */

export const LOCK_DIRNAME = ".bryce.lock";

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
