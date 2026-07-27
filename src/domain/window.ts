import { hostDate } from "./season.js";

/**
 * Digest window resolution (windowed Digest spec, 2026-07-20).
 *
 * Every window ends on the LAST COMPLETED host date — yesterday, not today.
 * A digest run at 08:00 covering "today" would be empty every morning, and a
 * run at 23:00 would cover a partial day. Anchoring on yesterday makes the
 * report independent of run hour: 06:00 and 23:00 produce the same output.
 *
 * Date arithmetic runs on the calendar date, never on the Date object's UTC
 * clock — adding "minus six days" to a timestamp breaks across DST, where a
 * local day is 23 or 25 hours long.
 */

/**
 * The supported windows, as a tuple. DECLARATION ORDER IS THE DISPLAY ORDER an
 * operator sees when a bad value is refused. `WindowSpec` derives FROM this
 * array rather than standing beside it (the src/mlb/levels.ts SPORT_IDS
 * pattern), so the list and the type cannot drift, and consumers that need a
 * literal-typed enum — the Zod schemas behind the REST and MCP surfaces — get
 * one without a cast.
 */
export const WINDOW_SPECS = ["1d", "7d", "14d", "21d", "28d", "35d", "60d", "ytd"] as const;

export type WindowSpec = (typeof WINDOW_SPECS)[number];

/**
 * Per-player GAME-COUNT windows (issue #153). Deliberately a SEPARATE tuple from
 * `WINDOW_SPECS`, never merged: a date window is one range applied to every
 * player, a game-count window is a per-player ordered limit, so two players in
 * one report can cover different date spans. Keeping the two sets disjoint is the
 * structural guard against implementing `last10games` as "roughly two weeks"
 * (issue #31 — the most likely silent defect in the feature): the date engine
 * (`resolveWindow`, `SPAN_DAYS`) can never receive a game-count token, because it
 * is not in `WINDOW_SPECS`. These mirror the single-player card's counts
 * (`PLAYER_CARD_WINDOWS = last10/last30`), spelled `…games` on the cohort surface
 * so an operator can tell a cohort game-count report apart from the card.
 */
export const GAME_COUNT_WINDOW_SPECS = ["last10games", "last30games"] as const;

export type GameCountWindowSpec = (typeof GAME_COUNT_WINDOW_SPECS)[number];

/** The full report window vocabulary: a date window OR a per-player game count. */
export type ReportWindowSpec = WindowSpec | GameCountWindowSpec;

/** Narrow a report window to the game-count arm (and off it, for the date engine). */
export function isGameCountSpec(spec: ReportWindowSpec): spec is GameCountWindowSpec {
  return (GAME_COUNT_WINDOW_SPECS as readonly string[]).includes(spec);
}

/** How many distinct games a game-count window keeps per player. */
export function gameCountLimit(spec: GameCountWindowSpec): number {
  return spec === "last10games" ? 10 : 30;
}

/** Body-heading title for a game-count window, e.g. "Last 10 Games". */
export function gameCountTitle(spec: GameCountWindowSpec): string {
  return `Last ${gameCountLimit(spec)} Games`;
}

export function parseReportWindowSpec(raw: string): ReportWindowSpec | null {
  const normalized = raw.trim().toLowerCase();
  return (GAME_COUNT_WINDOW_SPECS as readonly string[]).includes(normalized)
    ? (normalized as GameCountWindowSpec)
    : parseWindowSpec(normalized);
}

/** Inclusive day counts; `ytd` is anchored on the season start instead. */
const SPAN_DAYS: Readonly<Record<Exclude<WindowSpec, "ytd">, number>> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "21d": 21,
  "28d": 28,
  "35d": 35,
  "60d": 60,
};

/**
 * True for windows the extra display-only rates (BB%/K%) are shown on: date
 * windows >= 21 days (21d/28d/35d/60d/ytd), plus `last30games` — thirty games is
 * a large enough sample for a rate to mean something, where ten is not (matching
 * the digest's "a single week's plate appearances are too few" reasoning). ytd is
 * long even when its from..to span is under 21 real days early in a season.
 */
export function isLongWindow(spec: ReportWindowSpec): boolean {
  if (isGameCountSpec(spec)) return spec === "last30games";
  return spec === "ytd" || SPAN_DAYS[spec] >= 21;
}

export interface ResolvedWindow {
  /**
   * The window this report covers — a date window OR a per-player game-count
   * window (issue #153). For a game-count window `from`/`to` are the cohort
   * ENVELOPE (the min/max game date across every selected game), an honest
   * report-level span that is deliberately distinct from each ROW's own span
   * (a game-count row carries its player's real `spanFrom`/`spanTo`).
   */
  spec: ReportWindowSpec;
  /** Inclusive host-timezone start date, YYYY-MM-DD. */
  from: string;
  /** Inclusive host-timezone end date — the last COMPLETED day. */
  to: string;
  label: string;
  groupBy: "game" | "playerLevel";
}

export function parseWindowSpec(raw: string): WindowSpec | null {
  const normalized = raw.trim().toLowerCase();
  return (WINDOW_SPECS as readonly string[]).includes(normalized)
    ? (normalized as WindowSpec)
    : null;
}

/** Calendar-date arithmetic: "2026-03-09" minus 6 days → "2026-03-03".
 * Exported as the one home for this arithmetic — the player card and the
 * game-count engine share it rather than each keeping a private copy. */
export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Noon UTC keeps the arithmetic clear of any timezone's midnight.
  const anchor = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/**
 * The last COMPLETED host date — yesterday, in the host timezone. Every report
 * excludes the in-progress host date so results do not depend on the run hour
 * and never expose a partial day (the windowed-digest and player-card rule,
 * shared here instead of re-derived per caller).
 */
export function lastCompletedHostDate(now: Date, tz: string): string {
  return shiftDate(hostDate(now, tz), -1);
}

/** "2026-07-13" → "Jul 13" */
export function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** Format a date range, collapsing the month if both dates are in the same month. */
export function formatDateRange(from: string, to: string): string {
  const [fromY, fromM] = from.split("-");
  const [toY, toM] = to.split("-");

  // Same month: show month once, then both days
  if (fromY === toY && fromM === toM) {
    const month = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
    }).format(new Date(`${from}T12:00:00Z`));
    const fromDay = String(Number(from.slice(8)));
    const toDay = String(Number(to.slice(8)));
    return `${month} ${fromDay}-${toDay}`;
  }

  // Different months: show both dates with their months
  return `${shortDate(from)}-${shortDate(to)}`;
}

function labelFor(spec: WindowSpec, from: string, to: string): string {
  if (spec === "1d") return shortDate(to);
  const range = formatDateRange(from, to);
  if (spec === "ytd") return `Season to Date (${range})`;
  const days = SPAN_DAYS[spec];
  return `Last ${days} Days (${range})`;
}

export function resolveWindow(
  spec: WindowSpec,
  now: Date,
  tz: string,
  seasonStart: string | null = null,
  /**
   * Anchor the window on this host date instead of `now`. Used to recover a
   * daily digest whose slot is a PAST date: its content is the 1d window ending
   * the day before that slot, not the day before today.
   */
  asOf: string | null = null,
): ResolvedWindow {
  const to = shiftDate(asOf ?? hostDate(now, tz), -1);
  const from =
    spec === "ytd"
      ? (seasonStart ?? `${to.slice(0, 4)}-01-01`)
      : shiftDate(to, -(SPAN_DAYS[spec] - 1));

  return {
    spec,
    from,
    to,
    label: labelFor(spec, from, to),
    groupBy: spec === "1d" ? "game" : "playerLevel",
  };
}
