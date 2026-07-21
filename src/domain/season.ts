import type { Level } from "../mlb/levels.js";
import { sportIdForLevel } from "../mlb/levels.js";

/**
 * Season / Offseason Sleep math (ADR 0031). Pure functions over cached season
 * calendars and an injected `now` — never the wall clock.
 *
 * Sleep runs from the end of the World Series (sportId 1 postSeasonEndDate) to
 * the EARLIEST regularSeasonStartDate among WATCHED levels. Spring training
 * never wakes the pipeline.
 */

export interface CalendarEntry {
  sportId: number;
  season: string;
  regularSeasonStart: string | null;
  regularSeasonEnd: string | null;
  postSeasonStart: string | null;
  postSeasonEnd: string | null;
  springStart: string | null;
  springEnd: string | null;
}

export interface WatchedLevel {
  level: Level;
  milbLevel: string | null;
}

export interface SleepState {
  sleeping: boolean;
  /** Earliest watched opening day strictly after today; null when unpublished. */
  nextOpeningDay: string | null;
}

/** YYYY-MM-DD for `now` in the host timezone (en-CA yields ISO date ordering). */
export function hostDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function sportIdForPlayer(player: WatchedLevel): number | null {
  return sportIdForLevel(player.level, player.milbLevel);
}

/**
 * A Player is In Season while his sport still has games left: today is on or
 * after his sport's regular-season start and on or before its last possible
 * game (postseason end, falling back to regular-season end).
 */
export function isInSeason(
  player: WatchedLevel,
  calendars: CalendarEntry[],
  now: Date,
  tz: string,
  /**
   * Judge season membership as of THIS host date instead of `now`. A recovered
   * digest covers a past day, and an idle player's zero row belongs on the
   * report if he was in season THEN — using today would drop a player whose
   * season ended between the covered day and the recovery run.
   */
  asOfDate: string | null = null,
): boolean {
  const sportId = sportIdForPlayer(player);
  if (sportId === null) return false;
  const today = asOfDate ?? hostDate(now, tz);
  return calendars.some((cal) => {
    if (cal.sportId !== sportId) return false;
    const start = cal.regularSeasonStart;
    const end = cal.postSeasonEnd ?? cal.regularSeasonEnd;
    return start !== null && end !== null && today >= start && today <= end;
  });
}

/**
 * Offseason Sleep state for the whole pipeline.
 *
 * Awake window (per calendar year): [earliest watched opening day, MLB World
 * Series end]. The end anchors on sportId 1's postSeasonEnd even when no MLB
 * player is watched (ADR 0031: "sleep = WS end ..."), falling back to the
 * latest watched season end when the MLB calendar is not cached.
 *
 * Fail open: with no calendar data for the current year (first-ever run, or a
 * new year whose calendar was never fetched) the pipeline is treated as awake,
 * so the next Refresh fetches the calendar and the math self-corrects.
 */
export function sleepWindow(
  calendars: CalendarEntry[],
  watched: WatchedLevel[],
  now: Date,
  tz: string,
): SleepState {
  const today = hostDate(now, tz);
  const watchedSportIds = new Set(
    watched.map((w) => sportIdForPlayer(w)).filter((id): id is number => id !== null),
  );

  const nextOpeningDay = earliestWatchedOpeningAfter(calendars, watchedSportIds, today);

  if (watchedSportIds.size === 0) {
    return { sleeping: false, nextOpeningDay };
  }

  const year = today.slice(0, 4);
  const yearEntries = calendars.filter((c) => c.season === year);
  const watchedEntries = yearEntries.filter((c) => watchedSportIds.has(c.sportId));

  const openings = watchedEntries
    .map((c) => c.regularSeasonStart)
    .filter((d): d is string => d !== null);
  if (openings.length === 0) {
    // No calendar knowledge for the current year: fail open (awake).
    return { sleeping: false, nextOpeningDay };
  }
  const awakeStart = openings.reduce((a, b) => (a <= b ? a : b));

  const mlbEntry = yearEntries.find((c) => c.sportId === 1);
  const watchedEnds = watchedEntries
    .map((c) => c.postSeasonEnd ?? c.regularSeasonEnd)
    .filter((d): d is string => d !== null);
  const awakeEnd =
    mlbEntry?.postSeasonEnd ??
    (watchedEnds.length > 0 ? watchedEnds.reduce((a, b) => (a >= b ? a : b)) : null);
  if (awakeEnd === null) {
    return { sleeping: false, nextOpeningDay };
  }

  const sleeping = today < awakeStart || today > awakeEnd;
  return { sleeping, nextOpeningDay };
}

/** Earliest watched opening day strictly after `today`, across every cached season. */
function earliestWatchedOpeningAfter(
  calendars: CalendarEntry[],
  watchedSportIds: ReadonlySet<number>,
  today: string,
): string | null {
  const candidates = calendars
    .filter((c) => watchedSportIds.has(c.sportId))
    .map((c) => c.regularSeasonStart)
    .filter((d): d is string => d !== null && d > today);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a <= b ? a : b));
}
