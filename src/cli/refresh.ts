import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { asciiField } from "../domain/names.js";
import { runRefresh } from "../jobs/refresh.js";
import type {
  PlayerRef,
  RefreshCall,
  RefreshNotice,
  RefreshProgressEvent,
} from "../jobs/refresh-progress.js";
import { REFRESH_CALL_KEYS, legacyNoticeText } from "../jobs/refresh-progress.js";
import { MlbClient } from "../mlb/client.js";
import { HighlightlyClient } from "../highlightly/client.js";
import { exitAfterDrain, isMain } from "./main.js";
import { preflightDirect } from "./router.js";

/**
 * The refresh CLI: `npm run refresh [-- --quiet]`. The ONLY presenter of the
 * Refresh Liveness stream (ADR 0056) — the job emits typed events and this file
 * decides, alone, what becomes text and whether it is rendered at all.
 *
 * Injectable like the digest CLI (src/cli/digest.ts) so the WIRING — exit code,
 * failure print, TTY-ness, and the stall threshold — is testable and not merely
 * asserted through the job.
 *
 * Exit semantics (#23, MF6) are UNCHANGED by #146: a `failed` status is a
 * BLOCKED run (it refreshed nobody) and exits 1; `ok`, `partial` (safe partial
 * success), and any Skipped Sweep exit 0 — a partial sweep is not a job failure.
 * Whenever any calendar or per-player failure was collected, a one-line summary
 * is printed to stderr, even on an otherwise-`ok`/`partial` run, so a degraded
 * sweep is never silent.
 *
 * THE TWO RENDERINGS carry IDENTICAL content and differ only in how they make a
 * hang visible (ADR 0056 s4):
 *   - not a TTY (cron, `> refresh.log`, a pipe): append-only ASCII `key=value`
 *     lines, no cursor control, no redraws. An outstanding call would otherwise
 *     write nothing at all and a stall would be indistinguishable from
 *     truncation, so a `waiting` line repeats every {@link STALL_MS}.
 *   - a TTY: the same append-only lines, plus ONE in-place line for the call
 *     currently in flight whose elapsed time ticks every {@link TTY_TICK_MS}.
 * `--quiet` drops the whole stream and prints only the terminal summary — the
 * SAME summary path, which is why quiet mode reproduces today's output exactly
 * rather than reimplementing it.
 */

/** How long an outstanding call runs before a piped run starts saying so, and the repeat period. */
export const STALL_MS = 30_000;
/** How often the TTY in-place line redraws its elapsed time. */
export const TTY_TICK_MS = 1_000;

/** An opaque repeating-timer seam, injected so no test ever sleeps for real. */
export interface RefreshTicker {
  start: (tick: () => void, everyMs: number) => unknown;
  stop: (handle: unknown) => void;
}

/**
 * The default ticker. `unref()` is load-bearing: `src/cli/refresh.ts`
 * deliberately relies on natural stdio drain rather than `process.exit()` (P2),
 * so a live interval would hold the event loop open and the process would never
 * exit.
 */
const realTicker: RefreshTicker = {
  start: (tick, everyMs) => setInterval(tick, everyMs).unref(),
  stop: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>); },
};

export interface RefreshCliDeps {
  db: Db;
  client: MlbClient;
  highlightlyClient?: HighlightlyClient;
  now: () => Date;
  tz: string;
  write: (line: string) => void;
  writeError?: (line: string) => void;
  /**
   * Whether stdout is a terminal. Injected rather than read from `process` so
   * BOTH renderings are testable; defaults to false, the conservative choice —
   * a wrong guess that emits control bytes into a log file is the worse failure.
   */
  isTty?: boolean;
  /** Raw (un-terminated) stdout, used ONLY for the TTY in-place line. */
  writeRaw?: (text: string) => void;
  ticker?: RefreshTicker;
}

/**
 * `--quiet`: suppress the live stream and print only the terminal summary.
 * One valueless boolean, so a bare `includes` — mirroring `parseForce`
 * (src/cli/digest.ts). It is parsed HERE, not taken from `preflight`, because
 * `preflight` returns only `string | null` and discards its parsed values;
 * a flag that validated and was then dropped on the way to the presenter would
 * be silently dead with the suite still green (rules/testing.md).
 */
export function parseQuiet(argv: string[]): boolean {
  return argv.includes("--quiet") || argv.includes("-q");
}

/**
 * Fold ANY runtime-derived free text to one ASCII token: no spaces, so
 * `key=value` stays parseable and a crafted upstream string cannot FORGE a
 * token. `asciiField` alone is not enough — it strips control bytes and folds
 * accents but collapses whitespace to a *space*, which still terminates a token.
 *
 * This is the forgery-proofing ADR 0047's #146 amendment turns on, and it must
 * cover every upstream-influenced field on the line, not just the Player's name:
 * a `reason` is `err.message` from the MLB/Highlightly adapters (a zod failure
 * embeds the API's own payload text), so it is exactly as attacker-influenced as
 * a name, and it is followed on the line by `elapsed=`/`refreshed=`/`failed=`.
 */
function tokenField(raw: string): string {
  const folded = asciiField(raw).replace(/ /g, "_");
  return folded.length === 0 ? "?" : folded;
}

/**
 * The call's own payload keys, in their declared order (`RefreshCall` is the source of truth).
 *
 * `tokenField`, not `asciiField`, DELIBERATELY. Every payload field today is a
 * number or the fixed `StatGroup` enum, so the two are identical here and this
 * changes no output. It is written this way so the safe choice is the DEFAULT
 * for the next call variant: a future payload carrying provider-supplied free
 * text would otherwise silently inherit space-preserving folding and reopen the
 * token-forgery hole `tokenField` exists to close.
 */
function callFields(call: RefreshCall): string {
  const record = call as unknown as Record<string, unknown>;
  return REFRESH_CALL_KEYS[call.call]
    .map((key) => ` ${key}=${tokenField(String(record[key]))}`)
    .join("");
}

/** `player=3/12 id=41`, or nothing for a call that belongs to no player. */
function playerFields(player: PlayerRef | null): string {
  return player === null ? "" : ` player=${player.index}/${player.total} id=${player.playerId}`;
}

/** The greppable rendering of a notice; the legacy stderr text is a separate, quiet-mode concern. */
function noticeFields(notice: RefreshNotice): string {
  switch (notice.code) {
    case "ncaa-season-missing":
      return ` season=${tokenField(notice.season)}`;
    case "tag-sync-failed":
      return ` playerId=${notice.playerId} reason=${tokenField(notice.reason)}`;
    case "targeted-calendar-failures":
      return ` playerId=${notice.playerId} failures=${notice.failures.length}` +
        ` sports=${notice.failures.map((f) => f.sportId).join(",")}`;
  }
}

/**
 * One append-only line per event, or null for an event this presenter renders
 * NOTHING for. Two events deliberately return null: `sweep-skipped` and
 * `sweep-finished` are already printed, byte-identically, by the terminal
 * summary path below — rendering them here would duplicate the line and break
 * quiet mode's "exactly today's output". They are still consumed (they stop the
 * ticker), just not printed.
 *
 * Key order is FIXED so the output is stably greppable:
 *   `refresh` · `player=i/total` · `id=` · `name=` · `call=` · the call's own
 *   keys in declaration order · `outcome=` · `elapsed=`.
 * Every elapsed value is integer milliseconds with an `ms` suffix — one unit,
 * one grammar — and every runtime-derived value is `tokenField`-folded, so no upstream
 * string can forge a token.
 */
export function formatRefreshEvent(event: RefreshProgressEvent): string | null {
  switch (event.kind) {
    case "sweep-started":
      return `refresh start players=${event.playersTotal} season=${tokenField(event.season)} run=${event.runId}`;
    case "phase-started":
      return `refresh phase=${event.phase} start`;
    case "phase-finished":
      return `refresh phase=${event.phase} done failures=${event.failures}`;
    case "call-started":
      // Deliberately unrendered: it exists to drive the in-flight indicator (the
      // TTY ticker and the piped `waiting` line), and printing a line per call
      // start would double the volume without adding a fact the matching
      // `call-finished` does not already carry.
      return null;
    case "call-finished":
      return `refresh${playerFields(event.player)} call=${event.call}${callFields(event)}` +
        ` outcome=${event.outcome}${event.reason === undefined ? "" : ` reason=${tokenField(event.reason)}`}` +
        ` elapsed=${event.elapsedMs}ms`;
    case "player-started":
      return `refresh${playerFields(event.player)} name=${tokenField(event.player.name)} start`;
    case "player-settled":
      return `refresh${playerFields(event.player)} done outcome=${event.outcome}` +
        (event.reason === undefined ? "" : ` reason=${tokenField(event.reason)}`) +
        (event.inserted === undefined ? "" : ` inserted=${event.inserted}`) +
        (event.updated === undefined ? "" : ` updated=${event.updated}`) +
        ` elapsed=${event.elapsedMs}ms` +
        ` refreshed=${event.counts.refreshed} passedOver=${event.counts.passedOver}` +
        ` failed=${event.counts.failed}`;
    case "sweep-superseded":
      return `refresh superseded at=${event.at}`;
    case "notice":
      return `refresh notice code=${event.code}${noticeFields(event)}`;
    case "sweep-skipped":
    case "sweep-finished":
      return null;
  }
}

/** The periodic line a PIPED run emits while one call stays outstanding. */
export function formatWaitingLine(
  player: PlayerRef | null,
  call: RefreshCall,
  elapsedMs: number,
): string {
  return `refresh${playerFields(player)} waiting call=${call.call}${callFields(call)} elapsed=${elapsedMs}ms`;
}

/** The single in-place TTY line for the call currently in flight. */
function formatInFlightLine(
  player: PlayerRef | null,
  call: RefreshCall | null,
  elapsedMs: number,
): string {
  const name = player === null ? "" : ` name=${tokenField(player.name)}`;
  const callPart = call === null ? "" : ` call=${call.call}${callFields(call)}`;
  return `refresh${playerFields(player)}${name}${callPart} elapsed=${elapsedMs}ms`;
}

/**
 * ANSI erase-to-end-of-line. Written as an ESCAPE, never a literal control byte:
 * git classifies a source file containing one as BINARY and hides its diff from
 * every reviewer (rules/backend.md).
 */
const ERASE_TO_EOL = "\u001b[K";
/** Carriage return + erase: the ONLY cursor control this file emits. */
const CLEAR_LINE = `\r${ERASE_TO_EOL}`;

interface Presenter {
  sink: (event: RefreshProgressEvent) => void;
  /** Release the ticker. Idempotent; safe to call on every path including a throw. */
  stop: () => void;
}

/**
 * Build the presenter for one run. `quiet` collapses the whole stream to the
 * three legacy notice lines — those are unconditional today, so dropping them
 * would make "quiet mode reproduces exactly today's output" false in the other
 * direction.
 */
export function createRefreshPresenter(deps: RefreshCliDeps, quiet: boolean): Presenter {
  const writeError = deps.writeError ?? deps.write;
  const isTty = deps.isTty ?? false;
  const ticker = deps.ticker ?? realTicker;

  let handle: unknown = null;
  let inFlightCall: RefreshCall | null = null;
  let inFlightPlayer: PlayerRef | null = null;
  let inFlightStartedMs = 0;
  // True while the TTY in-place line is on screen and must be erased before any
  // append-only line is written over it.
  let inPlaceDirty = false;

  const raw = (text: string): void => { deps.writeRaw?.(text); };

  const clearInPlace = (): void => {
    if (!inPlaceDirty) return;
    raw(CLEAR_LINE);
    inPlaceDirty = false;
  };

  const stopTicker = (): void => {
    if (handle === null) return;
    ticker.stop(handle);
    handle = null;
  };

  const tick = (): void => {
    if (inFlightCall === null) return;
    const elapsedMs = deps.now().getTime() - inFlightStartedMs;
    if (isTty) {
      raw(`\r${formatInFlightLine(inFlightPlayer, inFlightCall, elapsedMs)}${ERASE_TO_EOL}`);
      inPlaceDirty = true;
      return;
    }
    // Piped: only past the threshold, and then every period thereafter.
    if (elapsedMs >= STALL_MS) deps.write(formatWaitingLine(inFlightPlayer, inFlightCall, elapsedMs));
  };

  const endCall = (): void => {
    stopTicker();
    clearInPlace();
    inFlightCall = null;
    inFlightPlayer = null;
  };

  const sink = (event: RefreshProgressEvent): void => {
    if (quiet) {
      // The three diagnostics that wrote to stderr before #146 stay on stderr,
      // in their legacy wording, because today they are unconditional.
      if (event.kind === "notice") writeError(legacyNoticeText(event));
      return;
    }

    switch (event.kind) {
      case "call-started":
        endCall();
        inFlightCall = event;
        inFlightPlayer = event.player;
        inFlightStartedMs = deps.now().getTime();
        // One period, both renderings: a TTY redraws each second, a pipe stays
        // silent until the call has actually stalled.
        handle = ticker.start(tick, isTty ? TTY_TICK_MS : STALL_MS);
        return;
      case "call-finished":
        endCall();
        break;
      case "sweep-finished":
      case "sweep-superseded":
      case "sweep-skipped":
        // Every terminal path releases the ticker, so no timer survives a run.
        endCall();
        break;
      default:
        break;
    }

    const line = formatRefreshEvent(event);
    if (line === null) return;
    clearInPlace();
    deps.write(line);
  };

  return { sink, stop: () => { endCall(); } };
}

export async function runRefreshCli(argv: string[], deps: RefreshCliDeps): Promise<number> {
  const writeError = deps.writeError ?? deps.write;
  // Validated HERE as well as in main(), and that duplication is INTENTIONAL:
  // main() must reject a bad invocation before it opens the database, while
  // runRefreshCli is the injectable seam every test drives — so collapsing the
  // two would either leave the tested entry point unvalidated or make the
  // validation untestable. Both write to their own error sink, so neither is
  // reachable from the other's tests. (Mirrors src/cli/digest.ts.)
  const syntaxFailure = preflightDirect(["refresh"], argv);
  if (syntaxFailure !== null) {
    writeError(`error: ${syntaxFailure}`);
    return 1;
  }
  const presenter = createRefreshPresenter(deps, parseQuiet(argv));
  let summary;
  try {
    summary = await runRefresh({
      db: deps.db,
      client: deps.client,
      highlightlyClient: deps.highlightlyClient,
      now: deps.now,
      tz: deps.tz,
      onProgress: presenter.sink,
    });
  } finally {
    // Release the ticker even when the sweep throws, or a `.unref()`-less test
    // ticker (or a future non-unref'd one) would outlive the run.
    presenter.stop();
  }

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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failure = preflightDirect(["refresh"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runRefreshCli(argv, {
      db,
      client: new MlbClient({ delayMs: config.mlbApiDelayMs }),
      highlightlyClient: new HighlightlyClient({ apiKey: config.highlightlyApiKey }),
      now: () => new Date(),
      tz: config.tz,
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
  // Set process.exitCode and RETURN rather than calling process.exit(): the
  // failure summary is written to stderr just before main() resolves, and
  // process.exit() would tear the process down before a piped/backpressured
  // stderr finishes draining, truncating that diagnostic. main() has already
  // closed the db, so nothing keeps the event loop alive — Node drains stdio and
  // then exits with process.exitCode on its own (P2).
  main()
    .then(exitAfterDrain)
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
