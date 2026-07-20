import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { openDb } from "../db/client.js";
import type { Mailer } from "../mailer/types.js";
import { runDigest } from "../jobs/digest.js";
import { createMailer } from "../mailer/index.js";
import { isMain } from "./main.js";

/**
 * The digest CLI: `npm run digest [-- --force]`. A thin presenter over
 * `runDigest`, injectable like the other CLIs (src/cli/seed.ts,
 * src/cli/ncaa-probe.ts) so the WIRING is testable and not merely the parse —
 * a `force` that parsed correctly and was then dropped on the way to `runDigest`
 * would be a silently dead flag with the suite still green
 * (rules/testing.md: build the infrastructure the scenario needs).
 */

export interface DigestCliDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  tz: string;
  to: string;
  from: string;
  write: (line: string) => void;
}

/**
 * `--force`: re-send today's digest even though it already went out (testing).
 * One valueless boolean, so a bare `includes` rather than seed.ts's flag-map
 * parser. Exported and pure so the lookalike cases are covered directly.
 * What force does and does not override lives in src/jobs/delivery-claim.ts.
 */
export function parseForce(argv: string[]): boolean {
  return argv.includes("--force");
}

export async function runDigestCli(argv: string[], deps: DigestCliDeps): Promise<number> {
  const result = await runDigest({
    db: deps.db,
    mailer: deps.mailer,
    now: deps.now,
    tz: deps.tz,
    to: deps.to,
    from: deps.from,
    force: parseForce(argv),
  });
  deps.write(
    `digest kind=${result.kind} action=${result.action} statLines=${result.statLineCount} players=${result.playerCount}${
      result.reason !== null ? ` reason=${result.reason}` : ""
    }`,
  );
  return result.action === "failed" ? 1 : 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = openDb(config.databasePath);
  try {
    return await runDigestCli(process.argv.slice(2), {
      db,
      mailer: createMailer(config),
      now: () => new Date(),
      tz: config.tz,
      // The console provider needs no real addresses; every other provider has
      // fail-closed validated these in loadConfig.
      to: config.digestTo ?? "console@localhost",
      from: config.digestFrom ?? "bryce@localhost",
      write: (line) => process.stdout.write(`${line}\n`),
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
