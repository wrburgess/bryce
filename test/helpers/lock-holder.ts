import { acquireDbLock } from "../../src/db/lock.js";

/**
 * A real second process that registers itself against a database and stays alive
 * until signalled — the harness for the interlock's "restore refuses while the
 * app is running" test (rules/testing.md: build the harness, do not declare it
 * untestable). Not a `*.test.ts`, so vitest never collects it.
 *
 * Usage: tsx test/helpers/lock-holder.ts <dbPath>
 * Prints `HELD pid=<pid>` once registered, then waits.
 */
const dbPath = process.argv[2];
if (dbPath === undefined || dbPath.length === 0) {
  process.stderr.write("usage: lock-holder <dbPath>\n");
  process.exit(2);
}

const lock = acquireDbLock(dbPath);
process.stdout.write(`HELD pid=${process.pid}\n`);

const timer = setInterval(() => {
  // Keep the event loop alive while holding the registration.
}, 60_000);

const shutdown = (): void => {
  lock?.release();
  clearInterval(timer);
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
