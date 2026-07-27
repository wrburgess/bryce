import { and, eq, exists, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { listMembers, players, statLines } from "../db/schema.js";
import type { GameCountWindowSpec, ResolvedWindow } from "../domain/window.js";
import { gameCountLimit, gameCountTitle, lastCompletedHostDate } from "../domain/window.js";
import type { TagScope } from "../tags/service.js";
import { tagScopeCondition } from "../tags/service.js";
import type { DigestAssembly, DigestRow } from "./assemble.js";
import type { Split } from "./rows.js";
import {
  asRecord,
  buildStatRowCore,
  comparePlayerNames,
  isBatter,
  mergeFieldingIntoBatting,
  toRenderPlayer,
  unknownFieldsOf,
  withPlateAppearances,
} from "./rows.js";

/**
 * Cohort game-count report assembly (issue #153): all tracked players — or a
 * tag/list-scoped cohort — each aggregated over HIS OWN last N regular-season
 * games. This is a genuinely different query shape from `assembleDigest`, which
 * applies ONE shared date range to every player; here the window is a per-player
 * ordered limit, so two players in one report cover different date spans (issue
 * #31: implementing this as "roughly two weeks" is the defect this engine exists
 * to prevent). It reuses everything the two reports share — the cohort selection
 * helpers, the fielding-fold / PA / aggregate / QS / relief row math (`rows.ts`),
 * and the `DigestAssembly` render contract — and owns only what is genuinely
 * different: the per-player ranked game selection and the per-row provenance.
 *
 * Read-only: it selects and rolls up, and writes nothing.
 */

export interface GameWindowDeps {
  now: () => Date;
  tz: string;
  /** The game-count window: last10games / last30games. */
  spec: GameCountWindowSpec;
  /** Scope to a named list's active members (ADR 0046); intersects a tag scope. */
  listId?: number;
  /** Display name paired with `listId`, carried to the presentation. */
  listName?: string;
  /** Scope to the players matching a tag selector (ADR 0050); intersects a list. */
  tagScope?: TagScope;
}

/** One selected game's row, joined to its player, as the ranked query returns it. */
interface SelectedLine {
  line: typeof statLines.$inferSelect;
  player: PlayerRow;
}

/**
 * The single read that selects every stat-type row for each cohort player's last
 * N distinct games. Exported so a test can `.toSQL()` and EXPLAIN the EXACT
 * statement the engine runs — asserting index use and one-statement-no-N+1
 * against the real query, not a hand-copied lookalike that could drift.
 */
export function rankedGameLinesQuery(
  db: Db,
  args: { limit: number; lastCompleted: string; listId?: number; tagScope?: TagScope },
) {
  // The cohort scope, expressed ONCE as correlated SQL — the same
  // `tagScopeCondition` / list-EXISTS the digest uses, so the two reports can
  // never drift on what a selector means, and neither binds a materialized id
  // list (rules/backend.md: no `IN (...)` for an unbounded set).
  const listCondition =
    args.listId === undefined
      ? undefined
      : exists(
          db
            .select({ x: sql`1` })
            .from(listMembers)
            .where(and(eq(listMembers.listId, args.listId), eq(listMembers.playerId, players.id))),
        );
  const tagCondition =
    args.tagScope === undefined ? undefined : tagScopeCondition(db, args.tagScope.tokens);

  // game_rows: every scoped stat-line, tagged with a WITHIN-GAME rank so we can
  // pick ONE representative row per distinct game. The game's identity is
  // (player, source, game_id) — ADR 0029, and exactly the key `player-card.ts`'s
  // `selectGames` dedups on. `game_date`/`game_number` are attributes of the
  // game, NOT part of its identity: batting/pitching/fielding are fetched as
  // three independent calls (src/jobs/refresh.ts) and a suspended-then-resumed
  // game can carry two dates, so grouping BY date/number would split one game
  // into two — double-counting it and consuming two of the N slots. Ranking the
  // rows and keeping the top one per game picks the representative the way the
  // card does (its first row in game_date/number/id DESC order).
  const gameRows = db.$with("game_rows").as(
    db
      .select({
        playerId: statLines.playerId,
        source: statLines.source,
        gameId: statLines.gameId,
        gameDate: statLines.gameDate,
        gameNumber: statLines.gameNumber,
        id: statLines.id,
        withinGameRank:
          sql<number>`row_number() over (partition by ${statLines.playerId}, ${statLines.source}, ${statLines.gameId} order by ${statLines.gameDate} desc, ${statLines.gameNumber} desc, ${statLines.id} desc)`.as(
            "within_game_rank",
          ),
      })
      .from(statLines)
      .innerJoin(players, eq(players.id, statLines.playerId))
      .where(
        and(
          eq(players.active, true),
          eq(statLines.gameType, "R"),
          lte(statLines.gameDate, args.lastCompleted),
          ...(listCondition !== undefined ? [listCondition] : []),
          ...(tagCondition !== undefined ? [tagCondition] : []),
        ),
      ),
  );

  // ranked: number each player's DISTINCT games (the representative rows,
  // within_game_rank = 1) most-recent-first; the outer query keeps only rn <= N.
  // Ordering on the representative's (game_date DESC, game_number DESC, id DESC)
  // reproduces the single-player card exactly; the id tiebreaker keeps the N
  // boundary deterministic when two games tie on (game_date, game_number).
  const ranked = db.$with("ranked").as(
    db
      .with(gameRows)
      .select({
        playerId: gameRows.playerId,
        source: gameRows.source,
        gameId: gameRows.gameId,
        rn: sql<number>`row_number() over (partition by ${gameRows.playerId} order by ${gameRows.gameDate} desc, ${gameRows.gameNumber} desc, ${gameRows.id} desc)`.as(
          "rn",
        ),
      })
      .from(gameRows)
      .where(eq(gameRows.withinGameRank, 1)),
  );

  // Load every stat-type row (batting/pitching/fielding) for the selected games
  // in ONE statement — the ranked CTE joined back to stat_lines — so there is no
  // query-per-player (rules/backend.md: no N+1). Each selected game has exactly
  // one ranked row (the dedup above), so no stat-line is joined twice.
  return db
    .with(gameRows, ranked)
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(players.id, statLines.playerId))
    .innerJoin(
      ranked,
      and(
        eq(ranked.playerId, statLines.playerId),
        eq(ranked.source, statLines.source),
        eq(ranked.gameId, statLines.gameId),
      ),
    )
    .where(lte(ranked.rn, args.limit));
}

export async function assembleGameWindow(db: Db, deps: GameWindowDeps): Promise<DigestAssembly> {
  const { now, tz } = deps;
  const limit = gameCountLimit(deps.spec);
  // Every report excludes the in-progress host date, so a game-count window is
  // "the last N COMPLETED games" and the result never depends on the run hour.
  const lastCompleted = lastCompletedHostDate(now(), tz);

  const rows: SelectedLine[] = await rankedGameLinesQuery(db, {
    limit,
    lastCompleted,
    listId: deps.listId,
    tagScope: deps.tagScope,
  });

  const splits: Split[] = rows.map(({ line, player }) => ({
    line,
    player,
    stats: asRecord(line.stats),
  }));

  // Same table routing as the digest: a player belongs to exactly one table by
  // his declared position; fielding folds into batting (ADR 0033); PA is derived
  // per game before summing.
  const batting = mergeFieldingIntoBatting(splits)
    .filter((split) => isBatter(split.player))
    .map(withPlateAppearances);
  const pitching = splits.filter(
    (split) => split.line.statType === "pitching" && !isBatter(split.player),
  );

  const batters = buildGameCountRows(batting, "batting");
  const pitchers = buildGameCountRows(pitching, "pitching");

  const window = envelopeWindow(deps.spec, splits, lastCompleted);
  return {
    window,
    listName: deps.listName,
    tagSelector: deps.tagScope?.label,
    batters,
    pitchers,
    playerCount: new Set(splits.map((s) => s.player.id)).size,
    statLineCount: splits.length,
    unknownFields: unknownFieldsOf(splits),
  };
}

/**
 * Group a table's splits by (player, LEVEL) and roll each group up, carrying the
 * per-row provenance a game-count report owes (issue #153): the games counted
 * (the aggregate's own `games`) and the REAL first/last game date this row spans.
 *
 * Grouped by `(playerId, sportId, leagueName)` — the single-player card's key
 * (src/reports/player-card.ts), NOT the digest's coarser `(playerId, sportId)`.
 * sportId 16 covers every rookie/complex league, so a player who moved between
 * the Dominican Summer League and a domestic complex mid-window must split into
 * two rows; grouping by sportId alone would blend two levels' stats under one
 * label, the opposite of the per-level provenance this report is for.
 *
 * No idle / zero-row tail: a game-count report is about players who HAVE games,
 * so a player with zero completed regular-season games simply does not appear
 * (unlike the daily digest, whose "who didn't play" tail is load-bearing).
 */
function buildGameCountRows(splits: Split[], statType: "batting" | "pitching"): DigestRow[] {
  const groups = new Map<string, Split[]>();
  for (const split of splits) {
    const key = `${split.line.playerId} ${split.line.sportId} ${split.line.leagueName ?? ""}`;
    const bucket = groups.get(key) ?? [];
    groups.set(key, bucket);
    bucket.push(split);
  }

  const rows: DigestRow[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    const dates = bucket.map((s) => s.line.gameDate);
    rows.push({
      player: toRenderPlayer(first.player),
      ...buildStatRowCore(bucket, statType),
      // A game-count report never groups by game, so there is no doubleheader
      // Gm column; the games count rides the aggregate (rendered as GP).
      gameNumber: null,
      spanFrom: dates.reduce((min, d) => (d < min ? d : min), dates[0]!),
      spanTo: dates.reduce((max, d) => (d > max ? d : max), dates[0]!),
    });
  }

  return rows.sort(
    (a, b) => a.lvlRank - b.lvlRank || comparePlayerNames(a.player.fullName, b.player.fullName),
  );
}

/**
 * The report-level ENVELOPE window: `from`/`to` are the min/max game date across
 * EVERY selected game in the cohort — an honest report-wide span, deliberately
 * distinct from each row's own `spanFrom`/`spanTo` (there is no single window a
 * game-count report shares). When nothing was selected the envelope collapses to
 * the last completed date. `groupBy` is `playerLevel` so the renderer uses the
 * aggregated (GP-carrying) column layout.
 */
function envelopeWindow(
  spec: GameCountWindowSpec,
  splits: Split[],
  lastCompleted: string,
): ResolvedWindow {
  const dates = splits.map((s) => s.line.gameDate);
  const from = dates.length === 0 ? lastCompleted : dates.reduce((a, b) => (a < b ? a : b));
  const to = dates.length === 0 ? lastCompleted : dates.reduce((a, b) => (a > b ? a : b));
  return { spec, from, to, label: gameCountTitle(spec), groupBy: "playerLevel" };
}
