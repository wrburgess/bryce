import { ipToOuts } from "../digest/rates.js";
import type { StatType } from "./fields.js";
import { classifyField, counterKeys, rateKeys } from "./fields.js";

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

/**
 * Rate derivation. Every formula reads SUMMED counters and SUMMED outs — that
 * is the whole point. A rate averaged across games over-weights low-denominator
 * games (a 1-for-1 pinch-hit appearance moving a season line as much as an
 * 0-for-5 start), and stays inside a plausible range while doing it, which is
 * what makes the mistake hard to see.
 *
 * A zero denominator renders "-", matching src/digest/rates.ts.
 */

/** Three decimals, leading zero stripped: 0.31 → ".310"; 1.2 → "1.200". */
function slash(value: number): string {
  const text = value.toFixed(3);
  return text.startsWith("0.") ? text.slice(1) : text;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** numerator per nine innings, from summed outs. */
function per9(numerator: number, outs: number | null): number | null {
  return outs === null || outs === 0 ? null : (numerator * 27) / outs;
}

/** numerator per single inning (outs / 3), from summed outs. */
function perInning(numerator: number, outs: number | null): number | null {
  return outs === null || outs === 0 ? null : (numerator * 3) / outs;
}

type Formula = (agg: Aggregate) => string;

const fixed =
  (digits: number, compute: (agg: Aggregate) => number | null): Formula =>
  (agg) => {
    const value = compute(agg);
    return value === null ? "-" : value.toFixed(digits);
  };

const slashLine =
  (compute: (agg: Aggregate) => number | null): Formula =>
  (agg) => {
    const value = compute(agg);
    return value === null ? "-" : slash(value);
  };

const c = (agg: Aggregate, key: string): number => agg.counters[key] ?? 0;

const onBase = (agg: Aggregate): number | null =>
  ratio(
    c(agg, "hits") + c(agg, "baseOnBalls") + c(agg, "hitByPitch"),
    c(agg, "atBats") + c(agg, "baseOnBalls") + c(agg, "hitByPitch") + c(agg, "sacFlies"),
  );

const slugging = (agg: Aggregate): number | null => ratio(c(agg, "totalBases"), c(agg, "atBats"));

/** Formulas shared by batting and pitching (pitching's are "against" versions). */
const SHARED: Readonly<Record<string, Formula>> = {
  avg: slashLine((a) => ratio(c(a, "hits"), c(a, "atBats"))),
  obp: slashLine(onBase),
  slg: slashLine(slugging),
  ops: slashLine((a) => {
    const o = onBase(a);
    const s = slugging(a);
    return o === null || s === null ? null : o + s;
  }),
  stolenBasePercentage: slashLine((a) =>
    ratio(c(a, "stolenBases"), c(a, "stolenBases") + c(a, "caughtStealing")),
  ),
  caughtStealingPercentage: slashLine((a) =>
    ratio(c(a, "caughtStealing"), c(a, "stolenBases") + c(a, "caughtStealing")),
  ),
  groundOutsToAirouts: fixed(2, (a) => ratio(c(a, "groundOuts"), c(a, "airOuts"))),
};

const BATTING_RATES: Readonly<Record<string, Formula>> = {
  ...SHARED,
  babip: slashLine((a) =>
    ratio(
      c(a, "hits") - c(a, "homeRuns"),
      c(a, "atBats") - c(a, "strikeOuts") - c(a, "homeRuns") + c(a, "sacFlies"),
    ),
  ),
  atBatsPerHomeRun: fixed(2, (a) => ratio(c(a, "atBats"), c(a, "homeRuns"))),
};

const PITCHING_RATES: Readonly<Record<string, Formula>> = {
  ...SHARED,
  era: fixed(2, (a) => per9(c(a, "earnedRuns"), a.outs)),
  whip: fixed(2, (a) =>
    a.outs === null || a.outs === 0
      ? null
      : ((c(a, "baseOnBalls") + c(a, "hits")) * 3) / a.outs,
  ),
  hitsPer9Inn: fixed(2, (a) => per9(c(a, "hits"), a.outs)),
  homeRunsPer9: fixed(2, (a) => per9(c(a, "homeRuns"), a.outs)),
  runsScoredPer9: fixed(2, (a) => per9(c(a, "runs"), a.outs)),
  strikeoutsPer9Inn: fixed(2, (a) => per9(c(a, "strikeOuts"), a.outs)),
  walksPer9Inn: fixed(2, (a) => per9(c(a, "baseOnBalls"), a.outs)),
  // Pitches per SINGLE inning (not per 9) — deliberately perInning(), not per9().
  // per9() here would return raw numberOfPitches unchanged whenever outs === 27
  // (100 pitches over exactly 9 innings would render "100.00" pitches/inning
  // instead of ~11.11), a 9x error masked by staying in a plausible-looking range.
  pitchesPerInning: fixed(2, (a) => perInning(c(a, "numberOfPitches"), a.outs)),
  strikePercentage: slashLine((a) => ratio(c(a, "strikes"), c(a, "numberOfPitches"))),
  strikeoutWalkRatio: fixed(2, (a) => ratio(c(a, "strikeOuts"), c(a, "baseOnBalls"))),
  winPercentage: slashLine((a) => ratio(c(a, "wins"), c(a, "wins") + c(a, "losses"))),
};

const FIELDING_RATES: Readonly<Record<string, Formula>> = {
  fielding: slashLine((a) =>
    ratio(c(a, "putOuts") + c(a, "assists"), c(a, "putOuts") + c(a, "assists") + c(a, "errors")),
  ),
  rangeFactorPer9Inn: fixed(2, (a) => per9(c(a, "putOuts") + c(a, "assists"), a.outs)),
  rangeFactorPerGame: fixed(2, (a) => ratio(c(a, "putOuts") + c(a, "assists"), a.games)),
  // Derivable here too: stolenBases and caughtStealing are fielding counters
  // (catcher stats). Same formula as the shared batting/pitching version.
  stolenBasePercentage: slashLine((a) =>
    ratio(c(a, "stolenBases"), c(a, "stolenBases") + c(a, "caughtStealing")),
  ),
};

const FORMULAS: Readonly<Record<StatType, Readonly<Record<string, Formula>>>> = {
  batting: BATTING_RATES,
  pitching: PITCHING_RATES,
  fielding: FIELDING_RATES,
};

/** A formatted rate, or "-" when the denominator is zero or the key is unknown. */
export function deriveRate(agg: Aggregate, key: string): string {
  const formula = FORMULAS[agg.statType][key];
  return formula === undefined ? "-" : formula(agg);
}

export function deriveAllRates(agg: Aggregate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of rateKeys(agg.statType)) out[key] = deriveRate(agg, key);
  return out;
}
