import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { MIGRATIONS_FOLDER } from "../db/client.js";
import { DatabaseBusyError } from "../db/lock.js";
import { isKnownRestoreError, restoreSnapshot } from "../backup/restore.js";
import { isMain } from "./main.js";

/**
 * `db:restore --from FILE` — swap a validated Snapshot into place.
 *
 * This CLI NEVER opens or migrates the live database (that would re-apply a bad
 * migration and self-deadlock on the interlock): it loads config and invokes the
 * FILE-LEVEL restore service, which does the interlock, validation, safety
 * Snapshot, and WAL-safe swap. Malformed flags fail loud; the exit code is set,
 * never `process.exit()` after an async write (#64/#76).
 */

export interface RestoreRunDeps {
  liveDbPath: string;
  backupDir: string;
  keepLast: number;
  now: () => Date;
  migrationsFolder?: string;
  write: (line: string) => void;
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

export async function runRestore(argv: string[], deps: RestoreRunDeps): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error !== null) {
    deps.write(`error: ${error}; usage: db:restore --from FILE`);
    return 1;
  }
  for (const key of flags.keys()) {
    if (key !== "from") {
      deps.write(`error: unknown flag --${key}; usage: db:restore --from FILE`);
      return 1;
    }
  }
  const from = flags.get("from");
  if (from === undefined || from.trim().length === 0) {
    deps.write("error: db:restore requires --from FILE");
    return 1;
  }

  try {
    const result = await restoreSnapshot({
      liveDbPath: deps.liveDbPath,
      candidatePath: from.trim(),
      backupDir: deps.backupDir,
      keepLast: deps.keepLast,
      now: deps.now,
      migrationsFolder: deps.migrationsFolder ?? MIGRATIONS_FOLDER,
    });
    deps.write(
      `restored from=${result.restoredFrom} safetySnapshot=${result.safetySnapshot ?? "-"} ` +
        `installed=${result.installedPath}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof DatabaseBusyError || isKnownRestoreError(err)) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  // Deliberately never opens config.databasePath here — the restore service owns
  // the file-level swap; opening/migrating it would defeat the whole design.
  return runRestore(process.argv.slice(2), {
    liveDbPath: config.databasePath,
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
    now: () => new Date(),
    write: (line) => process.stdout.write(`${line}\n`),
  });
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
