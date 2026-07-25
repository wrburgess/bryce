import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { startupDb } from "../db/startup.js";
import { exitAfterDrain, isMain } from "./main.js";
import { preflightDirect } from "./router.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failure = preflightDirect(["db", "migrate"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  loadDotEnv();
  const config = loadConfig();
  // startupDb takes a pre-migration Snapshot when one is pending (ADR 0042).
  const started = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  started.close();
  process.stdout.write(`migrations applied path=${config.databasePath}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(exitAfterDrain).catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitAfterDrain(1);
  });
}
