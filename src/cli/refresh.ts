import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { runRefresh } from "../jobs/refresh.js";
import { MlbClient } from "../mlb/client.js";
import { NcaaClient } from "../ncaa/client.js";
import { isMain } from "./main.js";

/**
 * The refresh CLI: `npm run refresh`. A thin presenter over `runRefresh`,
 * injectable like the digest CLI (src/cli/digest.ts) so the WIRING — exit code
 * and failure print — is testable and not merely asserted through the job.
 *
 * Exit semantics (#23, MF6): a `failed` status is a BLOCKED run (it refreshed
 * nobody) and exits 1; `ok`, `partial` (safe partial success), and any skipped
 * sweep exit 0 — a partial sweep is not a job failure. Whenever any calendar or
 * per-player failure was collected, a one-line summary is printed to stderr,
 * even on an otherwise-`ok`/`partial` run, so a degraded sweep is never silent.
 */
export interface RefreshCliDeps {
  db: Db;
  client: MlbClient;
  ncaaClient: NcaaClient;
  now: () => Date;
  tz: string;
  write: (line: string) => void;
  writeError?: (line: string) => void;
}

export async function runRefreshCli(deps: RefreshCliDeps): Promise<number> {
  const writeError = deps.writeError ?? deps.write;
  const summary = await runRefresh({
    db: deps.db,
    client: deps.client,
    ncaaClient: deps.ncaaClient,
    now: deps.now,
    tz: deps.tz,
  });

  if (summary.skipped) {
    deps.write(`refresh skipped reason=${summary.reason}`);
    return 0;
  }

  deps.write(
    `refresh done status=${summary.status} players=${summary.playersRefreshed} ` +
      `skipped=${summary.playersSkipped} failed=${summary.playersFailed} ` +
      `inserted=${summary.statLinesInserted} updated=${summary.statLinesUpdated}`,
  );

  // A one-line failure summary whenever anything was collected — independent of
  // the terminal status, so a calendar failure on an `ok` run is still surfaced.
  if (summary.playerFailures.length > 0 || summary.calendarFailures.length > 0) {
    const playerPart =
      summary.playerFailures.length > 0
        ? `; players: ${summary.playerFailures.map((f) => `${f.playerId} (${f.reason})`).join("; ")}`
        : "";
    const calendarPart =
      summary.calendarFailures.length > 0
        ? `; calendars: ${summary.calendarFailures.map((f) => `${f.sportId} (${f.reason})`).join("; ")}`
        : "";
    writeError(
      `refresh failures: ${summary.playerFailures.length} player(s), ` +
        `${summary.calendarFailures.length} calendar fetch(es)${playerPart}${calendarPart}`,
    );
  }

  return summary.status === "failed" ? 1 : 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runRefreshCli({
      db,
      client: new MlbClient({ delayMs: config.mlbApiDelayMs }),
      ncaaClient: new NcaaClient({ delayMs: config.ncaaScrapeDelayMs }),
      now: () => new Date(),
      tz: config.tz,
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
    });
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
