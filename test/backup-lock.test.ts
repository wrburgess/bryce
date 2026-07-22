import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DatabaseBusyError,
  acquireDbLock,
  assertNotBusy,
  isProcessAlive,
  liveHolders,
  lockDirFor,
} from "../src/db/lock.js";
import { createSnapshot } from "../src/backup/snapshot.js";
import { restoreSnapshot } from "../src/backup/restore.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import { fakeClock, insertPlayer, testFileDb } from "./factories.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const holderScript = join(repoRoot, "test", "helpers", "lock-holder.ts");

/** Definitely-dead pid: the max 32-bit pid is not a running process. */
const DEAD_PID = 2_147_483_647;

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
