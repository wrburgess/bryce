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

export type WindowSpec = "1d" | "7d" | "14d" | "21d" | "ytd";

export const WINDOW_SPECS: readonly WindowSpec[] = ["1d", "7d", "14d", "21d", "ytd"];

/** Inclusive day counts; `ytd` is anchored on the season start instead. */
const SPAN_DAYS: Readonly<Record<Exclude<WindowSpec, "ytd">, number>> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "21d": 21,
};

export interface ResolvedWindow {
  spec: WindowSpec;
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

/** Calendar-date arithmetic: "2026-03-09" minus 6 days → "2026-03-03". */
function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Noon UTC keeps the arithmetic clear of any timezone's midnight.
  const anchor = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** "2026-07-13" → "Jul 13" */
function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(d);
}

function labelFor(spec: WindowSpec, from: string, to: string): string {
  if (spec === "1d") return shortDate(to);
  if (spec === "ytd") return `Season to Date (${shortDate(from)}-${shortDate(to)})`;
  const days = SPAN_DAYS[spec];
  return `Last ${days} Days (${shortDate(from)}-${shortDate(to)})`;
}

export function resolveWindow(
  spec: WindowSpec,
  now: Date,
  tz: string,
  seasonStart: string | null = null,
): ResolvedWindow {
  const to = shiftDate(hostDate(now, tz), -1);
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
