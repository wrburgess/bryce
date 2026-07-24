import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { players } from "../src/db/schema.js";
import { createSnapshot, listSnapshots } from "../src/backup/snapshot.js";
import { MAX_BACKUP_BYTES, parsePlayerListBackup } from "../src/backup/player-list.js";
import { runBackup } from "../src/cli/backup.js";
import { runRestore } from "../src/cli/restore.js";
import { runPlayersBackup } from "../src/cli/players-backup.js";
import { runPlayersRestore } from "../src/cli/players-restore.js";
import type { TempDir } from "./backup-helpers.js";
import { makeBackupEntry, makeBackupEnvelope, makeTempDir } from "./backup-helpers.js";
import type { TempFileDb } from "./factories.js";
import { fakeClock, insertPlayer, testFileDb } from "./factories.js";

const CLOCK = fakeClock("2026-07-22T12:00:00Z").now;

describe("CLI logic in-process", () => {
  let live: TempFileDb;
  let backups: TempDir;
  let out: string[];
  const write = (line: string): void => {
    out.push(line);
  };

  beforeEach(() => {
    live = testFileDb();
    backups = makeTempDir();
    out = [];
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
  });

  describe("db:backup", () => {
    it("snapshots and prints a deterministic snapshot + retention line", async () => {
      const code = await runBackup([], {
        sqlite: live.opened.sqlite,
        backupDir: backups.path,
        keepLast: 10,
        now: CLOCK,
        write,
      });
      expect(code).toBe(0);
      expect(out[0]).toMatch(/^snapshot created name=bryce-\d{8}T\d{6}Z-\d{3}\.db dir=/);
      expect(out[1]).toBe("retention keepLast=10 kept=1 deleted=0");
      expect(listSnapshots(backups.path)).toHaveLength(1);
    });

    it("fails loud on unexpected arguments", async () => {
      const code = await runBackup(["surprise"], {
        sqlite: live.opened.sqlite,
        backupDir: backups.path,
        keepLast: 10,
        now: CLOCK,
        write,
      });
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error:/);
    });
  });

  describe("db:restore", () => {
    it("restores a snapshot and reports the safety snapshot", async () => {
      await insertPlayer(live.opened.db, { fullName: "Live" });
      const snap = await createSnapshot(live.opened.sqlite, backups.path, CLOCK);
      live.opened.close();

      const code = await runRestore(["--from", snap.path], {
        liveDbPath: live.path,
        backupDir: backups.path,
        keepLast: 10,
        now: CLOCK,
        write,
      });
      expect(code).toBe(0);
      expect(out[0]).toMatch(/^restored from=bryce-.*safetySnapshot=bryce-/);
    });

    it("maps a typed error (alias) to a non-zero usage line", async () => {
      const code = await runRestore(["--from", live.path], {
        liveDbPath: live.path,
        backupDir: backups.path,
        keepLast: 10,
        now: CLOCK,
        write,
      });
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: refusing to restore/);
    });

    it("fails loud on a missing or unknown flag", async () => {
      expect(await runRestore([], { liveDbPath: live.path, backupDir: backups.path, keepLast: 10, now: CLOCK, write })).toBe(1);
      out = [];
      expect(
        await runRestore(["--bogus", "x"], {
          liveDbPath: live.path,
          backupDir: backups.path,
          keepLast: 10,
          now: CLOCK,
          write,
        }),
      ).toBe(1);
      expect(out[0]).toMatch(/^error: unknown flag/);
    });
  });

  describe("players:backup", () => {
    it("writes a versioned envelope to --out", async () => {
      await insertPlayer(live.opened.db, { externalId: 691185, fullName: "Maximo Acosta" });
      const outPath = join(backups.path, "players.json");
      const code = await runPlayersBackup(["--out", outPath], {
        db: live.opened.db,
        databasePath: live.path,
        now: CLOCK,
        write,
      });
      expect(code).toBe(0);
      expect(out[0]).toBe(`player-list backup written out=${outPath} players=1`);
      const parsed = parsePlayerListBackup(readFileSync(outPath, "utf8"));
      expect(parsed.players[0]?.externalId).toBe(691185);
    });

    it("refuses to overwrite the live database or a Snapshot name", async () => {
      expect(
        await runPlayersBackup(["--out", live.path], {
          db: live.opened.db,
          databasePath: live.path,
          now: CLOCK,
          write,
        }),
      ).toBe(1);
      expect(out[0]).toMatch(/refusing to overwrite the live database/);
      out = [];
      expect(
        await runPlayersBackup(["--out", join(backups.path, "bryce-20260722T120000Z-000.db")], {
          db: live.opened.db,
          databasePath: live.path,
          now: CLOCK,
          write,
        }),
      ).toBe(1);
      expect(out[0]).toMatch(/refusing to write a player-list backup over a Snapshot/);
    });

    it("fails loud on a missing --out", async () => {
      expect(
        await runPlayersBackup([], { db: live.opened.db, databasePath: live.path, now: CLOCK, write }),
      ).toBe(1);
      expect(out[0]).toMatch(/requires --out/);
    });

    it("fails loud and writes nothing when the generated backup exceeds the size ceiling (finding #9)", async () => {
      // One player with a notes field large enough to push the JSON over the
      // parser's ceiling — the producer must refuse rather than write a file
      // players:restore would always reject.
      await insertPlayer(live.opened.db, {
        externalId: 691185,
        fullName: "Huge Notes",
        notes: "x".repeat(MAX_BACKUP_BYTES + 100),
      });
      const outPath = join(backups.path, "too-big.json");
      const code = await runPlayersBackup(["--out", outPath], {
        db: live.opened.db,
        databasePath: live.path,
        now: CLOCK,
        write,
      });
      expect(code).toBe(1);
      expect(out[0]).toMatch(/over the .*-byte ceiling; nothing written/);
      expect(existsSync(outPath)).toBe(false);
    });
  });

  describe("players:restore", () => {
    it("imports a valid backup file and reports counts", async () => {
      const file = join(backups.path, "players.json");
      writeFileSync(file, JSON.stringify(makeBackupEnvelope([makeBackupEntry({ externalId: 700009 })])));
      const code = await runPlayersRestore(["--in", file], {
        db: live.opened.db,
        now: CLOCK,
        write,
      });
      expect(code).toBe(0);
      expect(out[0]).toBe("player-list restored inserted=1 updated=0 total=1 lists=0 members=0");
      expect((await live.opened.db.select().from(players))[0]?.externalId).toBe(700009);
    });

    it("rejects an invalid payload with a non-zero exit", async () => {
      const file = join(backups.path, "bad.json");
      writeFileSync(file, JSON.stringify({ players: [] })); // missing version
      const code = await runPlayersRestore(["--in", file], { db: live.opened.db, now: CLOCK, write });
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: invalid player-list backup/);
    });

    it("fails loud on a missing --in or unreadable file", async () => {
      expect(await runPlayersRestore([], { db: live.opened.db, now: CLOCK, write })).toBe(1);
      out = [];
      expect(
        await runPlayersRestore(["--in", join(backups.path, "nope.json")], {
          db: live.opened.db,
          now: CLOCK,
          write,
        }),
      ).toBe(1);
      expect(out[0]).toMatch(/^error: cannot read/);
    });
  });
});

/**
 * Real subprocess per entrypoint (resolution #13): network-free — a temp DB and
 * injected env, no MLB/NCAA. Proves the flush-safe exit, `.env` load, and real
 * filesystem args in an actual process. If the local sandbox forbids
 * process-spawn, that is surfaced explicitly (CI is authoritative), never a
 * silent skip.
 */
describe("CLI real subprocess", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  let work: TempDir;
  let dbPath: string;
  let backupDir: string;

  const cliEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    MAILER_PROVIDER: "console",
    DATABASE_PATH: dbPath,
    BACKUP_DIR: backupDir,
  });

  const runCli = (script: string, args: string[]) =>
    spawnSync(tsxBin, [join(repoRoot, "src", "cli", script), ...args], {
      encoding: "utf8",
      env: cliEnv(),
      cwd: work.path,
    });

  beforeEach(() => {
    work = makeTempDir();
    dbPath = join(work.path, "bryce.db");
    backupDir = join(work.path, "snapshots");
  });

  afterEach(() => {
    work.cleanup();
  });

  it("db:backup creates and prunes a snapshot end to end", () => {
    const result = runCli("backup.ts", []);
    expect(result.status).toBe(0);
    expect(`${result.stdout}`).toMatch(/snapshot created name=bryce-/);
    expect(readdirSync(backupDir).some((n) => /^bryce-.*\.db$/.test(n))).toBe(true);
  }, 30_000);

  it("db:restore swaps a snapshot the backup just wrote", () => {
    const backup = runCli("backup.ts", []);
    expect(backup.status).toBe(0);
    const snapshot = readdirSync(backupDir).find((n) => /^bryce-.*\.db$/.test(n));
    expect(snapshot).toBeDefined();
    const restore = runCli("restore.ts", ["--from", join(backupDir, snapshot as string)]);
    expect(restore.status).toBe(0);
    expect(`${restore.stdout}`).toMatch(/^restored from=bryce-/m);
  }, 30_000);

  it("db:restore fails loud (no stack trace) on a missing --from", () => {
    const result = runCli("restore.ts", []);
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain("requires --from");
    expect(combined).not.toMatch(/\n\s+at /);
  }, 30_000);

  it("players:backup then players:restore round-trips a player", () => {
    // Seed one player directly so the backup is non-empty.
    const seedFile = join(work.path, "seed.json");
    writeFileSync(
      seedFile,
      JSON.stringify(makeBackupEnvelope([makeBackupEntry({ externalId: 424242, fullName: "Sub Player" })])),
    );
    // Bring the DB up + import.
    const restore = runCli("players-restore.ts", ["--in", seedFile]);
    expect(restore.status).toBe(0);
    expect(`${restore.stdout}`).toMatch(/player-list restored inserted=1/);

    // Now back it up to a file.
    const outFile = join(work.path, "out.json");
    const backup = runCli("players-backup.ts", ["--out", outFile]);
    expect(backup.status).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const parsed = parsePlayerListBackup(readFileSync(outFile, "utf8"));
    expect(parsed.players.some((p) => p.externalId === 424242)).toBe(true);
  }, 30_000);
});
