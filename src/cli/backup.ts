import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { MIGRATIONS_FOLDER } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { createSnapshot, pruneSnapshots } from "../backup/snapshot.js";
import { isMain } from "./main.js";

/**
 * `db:backup` — take a Snapshot of the live database and prune to keep-last-N.
 *
 * A thin presenter over the Snapshot service. Output is deterministic, greppable,
 * ASCII-only `key=value` lines (rules/scripting.md). A malformed invocation fails
 * loud with a usage error and non-zero exit; the exit code is set (never
 * `process.exit()` after an async write) so buffered output flushes (#64/#76).
 */

export interface BackupRunDeps {
  sqlite: Database.Database;
  backupDir: string;
  keepLast: number;
  now: () => Date;
  write: (line: string) => void;
}

export async function runBackup(argv: string[], deps: BackupRunDeps): Promise<number> {
  if (argv.length > 0) {
    deps.write(`error: db:backup takes no arguments; got ${argv.join(" ")}`);
    return 1;
  }
  const info = await createSnapshot(deps.sqlite, deps.backupDir, deps.now);
  deps.write(`snapshot created name=${info.name} dir=${deps.backupDir}`);
  const prune = pruneSnapshots(deps.backupDir, deps.keepLast);
  deps.write(
    `retention keepLast=${deps.keepLast} kept=${prune.kept.length} deleted=${prune.deleted.length}`,
  );
  return 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const started = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
    migrationsFolder: MIGRATIONS_FOLDER,
  });
  try {
    return await runBackup(process.argv.slice(2), {
      sqlite: started.sqlite,
      backupDir: config.backupDir,
      keepLast: config.backupKeepLast,
      now: () => new Date(),
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    started.close();
  }
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
