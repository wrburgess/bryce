import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { isMain } from "./main.js";

export function main(): void {
  const config = loadConfig();
  const { close } = openDb(config.databasePath);
  close();
  process.stdout.write(`migrations applied path=${config.databasePath}\n`);
}

if (isMain(import.meta.url)) {
  main();
}
