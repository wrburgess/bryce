import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { startupDb } from "../db/startup.js";
import { isMain } from "./main.js";

export async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  // startupDb takes a pre-migration Snapshot when one is pending (ADR 0042).
  const started = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  started.close();
  process.stdout.write(`migrations applied path=${config.databasePath}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
