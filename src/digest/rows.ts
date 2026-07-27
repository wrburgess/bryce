import type { PlayerRow, StatLineRow } from "../db/schema.js";
import { levelAbbrev, levelRank } from "../mlb/levels.js";
import type { Aggregate } from "../stats/aggregate.js";
import { aggregate } from "../stats/aggregate.js";
import { classifyField } from "../stats/fields.js";
import { ipToOuts, qualityStart } from "./rates.js";
import type { RenderPlayer } from "./render.js";

/**
 * Shared row-building for every aggregated report (the date-window Digest,
 * issue #29, and the cohort game-count report, issue #153). The two engines
 * differ in how they SELECT games and GROUP them, but the per-group roll-up is
 * one correctness-critical body — fielding folds into batting (ADR 0033), PA is
 * derived per game before summing, rates come from summed counters, and QS /
 * relief decisions are COUNTS the summed aggregate cannot recover — so it lives
 * here once rather than being reimplemented per engine (the `tagScopeCondition`
 * "one implementation, two callers" pattern, #140).
 */

export interface Split {
  line: StatLineRow;
  player: PlayerRow;
  stats: Record<string, unknown>;
}

/** A stat value as a number; a missing or non-numeric value is 0. */
export function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Which table a player belongs in. Position is the classification: a pitcher who
 * did not pitch must not render as a batter (0-for-0 reads as a bad week, not
 * "he pitched"), and an unknown position falls to batting, the harmless default.
 * A player belongs to exactly one table even if a game log carries the other
 * stat type.
 */
export function isBatter(player: PlayerRow): boolean {
  return player.position !== "P";
}

/**
 * ADR 0033: a fielding row never renders standalone. Its error count merges into
 * the same (player, game) batting split, synthesizing an all-zero batting split
 * when the player has no batting row for that game. Only `errors` crosses over —
 * the rest of a fielding row is not a batting stat. A pitcher's fielding row
 * belongs to his pitching appearance, not a batting one he never had, so it is
 * not synthesized into the Batters table. Highlightly NCAA carries no fielding
 * contract, so its historical fielding rows never claim a value post-cutover.
 */
export function mergeFieldingIntoBatting(splits: Split[]): Split[] {
  const batting = splits
    .filter((s) => s.line.statType === "batting")
    // Copied, not aliased: the merge below writes `errors`, and the caller still
    // reads the original splits for counts.
    .map((s) => ({ ...s, stats: { ...s.stats } }));
  const byGame = new Map<string, Split>();
  for (const split of batting) {
    byGame.set(`${split.line.playerId}:${split.line.gameId}`, split);
  }
  const pitchedInGame = new Set(
    splits
      .filter((s) => s.line.statType === "pitching")
      .map((s) => `${s.line.playerId}:${s.line.gameId}`),
  );
  for (const split of splits) {
    if (split.line.statType !== "fielding") continue;
    if (split.line.source === "highlightly_ncaa") continue;
    const key = `${split.line.playerId}:${split.line.gameId}`;
    const errors = numberOr0(split.stats.errors);
    const target = byGame.get(key);
    if (target !== undefined) {
      target.stats.errors = errors;
      continue;
    }
    if (pitchedInGame.has(key)) continue;
    const synthesized: Split = { ...split, stats: { errors } };
    byGame.set(key, synthesized);
    batting.push(synthesized);
  }
  return batting;
}

/**
 * PA from the source when present, else AB + BB + HBP — computed PER GAME, before
 * aggregation, because a window SUMS. Deriving it after summing would undercount
 * a window whose games disagree about whether the source reported PA.
 */
export function withPlateAppearances(split: Split): Split {
  if (numberOr0(split.stats.plateAppearances) > 0) return split;
  const derived =
    numberOr0(split.stats.atBats) +
    numberOr0(split.stats.baseOnBalls) +
    numberOr0(split.stats.hitByPitch);
  return derived === 0 ? split : { ...split, stats: { ...split.stats, plateAppearances: derived } };
}

/**
 * The three per-game COUNTS below take a bucket of raw per-game `stats` records
 * rather than `Split[]`, because that is the whole of what they read — no
 * `s.line`, no `s.player`. Signing them at that grain is what lets the Player
 * Card (`src/reports/player-card.ts`, whose bucket is already
 * `Record<string, unknown>[]`) call the SAME implementation the Digest uses
 * instead of re-deriving the math, which would risk diverging on the NCAA
 * fail-closed `gamesStarted` rule below (#141 / ADR 0055 consequence 2).
 */
type StatsBucket = ReadonlyArray<Record<string, unknown>>;

/** An appearance is relief only when gamesStarted is PRESENT and 0. A missing
 * value (NCAA rows have no gamesStarted) is unknown-not-relief, so a starter's
 * decision is never miscounted as relief. Starter decisions are never surfaced. */
export function isReliefAppearance(stats: Record<string, unknown>): boolean {
  const gs = stats.gamesStarted;
  return typeof gs === "number" && Number.isFinite(gs) && gs === 0;
}

/**
 * QS is not a source field — it is computed per game and COUNTED while the
 * per-game rows are still in hand. A window's QS is a count of qualifying games,
 * never a flag: summed outs and summed earned runs cannot recover it.
 */
export function countQualityStarts(bucket: StatsBucket): number {
  return bucket.filter((stats) => {
    const ip = stats.inningsPitched;
    // Same coercion as src/stats/aggregate.ts, so this count and the summed outs
    // it sits beside can never disagree about what an IP value means.
    const outs = ipToOuts(typeof ip === "string" ? ip : String(ip));
    return qualityStart(outs, numberOr0(stats.earnedRuns)) === 1;
  }).length;
}

export function countReliefWins(bucket: StatsBucket): number {
  return bucket.filter((stats) => numberOr0(stats.wins) === 1 && isReliefAppearance(stats)).length;
}

export function countReliefLosses(bucket: StatsBucket): number {
  return bucket.filter((stats) => numberOr0(stats.losses) === 1 && isReliefAppearance(stats)).length;
}

export function toRenderPlayer(player: PlayerRow): RenderPlayer {
  return {
    fullName: player.fullName,
    level: player.level,
    milbLevel: player.milbLevel,
    teamName: player.teamName,
    schoolName: player.schoolName,
  };
}

/**
 * The shared per-group roll-up: the fields a DigestRow carries that are computed
 * purely from a bucket of same-group splits. The caller supplies `player`,
 * `gameNumber`, and (for a game-count report) the per-player span; everything
 * derived from the stats themselves is produced here so no engine reimplements
 * the aggregate / QS / relief math. `lvl` / `lvlRank` come from the FIRST split's
 * sportId + leagueName — the level a game was played at, never `players.level` —
 * so a bucket the caller keyed by (player, sportId, leagueName) yields the honest
 * per-level line.
 */
export interface StatRowCore {
  lvl: string;
  lvlRank: number;
  agg: Aggregate;
  qualityStarts: number;
  reliefWins: number;
  reliefLosses: number;
}

export function buildStatRowCore(bucket: Split[], statType: "batting" | "pitching"): StatRowCore {
  const first = bucket[0]!;
  // The Digest's bucket is Split[]; the counters (and `aggregate`) read only the
  // per-game stats, so this caller projects once and passes that.
  const stats = bucket.map((s) => s.stats);
  return {
    lvl: levelAbbrev(first.line.sportId, first.line.leagueName),
    lvlRank: levelRank(first.line.sportId),
    agg: aggregate(statType, stats),
    qualityStarts: statType === "pitching" ? countQualityStarts(stats) : 0,
    reliefWins: statType === "pitching" ? countReliefWins(stats) : 0,
    reliefLosses: statType === "pitching" ? countReliefLosses(stats) : 0,
  };
}

/**
 * Every unrecognised stat key across the RAW selected lines, deduped and sorted.
 *
 * Computed from the raw splits, NOT the built rows: a fielding split is projected
 * to its error count before aggregation, so an unknown fielding key never reaches
 * a row's aggregate and would be silently dropped — the exact staleness the report
 * exists to surface. Classifying each split by its OWN statType catches batting,
 * pitching and fielding alike.
 */
export function unknownFieldsOf(splits: Split[]): string[] {
  const seen = new Set<string>();
  for (const { line, stats } of splits) {
    for (const key of Object.keys(stats)) {
      if (classifyField(line.statType, key) === null) seen.add(key);
    }
  }
  return [...seen].sort();
}

/** Sort by surname, then first initial, matching the digest's displayed name. */
export function comparePlayerNames(a: string, b: string): number {
  const nameParts = (fullName: string): [surname: string, firstInitial: string] => {
    const parts = fullName.trim().split(/\s+/);
    return parts.length < 2 ? [fullName, ""] : [parts.slice(1).join(" "), parts[0]![0]!];
  };
  const [aSurname, aInitial] = nameParts(a);
  const [bSurname, bInitial] = nameParts(b);
  return aSurname.localeCompare(bSurname) || aInitial.localeCompare(bInitial);
}
