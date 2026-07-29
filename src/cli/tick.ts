import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { asciiField } from "../domain/names.js";
import { HighlightlyClient } from "../highlightly/client.js";
import type { TickDigest, TickRefresh, TickResult } from "../jobs/tick.js";
import { runTick } from "../jobs/tick.js";
import { createMailer } from "../mailer/index.js";
import type { Mailer } from "../mailer/types.js";
import { MlbClient } from "../mlb/client.js";
import { exitAfterDrain, isMain } from "./main.js";
import type { RefreshCliDeps } from "./refresh.js";
import { createRefreshPresenter, parseQuiet } from "./refresh.js";
import { normalizeDirect, preflightDirect } from "./router.js";

/**
 * The tick CLI: `npm run tick [-- --quiet]` — the ONE scheduled entry point
 * (#193, ADR 0062 decision 3), replacing the fixed `refresh` and `digest`
 * agents. `ops/templates/com.sk.tick.plist` runs it every 15 minutes.
 *
 * It is the only presenter of a tick, exactly as `src/cli/refresh.ts` is the
 * only presenter of a sweep (ADR 0056): `runTick` returns a typed result and
 * decides nothing about text. That is what makes `--quiet`'s contract hold by
 * construction rather than by two files agreeing.
 *
 * `--quiet` IS WHAT THE SCHEDULED RUN USES, and its contract is EXACTLY ONE
 * TERMINAL LINE (Reviewer should-consider 2). Three streams would otherwise leak
 * around it — the refresh Liveness stream, the refresh job's legacy notice
 * lines, and the digest's unclassified-field warnings — and each is silenced
 * here at its own seam rather than hoped away: no progress sink is attached, the
 * notice sink is swallowed, and digest warnings are collected and dropped. A
 * quiet tick that ran 96 times a day and wrote a stray warning each time would
 * grow an unrotated log by exactly the amount quiet mode exists to prevent.
 *
 * Exit semantics mirror `sk refresh`: 0 when every attempted action ended
 * sent/skipped/ok/partial, 1 when anything failed — AFTER all due work was
 * attempted, never as an early abort (Reviewer must-fix 2).
 */

export interface TickCliDeps {
  db: Db;
  client: MlbClient;
  highlightlyClient?: HighlightlyClient;
  mailer: Mailer;
  now: () => Date;
  tz: string;
  to: string;
  from: string;
  write: (line: string) => void;
  writeError?: (line: string) => void;
  /** TTY-ness and the raw/ticker seams, forwarded to the refresh presenter. */
  isTty?: boolean;
  writeRaw?: (text: string) => void;
  ticker?: RefreshCliDeps["ticker"];
}

/**
 * Fold runtime-derived free text to one ASCII token — no spaces, so `key=value`
 * stays parseable and an upstream string cannot FORGE a token (ADR 0047 as
 * amended for #146). Authored here rather than imported because
 * `src/cli/refresh.ts` keeps its copy module-private; the two are the same three
 * lines and the shared alternative is a presentation module neither file needs.
 */
function tokenField(raw: string): string {
  const folded = asciiField(raw).replace(/ /g, "_");
  return folded.length === 0 ? "?" : folded;
}

/** What separates two lane names inside one `lanes=` value — the refresh CLI's convention. */
const LANE_JOIN = ",";

/** One lane name, folded so a lane genuinely named `A,B` cannot read as two lanes. */
function laneToken(raw: string): string {
  return tokenField(raw).replaceAll(LANE_JOIN, "_");
}

/** The refresh stage's line: what was swept, and how it ended. */
export function formatRefreshLine(refresh: TickRefresh): string {
  const lanes = `lanes=${refresh.lanes.map((lane) => laneToken(lane.name)).join(LANE_JOIN)}`;
  if (refresh.error !== null) {
    return `tick refresh ${lanes} outcome=error reason=${tokenField(refresh.error)}`;
  }
  const summary = refresh.summary!;
  if (summary.skipped) return `tick refresh ${lanes} outcome=skipped reason=${summary.reason}`;
  return (
    `tick refresh ${lanes} outcome=${summary.status} players=${summary.playersRefreshed} ` +
    `skipped=${summary.playersSkipped} failed=${summary.playersFailed} ` +
    `inserted=${summary.statLinesInserted} updated=${summary.statLinesUpdated}`
  );
}

/** One invocation's line. `list=-` is the unscoped Offseason-Sleep heartbeat. */
export function formatDigestLine(digest: TickDigest): string {
  const list = `list=${digest.lane === null ? "-" : laneToken(digest.lane.name)}`;
  if (digest.error !== null) {
    return `tick digest ${list} action=error reason=${tokenField(digest.error)}`;
  }
  const result = digest.result!;
  return (
    `tick digest ${list} kind=${result.kind} action=${result.action} ` +
    `statLines=${result.statLineCount} players=${result.playerCount}` +
    (result.reason === null ? "" : ` reason=${tokenField(result.reason)}`)
  );
}

/**
 * THE terminal line, printed on every path — including the tick that found
 * nothing to do, where it is the only line written at all. `refreshed` counts
 * lanes swept, not players; `digests` counts invocations made, not emails sent
 * (a refused claim is an invocation that correctly sent nothing).
 */
export function formatTerminalLine(result: TickResult): string {
  return (
    `tick done refreshed=${result.refresh?.lanes.length ?? 0} ` +
    `digests=${result.digests.length} ok=${result.ok}`
  );
}

export async function runTickCli(rawArgv: string[], deps: TickCliDeps): Promise<number> {
  const writeError = deps.writeError ?? deps.write;
  // Validated HERE as well as in main(), and the duplication is INTENTIONAL for
  // the reason src/cli/refresh.ts states: main() must reject a bad invocation
  // before it opens the database, while this is the injectable seam every test
  // drives. A malformed flag exits 1 having done NOTHING — no claim, no sweep,
  // no mail (rules/scripting.md: fail before the first side effect).
  const syntaxFailure = preflightDirect(["tick"], rawArgv);
  if (syntaxFailure !== null) {
    writeError(`error: ${syntaxFailure}`);
    return 1;
  }
  const argv = normalizeDirect(["tick"], rawArgv);
  const quiet = parseQuiet(argv);

  // The refresh Liveness presenter, reused whole rather than re-implemented
  // (ADR 0056: one presenter for that stream). Under `--quiet` it is not built
  // at all and no sink is attached, so the job emits into nothing.
  const presenter = quiet
    ? null
    : createRefreshPresenter(
        {
          db: deps.db,
          client: deps.client,
          highlightlyClient: deps.highlightlyClient,
          now: deps.now,
          tz: deps.tz,
          write: deps.write,
          writeError,
          isTty: deps.isTty,
          writeRaw: deps.writeRaw,
          ticker: deps.ticker,
        },
        false,
      );

  // Digest warnings are COLLECTED, never written straight through: under
  // `--quiet` they are dropped so the single-line contract holds, and otherwise
  // they are replayed to stderr after the terminal line so they cannot land in
  // the middle of the greppable stream.
  const warnings: string[] = [];
  let result: TickResult;
  try {
    result = await runTick({
      db: deps.db,
      now: deps.now,
      tz: deps.tz,
      client: deps.client,
      highlightlyClient: deps.highlightlyClient,
      onRefreshProgress: presenter?.sink,
      writeLegacyNotice: quiet ? () => {} : (line) => { writeError(line); },
      mailer: deps.mailer,
      to: deps.to,
      from: deps.from,
      warn: (message) => warnings.push(message),
    });
  } finally {
    // Release the ticker even when the tick throws, or a non-unref'd test ticker
    // would outlive the run.
    presenter?.stop();
  }

  if (!quiet) {
    if (result.refresh !== null) deps.write(formatRefreshLine(result.refresh));
    for (const digest of result.digests) deps.write(formatDigestLine(digest));
    // A digest-stage SETUP failure has no lane to name, so it gets its own line
    // rather than being folded into a `list=-` one (which means the unscoped
    // heartbeat invocation, a different thing).
    if (result.digestError !== null) {
      deps.write(`tick digest stage=setup action=error reason=${tokenField(result.digestError)}`);
    }
  }
  deps.write(formatTerminalLine(result));
  if (!quiet) for (const warning of warnings) writeError(warning);

  return result.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failure = preflightDirect(["tick"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  const normalized = normalizeDirect(["tick"], argv);
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runTickCli(normalized, {
      db,
      client: new MlbClient({ delayMs: config.mlbApiDelayMs }),
      highlightlyClient: new HighlightlyClient({ apiKey: config.highlightlyApiKey }),
      mailer: createMailer(config),
      now: () => new Date(),
      tz: config.tz,
      // The console provider needs no real addresses; every other provider has
      // fail-closed validated these in loadConfig.
      to: config.digestTo ?? "console@localhost",
      from: config.digestFrom ?? "bryce@localhost",
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
      isTty: process.stdout.isTTY === true,
      writeRaw: (text) => process.stdout.write(text),
    });
  } finally {
    close();
  }
}

if (isMain(import.meta.url)) {
  // exitCode + return rather than process.exit(), so a backpressured pipe
  // finishes draining before the process tears down (src/cli/refresh.ts, P2).
  main()
    .then(exitAfterDrain)
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
