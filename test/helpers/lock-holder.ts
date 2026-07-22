import { acquireOpenLock } from "../../src/db/lock.js";

/**
 * A real second process that opens (registers against) a database as an ordinary
 * app opener and stays alive until signalled — the harness for the interlock
 * tests (rules/testing.md: build the harness, do not declare it untestable). Not
 * a `*.test.ts`, so vitest never collects it.
 *
 * It uses the REAL opener path (`acquireOpenLock`), so if a live restore marker is
 * present it is REJECTED and exits non-zero (printing `REJECTED ...`) — that is
 * how the "opener starting mid-restore is refused" test observes the two-flag
 * exclusion. Otherwise it prints `HELD pid=<pid>` and waits.
 *
 * Usage: tsx test/helpers/lock-holder.ts <dbPath>
 */
const dbPath = process.argv[2];
if (dbPath === undefined || dbPath.length === 0) {
  process.stderr.write("usage: lock-holder <dbPath>\n");
  process.exit(2);
}

let lock;
try {
  lock = acquireOpenLock(dbPath);
} catch (err) {
  process.stderr.write(`REJECTED ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
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
