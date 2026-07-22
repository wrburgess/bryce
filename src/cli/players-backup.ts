import { basename, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { MIGRATIONS_FOLDER } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import {
  MAX_BACKUP_BYTES,
  createPlayerListBackup,
  writePlayerListBackupFile,
} from "../backup/player-list.js";
import { isMain } from "./main.js";

/**
 * `players:backup --out FILE` — write a portable Player List Backup (every Player
 * row, active and inactive) as a versioned JSON envelope. Network-free. Refuses
 * to overwrite the live database or a Snapshot (that would destroy state rather
 * than back it up). Malformed flags fail loud; the exit code is set (#64/#76).
 */

const SNAPSHOT_NAME_RE = /^bryce-\d{8}T\d{6}Z-\d{3}\.db$/;

export interface PlayersBackupRunDeps {
  db: Db;
  /** The live DB path, so we can refuse to overwrite it. */
  databasePath: string;
  now: () => Date;
  write: (line: string) => void;
  /** Injected for tests; defaults to the crash-safe file writer. */
  writeFile?: (path: string, json: string) => void;
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

export async function runPlayersBackup(argv: string[], deps: PlayersBackupRunDeps): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error !== null) {
    deps.write(`error: ${error}; usage: players:backup --out FILE`);
    return 1;
  }
  for (const key of flags.keys()) {
    if (key !== "out") {
      deps.write(`error: unknown flag --${key}; usage: players:backup --out FILE`);
      return 1;
    }
  }
  const out = flags.get("out");
  if (out === undefined || out.trim().length === 0) {
    deps.write("error: players:backup requires --out FILE");
    return 1;
  }
  const outPath = out.trim();

  if (resolve(outPath) === resolve(deps.databasePath)) {
    deps.write("error: refusing to overwrite the live database with a player-list backup");
    return 1;
  }
  if (SNAPSHOT_NAME_RE.test(basename(outPath))) {
    deps.write("error: refusing to write a player-list backup over a Snapshot filename");
    return 1;
  }

  const backup = await createPlayerListBackup(deps.db, deps.now);
  const json = JSON.stringify(backup, null, 2);
  // Enforce the SAME ceiling the parser applies, so the producer never writes a
  // file that players:restore would always reject. Fail loud, write nothing.
  if (json.length > MAX_BACKUP_BYTES) {
    deps.write(
      `error: generated backup is ${json.length} bytes, over the ${MAX_BACKUP_BYTES}-byte ceiling; nothing written`,
    );
    return 1;
  }
  const writeFile = deps.writeFile ?? writePlayerListBackupFile;
  writeFile(outPath, json);
  deps.write(`player-list backup written out=${outPath} players=${backup.players.length}`);
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
    return await runPlayersBackup(process.argv.slice(2), {
      db: started.db,
      databasePath: config.databasePath,
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
