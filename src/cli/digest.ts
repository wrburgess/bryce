import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import type { WindowSpec } from "../domain/window.js";
import { WINDOW_SPECS, parseWindowSpec } from "../domain/window.js";
import type { Mailer } from "../mailer/types.js";
import { runDigest } from "../jobs/digest.js";
import { UnknownListError, resolveListByName } from "../lists/service.js";
import { createMailer } from "../mailer/index.js";
import { isMain } from "./main.js";

/**
 * The digest CLI: `npm run digest [-- --window 7d] [-- --force]`. A thin
 * presenter over `runDigest`, injectable like the other CLIs (src/cli/seed.ts,
 * src/cli/ncaa-probe.ts) so the WIRING is testable and not merely the parse —
 * a flag that parsed correctly and was then dropped on the way to `runDigest`
 * would be silently dead with the suite still green
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
  writeError?: (line: string) => void;
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

/**
 * `--window <spec>` / `--window=<spec>`, default `1d`. Returns null for an
 * unsupported value so the caller can fail closed — a typo'd window must not
 * silently send a different report than the operator asked for, and under
 * window selection the window IS the content.
 */
export function parseWindow(argv: string[]): WindowSpec | null {
  const inline = argv.find((a) => a.startsWith("--window="));
  if (inline !== undefined) return parseWindowSpec(inline.slice("--window=".length));
  const at = argv.indexOf("--window");
  if (at === -1) return "1d";
  const value = argv[at + 1];
  return value === undefined ? null : parseWindowSpec(value);
}

/**
 * `--list <name>` / `--list=<name>`, scoping an on-demand send to a named list's
 * active members (issue #70). Returns undefined when absent (unscoped, all
 * active players) and null when the flag is present but its value is missing —
 * so the caller can fail closed on a malformed flag, just like `--window`.
 */
export function parseList(argv: string[]): string | null | undefined {
  const inline = argv.find((a) => a.startsWith("--list="));
  if (inline !== undefined) {
    const value = inline.slice("--list=".length).trim();
    return value.length === 0 ? null : value;
  }
  const at = argv.indexOf("--list");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  // A following flag (or nothing) means the value is missing — fail closed.
  return value === undefined || value.startsWith("--") || value.trim().length === 0
    ? null
    : value.trim();
}

export async function runDigestCli(argv: string[], deps: DigestCliDeps): Promise<number> {
  const spec = parseWindow(argv);
  const writeError = deps.writeError ?? deps.write;
  if (spec === null) {
    // Fail closed, BEFORE the mailer is touched: nothing is sent.
    writeError(`error: unsupported --window value; supported: ${WINDOW_SPECS.join(", ")}`);
    return 1;
  }
  const listName = parseList(argv);
  if (listName === null) {
    writeError("error: --list requires a non-blank list name");
    return 1;
  }
  // Resolve a named list to its id and fail closed on an unknown list — a typo'd
  // list must not silently widen the scope to every active player.
  let listId: number | undefined;
  if (listName !== undefined) {
    try {
      listId = (await resolveListByName(deps.db, listName)).id;
    } catch (err) {
      if (err instanceof UnknownListError) {
        writeError(`error: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }
  const result = await runDigest({
    db: deps.db,
    mailer: deps.mailer,
    now: deps.now,
    tz: deps.tz,
    to: deps.to,
    from: deps.from,
    spec,
    force: parseForce(argv),
    listId,
  });
  deps.write(
    `digest kind=${result.kind} action=${result.action} statLines=${result.statLineCount} players=${result.playerCount}${
      result.window !== null ? ` window=${result.window}` : ""
    }${result.reason !== null ? ` reason=${result.reason}` : ""}`,
  );
  return result.action === "failed" ? 1 : 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
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
