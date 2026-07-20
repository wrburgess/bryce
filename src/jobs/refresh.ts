import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { NewStatLineRow, PlayerRow } from "../db/schema.js";
import { players, seasonCalendar, statLines } from "../db/schema.js";
import type { CalendarEntry } from "../domain/season.js";
import { hostDate, sleepWindow } from "../domain/season.js";
import type { MlbClient, StatGroup } from "../mlb/client.js";
import { isIngestedGameType } from "../mlb/gameTypes.js";
import { levelForSportId, NCAA_SPORT_ID, SPORT_IDS } from "../mlb/levels.js";
import type { GameLogSplit } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
import { normalizeGameLog } from "../ncaa/normalize.js";
import { parseGameLogPage } from "../ncaa/parse.js";
import type { NcaaStatCategory } from "../ncaa/seasons.js";
import { ncaaSeasonFor } from "../ncaa/seasons.js";

export interface RefreshDeps {
  db: Db;
  client: MlbClient;
  ncaaClient: NcaaClient;
  now: () => Date;
  tz: string;
}

const NCAA_CATEGORIES: readonly NcaaStatCategory[] = ["batting", "pitching"];

export interface RefreshSummary {
  skipped: boolean;
  reason: "offseason-sleep" | null;
  playersRefreshed: number;
  statLinesInserted: number;
  statLinesUpdated: number;
}

const STAT_GROUPS: readonly StatGroup[] = ["hitting", "pitching"];
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
  if (sleep.sleeping) {
    return {
      skipped: true,
      reason: "offseason-sleep",
      playersRefreshed: 0,
      statLinesInserted: 0,
      statLinesUpdated: 0,
    };
  }

  const season = currentSeason(deps);
  await refreshCalendars(deps, season);
  await refreshNcaaCalendar(deps, season, activePlayers);

  let playersRefreshed = 0;
  let inserted = 0;
  let updated = 0;
  for (const player of activePlayers) {
    const result = await refreshOnePlayer(deps, player, season);
    if (result === null) continue;
    playersRefreshed += 1;
    inserted += result.inserted;
    updated += result.updated;
  }

  return {
    skipped: false,
    reason: null,
    playersRefreshed,
    statLinesInserted: inserted,
    statLinesUpdated: updated,
  };
}

export function currentSeason(deps: Pick<RefreshDeps, "now" | "tz">): string {
  return hostDate(deps.now(), deps.tz).slice(0, 4);
}

/** Fetch and cache season dates for every swept sportId (skipping unpublished seasons). */
export async function refreshCalendars(deps: RefreshDeps, season: string): Promise<void> {
  const { db, client, now } = deps;
  const fetchedAt = now().toISOString();
  for (const sportId of SPORT_IDS) {
    const s = await client.getSeason(sportId, season);
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
    return refreshNcaaPlayer(deps, player, season);
  }
  if (player.externalId === null) return null;
  return refreshPlayer(deps, player, season);
}

/**
 * Refresh one NCAA Player (ADR 0032): fetch his batting + pitching game-log
 * pages for the current season, normalize, and upsert idempotently on the ADR
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

  const existing = await db
    .select({ gameId: statLines.gameId, statType: statLines.statType })
    .from(statLines)
    .where(eq(statLines.playerId, player.id));
  const existingKeys = new Set(existing.map((r) => `${r.gameId}:${r.statType}`));

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
  await db.update(players).set(identity).where(eq(players.id, player.id));

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
  await upsertStatLines(db, rows);
  return { inserted, updated };
}

/**
 * Refresh one Player: current identity/location first (a call-up CHANGES the
 * row — one Player forever, per the domain model), then the full-season game
 * log across every sportId and both stat groups.
 */
export async function refreshPlayer(
  deps: RefreshDeps,
  player: PlayerRow,
  season: string,
): Promise<{ inserted: number; updated: number }> {
  const { db, client, now } = deps;
  if (player.externalId === null) {
    throw new Error(`refreshPlayer requires an externalId (player id ${player.id})`);
  }

  const person = await client.getPerson(player.externalId);
  const changes: Partial<typeof players.$inferInsert> = {
    fullName: person.fullName,
    updatedAt: now().toISOString(),
  };
  if (person.primaryPosition?.abbreviation !== undefined) {
    changes.position = person.primaryPosition.abbreviation;
  }
  if (person.currentTeam !== undefined) {
    const team = await client.getTeam(person.currentTeam.id);
    const info = levelForSportId(team.sport.id);
    if (info !== null && info.level !== "ncaa") {
      changes.level = info.level;
      changes.milbLevel = info.milbLevel;
      changes.teamName = team.name;
    }
  }
  await db.update(players).set(changes).where(eq(players.id, player.id));

  // One query, not one per split: preload this Player's existing line keys.
  const existing = await db
    .select({ gameId: statLines.gameId, statType: statLines.statType })
    .from(statLines)
    .where(eq(statLines.playerId, player.id));
  const existingKeys = new Set(existing.map((r) => `${r.gameId}:${r.statType}`));

  let inserted = 0;
  let updated = 0;
  const rows: NewStatLineRow[] = [];
  for (const sportId of SPORT_IDS) {
    for (const group of STAT_GROUPS) {
      const log = await client.getGameLog({
        personId: player.externalId,
        sportId,
        group,
        season,
      });
      const statType = group === "hitting" ? "batting" : "pitching";
      for (const stat of log.stats) {
        for (const split of stat.splits) {
          if (!isIngestedGameType(split.gameType)) continue;
          rows.push(splitToRow(player.id, statType, split, now().toISOString()));
        }
      }
    }
  }

  for (const row of rows) {
    const key = `${row.gameId}:${row.statType}`;
    if (existingKeys.has(key)) {
      updated += 1;
    } else {
      inserted += 1;
      existingKeys.add(key);
    }
  }

  await upsertStatLines(db, rows);
  return { inserted, updated };
}

function splitToRow(
  playerId: number,
  statType: "batting" | "pitching",
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

/**
 * Idempotent upsert on the ADR 0029 key. On conflict the stat payload is
 * refreshed but digest_delivery_id and created_at are NEVER touched —
 * corrections update storage quietly and are not re-announced (ADR 0030).
 */
export async function upsertStatLines(db: Db, rows: NewStatLineRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await db
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
      });
  }
}

/**
 * A Player's first Refresh, run at seed time (adding a Player IS his first
 * Refresh) — skipped during Offseason Sleep, exactly like the nightly job.
 */
export async function runRefreshForPlayer(
  deps: RefreshDeps,
  playerId: number,
): Promise<{ skipped: boolean; inserted: number; updated: number }> {
  const { db, now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  if (sleepWindow(calendars, activePlayers, now(), tz).sleeping) {
    return { skipped: true, inserted: 0, updated: 0 };
  }
  const player = (await db.select().from(players).where(eq(players.id, playerId)))[0];
  if (player === undefined) {
    throw new Error(`No player with id ${playerId}`);
  }
  const season = currentSeason(deps);
  if (player.level === "ncaa") {
    await refreshNcaaCalendar(deps, season, activePlayers);
    if (player.ncaaPlayerSeq === null) {
      return { skipped: false, inserted: 0, updated: 0 };
    }
    const ncaaResult = await refreshNcaaPlayer(deps, player, season);
    return { skipped: false, ...ncaaResult };
  }
  await refreshCalendars(deps, season);
  const result = await refreshPlayer(deps, player, season);
  return { skipped: false, ...result };
}
