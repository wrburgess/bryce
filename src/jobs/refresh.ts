import { and, count, eq, exists, inArray, like, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { NewStatLineRow, PlayerListRow, PlayerRow } from "../db/schema.js";
import {
  highlightlyBoxScoreCache,
  highlightlyMatchCache,
  highlightlyPlayerCursors,
  listMembers,
  players,
  seasonCalendar,
  statLines,
} from "../db/schema.js";
import {
  HighlightlyCoverageError,
  HighlightlyMigrationRequiredError,
  normalizeHighlightlyStats,
  type HighlightlyMatch,
  type HighlightlyPlayer,
} from "../highlightly/client.js";
import type { HighlightlyClient } from "../highlightly/client.js";
import type { CalendarEntry } from "../domain/season.js";
import { calendarHasUsableDates, hostDate, sleepWindow, sportIdForPlayer } from "../domain/season.js";
import type { MlbClient, StatGroup } from "../mlb/client.js";
import { isIngestedGameType } from "../mlb/gameTypes.js";
import { levelForSportId, NCAA_SPORT_ID, SPORT_IDS } from "../mlb/levels.js";
import type { GameLogSplit } from "../mlb/schemas.js";
import { ncaaSeasonFor } from "../ncaa/seasons.js";
import { syncDerivedTags } from "../tags/service.js";
import type { IngestionFence, RefreshTerminalStatus } from "./refresh-run.js";
import { admitTargetedRefresh, claimRefreshRun, renewRefreshRun, settleRefreshRun, updateRefreshRunProgress, withIngestionFence } from "./refresh-run.js";
import type { PlayerRef, RefreshCall, RefreshProgressEvent, RefreshProgressSink } from "./refresh-progress.js";
import { emitNotice, safeEmit } from "./refresh-progress.js";

/**
 * WHICH LANES one sweep covers (#192, ADR 0061), resolved ONCE by the caller
 * BEFORE the claim and then consumed by BOTH of `runRefresh`'s player-selection
 * sites. Resolving once is the whole point: the settle-time re-read at the
 * bottom of the sweep is the site that feeds `calendarBlocksFresh`, so a scope
 * re-decided there — or not applied there at all — lets an off-lane player
 * downgrade a clean lane run to `partial` while every pre-#192 test stays green.
 */
export interface RefreshScope {
  /**
   * The live lane rows this sweep covers. Carried alongside the ids because the
   * caller has already paid for them and a presenter must never re-query to turn
   * an id back into a name — one resolution, one set of lanes, one label.
   */
  lists: PlayerListRow[];
  /** Their ids — what BOTH selection sites filter by. */
  listIds: number[];
}

export interface RefreshDeps {
  db: Db;
  client: MlbClient;
  /** Optional only for installations without an attached NCAA player. */
  highlightlyClient?: HighlightlyClient;
  now: () => Date;
  tz: string;
  /**
   * The Liveness sink (ADR 0056). OPTIONAL by design: the MCP tool, the REST
   * route, and the watchlist seed path attach none and stay byte-identical to
   * their pre-#146 behavior. It carries EVENTS ABOUT THE SWEEP, never
   * diagnostics of convenience, and is never awaited — a slow or throwing
   * presenter must not be able to stall or fail a healthy sweep.
   */
  onProgress?: RefreshProgressSink;
  /**
   * Where the three LEGACY notice lines go when NO sink is attached. Defaults to
   * `process.stderr`. This is NOT a logging channel: it carries exactly the
   * three diagnostics that wrote to stderr before #146, so a sink-less caller's
   * stderr is unchanged. With a sink attached it is never used.
   */
  writeLegacyNotice?: (line: string) => void;
  /**
   * The lanes this sweep covers (#192, ADR 0061). OPTIONAL, and its absence
   * means THE WHOLE WATCH LIST — every active Player, membership ignored. That
   * unscoped default is the contract the MCP tool (`src/mcp/server.ts`), the
   * REST route (`src/api/routes.ts`), and every pre-#192 refresh test rely on,
   * and it is deliberately NOT the CLI's default: `sk refresh` resolves the
   * default lane in `src/cli/refresh.ts`, mirroring `sk players add`. The lane
   * default belongs to the command surface, not to the job.
   */
  scope?: RefreshScope;
}

/** The `player-settled` event, held back until the progress write has committed. */
type PlayerSettledEvent = Extract<RefreshProgressEvent, { kind: "player-settled" }>;

/**
 * Wrap one job-owned external call in its `call-started` / `call-finished` pair,
 * timing it on the injected clock. The pair is emitted for BOTH outcomes, so a
 * call that threw still reports how long it burned before it did — the
 * difference between a fast rejection and a socket that hung.
 */
async function timedCall<T>(
  deps: RefreshDeps,
  player: PlayerRef | null,
  call: RefreshCall,
  run: () => Promise<T>,
): Promise<T> {
  safeEmit(deps.onProgress, { kind: "call-started", player, ...call });
  const startedMs = deps.now().getTime();
  try {
    const value = await run();
    safeEmit(deps.onProgress, {
      kind: "call-finished", player, ...call,
      elapsedMs: deps.now().getTime() - startedMs, outcome: "ok",
    });
    return value;
  } catch (err) {
    safeEmit(deps.onProgress, {
      kind: "call-finished", player, ...call,
      elapsedMs: deps.now().getTime() - startedMs, outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}


/** A swept sportId whose `getSeason` fetch threw (#23): its cached row is left untouched. */
export interface CalendarFailure {
  sportId: number;
  reason: string;
}

/** A watched player whose refresh threw (#23): collected, not fatal to the sweep. */
export interface PlayerFailure {
  playerId: number;
  reason: string;
}

export interface RefreshSummary {
  skipped: boolean;
  /**
   * Why the sweep did not run normally, or null when it did. `offseason-sleep`
   * is the pure no-op (ADR 0031); `already-running` is a concurrent sweep
   * holding a live lease (ADR 0043) — neither records a run. `superseded` is a
   * run whose lease expired mid-sweep: a successor reaped its row and took over,
   * so it aborts WITHOUT settling (ADR 0043 fencing) rather than clobber the
   * successor's newer data.
   */
  reason: "offseason-sleep" | "already-running" | "superseded" | null;
  /**
   * The settled terminal status of a run that recorded one (#23): `ok`,
   * `partial`, or `failed`, mirroring the `refresh_runs` row so no caller has to
   * re-derive it. `null` on any SKIPPED sweep (offseason / already-running /
   * superseded), which settles no status of its own.
   */
  status: RefreshTerminalStatus | null;
  playersRefreshed: number;
  statLinesInserted: number;
  statLinesUpdated: number;
  /** Watched players deliberately skipped this sweep (out-of-season NCAA, no external id). */
  playersSkipped: number;
  /** Watched players whose refresh threw and was collected, not fatal (#23). */
  playersFailed: number;
  /** Per-sportId calendar fetch failures collected this sweep (#23); empty when clean. */
  calendarFailures: CalendarFailure[];
  /** Per-player refresh failures collected this sweep (#23); empty when clean. */
  playerFailures: PlayerFailure[];
  /** The recorded run's id, or null when nothing was recorded (skip/no-op). */
  runId: number | null;
}

/**
 * The pure status rule (#23, ADR 0043 vocabulary): a whole-list sweep is
 *  - `ok` iff NOTHING was left behind — zero failures, zero skips, AND no
 *    calendar failure that would leave the digest silently incomplete
 *    (`calendarBlocksFresh`, see P1). This includes the vacuous
 *    zero-active-player sweep: nothing to refresh is a clean sweep;
 *  - `failed` iff it refreshed NObody AND at least one player failed — a blocked
 *    run, nothing useful landed (skips alone never make a run `failed`, and
 *    `calendarBlocksFresh` NEVER forces `failed`);
 *  - `partial` otherwise — safe partial success (some refreshed, and/or some
 *    merely skipped, and/or a watched sport's calendar could not be resolved and
 *    has no cached fallback, so idle players at that level are omitted).
 * Extracted and pure so the truth table is table-tested directly, not only
 * through the orchestration.
 */
export function deriveRefreshStatus(counts: {
  refreshed: number;
  skipped: number;
  failed: number;
  /**
   * A watched sport's calendar could not be fetched AND has no cached fallback,
   * so the digest would silently drop that level's idle players (P1). It
   * downgrades an otherwise-`ok` run to `partial` (so the digest warns), but
   * never overrides a `failed` (blocked) run.
   */
  calendarBlocksFresh: boolean;
}): RefreshTerminalStatus {
  if (counts.failed === 0 && counts.skipped === 0 && !counts.calendarBlocksFresh) return "ok";
  if (counts.refreshed === 0 && counts.failed > 0) return "failed";
  return "partial";
}

/**
 * Compose an `error_message` from the collected failures, INDEPENDENT of the
 * terminal status (#23, MF2): a calendar failure is recorded even on an
 * otherwise-`ok` run, and a skip-only `partial` (no failures at all) records
 * `null` — never the nonsensical "0 player(s) failed; 0 calendar fetch(es)
 * failed". Returns null exactly when nothing failed.
 */
export function summarizeRefreshFailures(
  calendarFailures: CalendarFailure[],
  playerFailures: PlayerFailure[],
): string | null {
  if (calendarFailures.length === 0 && playerFailures.length === 0) return null;
  const parts: string[] = [];
  if (playerFailures.length > 0) {
    parts.push(
      `${playerFailures.length} player(s) failed: ` +
        playerFailures.map((f) => `${f.playerId} (${f.reason})`).join("; "),
    );
  }
  if (calendarFailures.length > 0) {
    parts.push(
      `${calendarFailures.length} calendar fetch(es) failed: ` +
        calendarFailures.map((f) => `${f.sportId} (${f.reason})`).join("; "),
    );
  }
  return parts.join("; ");
}

const STAT_GROUPS: readonly StatGroup[] = ["hitting", "pitching", "fielding"];
const UPSERT_CHUNK = 50;

/** One game-log fetch: a swept sportId paired with one stat group. */
export interface ProbePair {
  sportId: number;
  group: StatGroup;
}

/**
 * What one Player's Refresh will fetch (#197, ADR 0060): either the FULL fan-out
 * SENTINEL — every swept sportId x every stat group, ADR 0030's original sweep —
 * or the exact pairs to probe. A sentinel rather than the expanded eighteen pairs,
 * so "deliberately everything" stays distinguishable from "everything happened to
 * be seen"; the two mean different things to a reader and to a test.
 */
export type ProbePlan = { kind: "full" } | { kind: "probe"; pairs: ProbePair[] };

/** The whole 6x3 fan-out, expanded once. */
const FULL_FAN_OUT: readonly ProbePair[] = SPORT_IDS.flatMap((sportId) =>
  STAT_GROUPS.map((group) => ({ sportId, group })),
);

/** SPORT_IDS as plain numbers: the tuple's literal type rejects a `number` lookup. */
const SWEPT_SPORT_IDS: readonly number[] = SPORT_IDS;

/** stat_lines stores hitting as `batting`; the game-log API asks for `hitting`. */
function groupForStatType(statType: "batting" | "pitching" | "fielding"): StatGroup {
  return statType === "batting" ? "hitting" : statType;
}

/**
 * The pure probe-plan rule (#197, ADR 0060), superseding the unconditional 6x3
 * nested loop. Extracted and pure so the matrix is table-tested directly, not only
 * through the orchestration — the same treatment as {@link deriveRefreshStatus}.
 *
 * FULL fan-out — the exact prior behavior — whenever the plan cannot be trusted to
 * be complete:
 *  - an EMPTY seen set is a FIRST refresh. The watchlist-add backfill shares this
 *    code path, and a mid-season call-up added with zero rows must not lose the
 *    lower-level season he played before the call-up;
 *  - NO current sport (the person carries no `currentTeam`) leaves nothing to
 *    anchor the plan on;
 *  - a current sport OUTSIDE `SPORT_IDS` is not one the MLB path sweeps. This one
 *    predicate is load-bearing for BOTH the unknown-id and the NCAA case, because
 *    the non-NCAA keys of the level map are exactly `SPORT_IDS` — adding a
 *    `levelForSportId` check beside it would be two branches no input can reach.
 *
 * Otherwise: the CURRENT level in all three groups — so a two-way player's first
 * pitching appearance is ingested the sweep it happens, never a sweep late — plus
 * every seen pair at any OTHER level, because that is exactly where a historical
 * level's quiet corrections keep landing. A stored sportId outside `SPORT_IDS` is
 * dropped HERE, BEFORE the emptiness check, so a malformed or legacy row can never
 * mint a game-log request through this function in isolation — and a seen set made
 * ENTIRELY of such rows still reads as a first refresh and takes the FULL fan-out.
 */
export function probePlanFor(args: {
  /** DISTINCT (sportId, statType) rows this Player has THIS season from the MLB path. */
  seen: readonly { sportId: number; statType: "batting" | "pitching" | "fielding" }[];
  /** sportId of the team the identity fetch just resolved; null when he has none. */
  currentSportId: number | null;
}): ProbePlan {
  const { currentSportId } = args;
  // Unswept rows are dropped BEFORE the emptiness check: a seen set consisting
  // ONLY of unswept sportIds must read as "nothing usable seen" and take the FULL
  // fan-out, exactly as if the caller's WHERE had filtered them. This ordering is
  // what makes the function safe in isolation — swap it and the caller's inArray
  // becomes load-bearing for that input.
  const seen = args.seen.filter((row) => SWEPT_SPORT_IDS.includes(row.sportId));
  if (seen.length === 0) return { kind: "full" };
  if (currentSportId === null || !SWEPT_SPORT_IDS.includes(currentSportId)) return { kind: "full" };

  const pairs = new Map<string, ProbePair>();
  const add = (sportId: number, group: StatGroup): void => {
    pairs.set(`${sportId}:${group}`, { sportId, group });
  };
  for (const group of STAT_GROUPS) add(currentSportId, group);
  for (const row of seen) {
    if (row.sportId === currentSportId) continue; // already probed in full
    add(row.sportId, groupForStatType(row.statType));
  }

  // Emit in the level ladder's own order (SPORT_IDS declaration order), then
  // STAT_GROUPS — the exact order the pre-#197 nested loop issued its calls in, so
  // pruning changes which calls are made and never the order of the survivors.
  const ordered = [...pairs.values()].sort(
    (a, b) =>
      SWEPT_SPORT_IDS.indexOf(a.sportId) - SWEPT_SPORT_IDS.indexOf(b.sportId) ||
      STAT_GROUPS.indexOf(a.group) - STAT_GROUPS.indexOf(b.group),
  );
  return { kind: "probe", pairs: ordered };
}

/** A guarded mutation was deliberately refused; never classify it as provider failure. */
class RefreshFenceLostError extends Error {
  constructor(readonly reason: "superseded" | "whole-refresh-running") { super(reason); }
}

function guardedWrite<T>(db: Db, fence: IngestionFence | undefined, mutation: (tx: TxHandle) => T): T {
  const result = withIngestionFence(db, fence, mutation);
  if (!result.committed) throw new RefreshFenceLostError(result.reason === "lost-ownership" ? "superseded" : "whole-refresh-running");
  return result.value;
}

/** Whole-run lease validity is evaluated at the write, never at fetch start. */
function fenceAtWrite(fence: IngestionFence | undefined, now: Date): IngestionFence | undefined {
  return fence?.kind === "whole-refresh" ? { ...fence, now } : fence;
}

export async function loadCalendars(db: Db): Promise<CalendarEntry[]> {
  const rows = await db.select().from(seasonCalendar);
  return rows.map((r) => ({
    sportId: r.sportId,
    season: r.season,
    regularSeasonStart: r.regularSeasonStart,
    regularSeasonEnd: r.regularSeasonEnd,
    postSeasonStart: r.postSeasonStart,
    postSeasonEnd: r.postSeasonEnd,
    springStart: r.springStart,
    springEnd: r.springEnd,
  }));
}

/**
 * The active Players one sweep selects, optionally narrowed to a set of lanes
 * (#192, ADR 0061).
 *
 * `players.active` STAYS THE MASTER GATE, above membership: a deactivated
 * Player who is still enrolled in an in-scope lane is never fetched. That is the
 * surviving half of ADR 0046 decision 2 and the ordering the predicate below is
 * written in.
 *
 * `undefined` listIds ⇒ today's exact query, byte for byte — the whole Watch
 * List. A non-empty set adds a CORRELATED `EXISTS` over `list_members` (the same
 * shape `src/digest/assemble.ts` scopes its join with): constant-size regardless
 * of how many Players a lane holds, so no bind parameter per Player and no
 * SQLite ~999-param ceiling (`rules/backend.md`). `IN` over LANE ids is fine —
 * a scope is a handful of lanes, never an unbounded id set — and it is also what
 * makes UNION AND DEDUPE fall out of one query: a Player on two in-scope lanes
 * satisfies `EXISTS` once and yields exactly one row, hence exactly one fetch.
 */
export async function loadActivePlayers(db: Db, listIds?: readonly number[]): Promise<PlayerRow[]> {
  if (listIds === undefined) {
    return db.select().from(players).where(eq(players.active, true));
  }
  // ZERO lanes in scope selects NOBODY, by an explicit early return rather than
  // by whatever drizzle renders an empty `inArray` as. This is a real input, not
  // a defensive one: #193's due-lane driver ticks with an empty due set whenever
  // no lane's interval has elapsed, and "no lane is due" must sweep no Player —
  // never, through a vacuously-true predicate, sweep every Player.
  if (listIds.length === 0) return [];
  return db
    .select()
    .from(players)
    .where(
      and(
        eq(players.active, true),
        exists(
          db
            .select({ x: sql`1` })
            .from(listMembers)
            .where(
              and(
                inArray(listMembers.listId, [...listIds]),
                eq(listMembers.playerId, players.id),
              ),
            ),
        ),
      ),
    );
}

/**
 * Does a sweep over `listIds` reach EVERY active Player? (#192, ADR 0061
 * decision 8.)
 *
 * This is the question the digest's freshness banner actually asks — "was every
 * player I am about to report on swept?" — and it is what the run records, in
 * place of the "does the scope contain the default lane?" PROXY the Stage-4
 * self-review found wrong. The proxy holds only while the default lane contains
 * every active Player; point the default at a fresh empty lane and a sweep of
 * zero players certified the whole Watch List.
 *
 * It COUNTS THE UNCOVERED rather than comparing two counts. Comparing
 * `activePlayers.length` against a total taken moments later would answer "were
 * my two reads consistent?", which is a different question and one that goes the
 * wrong way under concurrent writes; a single `NOT EXISTS` count asks the real
 * one in one statement. `count()`, never a row load — the answer is a number and
 * this runs on every sweep (`rules/backend.md`).
 *
 * It is a CLAIM-TIME SNAPSHOT, and deliberately not re-taken. A Player added
 * mid-sweep is still picked up by the settle-time re-read that feeds
 * `calendarBlocksFresh`, but he does not retroactively change what this run's
 * row says it covered — a run's recorded coverage is a statement about the world
 * it claimed against. The direction of that staleness is safe either way: the
 * next sweep re-answers the question from scratch.
 */
async function coversEveryActivePlayer(db: Db, listIds: readonly number[]): Promise<boolean> {
  // ZERO lanes covers nobody, so coverage can hold only on a host with nobody to
  // cover. Split out rather than folded into the predicate below, because an
  // empty `inArray` is exactly the vacuous-truth shape `loadActivePlayers`
  // refuses to rely on.
  if (listIds.length === 0) {
    const total = await db.select({ n: count() }).from(players).where(eq(players.active, true));
    return (total[0]?.n ?? 0) === 0;
  }
  const uncovered = await db
    .select({ n: count() })
    .from(players)
    .where(
      and(
        eq(players.active, true),
        notExists(
          db
            .select({ x: sql`1` })
            .from(listMembers)
            .where(
              and(
                inArray(listMembers.listId, [...listIds]),
                eq(listMembers.playerId, players.id),
              ),
            ),
        ),
      ),
    );
  return (uncovered[0]?.n ?? 0) === 0;
}

/**
 * The Refresh (ADR 0030): re-ingest every active Player's complete current-season
 * game log and upsert idempotently on the ADR 0029 key. No date windows, ever —
 * every pair fetched is fetched whole-season. WHICH pairs are fetched is the
 * per-player probe plan (ADR 0060), not a fixed sweep of every sportId. During
 * Offseason Sleep the whole job is a no-op — zero API calls (ADR 0031).
 */
export async function runRefresh(deps: RefreshDeps): Promise<RefreshSummary> {
  const { db, now, tz } = deps;
  // SELECTION SITE 1 (#192). `deps.scope` is undefined for the whole Watch List
  // and carries the lanes otherwise; the SAME expression feeds selection site 2
  // at settle time below, which is what makes the scope one decision rather than
  // two that can disagree.
  const activePlayers = await loadActivePlayers(db, deps.scope?.listIds);
  const calendars = await loadCalendars(db);
  // Offseason Sleep is judged against THIS SWEEP'S players — so a lane sweep
  // sleeps on its own lane's levels, not the host's. Deliberate: a lane of
  // NCAA-only players has no reason to keep fetching because some other lane's
  // MLB players are in season. Note `sleepWindow` returns `{sleeping:false}` for
  // ZERO watched players (src/domain/season.ts), so an EMPTY lane sweeps
  // (recording an `ok`, zero-player run) rather than sleeping.
  const sleep = sleepWindow(calendars, activePlayers, now(), tz);
  // Offseason Sleep stays a PURE no-op: it records no run at all, because the
  // weekly heartbeat — not a freshness row — is the offseason liveness signal
  // (ADR 0031/0042). A stale freshness reading during sleep is expected.
  if (sleep.sleeping) {
    // A Skipped Sweep (docs/domain/CONTEXT.md) — the whole Refresh never ran.
    // Distinct from a Passed-Over Player, which only a RUNNING sweep produces.
    safeEmit(deps.onProgress, { kind: "sweep-skipped", reason: "offseason-sleep" });
    return skippedSummary("offseason-sleep", null);
  }

  // WHAT THIS RUN WILL CLAIM TO HAVE COVERED (#192, ADR 0061 decision 8).
  // `undefined` — stored as `NULL` — means "swept every active Player", so an
  // unscoped run records it, AND SO DOES a lane run whose lanes happen to hold
  // everyone: that is not a fudge, it is the column's documented meaning, and
  // such a run genuinely did sweep the whole Watch List. Anything less records
  // its lane ids as provenance for a genuinely partial run, which makes the
  // digest's banner read an honest `stale` rather than forging `fresh` over
  // players nobody fetched.
  const scopeListIds =
    deps.scope === undefined || (await coversEveryActivePlayer(db, deps.scope.listIds))
      ? undefined
      : deps.scope.listIds;

  // Claim a run AFTER the sleep check (ADR 0043). A refusal means another sweep
  // holds a live lease — the wake-time overlap of the launchd job and a manual
  // run — so this one no-ops rather than double-sweeping.
  //
  // `playersTotal` is the SCOPED count, and `scopeListIds` records whether that
  // count was the whole Watch List, so a lane run's N-of-M can never be read as
  // a whole-list claim (#192).
  const claim = claimRefreshRun(db, {
    now: now(),
    playersTotal: activePlayers.length,
    scopeListIds,
  });
  if (!claim.claimed) {
    safeEmit(deps.onProgress, { kind: "sweep-skipped", reason: claim.reason });
    return skippedSummary(claim.reason, null);
  }
  const runId = claim.runId;

  let playersRefreshed = 0;
  let playersSkipped = 0;
  let inserted = 0;
  let updated = 0;
  // Calendar + per-player failures are COLLECTED (#23): a single upstream fault
  // no longer aborts the whole sweep. They flow into the normal status
  // computation below, never to the outer catch.
  let calendarFailures: CalendarFailure[] = [];
  const playerFailures: PlayerFailure[] = [];
  // Terminal status + errorMessage are COMPUTED inside the try (their inputs
  // include fallible DB reads) but CONSUMED by the terminal settle outside it, so
  // they are declared here. Definite-assignment (`!`): the only path that reaches
  // the terminal settle is a normal completion of the try, which always assigns
  // both; any throw first goes to the MF1 catch, which re-throws.
  let status!: RefreshTerminalStatus;
  let errorMessage!: string | null;
  // Hoisted above the try so the settle-time freshness check (P1) can re-check
  // season membership for the SAME season the calendars were fetched for.
  const season = currentSeason(deps);
  // The stream's opening event: emitted AFTER the claim, so a sweep that never
  // started never announces one, and BEFORE any player event, so a presenter
  // always knows the denominator of `index/total` from the first player on.
  safeEmit(deps.onProgress, {
    kind: "sweep-started", runId, playersTotal: activePlayers.length, season,
  });
  try {
    // getSeason failures are caught inside refreshCalendars and returned; a
    // calendar DB-WRITE failure is NOT — it escapes to the outer catch (MF1).
    const fence: IngestionFence = { kind: "whole-refresh", runId, now: now() };
    safeEmit(deps.onProgress, { kind: "phase-started", phase: "calendars" });
    calendarFailures = await refreshCalendars(deps, season, fence);
    safeEmit(deps.onProgress, {
      kind: "phase-finished", phase: "calendars", failures: calendarFailures.length,
    });
    safeEmit(deps.onProgress, { kind: "phase-started", phase: "ncaa-calendar" });
    // The SAME scoped set again (#192): the NCAA calendar row is seeded only
    // when a watched NCAA player is in THIS sweep, so a lane with no NCAA player
    // does not seed one on another lane's behalf.
    await refreshNcaaCalendar(deps, season, activePlayers, fence);
    // The NCAA calendar is seeded from bundled dates, never fetched, so it has
    // no failure to collect; a missing bundled year is a `notice`, not a failure.
    safeEmit(deps.onProgress, { kind: "phase-finished", phase: "ncaa-calendar", failures: 0 });

    safeEmit(deps.onProgress, { kind: "phase-started", phase: "players" });
    let playerIndex = 0;
    for (const player of activePlayers) {
      playerIndex += 1;
      // Carried EXPLICITLY on every event about this player, including his
      // calls, so a presenter never infers association from event ordering.
      const ref: PlayerRef = {
        playerId: player.id,
        name: player.fullName,
        index: playerIndex,
        total: activePlayers.length,
      };
      // Renew + ownership check BEFORE this player's fetch/write (ADR 0043
      // fencing). A healthy long sweep keeps its lease live here; a run whose
      // lease expired was reaped `failed` by the successor that took over, so
      // renew returns false and we ABORT the sweep immediately — never settling
      // this run (the successor already marked it `failed`) and never letting a
      // stale write past this point. Any stale write is thus bounded to at most
      // the single player already in flight, which the successor re-fetches.
      //
      // This ownership check stays OUTSIDE the per-player try/catch: a
      // `superseded` abort is NOT a player failure — it must early-return, not
      // be collected and counted against the run.
      if (!renewRefreshRun(db, runId, now())) {
        safeEmit(deps.onProgress, { kind: "sweep-superseded", at: "renew" });
        return {
          skipped: true,
          reason: "superseded",
          status: null,
          playersRefreshed,
          statLinesInserted: inserted,
          statLinesUpdated: updated,
          playersSkipped,
          playersFailed: playerFailures.length,
          calendarFailures,
          playerFailures,
          runId,
        };
      }
      safeEmit(deps.onProgress, { kind: "player-started", player: ref });
      const playerStartedMs = now().getTime();
      // The settled event is BUILT here but HELD until the progress write below
      // commits — see the emit at the bottom of the loop.
      let settledEvent: PlayerSettledEvent;
      // Per-player boundary (#23): one player's fetch/write throw is collected
      // as a failure and the sweep CONTINUES to the next player, rather than
      // stranding the run. refreshOnePlayer buffers all HTTP before its atomic
      // write, so a throw leaves no partial write for this player.
      try {
        const result = await refreshOnePlayer(deps, player, season, { kind: "whole-refresh", runId, now: now() }, ref);
        if (result === null) {
          playersSkipped += 1;
          settledEvent = {
            kind: "player-settled", player: ref, outcome: "passed-over",
            elapsedMs: now().getTime() - playerStartedMs,
            counts: { refreshed: playersRefreshed, passedOver: playersSkipped, failed: playerFailures.length },
          };
        } else {
          playersRefreshed += 1;
          inserted += result.inserted;
          updated += result.updated;
          settledEvent = {
            kind: "player-settled", player: ref, outcome: "refreshed",
            inserted: result.inserted, updated: result.updated,
            elapsedMs: now().getTime() - playerStartedMs,
            counts: { refreshed: playersRefreshed, passedOver: playersSkipped, failed: playerFailures.length },
          };
        }
      } catch (err) {
        if (err instanceof RefreshFenceLostError) {
          safeEmit(deps.onProgress, { kind: "sweep-superseded", at: "player-fence" });
          return {
            skipped: true, reason: "superseded", status: null, playersRefreshed, statLinesInserted: inserted,
            statLinesUpdated: updated, playersSkipped, playersFailed: playerFailures.length, calendarFailures, playerFailures, runId,
          };
        }
        playerFailures.push({
          playerId: player.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        // Deliberately NO inserted/updated: refreshOnePlayer buffers all HTTP
        // before its single atomic write, so a throw leaves no partial write —
        // reporting `0` would read as "wrote nothing" rather than "never got there".
        settledEvent = {
          kind: "player-settled", player: ref, outcome: "failed",
          reason: err instanceof Error ? err.message : String(err),
          elapsedMs: now().getTime() - playerStartedMs,
          counts: { refreshed: playersRefreshed, passedOver: playersSkipped, failed: playerFailures.length },
        };
      }

      // Persist only completed work, after the player's atomic write or its
      // collected skip/failure. A crash in this narrow window can under-report
      // only an abandoned running row; it can never overstate committed data.
      // A successor reaps this row before creating its own, so a false result
      // means this worker lost ownership and must not start another player.
      if (!updateRefreshRunProgress(db, runId, {
        playersRefreshed,
        playersSkipped,
        playersFailed: playerFailures.length,
        playersTotal: activePlayers.length,
        statLinesInserted: inserted,
        statLinesUpdated: updated,
      })) {
        safeEmit(deps.onProgress, { kind: "sweep-superseded", at: "progress" });
        return {
          skipped: true,
          reason: "superseded",
          status: null,
          playersRefreshed,
          statLinesInserted: inserted,
          statLinesUpdated: updated,
          playersSkipped,
          playersFailed: playerFailures.length,
          calendarFailures,
          playerFailures,
          runId,
        };
      }
      // ORDERING INVARIANT (ADR 0056 s2). `player-settled` fires ONLY after the
      // progress write has committed, so the console counter can never run ahead
      // of `/health`: the printed tally and the persisted one derive from the
      // same committed fact, not from two counters kept in step by hand. A lost
      // fence above returns WITHOUT emitting, so the last thing an operator sees
      // is `player-started(N)` then `superseded` — never a settled player the
      // database does not know about.
      safeEmit(deps.onProgress, settledEvent);
    }
    safeEmit(deps.onProgress, {
      kind: "phase-finished", phase: "players", failures: playerFailures.length,
    });

    // A calendar failure BLOCKS `fresh` (P1) only when it would leave the digest
    // silently incomplete: a getSeason FETCH threw for a sport that — judged
    // against the POST-refresh state — a watched player is at, and no calendar row
    // with USABLE dates exists to fall back on. The digest reads a player's CURRENT
    // level and calls isInSeason, which returns false when the calendar row is
    // missing OR lacks a start/end; so those idle players would be dropped with no
    // warning, and such a run must settle at least `partial`.
    //
    // These reads are re-run at settle time (post-refresh): loadActivePlayers so a
    // call-up/demotion during the sweep is reflected in the watched sportIds, and
    // loadCalendars so a sportId that DID refresh is not counted stale. They live
    // INSIDE this try so a fallible DB read that throws (I/O error, closed
    // connection) is caught by the MF1 boundary below — settled `failed` and
    // re-thrown — rather than stranding the run `running` past its lease. Only a
    // sport in calendarFailures (an actual fetch throw) can block — a getSeason
    // that returned null (unpublished season) is not a failure and never blocks.
    // NCAA (sportId 22) is seeded from bundled dates, never fetched here, so it
    // never appears in calendarFailures and is unaffected.
    //
    // SELECTION SITE 2 (#192), and TWO properties have to hold at once. It is
    // LANE-SCOPED by the same `deps.scope?.listIds` site 1 used, or an off-lane
    // player at a calendar-failed sport downgrades a clean lane run to `partial`
    // — a completeness warning about data this run never claimed. And it still
    // RE-QUERIES the database rather than reusing the array above: the scope
    // narrows WHICH players are read, it does not FREEZE the set, so a mid-sweep
    // call-up or lane addition is still reflected in the watched sportIds.
    // Scoping without re-reading, or re-reading without scoping, each looks
    // correct and each is wrong in one direction; both are pinned by tests.
    const finalPlayers = await loadActivePlayers(db, deps.scope?.listIds);
    const finalCalendars = await loadCalendars(db);
    const watchedSportIds = new Set(
      finalPlayers.map((p) => sportIdForPlayer(p)).filter((id): id is number => id !== null),
    );
    const failedSportIds = new Set(calendarFailures.map((f) => f.sportId));
    const calendarBlocksFresh = [...watchedSportIds].some(
      (sportId) =>
        failedSportIds.has(sportId) &&
        !finalCalendars.some(
          (c) => c.sportId === sportId && c.season === season && calendarHasUsableDates(c),
        ),
    );

    // Status from the collected counts (#23): `ok` only when nothing failed,
    // nothing was skipped, AND no calendar failure blocks `fresh`; `failed` only
    // when a blocked run refreshed nobody; else `partial` (safe partial success).
    // errorMessage is composed from the failures INDEPENDENT of status (MF2), so
    // an `ok` run that hit a (cached-fallback) calendar failure still records it,
    // and a skip-only `partial` records null.
    status = deriveRefreshStatus({
      refreshed: playersRefreshed,
      skipped: playersSkipped,
      failed: playerFailures.length,
      calendarBlocksFresh,
    });
    errorMessage = summarizeRefreshFailures(calendarFailures, playerFailures);
  } catch (err) {
    if (err instanceof RefreshFenceLostError) {
      safeEmit(deps.onProgress, { kind: "sweep-superseded", at: "calendar-fence" });
      return { skipped: true, reason: "superseded", status: null, playersRefreshed, statLinesInserted: inserted,
        statLinesUpdated: updated, playersSkipped, playersFailed: playerFailures.length, calendarFailures, playerFailures, runId };
    }
    // MF1 fatal outer boundary: an UNEXPECTED throw during calendar/player
    // ORCHESTRATION — a calendar DB-upsert error, refreshNcaaCalendar, a
    // renewRefreshRun DB error, or the post-loop settle-time DB reads
    // (loadActivePlayers/loadCalendars) — is not a collected failure. Record it on
    // the run's own row (ownership-conditional, so a double-settle is a safe
    // no-op) and RE-THROW, so a genuinely broken sweep never strands its row
    // `running` and the caller still sees the throw. NOTE the TERMINAL settle
    // below sits OUTSIDE this try: if IT throws, this catch does NOT run — that
    // narrow window is backstopped by the lease-reap in claimRefreshRun (a later
    // run reaps the stranded `running` row once its lease expires), not by here.
    settleRefreshRun(db, {
      runId,
      now: now(),
      status: "failed",
      counts: {
        playersRefreshed,
        // Carried here too, or a fatal run would report `skipped=0 failed=0`
        // while its own errorMessage says otherwise.
        playersSkipped,
        playersFailed: playerFailures.length,
        playersTotal: activePlayers.length,
        statLinesInserted: inserted,
        statLinesUpdated: updated,
      },
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Terminal settle uses the status/errorMessage computed INSIDE the try above.
  const settled = settleRefreshRun(db, {
    runId,
    now: now(),
    status,
    counts: {
      playersRefreshed,
      playersSkipped,
      playersFailed: playerFailures.length,
      playersTotal: activePlayers.length,
      statLinesInserted: inserted,
      statLinesUpdated: updated,
    },
    errorMessage,
  });
  // The settle is conditional on still owning the row. If it changed nothing, a
  // successor reaped this run while it awaited the LAST player's refresh — the
  // one window the per-iteration renew above cannot cover — so it lost ownership
  // mid-final-write and must NOT claim success. Report `superseded`, exactly like
  // a mid-loop loss; the successor's row is the freshness winner.
  if (!settled) {
    safeEmit(deps.onProgress, { kind: "sweep-superseded", at: "settle" });
    return {
      skipped: true,
      reason: "superseded",
      status: null,
      playersRefreshed,
      statLinesInserted: inserted,
      statLinesUpdated: updated,
      playersSkipped,
      playersFailed: playerFailures.length,
      calendarFailures,
      playerFailures,
      runId,
    };
  }

  // The SAME field set the terminal `refresh done` line prints, emitted only on
  // the one path that actually settled a terminal status.
  safeEmit(deps.onProgress, {
    kind: "sweep-finished",
    status,
    playersRefreshed,
    playersSkipped,
    playersFailed: playerFailures.length,
    playersTotal: activePlayers.length,
    statLinesInserted: inserted,
    statLinesUpdated: updated,
  });

  return {
    skipped: false,
    reason: null,
    status,
    playersRefreshed,
    statLinesInserted: inserted,
    statLinesUpdated: updated,
    playersSkipped,
    playersFailed: playerFailures.length,
    calendarFailures,
    playerFailures,
    runId,
  };
}

/** A skip/no-op summary (offseason / already-running): recorded nothing, failed nothing. */
function skippedSummary(
  reason: "offseason-sleep" | "already-running",
  runId: number | null,
): RefreshSummary {
  return {
    skipped: true,
    reason,
    status: null,
    playersRefreshed: 0,
    statLinesInserted: 0,
    statLinesUpdated: 0,
    playersSkipped: 0,
    playersFailed: 0,
    calendarFailures: [],
    playerFailures: [],
    runId,
  };
}

export function currentSeason(deps: Pick<RefreshDeps, "now" | "tz">): string {
  return hostDate(deps.now(), deps.tz).slice(0, 4);
}

/**
 * Fetch and cache season dates for every swept sportId (skipping unpublished
 * seasons). A `getSeason` fetch that THROWS is collected as a
 * {@link CalendarFailure} and the sweep moves on to the next sportId, leaving
 * that sportId's cached `season_calendar` row untouched (#23) — Refresh reads
 * the cached calendar, so a stale row is a tolerable degradation, not a blocker.
 * A calendar DB-WRITE failure is deliberately NOT caught: it escapes to the
 * runRefresh outer boundary (MF1) rather than being silently swallowed.
 */
export async function refreshCalendars(
  deps: RefreshDeps,
  season: string,
  fence?: IngestionFence,
): Promise<CalendarFailure[]> {
  const { db, client, now } = deps;
  const fetchedAt = now().toISOString();
  const failures: CalendarFailure[] = [];
  for (const sportId of SPORT_IDS) {
    let s: Awaited<ReturnType<typeof client.getSeason>>;
    try {
      // `player: null` exactly here: the calendar phase runs BEFORE the loop, so
      // these calls belong to no player and must never be attributed to one.
      s = await timedCall(deps, null, { call: "getSeason", sportId }, () => client.getSeason(sportId, season));
    } catch (err) {
      failures.push({ sportId, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (s === null) continue;
    guardedWrite(db, fenceAtWrite(fence, now()), (tx) => tx
      .insert(seasonCalendar)
      .values({
        sportId,
        season,
        regularSeasonStart: s.regularSeasonStartDate ?? null,
        regularSeasonEnd: s.regularSeasonEndDate ?? null,
        postSeasonStart: s.postSeasonStartDate ?? null,
        postSeasonEnd: s.postSeasonEndDate ?? null,
        springStart: s.springStartDate ?? null,
        springEnd: s.springEndDate ?? null,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: [seasonCalendar.sportId, seasonCalendar.season],
        set: {
          regularSeasonStart: s.regularSeasonStartDate ?? null,
          regularSeasonEnd: s.regularSeasonEndDate ?? null,
          postSeasonStart: s.postSeasonStartDate ?? null,
          postSeasonEnd: s.postSeasonEndDate ?? null,
          springStart: s.springStartDate ?? null,
          springEnd: s.springEndDate ?? null,
          fetchedAt,
        },
      }).run());
  }
  return failures;
}

/**
 * Seed the sportId 22 (NCAA) season_calendar row from the bundled dates
 * (ADR 0032) when at least one active NCAA Player is watched. No bundled entry
 * for the year → no row, logged loudly, and NCAA is treated as not In Season.
 */
export async function refreshNcaaCalendar(
  deps: RefreshDeps,
  season: string,
  activePlayers: PlayerRow[],
  fence?: IngestionFence,
): Promise<void> {
  const watchingNcaa = activePlayers.some((p) => p.level === "ncaa");
  if (!watchingNcaa) return;

  const entry = ncaaSeasonFor(season);
  if (entry === null) {
    emitNotice(deps, { code: "ncaa-season-missing", season });
    return;
  }

  const fetchedAt = deps.now().toISOString();
  guardedWrite(deps.db, fenceAtWrite(fence, deps.now()), (tx) => tx
    .insert(seasonCalendar)
    .values({
      sportId: NCAA_SPORT_ID,
      season,
      regularSeasonStart: entry.regularSeasonStart,
      regularSeasonEnd: entry.regularSeasonEnd,
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [seasonCalendar.sportId, seasonCalendar.season],
      set: {
        regularSeasonStart: entry.regularSeasonStart,
        regularSeasonEnd: entry.regularSeasonEnd,
        fetchedAt,
      },
    }).run());
}

/** Dispatch one active Player to the right ingest path; null = skipped. */
/**
 * Days after the bundled NCAA regular-season end during which Refresh keeps
 * re-fetching, so late official-scorer corrections still land (ADR 0030's
 * quiet-correction rule). Past this window the NCAA scrape is a guaranteed
 * no-op until next season, so it is skipped with zero HTTP.
 */
const NCAA_POST_SEASON_GRACE_DAYS = 7;

/** True once the host date is past the bundled NCAA season end + grace window. */
export function ncaaSeasonOver(deps: Pick<RefreshDeps, "now" | "tz">, season: string): boolean {
  const entry = ncaaSeasonFor(season);
  if (entry === null) return false; // handled by the bundled-season guard
  const today = hostDate(deps.now(), deps.tz);
  const end = new Date(`${entry.regularSeasonEnd}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return false;
  end.setUTCDate(end.getUTCDate() + NCAA_POST_SEASON_GRACE_DAYS);
  return today > end.toISOString().slice(0, 10);
}

async function refreshOnePlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: string,
  fence?: IngestionFence,
  ref?: PlayerRef,
): Promise<{ inserted: number; updated: number } | null> {
  if (player.level === "ncaa") {
    if (player.ncaaPlayerSeq === null) return null; // defensive: no identity to fetch
    if (ncaaSeasonFor(season) === null) {
      // No bundled season lookup: skip entirely (zero HTTP), logged by refreshNcaaCalendar.
      return null;
    }
    if (ncaaSeasonOver(deps, season)) {
      // NCAA season is over (past regular-season end + grace) while MLB keeps the
      // pipeline awake — nothing new to scrape until next season (issue #15).
      return null;
    }
    // NCAA HTML is historical data only. Operational refresh has exactly one
    // provider: Highlightly. An unattached legacy row is deliberately reported
    // as migration-required instead of silently spending a browser scrape.
    if (
      player.ncaaSourceState === "highlightly_active" ||
      player.ncaaSourceState === "highlightly_pending"
    ) {
      return refreshHighlightlyNcaaPlayer(deps, player, Number(season), fence, ref);
    }
    throw new HighlightlyMigrationRequiredError();
  }
  if (player.externalId === null) return null;
  return refreshPlayer(deps, player, season, fence, ref);
}

type HighlightlyBox = Array<{ teamId: number | null; players: HighlightlyPlayer[] }>;

/**
 * Ingest an explicitly attached Highlightly player.  HTTP/cache work happens
 * before the write transaction.  Thus a legacy player remains wholly legacy
 * while pending; a complete backfill installs the new batting/pitching set and
 * activates the provider identity atomically.
 */
export async function refreshHighlightlyNcaaPlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: number,
  fence?: IngestionFence,
  ref?: PlayerRef,
): Promise<{ inserted: number; updated: number }> {
  if (player.highlightlyPlayerId === null || player.highlightlyTeamId === null) {
    throw new HighlightlyMigrationRequiredError();
  }
  if (deps.highlightlyClient === undefined) throw new HighlightlyMigrationRequiredError();
  const highlightlyClient = deps.highlightlyClient;
  const highlightlyTeamId = player.highlightlyTeamId;
  // Null on the targeted single-player path, which has no position in a sweep.
  const callRef = ref ?? null;

  const timestamp = deps.now().toISOString();
  const schedule = await timedCall(
    deps, callRef,
    { call: "getFinalTeamMatches", teamId: highlightlyTeamId, season },
    () => highlightlyClient.getFinalTeamMatches(highlightlyTeamId, season),
  );
  const rows: NewStatLineRow[] = [];
  for (const match of schedule.value) {
    guardedWrite(deps.db, fenceAtWrite(fence, deps.now()), (tx) => tx
      .insert(highlightlyMatchCache)
      .values({
        matchId: match.id,
        season,
        payload: match,
        complete: true,
        rateRemaining: schedule.remaining,
        fetchedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: highlightlyMatchCache.matchId,
        set: { season, payload: match, complete: true, rateRemaining: schedule.remaining, fetchedAt: timestamp },
      }).run());

    const cached = (await deps.db.select().from(highlightlyBoxScoreCache)
      .where(eq(highlightlyBoxScoreCache.matchId, match.id)))[0];
    let box: HighlightlyBox;
    if (cached?.complete) {
      box = cached.payload as HighlightlyBox;
    } else {
      const fetched = await timedCall(
        deps, callRef,
        { call: "getBoxScore", matchId: match.id },
        () => highlightlyClient.getBoxScore(match.id),
      );
      box = fetched.value;
      guardedWrite(deps.db, fenceAtWrite(fence, deps.now()), (tx) => tx
        .insert(highlightlyBoxScoreCache)
        .values({ matchId: match.id, payload: box, complete: true, rateRemaining: fetched.remaining, fetchedAt: timestamp })
        .onConflictDoUpdate({
          target: highlightlyBoxScoreCache.matchId,
          set: { payload: box, complete: true, rateRemaining: fetched.remaining, fetchedAt: timestamp },
        }).run());
    }
    const providerPlayer = box
      .filter((team) => team.teamId === player.highlightlyTeamId)
      .flatMap((team) => team.players)
      .find((candidate) => candidate.id === player.highlightlyPlayerId);
    // An omitted player from a complete box score is a DNP, not fabricated
    // zeroes. A record for the opponent is never allowed to attach by name.
    if (providerPlayer !== undefined) rows.push(...highlightlyRowsForMatch(player, match, providerPlayer, timestamp));
  }

  const existing = await deps.db
    .select({ gameId: statLines.gameId, statType: statLines.statType })
    .from(statLines)
    .where(and(eq(statLines.playerId, player.id), eq(statLines.source, "highlightly_ncaa")));
  const existingKeys = new Set(existing.map((row) => `${row.gameId}:${row.statType}`));
  const inserted = rows.filter((row) => !existingKeys.has(`${row.gameId}:${row.statType}`)).length;

  guardedWrite(deps.db, fenceAtWrite(fence, deps.now()), (tx) => {
      if (player.ncaaSourceState === "highlightly_pending") {
        tx.delete(statLines)
          .where(and(eq(statLines.playerId, player.id), eq(statLines.source, "ncaa_html_legacy"))).run();
      }
      upsertStatLinesInto(tx, rows);
      tx.update(players)
        .set({ ncaaSourceState: "highlightly_active", updatedAt: timestamp })
        .where(eq(players.id, player.id)).run();
      tx.insert(highlightlyPlayerCursors)
        .values({ playerId: player.id, season, nextMatchDate: null, lastCompleteAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: highlightlyPlayerCursors.playerId,
          set: { season, nextMatchDate: null, lastCompleteAt: timestamp, updatedAt: timestamp },
        }).run();
  });
  syncDerivedTagsBestEffort(deps, player.id);
  return { inserted, updated: rows.length - inserted };
}

function highlightlyRowsForMatch(
  player: PlayerRow,
  match: HighlightlyMatch,
  providerPlayer: HighlightlyPlayer,
  timestamp: string,
): NewStatLineRow[] {
  const gameDate = match.date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    throw new HighlightlyCoverageError(`Highlightly match ${match.id} has an invalid date`);
  }
  const isHome = match.homeTeam.id === player.highlightlyTeamId;
  const ownTeam = isHome ? match.homeTeam : match.awayTeam;
  const opponent = isHome ? match.awayTeam : match.homeTeam;
  return (["Batting", "Pitching"] as const).flatMap((group) => {
    const normalized = normalizeHighlightlyStats(providerPlayer, group);
    // NCAA fielding is deliberately unsupported, and no supplied key is a DNP
    // or unavailable line rather than an all-zero played appearance.
    if (normalized.availableStats.length === 0) return [];
    return [{
      playerId: player.id,
      gameId: match.id,
      source: "highlightly_ncaa" as const,
      statType: group === "Batting" ? "batting" as const : "pitching" as const,
      gameDate,
      gameNumber: 1,
      gameType: "R",
      isHome,
      opponentName: opponent.name,
      teamName: ownTeam.name,
      sportId: NCAA_SPORT_ID,
      leagueName: "NCAA",
      stats: normalized.stats,
      availableStats: normalized.availableStats,
      raw: providerPlayer,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  });
}

/**
 * Refresh one Player: current identity/location first (a call-up CHANGES the
 * row — one Player forever, per the domain model), then the full-season game log
 * at each pair of {@link probePlanFor}'s plan — his current level in all three
 * stat groups, plus every level/group pair his history has already produced
 * (#197, ADR 0060). A player with no history this season still takes the whole
 * 6x3 fan-out. Every probed pair is fetched WHOLE-SEASON: the pruning is in the
 * breadth of the fan-out, never in the dates (ADR 0030).
 */
export async function refreshPlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: string,
  fence?: IngestionFence,
  ref?: PlayerRef,
): Promise<{ inserted: number; updated: number }> {
  const { db, client, now, tz } = deps;
  if (player.externalId === null) {
    throw new Error(`refreshPlayer requires an externalId (player id ${player.id})`);
  }
  const personId = player.externalId;
  // Null on the targeted single-player path, which has no position in a sweep.
  const callRef = ref ?? null;

  // Finality gate (ADR 0040, issue #77): a game whose date is not yet in the
  // past may still be IN PROGRESS. The MLB gameLog split carries no game-status
  // field and updates live, so ingesting a same-day game would store a partial
  // line as if it were final. The Digest only ever reports yesterday, so holding
  // today's games one day costs nothing — the next Refresh re-ingests the
  // now-final line and the ADR 0029 upsert overwrites the row in place.
  const hostToday = hostDate(now(), tz);

  // Buffer ALL network fetches FIRST (#23) — identity (person/team) then every
  // game-log group — into `identity` + `rows`. The atomic write below must never
  // be held open across HTTP I/O.
  const person = await timedCall(
    deps, callRef, { call: "getPerson", personId }, () => client.getPerson(personId),
  );
  const identity: Partial<typeof players.$inferInsert> = {
    fullName: person.fullName,
    updatedAt: now().toISOString(),
  };
  if (person.primaryPosition?.abbreviation !== undefined) {
    identity.position = person.primaryPosition.abbreviation;
  }
  // Where he is TODAY, straight off the identity fetch — the probe plan's anchor.
  // Deliberately the RAW sportId, not a derived level: probePlanFor owns the
  // decision about which sports are swept, and a promotion resolved here is
  // therefore probed in full on this very sweep, not the next one.
  let currentSportId: number | null = null;
  if (person.currentTeam !== undefined) {
    const teamId = person.currentTeam.id;
    const team = await timedCall(
      deps, callRef, { call: "getTeam", teamId }, () => client.getTeam(teamId),
    );
    currentSportId = team.sport.id;
    const info = levelForSportId(team.sport.id);
    if (info !== null && info.level !== "ncaa") {
      identity.level = info.level;
      identity.milbLevel = info.milbLevel;
      identity.teamName = team.name;
    }
  }

  // The seen set (#197, ADR 0060): every (sportId, statType) pair this Player has
  // produced a line at THIS season, on the MLB path. One query, before any game
  // log, so a fault here costs zero game-log HTTP (identity was already fetched).
  //
  // `source` is what keeps a STORED value from minting a REQUEST: another
  // provider's row must never be read back as a level to fetch MLB game logs for,
  // and its sportId alone cannot be relied on to disqualify it. `game_date LIKE
  // '<season>-%'` scopes the set to this season, so last year's levels do not keep
  // a probe alive forever.
  //
  // The sportId `inArray` narrows what SQLite reads; it is NOT the behavioral
  // guard. probePlanFor re-applies the same constraint to its own input BEFORE its
  // emptiness check — that ordering is what makes this copy deletable with no
  // outcome change, and the all-unswept-rows unit case pins it.
  const seen = await db
    .selectDistinct({ sportId: statLines.sportId, statType: statLines.statType })
    .from(statLines)
    .where(
      and(
        eq(statLines.playerId, player.id),
        eq(statLines.source, "mlb_stats_api"),
        inArray(statLines.sportId, [...SPORT_IDS]),
        like(statLines.gameDate, `${season}-%`),
      ),
    );
  const plan = probePlanFor({ seen, currentSportId });
  const probes = plan.kind === "full" ? FULL_FAN_OUT : plan.pairs;

  const rows: NewStatLineRow[] = [];
  for (const { sportId, group } of probes) {
    const log = await timedCall(
      deps, callRef,
      { call: "getGameLog", personId, sportId, statGroup: group },
      () => client.getGameLog({ personId, sportId, group, season }),
    );
    const statType = group === "hitting" ? "batting" : group;
    for (const stat of log.stats) {
      for (const split of stat.splits) {
        if (!isIngestedGameType(split.gameType)) continue;
        if (split.date >= hostToday) continue; // not yet final — see the gate above
        rows.push(splitToRow(player.id, statType, split, now().toISOString()));
      }
    }
  }

  // Insert/update counts (informational): one query preloads this Player's
  // existing line keys, then diff against the buffered rows.
  const existing = await db
    .select({ gameId: statLines.gameId, statType: statLines.statType })
    .from(statLines)
    .where(eq(statLines.playerId, player.id));
  const existingKeys = new Set(existing.map((r) => `${r.gameId}:${r.statType}`));
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const key = `${row.gameId}:${row.statType}`;
    if (existingKeys.has(key)) {
      updated += 1;
    } else {
      inserted += 1;
      existingKeys.add(key);
    }
  }

  // Atomic identity + stat lines (#23): one BEGIN IMMEDIATE transaction, so a
  // throw mid-upsert rolls the identity/location update back with it — a call-up
  // is never recorded without its games, nor vice versa.
  writePlayerRefresh(db, { playerId: player.id, identity, rows }, fenceAtWrite(fence, now()));

  // Identity/location and this player's Stat Lines are now current — re-derive
  // his tags from the single entry point (covers the nightly sweep AND a first
  // Refresh; idempotent, manual tags untouched). Best-effort AFTER the
  // transaction (#23, MF5): a tag-sync failure must not mark the player failed
  // nor corrupt his already-committed identity/stats.
  syncDerivedTagsBestEffort(deps, player.id);
  return { inserted, updated };
}

/**
 * Re-derive one player's tags, swallowing any failure with a stderr diagnostic
 * (#23, MF5). The identity + stat lines are ALREADY committed by
 * {@link writePlayerRefresh}; tag derivation is a downstream convenience, so a
 * failure here must not fail the player nor roll back his refreshed data. The
 * next successful Refresh re-derives and self-heals the tags.
 */
function syncDerivedTagsBestEffort(
  deps: Pick<RefreshDeps, "db" | "now" | "onProgress" | "writeLegacyNotice">,
  playerId: number,
): void {
  try {
    syncDerivedTags(deps.db, playerId, deps.now());
  } catch (err) {
    emitNotice(deps, {
      code: "tag-sync-failed",
      playerId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function splitToRow(
  playerId: number,
  statType: "batting" | "pitching" | "fielding",
  split: GameLogSplit,
  timestamp: string,
): NewStatLineRow {
  return {
    playerId,
    gameId: split.game.gamePk,
    statType,
    gameDate: split.date,
    gameNumber: split.game.gameNumber,
    gameType: split.gameType,
    isHome: split.isHome,
    opponentName: split.opponent?.name ?? null,
    teamName: split.team?.name ?? null,
    sportId: split.sport.id,
    leagueName: split.league?.name ?? null,
    stats: split.stat,
    raw: split,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** The transaction handle drizzle hands a `db.transaction` callback. */
type TxHandle = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A db-or-tx handle: the top-level Db, or a transaction handle. Both share the sync query API. */
type StatLinesDb = Db | TxHandle;

/**
 * The shared chunked upsert on the ADR 0029 key, over EITHER the top-level db or
 * a transaction handle (#23 SC2). On conflict the stat payload is refreshed but
 * created_at is NEVER touched, so a correction updates storage quietly without
 * looking like a new row. Synchronous by construction (the better-sqlite3
 * driver): callers may `await` the wrapper, or call this inside a
 * `db.transaction((tx) => …)` callback with the tx handle. The single conflict
 * set is factored HERE so it is never duplicated between the two callers.
 *
 * There is no longer a reported/unreported stamp to preserve: the Digest
 * selects by date window and writes nothing here (ADR 0035, superseding the
 * novelty model of ADR 0030). A correction simply shows up in the next window
 * that covers its game date.
 */
export function upsertStatLinesInto(db: StatLinesDb, rows: NewStatLineRow[]): void {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    db
      .insert(statLines)
      .values(chunk)
      .onConflictDoUpdate({
        target: [statLines.playerId, statLines.source, statLines.gameId, statLines.statType],
        set: {
          gameDate: sql`excluded.game_date`,
          gameNumber: sql`excluded.game_number`,
          gameType: sql`excluded.game_type`,
          isHome: sql`excluded.is_home`,
          opponentName: sql`excluded.opponent_name`,
          teamName: sql`excluded.team_name`,
          sportId: sql`excluded.sport_id`,
          leagueName: sql`excluded.league_name`,
          stats: sql`excluded.stats`,
          availableStats: sql`excluded.available_stats`,
          raw: sql`excluded.raw`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
  }
}

/**
 * Idempotent chunked upsert on the ADR 0029 key — the top-level wrapper around
 * {@link upsertStatLinesInto}. Kept async so existing `await` callers are
 * unchanged, though the underlying driver is synchronous.
 */
export async function upsertStatLines(db: Db, rows: NewStatLineRow[]): Promise<void> {
  upsertStatLinesInto(db, rows);
}

/**
 * Persist one player's refreshed identity AND stat lines ATOMICALLY (#23): a
 * single `BEGIN IMMEDIATE` transaction does the players identity `UPDATE` then
 * the shared `upsertStatLinesInto` chunked upsert. Either both land or neither
 * does — a game-log throw mid-upsert rolls the identity update back with it, so
 * a call-up/transfer is never recorded without its games (and vice versa). All
 * HTTP I/O MUST be buffered by the caller BEFORE this runs; the transaction
 * never spans a network fetch.
 *
 * When a fence is supplied, its ownership predicate is evaluated in this SAME
 * immediate transaction as the identity and stat-line mutation (ADR 0048).
 */
export function writePlayerRefresh(
  db: Db,
  args: { playerId: number; identity: Partial<typeof players.$inferInsert>; rows: NewStatLineRow[] },
  fence?: IngestionFence,
): void {
  guardedWrite(db, fence, (tx) => {
      tx.update(players).set(args.identity).where(eq(players.id, args.playerId)).run();
      upsertStatLinesInto(tx, args.rows);
  });
}

/**
 * A Player's first Refresh, run at seed time (adding a Player IS his first
 * Refresh) — skipped during Offseason Sleep, exactly like the nightly job.
 *
 * It records NO freshness run (ADR 0043). A freshness run is a claim over the
 * WHOLE watch list — the guarantee the daily Digest gates on; a single-player
 * backfill sweeps one player and would settle a misleading `partial` (one of N
 * refreshed) that has nothing to do with the pipeline's freshness.
 */
export async function runRefreshForPlayer(
  deps: RefreshDeps,
  playerId: number,
): Promise<{
  skipped: boolean;
  /** Distinguishes an offseason no-op from durable sweep serialization. */
  reason: "offseason-sleep" | "whole-refresh-running" | null;
  inserted: number;
  updated: number;
  /**
   * Calendar fetch failures encountered while priming this player's refresh
   * (#23, MF3). Empty on the NCAA path (its calendar is seeded from bundled
   * dates, never fetched) and on a skip; the MLB path surfaces any `getSeason`
   * failure here AND on stderr, so a targeted refresh never reports clean
   * success while the calendar refresh silently failed.
   */
  calendarFailures: CalendarFailure[];
}> {
  const { db, now, tz } = deps;
  // WHOLE-LIST ON PURPOSE, even when `deps.scope` is set (#192, ADR 0061). This
  // read exists only to answer "is the PIPELINE asleep?" before spending a
  // backfill's HTTP, and Offseason Sleep is a host-wide state (ADR 0031). A
  // seed-time backfill is not a lane operation — it targets one Player by id and
  // records no freshness run — so narrowing it to whichever lane a caller
  // happened to pass would make an unrelated lane's levels decide whether a new
  // Player gets his first Refresh.
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  if (sleepWindow(calendars, activePlayers, now(), tz).sleeping) {
    return { skipped: true, reason: "offseason-sleep", inserted: 0, updated: 0, calendarFailures: [] };
  }
  const admission = admitTargetedRefresh(db, now());
  if (!admission.admitted) {
    return { skipped: true, reason: "whole-refresh-running", inserted: 0, updated: 0, calendarFailures: [] };
  }
  const fence = admission.fence;
  const player = (await db.select().from(players).where(eq(players.id, playerId)))[0];
  if (player === undefined) {
    throw new Error(`No player with id ${playerId}`);
  }
  const season = currentSeason(deps);
  if (player.level === "ncaa") {
    try {
      // Configuration is a precondition, not an ingestion side effect. Check it
      // before seeding the NCAA calendar so a rejected targeted refresh leaves
      // every table unchanged.
      if (
        player.ncaaSourceState === "highlightly_active" ||
        player.ncaaSourceState === "highlightly_pending"
      ) {
        if (deps.highlightlyClient === undefined) throw new HighlightlyMigrationRequiredError();
        deps.highlightlyClient.assertConfigured();
      }
      await refreshNcaaCalendar(deps, season, activePlayers, fence);
    if (
      player.ncaaPlayerSeq === null &&
      player.ncaaSourceState !== "highlightly_active" &&
      player.ncaaSourceState !== "highlightly_pending"
    ) {
      return { skipped: false, reason: null, inserted: 0, updated: 0, calendarFailures: [] };
    }
    const ncaaResult =
      player.ncaaSourceState === "highlightly_active" || player.ncaaSourceState === "highlightly_pending"
        ? await refreshHighlightlyNcaaPlayer(deps, player, Number(season), fence)
        : (() => { throw new HighlightlyMigrationRequiredError(); })();
    return { skipped: false, reason: null, ...ncaaResult, calendarFailures: [] };
    } catch (err) {
      if (err instanceof RefreshFenceLostError) return { skipped: true, reason: "whole-refresh-running", inserted: 0, updated: 0, calendarFailures: [] };
      throw err;
    }
  }
  let calendarFailures: CalendarFailure[];
  try {
    calendarFailures = await refreshCalendars(deps, season, fence);
  if (calendarFailures.length > 0) {
    // MF3: do NOT silently swallow a calendar failure on the single-player path.
    // The player still proceeds (he never depended on the DB calendar), but the
    // failure is explicit — returned to the caller AND reported.
    emitNotice(deps, { code: "targeted-calendar-failures", playerId, failures: calendarFailures });
  }
    const result = await refreshPlayer(deps, player, season, fence);
    return { skipped: false, reason: null, ...result, calendarFailures };
  } catch (err) {
    if (err instanceof RefreshFenceLostError) return { skipped: true, reason: "whole-refresh-running", inserted: 0, updated: 0, calendarFailures: [] };
    throw err;
  }
}
