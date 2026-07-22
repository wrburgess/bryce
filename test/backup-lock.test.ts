import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DatabaseBusyError,
  acquireDbLock,
  acquireOpenLock,
  acquireRestoreLock,
  assertNotBusy,
  isProcessAlive,
  liveHolders,
  lockDirFor,
  restoreMarkerPath,
} from "../src/db/lock.js";
import { createSnapshot } from "../src/backup/snapshot.js";
import { restoreSnapshot } from "../src/backup/restore.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import { fakeClock, insertPlayer, testFileDb } from "./factories.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const holderScript = join(repoRoot, "test", "helpers", "lock-holder.ts");
const restoreHolderScript = join(repoRoot, "test", "helpers", "restore-holder.ts");
const CLOCK = fakeClock("2026-07-22T12:00:00Z").now;

/** Definitely-dead pid: the max 32-bit pid is not a running process. */
const DEAD_PID = 2_147_483_647;

/** Spawn a holder script and resolve once it prints HELD (never a wall-clock sleep). */
function spawnUntilHeld(script: string, dbPath: string): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
} {
  const child = spawn(tsxBin, [script, dbPath], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("HELD")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`holder exited early code=${code}`)));
  });
  return { child, ready };
}

/**
 * The interlock (ADR 0042): a cooperative presence registry. Many app processes
 * coexist (server + jobs); Restore refuses while ANY other live process is
 * registered — proven against a REAL second process.
 */
describe("database interlock registry", () => {
  let live: TempDir;
  let dbPath: string;

  beforeEach(() => {
    live = makeTempDir();
    dbPath = join(live.path, "bryce.db");
  });

  afterEach(() => {
    live.cleanup();
  });

  it("is a no-op for :memory: (process-private — nothing to interlock)", () => {
    expect(acquireDbLock(":memory:")).toBeNull();
    expect(liveHolders(":memory:")).toEqual([]);
  });

  it("registers this process and deregisters on release", () => {
    const lock = acquireDbLock(dbPath, fakeClock("2026-07-22T12:00:00Z").now);
    expect(lock).not.toBeNull();
    expect(existsSync(lock!.path)).toBe(true);
    // Our own pid is a live holder.
    expect(liveHolders(dbPath).some((h) => h.pid === process.pid)).toBe(true);
    // assertNotBusy excludes our own pid, so it passes with only us registered.
    expect(() => assertNotBusy(dbPath, process.pid)).not.toThrow();

    lock!.release();
    expect(existsSync(lock!.path)).toBe(false);
    expect(liveHolders(dbPath)).toEqual([]);
  });

  it("treats another live pid as busy and cleans up a dead-pid entry", () => {
    const lockDir = lockDirFor(dbPath);
    mkdirSync(lockDir, { recursive: true });

    // A dead-pid entry is stale: liveHolders ignores AND removes it.
    const deadEntry = join(lockDir, `${DEAD_PID}.json`);
    writeFileSync(deadEntry, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(liveHolders(dbPath)).toEqual([]);
    expect(existsSync(deadEntry)).toBe(false);

    // A live foreign pid (our parent) IS a holder → busy.
    const foreignPid = process.ppid;
    writeFileSync(
      join(lockDir, `${foreignPid}.json`),
      JSON.stringify({ pid: foreignPid, startedAt: "2026-07-22T12:00:00.000Z" }),
    );
    expect(() => assertNotBusy(dbPath, process.pid)).toThrow(DatabaseBusyError);
  });
});

describe("restoreSnapshot interlock (real second process)", () => {
  let live: ReturnType<typeof testFileDb>;
  let backups: TempDir;
  let snapshotPath: string;

  beforeEach(async () => {
    live = testFileDb();
    backups = makeTempDir();
    await insertPlayer(live.opened.db, { fullName: "Maximo Acosta" });
    const info = await createSnapshot(live.opened.sqlite, backups.path, fakeClock("2026-07-22T12:00:00Z").now);
    snapshotPath = info.path;
    // Close our own handle so the ONLY holder is the spawned process.
    live.opened.close();
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
  });

  it("refuses with DatabaseBusyError while a real second process holds the registration", async () => {
    const child = spawn(tsxBin, [holderScript, live.path], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      // Wait until the child has registered (prints HELD) — never a wall-clock sleep.
      await new Promise<void>((resolve, reject) => {
        let buf = "";
        const onData = (chunk: Buffer): void => {
          buf += chunk.toString();
          if (buf.includes("HELD")) resolve();
        };
        child.stdout.on("data", onData);
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`holder exited early code=${code}`)));
      });

      await expect(
        restoreSnapshot({
          liveDbPath: live.path,
          candidatePath: snapshotPath,
          backupDir: backups.path,
          keepLast: 10,
          now: fakeClock("2026-07-22T12:05:00Z").now,
        }),
      ).rejects.toBeInstanceOf(DatabaseBusyError);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }
  }, 30_000);
});

/**
 * The RACE-FREE two-flag exclusion (finding #1): each party publishes its own
 * artifact before checking the other's, so a mid-restore opener is rejected AND a
 * restore refuses while an opener is live — with no TOCTOU window. Proven with
 * REAL spawned processes in both directions.
 */
describe("two-flag restore exclusion", () => {
  let dir: TempDir;
  let dbPath: string;

  beforeEach(() => {
    dir = makeTempDir();
    dbPath = join(dir.path, "bryce.db");
  });

  afterEach(() => {
    dir.cleanup();
  });

  it("rejects a REAL opener process that starts while a restore marker is held", () => {
    // This test process holds the exclusive restore marker.
    const held = acquireRestoreLock(dbPath, CLOCK);
    try {
      // A real opener process must refuse to open and exit non-zero.
      const result = spawnSync(tsxBin, [holderScript, dbPath], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("REJECTED");
    } finally {
      held?.release();
    }
  }, 30_000);

  it("rejects an in-process open while a REAL restore-holder process holds the marker", async () => {
    const { child, ready } = spawnUntilHeld(restoreHolderScript, dbPath);
    try {
      await ready;
      // The opener publishes its presence then sees the real process's marker.
      expect(() => acquireOpenLock(dbPath)).toThrow(DatabaseBusyError);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }
  }, 30_000);

  it("rejects a second restore while a REAL restore-holder process holds the marker", async () => {
    const { child, ready } = spawnUntilHeld(restoreHolderScript, dbPath);
    try {
      await ready;
      expect(() => acquireRestoreLock(dbPath)).toThrow(DatabaseBusyError);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }
  }, 30_000);

  it("a dead-pid restore marker never wedges an opener or a new restore (self-heal)", () => {
    // A stale marker from a crashed restore (dead owner).
    mkdirSync(dir.path, { recursive: true });
    writeFileSync(
      restoreMarkerPath(dbPath),
      JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    // An opener sees a dead marker and opens normally.
    const openLock = acquireOpenLock(dbPath, CLOCK);
    expect(openLock).not.toBeNull();
    openLock?.release();
    // A new restore clears the stale marker (O_EXCL EEXIST -> dead -> unlink -> retry).
    const restoreLock = acquireRestoreLock(dbPath, CLOCK);
    expect(restoreLock).not.toBeNull();
    restoreLock?.release();
  });

  it("a dead-pid presence entry never wedges a restore (self-heal)", () => {
    mkdirSync(lockDirFor(dbPath), { recursive: true });
    writeFileSync(
      join(lockDirFor(dbPath), `${DEAD_PID}.json`),
      JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const restoreLock = acquireRestoreLock(dbPath, CLOCK);
    expect(restoreLock).not.toBeNull();
    restoreLock?.release();
  });
});
