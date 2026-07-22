import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { MIGRATIONS_FOLDER } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { PlayerBackupParseError, parsePlayerListBackup } from "../backup/player-list.js";
import {
  AmbiguousImportTargetError,
  SplitIdentityConflictError,
  restorePlayerListBackup,
} from "../watchlist/service.js";
import { isMain } from "./main.js";

/**
 * `players:restore --in FILE` — re-import a Player List Backup, network-free and
 * all-or-nothing. Upserts on each Player's natural identity so existing rows keep
 * their id (Stat Line FKs stay intact). Malformed flags and invalid payloads fail
 * loud with a non-zero exit; the exit code is set (never `process.exit()` after
 * an async write, #64/#76).
 */

export interface PlayersRestoreRunDeps {
  db: Db;
  now: () => Date;
  write: (line: string) => void;
  /** Injected for tests; defaults to reading the file at the given path. */
  readFile?: (path: string) => string;
}

function parseFlags(args: string[]): { flags: Map<string, string>; error: string | null } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      return { flags, error: `unexpected argument ${arg}` };
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { flags, error: `flag --${key} requires a value` };
    }
    flags.set(key, value);
    i += 1;
  }
  return { flags, error: null };
}

export async function runPlayersRestore(
  argv: string[],
  deps: PlayersRestoreRunDeps,
): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error !== null) {
    deps.write(`error: ${error}; usage: players:restore --in FILE`);
    return 1;
  }
  for (const key of flags.keys()) {
    if (key !== "in") {
      deps.write(`error: unknown flag --${key}; usage: players:restore --in FILE`);
      return 1;
    }
  }
  const inPath = flags.get("in");
  if (inPath === undefined || inPath.trim().length === 0) {
    deps.write("error: players:restore requires --in FILE");
    return 1;
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = readFile(inPath.trim());
  } catch (err) {
    deps.write(`error: cannot read ${inPath.trim()}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let backup;
  try {
    backup = parsePlayerListBackup(raw);
  } catch (err) {
    if (err instanceof PlayerBackupParseError) {
      deps.write(`error: invalid player-list backup: ${err.message}`);
      return 1;
    }
    throw err;
  }

  try {
    const summary = restorePlayerListBackup(deps.db, backup.players, deps.now());
    deps.write(
      `player-list restored inserted=${summary.inserted} updated=${summary.updated} total=${summary.total}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SplitIdentityConflictError || err instanceof AmbiguousImportTargetError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
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
    return await runPlayersRestore(process.argv.slice(2), {
      db: started.db,
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
