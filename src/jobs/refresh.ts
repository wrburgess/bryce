import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { NewStatLineRow, PlayerRow } from "../db/schema.js";
import { players, seasonCalendar, statLines } from "../db/schema.js";
import type { CalendarEntry } from "../domain/season.js";
import { hostDate, sleepWindow, sportIdForPlayer } from "../domain/season.js";
import type { MlbClient, StatGroup } from "../mlb/client.js";
import { isIngestedGameType } from "../mlb/gameTypes.js";
import { levelForSportId, NCAA_SPORT_ID, SPORT_IDS } from "../mlb/levels.js";
import type { GameLogSplit } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
import { normalizeGameLog } from "../ncaa/normalize.js";
import { parseGameLogPage } from "../ncaa/parse.js";
import type { NcaaStatCategory } from "../ncaa/seasons.js";
import { ncaaSeasonFor } from "../ncaa/seasons.js";
import { syncDerivedTags } from "../tags/service.js";
import type { RefreshTerminalStatus } from "./refresh-run.js";
import { claimRefreshRun, renewRefreshRun, settleRefreshRun } from "./refresh-run.js";

export interface RefreshDeps {
  db: Db;
  client: MlbClient;
  ncaaClient: NcaaClient;
  now: () => Date;
  tz: string;
}

const NCAA_CATEGORIES: readonly NcaaStatCategory[] = ["batting", "pitching", "fielding"];

/** A swept sportId whose `getSeason` fetch threw (#23): its cached row is left untouched. */
export interface CalendarFailure {
  sportId: number;
  reason: string;
  /**
   * Whether a cached `season_calendar` row for this (sportId, season) ALREADY
   * existed when the fetch threw (P1). When true the digest still has a calendar
   * to judge season membership against — a stale row is a tolerable fallback. When
   * FALSE, no calendar exists for a watched sport, so `isInSeason` returns false
   * and the digest would SILENTLY omit that level's idle players — the run must
   * then settle at least `partial` so the digest carries a freshness warning.
   */
  hadCachedRow: boolean;
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

export async function loadActivePlayers(db: Db): Promise<PlayerRow[]> {
  return db.select().from(players).where(eq(players.active, true));
}

/**
 * The Refresh (ADR 0030): re-ingest every active Player's complete
 * current-season game log and upsert idempotently on the ADR 0029 key.
 * No date windows, ever. During Offseason Sleep the whole job is a no-op —
 * zero API calls (ADR 0031).
 */
export async function runRefresh(deps: RefreshDeps): Promise<RefreshSummary> {
  const { db, now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const sleep = sleepWindow(calendars, activePlayers, now(), tz);
  // Offseason Sleep stays a PURE no-op: it records no run at all, because the
  // weekly heartbeat — not a freshness row — is the offseason liveness signal
  // (ADR 0031/0042). A stale freshness reading during sleep is expected.
  if (sleep.sleeping) {
    return skippedSummary("offseason-sleep", null);
  }

  // Claim a run AFTER the sleep check (ADR 0043). A refusal means another sweep
  // holds a live lease — the wake-time overlap of the launchd job and a manual
  // run — so this one no-ops rather than double-sweeping.
  const claim = claimRefreshRun(db, { now: now(), playersTotal: activePlayers.length });
  if (!claim.claimed) {
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
  try {
    const season = currentSeason(deps);
    // getSeason failures are caught inside refreshCalendars and returned; a
    // calendar DB-WRITE failure is NOT — it escapes to the outer catch (MF1).
    // Pass the start-of-run calendar snapshot so each failure records whether a
    // cached fallback row exists (P1).
    calendarFailures = await refreshCalendars(deps, season, calendars);
    await refreshNcaaCalendar(deps, season, activePlayers);

    for (const player of activePlayers) {
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
      // Per-player boundary (#23): one player's fetch/write throw is collected
      // as a failure and the sweep CONTINUES to the next player, rather than
      // stranding the run. refreshOnePlayer buffers all HTTP before its atomic
      // write, so a throw leaves no partial write for this player.
      try {
        const result = await refreshOnePlayer(deps, player, season);
        if (result === null) {
          playersSkipped += 1;
          continue;
        }
        playersRefreshed += 1;
        inserted += result.inserted;
        updated += result.updated;
      } catch (err) {
        playerFailures.push({
          playerId: player.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // MF1 fatal outer boundary: an UNEXPECTED throw during calendar/player
    // ORCHESTRATION — a calendar DB-upsert error, refreshNcaaCalendar, or a
    // renewRefreshRun DB error — is not a collected failure. Record it on the
    // run's own row (ownership-conditional, so a double-settle is a safe no-op)
    // and RE-THROW, so a genuinely broken sweep never strands its row `running`
    // and the caller still sees the throw. NOTE the TERMINAL settle below sits
    // OUTSIDE this try: if IT throws, this catch does NOT run — that narrow
    // window is backstopped by the lease-reap in claimRefreshRun (a later run
    // reaps the stranded `running` row once its lease expires), not by here.
    settleRefreshRun(db, {
      runId,
      now: now(),
      status: "failed",
      counts: {
        playersRefreshed,
        playersTotal: activePlayers.length,
        statLinesInserted: inserted,
        statLinesUpdated: updated,
      },
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // A calendar failure BLOCKS `fresh` (P1) only when it would leave the digest
  // silently incomplete: the fetch failed for a WATCHED sport AND no cached
  // season_calendar row exists to fall back on. `isInSeason` returns false with
  // no calendar row, so those idle players would be dropped from the digest with
  // no warning — such a run must settle at least `partial`. NCAA (sportId 22) is
  // seeded from bundled dates, never fetched here, so it never appears in
  // calendarFailures and is unaffected.
  const watchedSportIds = new Set(
    activePlayers.map((p) => sportIdForPlayer(p)).filter((id): id is number => id !== null),
  );
  const calendarBlocksFresh = calendarFailures.some(
    (f) => !f.hadCachedRow && watchedSportIds.has(f.sportId),
  );

  // Status from the collected counts (#23): `ok` only when nothing failed, nothing
  // was skipped, AND no calendar failure blocks `fresh`; `failed` only when a
  // blocked run refreshed nobody; else `partial` (safe partial success).
  // errorMessage is composed from the failures INDEPENDENT of status (MF2), so an
  // `ok` run that hit a (cached-fallback) calendar failure still records it, and a
  // skip-only `partial` records null.
  const status = deriveRefreshStatus({
    refreshed: playersRefreshed,
    skipped: playersSkipped,
    failed: playerFailures.length,
    calendarBlocksFresh,
  });
  const errorMessage = summarizeRefreshFailures(calendarFailures, playerFailures);
  const settled = settleRefreshRun(db, {
    runId,
    now: now(),
    status,
    counts: {
      playersRefreshed,
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
 *
 * `cachedCalendars` is the start-of-run snapshot of `season_calendar`; each
 * collected failure records whether a cached row for that (sportId, season)
 * already existed (P1). A failed sportId is never upserted, so the snapshot is
 * an accurate answer to "does the digest still have a calendar to fall back on?".
 */
export async function refreshCalendars(
  deps: RefreshDeps,
  season: string,
  cachedCalendars: CalendarEntry[] = [],
): Promise<CalendarFailure[]> {
  const { db, client, now } = deps;
  const fetchedAt = now().toISOString();
  const failures: CalendarFailure[] = [];
  for (const sportId of SPORT_IDS) {
    let s: Awaited<ReturnType<typeof client.getSeason>>;
    try {
      s = await client.getSeason(sportId, season);
    } catch (err) {
      failures.push({
        sportId,
        reason: err instanceof Error ? err.message : String(err),
        hadCachedRow: cachedCalendars.some((c) => c.sportId === sportId && c.season === season),
      });
      continue;
    }
    if (s === null) continue;
    await db
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
      });
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
): Promise<void> {
  const watchingNcaa = activePlayers.some((p) => p.level === "ncaa");
  if (!watchingNcaa) return;

  const entry = ncaaSeasonFor(season);
  if (entry === null) {
    process.stderr.write(
      `refresh: no bundled NCAA season lookup for year=${season}; ` +
        `NCAA treated as not In Season (update src/ncaa/seasons.ts)\n`,
    );
    return;
  }

  const fetchedAt = deps.now().toISOString();
  await deps.db
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
    });
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
    return refreshNcaaPlayer(deps, player, season);
  }
  if (player.externalId === null) return null;
  return refreshPlayer(deps, player, season);
}

/**
 * Refresh one NCAA Player (ADR 0032): fetch his batting + pitching + fielding
 * game-log pages for the current season, normalize, and upsert idempotently on the ADR
 * 0029 key. Identity (name/school) is refreshed from the page — a transfer
 * CHANGES the row, never creates a second Player. No bundled season for the
 * year → zero HTTP, nothing ingested.
 */
export async function refreshNcaaPlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: string,
): Promise<{ inserted: number; updated: number }> {
  const { db, ncaaClient, now } = deps;
  const seq = player.ncaaPlayerSeq;
  if (seq === null) {
    throw new Error(`refreshNcaaPlayer requires an ncaaPlayerSeq (player id ${player.id})`);
  }
  if (ncaaSeasonFor(season) === null) {
    process.stderr.write(
      `refresh: no bundled NCAA season lookup for year=${season}; ` +
        `skipping NCAA player id=${player.id}\n`,
    );
    return { inserted: 0, updated: 0 };
  }

  // Buffer ALL page fetches FIRST into identity + rows (#23): the atomic write
  // below must never be held open across HTTP I/O.
  const timestamp = now().toISOString();
  const rows: NewStatLineRow[] = [];
  let latestFullName: string | null = null;
  let latestSchoolName: string | null = null;
  for (const category of NCAA_CATEGORIES) {
    const html = await ncaaClient.getGameLogPage(seq, season, category);
    const page = parseGameLogPage(html);
    latestFullName = page.fullName;
    latestSchoolName = page.schoolName;
    rows.push(
      ...normalizeGameLog({ playerId: player.id, seq, category, rows: page.rows, timestamp }),
    );
  }

  // Identity refresh: a name or school change CHANGES the one Player row.
  const identity: Partial<typeof players.$inferInsert> = { updatedAt: timestamp };
  if (latestFullName !== null && latestFullName !== player.fullName) {
    identity.fullName = latestFullName;
  }
  if (latestSchoolName !== null && latestSchoolName !== player.schoolName) {
    identity.schoolName = latestSchoolName;
  }

  // Insert/update counts (informational): read the pre-existing keys, then diff.
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
  // throw mid-upsert rolls the identity update back with it.
  writePlayerRefresh(db, { playerId: player.id, identity, rows });

  // Identity and this NCAA player's Stat Lines are now current — re-derive his
  // tags from the single entry point (idempotent; manual tags untouched).
  // Best-effort AFTER the transaction (#23, MF5): a tag-sync failure must not
  // mark the player failed nor corrupt his already-committed identity/stats.
  syncDerivedTagsBestEffort(deps, player.id);
  return { inserted, updated };
}

/**
 * Refresh one Player: current identity/location first (a call-up CHANGES the
 * row — one Player forever, per the domain model), then the full-season game
 * log across every sportId and every stat group (hitting, pitching, fielding).
 */
export async function refreshPlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: string,
): Promise<{ inserted: number; updated: number }> {
  const { db, client, now, tz } = deps;
  if (player.externalId === null) {
    throw new Error(`refreshPlayer requires an externalId (player id ${player.id})`);
  }

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
  const person = await client.getPerson(player.externalId);
  const identity: Partial<typeof players.$inferInsert> = {
    fullName: person.fullName,
    updatedAt: now().toISOString(),
  };
  if (person.primaryPosition?.abbreviation !== undefined) {
    identity.position = person.primaryPosition.abbreviation;
  }
  if (person.currentTeam !== undefined) {
    const team = await client.getTeam(person.currentTeam.id);
    const info = levelForSportId(team.sport.id);
    if (info !== null && info.level !== "ncaa") {
      identity.level = info.level;
      identity.milbLevel = info.milbLevel;
      identity.teamName = team.name;
    }
  }

  const rows: NewStatLineRow[] = [];
  for (const sportId of SPORT_IDS) {
    for (const group of STAT_GROUPS) {
      const log = await client.getGameLog({
        personId: player.externalId,
        sportId,
        group,
        season,
      });
      const statType = group === "hitting" ? "batting" : group;
      for (const stat of log.stats) {
        for (const split of stat.splits) {
          if (!isIngestedGameType(split.gameType)) continue;
          if (split.date >= hostToday) continue; // not yet final — see the gate above
          rows.push(splitToRow(player.id, statType, split, now().toISOString()));
        }
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
  writePlayerRefresh(db, { playerId: player.id, identity, rows });

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
function syncDerivedTagsBestEffort(deps: Pick<RefreshDeps, "db" | "now">, playerId: number): void {
  try {
    syncDerivedTags(deps.db, playerId, deps.now());
  } catch (err) {
    process.stderr.write(
      `refresh: tag sync failed for player id=${playerId} ` +
        `(identity/stats already committed; will heal next refresh): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
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
        target: [statLines.playerId, statLines.gameId, statLines.statType],
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
 * SCOPE (#23 SC4 / #81): this gives per-player atomicity only. It does NOT close
 * the ingestion-wide write-coordination race tracked by issue #81 — a superseded
 * run whose lease expired can still atomically write an OLDER snapshot after
 * losing ownership. The lease-fencing renew/settle guards (ADR 0043) bound that
 * exposure to a single in-flight player; the full fix is #81, out of scope here.
 */
export function writePlayerRefresh(
  db: Db,
  args: { playerId: number; identity: Partial<typeof players.$inferInsert>; rows: NewStatLineRow[] },
): void {
  db.transaction(
    (tx) => {
      tx.update(players).set(args.identity).where(eq(players.id, args.playerId)).run();
      upsertStatLinesInto(tx, args.rows);
    },
    { behavior: "immediate" },
  );
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
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  if (sleepWindow(calendars, activePlayers, now(), tz).sleeping) {
    return { skipped: true, inserted: 0, updated: 0, calendarFailures: [] };
  }
  const player = (await db.select().from(players).where(eq(players.id, playerId)))[0];
  if (player === undefined) {
    throw new Error(`No player with id ${playerId}`);
  }
  const season = currentSeason(deps);
  if (player.level === "ncaa") {
    await refreshNcaaCalendar(deps, season, activePlayers);
    if (player.ncaaPlayerSeq === null) {
      return { skipped: false, inserted: 0, updated: 0, calendarFailures: [] };
    }
    const ncaaResult = await refreshNcaaPlayer(deps, player, season);
    return { skipped: false, ...ncaaResult, calendarFailures: [] };
  }
  const calendarFailures = await refreshCalendars(deps, season, calendars);
  if (calendarFailures.length > 0) {
    // MF3: do NOT silently swallow a calendar failure on the single-player path.
    // The player still proceeds (he never depended on the DB calendar), but the
    // failure is explicit — returned to the caller AND logged.
    process.stderr.write(
      `refresh: ${calendarFailures.length} calendar fetch(es) failed during single-player ` +
        `refresh of player id=${playerId}: ` +
        calendarFailures.map((f) => `${f.sportId} (${f.reason})`).join("; ") +
        "\n",
    );
  }
  const result = await refreshPlayer(deps, player, season);
  return { skipped: false, ...result, calendarFailures };
}
