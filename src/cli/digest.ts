import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { openDb } from "../db/client.js";
import { runDigest } from "../jobs/digest.js";
import { createMailer } from "../mailer/index.js";
import { isMain } from "./main.js";

/**
 * `--force`: re-send today's digest even though it already went out (testing).
 * One valueless boolean, so a bare `includes` rather than seed.ts's flag-map
 * parser. Exported and pure so it is testable without a database or a mailer.
 * What force does and does not override lives in src/jobs/delivery-claim.ts.
 */
export function parseForce(argv: string[]): boolean {
  return argv.includes("--force");
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = openDb(config.databasePath);
  try {
    const mailer = createMailer(config);
    // The console provider needs no real addresses; every other provider has
    // fail-closed validated these in loadConfig.
    const to = config.digestTo ?? "console@localhost";
    const from = config.digestFrom ?? "bryce@localhost";
    const force = parseForce(process.argv.slice(2));
    const result = await runDigest({
      db,
      mailer,
      now: () => new Date(),
      tz: config.tz,
      to,
      from,
      force,
    });
    process.stdout.write(
      `digest kind=${result.kind} action=${result.action} statLines=${result.statLineCount} players=${result.playerCount}${
        result.reason !== null ? ` reason=${result.reason}` : ""
      }\n`,
    );
    return result.action === "failed" ? 1 : 0;
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
