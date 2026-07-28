import { ZodError } from "zod";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import type { ReportWindowSpec } from "../domain/window.js";
import {
  GAME_COUNT_WINDOW_SPECS,
  WINDOW_SPECS,
  parseReportWindowSpec,
} from "../domain/window.js";
import type { Mailer } from "../mailer/types.js";
import { runDigest } from "../jobs/digest.js";
import { NoDefaultListError, UnknownListError, resolveListByName } from "../lists/service.js";
import { createMailer } from "../mailer/index.js";
import type { TagScope } from "../tags/service.js";
import { resolveTagScope } from "../tags/service.js";
import { exitAfterDrain, isMain } from "./main.js";
import { normalizeDirect, preflightDirect } from "./router.js";

/**
 * The digest CLI: `npm run digest [-- --window 7d] [-- --force]`. A thin
 * presenter over `runDigest`, injectable like the other CLIs (src/cli/seed.ts)
 * so the WIRING is testable and not merely the parse —
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
 * Every parser below reads a NORMALIZED argv (#191): `runRouter` and this
 * module's own entry points call `normalizeOptions` right after preflight, so
 * an alias (`-w`, `-l`, `-f`) and an inline `--window=7d` have already been
 * rewritten to the canonical `--window 7d` spelling by the time a parser runs.
 *
 * That is why the hand-rolled `-w` / `--window=` / `--list=` branches that used
 * to live here are GONE rather than kept alongside. They were a second
 * implementation of the router's own option grammar, and it had already drifted:
 * `parseWindow` handled `-w` while `parseList` handled no alias at all, so
 * adding an `l` alias would have let `sk digest -l Prospects` pass preflight,
 * parse to `undefined`, and mail the WHOLE Watch List under a line that reads
 * like a scoped send. One grammar, declared in the router's table, is the fix.
 */

/**
 * `--force`: re-send today's digest even though it already went out (testing).
 * One valueless boolean, so a bare `includes` rather than seed.ts's flag-map
 * parser. Exported and pure so the lookalike cases are covered directly.
 * What force does and does not override lives in src/jobs/delivery-claim.ts.
 *
 * The `-f` check is deliberately RETAINED where the value parsers' alias
 * branches were deleted: `includes` is order-free and a boolean has no value to
 * mis-attach, so recognizing both spellings cannot mis-scope anything — it only
 * keeps a direct, un-normalized caller honest. The deleted branches were the
 * opposite: they decided WHICH VALUE was read.
 */
export function parseForce(argv: string[]): boolean {
  return argv.includes("--force") || argv.includes("-f");
}

/**
 * `--window <spec>`, default `1d`. Returns null for an unsupported value so the
 * caller can fail closed — a typo'd window must not silently send a different
 * report than the operator asked for, and under window selection the window IS
 * the content.
 */
export function parseWindow(argv: string[]): ReportWindowSpec | null {
  const at = argv.indexOf("--window");
  if (at === -1) return "1d";
  const value = argv[at + 1];
  return value === undefined ? null : parseReportWindowSpec(value);
}

/**
 * `--list <name>`, scoping an on-demand send to a named list's active members
 * (issue #70). Returns undefined when absent (unscoped, all active players) and
 * null when the flag is present but its value is missing — so the caller can
 * fail closed on a malformed flag, just like `--window`.
 */
export function parseList(argv: string[]): string | null | undefined {
  const at = argv.indexOf("--list");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  // A following flag (or nothing) means the value is missing — fail closed.
  return value === undefined || value.startsWith("--") || value.trim().length === 0
    ? null
    : value.trim();
}

/**
 * `--tags <selector>`, scoping the report to the players matching every token
 * (#140). Same three-state contract as `parseList`: undefined when absent (no
 * tag scope), null when the flag is present but its value is missing — so a
 * malformed flag fails closed rather than silently widening the report to every
 * active player. Its `--tags=` branch was deleted alongside `--list=`'s (#191),
 * for the same reason: the router's grammar already rewrote it. The selector's
 * GRAMMAR is not checked here; `resolveTagScope` owns it, so the CLI cannot
 * drift from REST/MCP.
 */
export function parseTags(argv: string[]): string | null | undefined {
  const at = argv.indexOf("--tags");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") || value.trim().length === 0
    ? null
    : value.trim();
}

export async function runDigestCli(rawArgv: string[], deps: DigestCliDeps): Promise<number> {
  const writeError = deps.writeError ?? deps.write;
  const syntaxFailure = preflightDirect(["digest"], rawArgv);
  if (syntaxFailure !== null) {
    // Reported against what the operator TYPED, which is why validation runs
    // before normalization rather than after.
    writeError(`error: ${syntaxFailure}`);
    return 1;
  }
  // Validated; now collapse aliases and `=` forms to one spelling, so every
  // parser below reads `--name value` and an alias can never be dropped (#191).
  const argv = normalizeDirect(["digest"], rawArgv);
  const spec = parseWindow(argv);
  if (spec === null) {
    // Fail closed, BEFORE the mailer is touched: nothing is sent.
    writeError(
      `error: unsupported --window value; supported: ${[...WINDOW_SPECS, ...GAME_COUNT_WINDOW_SPECS].join(", ")}`,
    );
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
  let resolvedListName: string | undefined;
  if (listName !== undefined) {
    try {
      const list = await resolveListByName(deps.db, listName);
      listId = list.id;
      resolvedListName = list.name;
    } catch (err) {
      if (err instanceof UnknownListError) {
        writeError(`error: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }
  const tagsExpr = parseTags(argv);
  if (tagsExpr === null) {
    writeError("error: --tags requires a non-blank selector");
    return 1;
  }
  // Parse the selector BEFORE the mailer is touched: a malformed selector must
  // fail closed with nothing sent, exactly like an unsupported --window. The
  // grammar's ZodError carries the operator-facing message.
  let tagScope: TagScope | undefined;
  if (tagsExpr !== undefined) {
    try {
      tagScope = resolveTagScope(tagsExpr);
    } catch (err) {
      if (err instanceof ZodError) {
        writeError(`error: ${err.issues.map((i) => i.message).join("; ")}`);
        return 1;
      }
      throw err;
    }
  }
  let result;
  try {
    result = await runDigest({
      db: deps.db,
      mailer: deps.mailer,
      now: deps.now,
      tz: deps.tz,
      to: deps.to,
      from: deps.from,
      spec,
      force: parseForce(argv),
      listId,
      listName: resolvedListName,
      tagScope,
    });
  } catch (err) {
    // The scheduled path resolves the DEFAULT lane (#190), and a database with
    // none refuses rather than mailing an unknown cohort. Caught here so the
    // operator gets the same greppable `error:` line and exit 1 as every other
    // refusal, instead of an unhandled rejection — and the message names the
    // command that fixes it.
    if (err instanceof NoDefaultListError) {
      writeError(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
  deps.write(
    `digest kind=${result.kind} action=${result.action} statLines=${result.statLineCount} players=${result.playerCount}${
      result.window !== null ? ` window=${result.window}` : ""
    }${result.reason !== null ? ` reason=${result.reason}` : ""}`,
  );
  return result.action === "failed" ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failure = preflightDirect(["digest"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  // Normalized here too, not only in `runDigestCli`: the direct `npm run digest
  // -- -l X` path bypasses `runRouter` entirely, and normalizing in only one
  // place is how one entry point keeps a broken alias (#191).
  const normalized = normalizeDirect(["digest"], argv);
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runDigestCli(normalized, {
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
    .then(exitAfterDrain)
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
