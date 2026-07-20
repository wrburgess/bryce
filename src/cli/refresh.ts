import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { openDb } from "../db/client.js";
import { runRefresh } from "../jobs/refresh.js";
import { MlbClient } from "../mlb/client.js";
import { NcaaClient } from "../ncaa/client.js";
import { isMain } from "./main.js";

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = openDb(config.databasePath);
  try {
    const client = new MlbClient({ delayMs: config.mlbApiDelayMs });
    const ncaaClient = new NcaaClient({ delayMs: config.ncaaScrapeDelayMs });
    const summary = await runRefresh({ db, client, ncaaClient, now: () => new Date(), tz: config.tz });
    if (summary.skipped) {
      process.stdout.write(`refresh skipped reason=${summary.reason}\n`);
    } else {
      process.stdout.write(
        `refresh done players=${summary.playersRefreshed} inserted=${summary.statLinesInserted} updated=${summary.statLinesUpdated}\n`,
      );
    }
    return 0;
  } finally {
    close();
  }
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
