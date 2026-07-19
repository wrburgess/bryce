import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { runDigest } from "../jobs/digest.js";
import { createMailer } from "../mailer/index.js";
import { isMain } from "./main.js";

export async function main(): Promise<number> {
  const config = loadConfig();
  const { db, close } = openDb(config.databasePath);
  try {
    const mailer = createMailer(config);
    // The console provider needs no real addresses; every other provider has
    // fail-closed validated these in loadConfig.
    const to = config.digestTo ?? "console@localhost";
    const from = config.digestFrom ?? "bryce@localhost";
    const result = await runDigest({ db, mailer, now: () => new Date(), tz: config.tz, to, from });
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
