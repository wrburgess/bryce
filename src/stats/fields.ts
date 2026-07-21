/**
 * Stat field classification (windowed Digest spec, 2026-07-20).
 *
 * Every key in a gamelog `stat` object belongs to exactly one class, and the
 * classification is what makes aggregation correct:
 *
 *   counter  — sum across games
 *   rate     — RECOMPUTE from summed counters; never sum, never average
 *   innings  — baseball notation ("6.1" is 6 1/3); sum via outs only
 *   excluded — not aggregatable (per-game prose, position codes)
 *
 * Unknown keys classify as `null` and callers exclude them. That is deliberate
 * and follows src/mlb/gameTypes.ts: allowlist, not blocklist. Summing anything
 * numeric would be the worst default available, because every rate field is
 * numeric and would silently produce garbage — a season `avg` in the tens, or
 * an averaged one that looks plausible and is simply wrong.
 */

export type StatType = "batting" | "pitching" | "fielding";
export type FieldClass = "counter" | "rate" | "innings" | "excluded";

const BATTING: Readonly<Record<string, FieldClass>> = {
  airOuts: "counter",
  atBats: "counter",
  atBatsPerHomeRun: "rate",
  avg: "rate",
  babip: "rate",
  baseOnBalls: "counter",
  catchersInterference: "counter",
  caughtStealing: "counter",
  caughtStealingPercentage: "rate",
  doubles: "counter",
  flyOuts: "counter",
  gamesPlayed: "counter",
  groundIntoDoublePlay: "counter",
  groundIntoTriplePlay: "counter",
  groundOuts: "counter",
  groundOutsToAirouts: "rate",
  hitByPitch: "counter",
  hits: "counter",
  homeRuns: "counter",
  intentionalWalks: "counter",
  leftOnBase: "counter",
  numberOfPitches: "counter",
  obp: "rate",
  ops: "rate",
  plateAppearances: "counter",
  rbi: "counter",
  runs: "counter",
  sacBunts: "counter",
  sacFlies: "counter",
  slg: "rate",
  stolenBasePercentage: "rate",
  stolenBases: "counter",
  strikeOuts: "counter",
  summary: "excluded",
  totalBases: "counter",
  triples: "counter",
  // Merged in from the same game's fielding row (ADR 0033).
  errors: "counter",
};

const PITCHING: Readonly<Record<string, FieldClass>> = {
  airOuts: "counter",
  atBats: "counter",
  avg: "rate",
  balks: "counter",
  baseOnBalls: "counter",
  battersFaced: "counter",
  blownSaves: "counter",
  catchersInterference: "counter",
  caughtStealing: "counter",
  caughtStealingPercentage: "rate",
  completeGames: "counter",
  doubles: "counter",
  earnedRuns: "counter",
  era: "rate",
  flyOuts: "counter",
  gamesFinished: "counter",
  gamesPitched: "counter",
  gamesPlayed: "counter",
  gamesStarted: "counter",
  groundIntoDoublePlay: "counter",
  groundOuts: "counter",
  groundOutsToAirouts: "rate",
  hitBatsmen: "counter",
  hitByPitch: "counter",
  hits: "counter",
  hitsPer9Inn: "rate",
  holds: "counter",
  homeRuns: "counter",
  homeRunsPer9: "rate",
  inheritedRunners: "counter",
  inheritedRunnersScored: "counter",
  inningsPitched: "innings",
  intentionalWalks: "counter",
  losses: "counter",
  numberOfPitches: "counter",
  obp: "rate",
  ops: "rate",
  outs: "counter",
  pickoffs: "counter",
  pitchesPerInning: "rate",
  runs: "counter",
  runsScoredPer9: "rate",
  sacBunts: "counter",
  sacFlies: "counter",
  saveOpportunities: "counter",
  saves: "counter",
  shutouts: "counter",
  slg: "rate",
  stolenBasePercentage: "rate",
  stolenBases: "counter",
  strikeOuts: "counter",
  strikePercentage: "rate",
  strikeoutWalkRatio: "rate",
  strikeoutsPer9Inn: "rate",
  strikes: "counter",
  summary: "excluded",
  totalBases: "counter",
  triples: "counter",
  walksPer9Inn: "rate",
  whip: "rate",
  wildPitches: "counter",
  winPercentage: "rate",
  wins: "counter",
};

const FIELDING: Readonly<Record<string, FieldClass>> = {
  assists: "counter",
  catchersInterference: "counter",
  caughtStealing: "counter",
  chances: "counter",
  // Excluded, not rate: an ERA needs earned runs, which the fielding payload
  // never carries (it only has innings). The four classes describe *how to
  // aggregate*, and a rate that cannot be recomputed here is not
  // aggregatable at all — classifying it "rate" would promise a derivation
  // that cannot exist from this table alone.
  catcherERA: "excluded",
  doublePlays: "counter",
  errors: "counter",
  fielding: "rate",
  games: "counter",
  gamesPlayed: "counter",
  gamesStarted: "counter",
  innings: "innings",
  passedBall: "counter",
  pickoffs: "counter",
  position: "excluded",
  putOuts: "counter",
  rangeFactorPer9Inn: "rate",
  rangeFactorPerGame: "rate",
  // Derivable here: both stolenBases and caughtStealing are fielding counters.
  stolenBasePercentage: "rate",
  stolenBases: "counter",
  throwingErrors: "counter",
  triplePlays: "counter",
  wildPitches: "counter",
};

const TABLES: Readonly<Record<StatType, Readonly<Record<string, FieldClass>>>> = {
  batting: BATTING,
  pitching: PITCHING,
  fielding: FIELDING,
};

/** The field's class, or null when the key is unknown (caller excludes it). */
export function classifyField(statType: StatType, key: string): FieldClass | null {
  // Object.hasOwn (not plain indexing, not `in`) matters here: a gamelog key
  // named "toString", "constructor", "valueOf", "hasOwnProperty",
  // "__proto__", or "isPrototypeOf" would otherwise read through the object
  // literal's prototype chain and return a function instead of null, quietly
  // breaking the fail-closed contract every caller relies on. Do not
  // "simplify" this back to `TABLES[statType][key] ?? null`.
  const table = TABLES[statType];
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

function keysOfClass(statType: StatType, wanted: FieldClass): readonly string[] {
  return Object.entries(TABLES[statType])
    .filter(([, cls]) => cls === wanted)
    .map(([key]) => key);
}

export function counterKeys(statType: StatType): readonly string[] {
  return keysOfClass(statType, "counter");
}

export function rateKeys(statType: StatType): readonly string[] {
  return keysOfClass(statType, "rate");
}
