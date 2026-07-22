import { acquireRestoreLock } from "../../src/db/lock.js";

/**
 * A real second process that holds the EXCLUSIVE restore marker for a database
 * and stays alive until signalled — the harness for "an opener starting during a
 * held restore is rejected" (rules/testing.md). Not a `*.test.ts`, so vitest
 * never collects it.
 *
 * Usage: tsx test/helpers/restore-holder.ts <dbPath>
 * Prints `HELD pid=<pid>` once the marker is published, then waits.
 */
const dbPath = process.argv[2];
if (dbPath === undefined || dbPath.length === 0) {
  process.stderr.write("usage: restore-holder <dbPath>\n");
  process.exit(2);
}

let lock;
try {
  lock = acquireRestoreLock(dbPath);
} catch (err) {
  process.stderr.write(`REJECTED ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
process.stdout.write(`HELD pid=${process.pid}\n`);

const timer = setInterval(() => {
  // Keep the event loop alive while holding the restore marker.
}, 60_000);

const shutdown = (): void => {
  lock?.release();
  clearInterval(timer);
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
