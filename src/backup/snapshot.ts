import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * The Snapshot service (ADR 0042): whole-database, point-in-time file copies for
 * *logical* rollback — above all, the known-good state to return to before a
 * risky migration. Distinct from the Litestream Replica (continuous, off-box).
 *
 * Publication is crash-safe: back up to a NON-owned temp name, validate the copy
 * (open read-only + integrity_check), fsync, then atomically rename to the owned
 * name — so a crash mid-write never leaves a torn file under a name that looks
 * complete. Names are UTC `bryce-YYYYMMDDTHHMMSSZ-NNN.db`; ordering is by the
 * embedded timestamp + numeric sequence, never a naive lexical sort of the
 * suffix.
 */

/** Matches ONLY our own owned Snapshot filenames — never a temp or unrelated file. */
const SNAPSHOT_RE = /^bryce-(\d{8}T\d{6}Z)-(\d{3})\.db$/;

/** Snapshots, the restored database, and the player-backup file are owner-only. */
export const SNAPSHOT_FILE_MODE = 0o600;

const MAX_SEQ_PER_SECOND = 1000;

export interface SnapshotInfo {
  name: string;
  path: string;
  /** UTC stamp embedded in the name, e.g. `20260722T120000Z`. */
  timestamp: string;
  /** Same-second sequence (0-based); higher = later within the second. */
  seq: number;
  mtimeMs: number;
}

export interface PruneResult {
  kept: string[];
  deleted: string[];
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** UTC `YYYYMMDDTHHMMSSZ` — fixed width, so lexical order is chronological. */
export function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Best-effort fsync of a directory entry so a rename is durable across a crash. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms cannot fsync a directory handle; the rename still landed.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** fsync a just-written regular file so its bytes are durable before publish. */
function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface CreateSnapshotOptions {
  /**
   * Test seam: invoked just before the atomic name publication, so a test can
   * simulate a concurrent process claiming the same sequence and prove the
   * publish never overwrites it.
   */
  onBeforePublish?: () => void;
}

/**
 * Take a Snapshot of `source` into `dir`, crash-safely. Uses better-sqlite3's
 * online `.backup()` (WAL-consistent — folds committed frames, no torn read),
 * validates the copy, fsyncs, and publishes it under the first free
 * `bryce-<stamp>-NNN.db` name using an ATOMIC exclusive claim (`link()`): two
 * processes snapshotting in the same second can never both take `-000` and clobber
 * one another — the loser gets EEXIST and bumps the sequence. Returns the
 * published file's metadata.
 */
export async function createSnapshot(
  source: Database.Database,
  dir: string,
  now: () => Date = () => new Date(),
  options: CreateSnapshotOptions = {},
): Promise<SnapshotInfo> {
  mkdirSync(dir, { recursive: true });
  const stamp = utcStamp(now());
  const tempPath = join(dir, `.tmp-snapshot-${stamp}-${process.pid}.db`);

  let seq = -1;
  let finalName = "";
  let finalPath = "";
  try {
    await source.backup(tempPath);

    // Validate the materialized copy on a genuinely read-only handle.
    const check = new Database(tempPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = check.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new SnapshotValidationError(`snapshot failed integrity_check: ${String(integrity)}`);
      }
    } finally {
      check.close();
    }

    fsyncFile(tempPath);
    chmodSync(tempPath, SNAPSHOT_FILE_MODE);

    options.onBeforePublish?.();

    // Atomically claim the first free sequence name. link() creates a second name
    // for the temp's inode and FAILS with EEXIST if the name is already taken —
    // an exclusive, race-free publish. No 0-byte placeholder is ever left behind.
    for (let candidate = 0; candidate < MAX_SEQ_PER_SECOND; candidate += 1) {
      const name = `bryce-${stamp}-${pad(candidate, 3)}.db`;
      const path = join(dir, name);
      try {
        linkSync(tempPath, path);
        seq = candidate;
        finalName = name;
        finalPath = path;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
    if (finalName === "") {
      throw new SnapshotValidationError(`snapshot name space exhausted for ${stamp}`);
    }

    unlinkSync(tempPath); // drop the temp name; finalPath keeps the inode alive
    fsyncDir(dir);
  } catch (err) {
    try {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  const st = statSync(finalPath);
  return { name: finalName, path: finalPath, timestamp: stamp, seq, mtimeMs: st.mtimeMs };
}

/**
 * Owned Snapshots in `dir`, newest first. Regular files only — a symlink or
 * directory bearing the pattern is deliberately ignored (never listed, never a
 * prune target). Ordering is by embedded (timestamp, sequence), then mtime.
 */
export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  const infos: SnapshotInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dirent reflects the entry's own type (no symlink following): skip symlinks and dirs.
    if (!entry.isFile()) continue;
    const match = SNAPSHOT_RE.exec(entry.name);
    if (match === null) continue;
    const path = join(dir, entry.name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    infos.push({
      name: entry.name,
      path,
      timestamp: match[1] as string,
      seq: Number(match[2]),
      mtimeMs: st.mtimeMs,
    });
  }
  infos.sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || b.seq - a.seq || b.mtimeMs - a.mtimeMs,
  );
  return infos;
}

/**
 * Keep the `keepLast` newest Snapshots in `dir`, delete the rest. Deletes only
 * owned Snapshot filenames that are regular files (never a symlink or unrelated
 * file). Idempotent; `keepLast` must be >= 1 (validated upstream in config).
 */
export function pruneSnapshots(dir: string, keepLast: number): PruneResult {
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    throw new RangeError(`keepLast must be an integer >= 1, got ${keepLast}`);
  }
  const snapshots = listSnapshots(dir);
  const kept = snapshots.slice(0, keepLast);
  const deleted: string[] = [];
  for (const snap of snapshots.slice(keepLast)) {
    try {
      // Re-confirm with lstat that it is a regular file — never follow a symlink.
      if (!lstatSync(snap.path).isFile()) continue;
      rmSync(snap.path, { force: true });
      deleted.push(snap.name);
    } catch {
      // best-effort: a file we could not remove stays; retention is not a guarantee.
    }
  }
  return { kept: kept.map((s) => s.name), deleted };
}
