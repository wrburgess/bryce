import { ipToOuts } from "../digest/rates.js";
import type { StatType } from "./fields.js";
import { classifyField, counterKeys } from "./fields.js";

/**
 * Windowed aggregation over per-game stat objects.
 *
 * Counters sum. Innings sum through OUTS — "6.1" is six innings and one out, so
 * 6.1 + 6.1 is 12.2, which arithmetic gets wrong. Rates are deliberately absent
 * from this structure: they are derived from the sums in deriveRate(), because
 * a stored aggregate rate is a rate someone can accidentally sum.
 */

export interface Aggregate {
  statType: StatType;
  games: number;
  counters: Record<string, number>;
  /** Summed outs; null for a stat type with no innings concept. */
  outs: number | null;
  /** Unknown keys seen and excluded, deduped and sorted. */
  unknownFields: string[];
}

const HAS_INNINGS: Readonly<Record<StatType, string | null>> = {
  batting: null,
  pitching: "inningsPitched",
  fielding: "innings",
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function aggregate(
  statType: StatType,
  stats: ReadonlyArray<Record<string, unknown>>,
): Aggregate {
  const counters: Record<string, number> = {};
  for (const key of counterKeys(statType)) counters[key] = 0;

  const inningsKey = HAS_INNINGS[statType];
  let outs = inningsKey === null ? null : 0;
  const unknown = new Set<string>();

  for (const split of stats) {
    for (const [key, value] of Object.entries(split)) {
      const cls = classifyField(statType, key);
      if (cls === null) {
        unknown.add(key);
        continue;
      }
      if (cls === "counter") {
        counters[key] = (counters[key] ?? 0) + numeric(value);
        continue;
      }
      if (cls === "innings" && outs !== null) {
        outs += ipToOuts(typeof value === "string" ? value : String(value)) ?? 0;
      }
      // "rate" and "excluded" are intentionally dropped: a rate is derived from
      // the sums below, never carried forward from a single game.
    }
  }

  return {
    statType,
    games: stats.length,
    counters,
    outs,
    unknownFields: [...unknown].sort(),
  };
}
