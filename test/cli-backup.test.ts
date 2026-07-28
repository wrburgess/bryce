import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { players } from "../src/db/schema.js";
import { openReadonlyDb } from "../src/db/readonly.js";
import { createSnapshot, listSnapshots } from "../src/backup/snapshot.js";
import { MAX_BACKUP_BYTES, parsePlayerListBackup } from "../src/backup/player-list.js";
import { runBackup } from "../src/cli/backup.js";
import { runRestore } from "../src/cli/restore.js";
import { runPlayersBackup } from "../src/cli/players-backup.js";
import { runPlayersRestore } from "../src/cli/players-restore.js";
import type { TempDir } from "./backup-helpers.js";
import { createList, setDefaultList } from "../src/lists/service.js";
import { makeBackupEntry, makeBackupEnvelope, makeBackupList, makeTempDir } from "./backup-helpers.js";
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
      // A payload with no `lists` array says nothing about lists, so the seeded
      // default lane survives and there is nothing to warn about (#190).
      expect(out.join("\n")).not.toContain("warning:");
    });

    it("WARNS, naming set-default, when a pre-v5 payload leaves no default lane (#190)", async () => {
      // Silence is the failure mode this whole line exists to prevent: without
      // it the HC discovers the missing lane when a digest does not arrive. The
      // TEXT is pinned, not merely the presence of some warning.
      const file = join(backups.path, "v4.json");
      writeFileSync(
        file,
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry({ externalId: 700010 })], { version: 4 }),
          lists: [{ name: "Legacy" }],
          members: [{ list: "Legacy", externalId: 700010, ncaaPlayerSeq: null }],
        }),
      );

      const code = await runPlayersRestore(["--in", file], {
        db: live.opened.db,
        now: CLOCK,
        write,
      });

      // The restore SUCCEEDS — failing closed here would refuse a legitimate
      // recovery from an older backup, which is worse than an operable warning.
      expect(code).toBe(0);
      expect(out[0]).toContain("lists=1 members=1");
      expect(out[1]).toBe(
        "warning: no default list after restore — unscoped commands will fail until you run: sk players lists set-default --name NAME",
      );
      // ONE warning, not two: the default did move (Watchlist -> none), but the
      // line above already says so in the form that names the fix. A second
      // re-point line here would be noise on the same event (#190).
      expect(out).toHaveLength(2);
    });

    it("WARNS, naming both lanes, when the restore RE-POINTS the default (#190)", async () => {
      // The backup's default wins — deliberately, so a restored state does not
      // depend on what happened to be in the database. The cost is that a
      // restore run to recover one deleted player also moves the schedule back
      // to whichever lane was default when the backup was written. This line is
      // what keeps that from being discovered by reading the wrong digest, so
      // its TEXT is pinned, including the command that undoes it.
      await createList(live.opened.db, "Prospects", CLOCK());
      await setDefaultList(live.opened.db, "Prospects", CLOCK());

      const file = join(backups.path, "v5.json");
      writeFileSync(
        file,
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry({ externalId: 700011 })], { version: 5 }),
          lists: [makeBackupList({ name: "Watchlist", isDefault: true })],
        }),
      );

      const code = await runPlayersRestore(["--in", file], {
        db: live.opened.db,
        now: CLOCK,
        write,
      });

      expect(code).toBe(0);
      expect(out[1]).toBe(
        'warning: default list changed from "Prospects" to "Watchlist" — the backup\'s default won; run: sk players lists set-default --name "Prospects" to change it back',
      );
      // The re-point is the ONLY warning: a default exists, so the no-default
      // line must not also fire.
      expect(out).toHaveLength(2);
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
  const offlineFetch = join(repoRoot, "test", "helpers", "offline-fetch.mjs");
  let work: TempDir;
  let dbPath: string;
  let backupDir: string;

  const cliEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MAILER_PROVIDER: "console",
    DATABASE_PATH: dbPath,
    BACKUP_DIR: backupDir,
    BRYCE_TZ: "America/Chicago",
    NODE_OPTIONS: `--import=${offlineFetch}`,
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

  it("runs migrate, refresh, and digest through their real safe entrypoints", () => {
    const migrate = runCli("migrate.ts", []);
    expect(migrate.status).toBe(0);
    expect(`${migrate.stdout}`).toContain(`migrations applied path=${dbPath}`);
    expect(existsSync(dbPath)).toBe(true);
    let opened = openReadonlyDb(dbPath);
    try {
      expect(opened.sqlite.prepare("select count(*) as count from __drizzle_migrations").get()).toMatchObject({ count: expect.any(Number) });
      expect((opened.sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as { count: number }).count).toBeGreaterThan(0);
    } finally { opened.close(); }

    // The fresh migrated database has no active players, and the child fixture
    // makes any unexpected calendar fetch fail locally rather than egress. Since
    // #192 a bare `sk refresh` resolves the DEFAULT lane that drizzle/0012 seeds
    // — an empty one here — so the terminal line names it.
    const refresh = runCli("refresh.ts", []);
    expect(refresh.status).toBe(0);
    expect(`${refresh.stdout}`).toMatch(/refresh done list=Watchlist status=ok players=0/);
    expect(`${refresh.stderr}`).toContain("offline subprocess fixture forbids fetch");
    opened = openReadonlyDb(dbPath);
    try {
      expect(opened.sqlite.prepare("select status, players_total from refresh_runs order by id desc limit 1").get()).toEqual({ status: "ok", players_total: 0 });
    } finally { opened.close(); }

    // Console mail is explicit in cliEnv, so this executes the scheduled
    // digest presenter without a real recipient or delivery provider.
    const digest = runCli("digest.ts", []);
    expect(digest.status).toBe(0);
    expect(`${digest.stdout}`).toMatch(/digest kind=(digest|heartbeat) action=sent/);
    opened = openReadonlyDb(dbPath);
    try {
      expect(opened.sqlite.prepare("select status, kind from digest_deliveries order by id desc limit 1").get()).toMatchObject({ status: "sent" });
    } finally { opened.close(); }
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

  it("performs a disposable restore drill and refuses a corrupt candidate without changing its target", () => {
    const sourcePath = join(work.path, "source.db");
    const sourceBackups = join(work.path, "source-backups");
    const targetPath = join(work.path, "target.db");
    const targetBackups = join(work.path, "target-backups");
    const sourceSeed = join(work.path, "source-sentinel.json");
    const targetSeed = join(work.path, "target-sentinel.json");
    writeFileSync(sourceSeed, JSON.stringify(makeBackupEnvelope([makeBackupEntry({ externalId: 424242, fullName: "Snapshot Sentinel" })])));
    writeFileSync(targetSeed, JSON.stringify(makeBackupEnvelope([makeBackupEntry({ externalId: 525252, fullName: "Pre-restore Sentinel" })])));
    const runAt = (path: string, backups: string, script: string, args: string[] = []) =>
      spawnSync(tsxBin, [join(repoRoot, "src", "cli", script), ...args], {
        encoding: "utf8",
        cwd: work.path,
        env: { ...cliEnv(), DATABASE_PATH: path, BACKUP_DIR: backups },
      });

    expect(runAt(sourcePath, sourceBackups, "players-restore.ts", ["--in", sourceSeed]).status).toBe(0);
    expect(runAt(sourcePath, sourceBackups, "backup.ts").status).toBe(0);
    const snapshot = readdirSync(sourceBackups).find((name) => /^bryce-.*\.db$/.test(name));
    expect(snapshot).toBeDefined();

    // A non-empty target proves restore does a safety Snapshot before its swap.
    expect(runAt(targetPath, targetBackups, "players-restore.ts", ["--in", targetSeed]).status).toBe(0);
    const restored = runAt(targetPath, targetBackups, "restore.ts", ["--from", join(sourceBackups, snapshot!)]);
    expect(restored.status).toBe(0);
    expect(`${restored.stdout}`).toMatch(/^restored from=bryce-.* safetySnapshot=bryce-/);
    const opened = openReadonlyDb(targetPath);
    try {
      expect(opened.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(opened.sqlite.prepare("select full_name from players where full_name = ?").get("Snapshot Sentinel")).toBeDefined();
      expect(opened.sqlite.prepare("select full_name from players where full_name = ?").get("Pre-restore Sentinel")).toBeUndefined();
    } finally { opened.close(); }
    const safetySnapshot = `${restored.stdout}`.match(/safetySnapshot=(bryce-[^\s]+\.db)/)?.[1];
    expect(safetySnapshot).toBeDefined();
    const safety = openReadonlyDb(join(targetBackups, safetySnapshot!));
    try { expect(safety.sqlite.prepare("select full_name from players where full_name = ?").get("Pre-restore Sentinel")).toBeDefined(); } finally { safety.close(); }

    const corrupt = join(work.path, "corrupt.db");
    writeFileSync(corrupt, "not a sqlite snapshot");
    const rejected = runAt(targetPath, targetBackups, "restore.ts", ["--from", corrupt]);
    expect(rejected.status).not.toBe(0);
    const unchanged = openReadonlyDb(targetPath);
    try {
      expect(unchanged.sqlite.prepare("select full_name from players where full_name = ?").get("Snapshot Sentinel")).toBeDefined();
      expect(unchanged.sqlite.prepare("select full_name from players where full_name = ?").get("Pre-restore Sentinel")).toBeUndefined();
    } finally { unchanged.close(); }
  }, 30_000);

  it("db:restore fails loud (no stack trace) on a missing --from", () => {
    const result = runCli("restore.ts", []);
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain("missing required option '--from'");
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
