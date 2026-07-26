import { and, eq, exists, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { listMembers, players, statLines } from "../db/schema.js";
import type { CalendarEntry } from "../domain/season.js";
import { hostDate, isInSeason, sportIdForPlayer } from "../domain/season.js";
import type { ResolvedWindow, WindowSpec } from "../domain/window.js";
import { resolveWindow } from "../domain/window.js";
import { listMemberIds } from "../lists/service.js";
import type { TagScope } from "../tags/service.js";
import { playerIdsMatchingTags, tagScopeCondition } from "../tags/service.js";
import { levelAbbrev, levelRank } from "../mlb/levels.js";
import type { Aggregate } from "../stats/aggregate.js";
import { aggregate } from "../stats/aggregate.js";
import { loadActivePlayers, loadCalendars } from "../jobs/refresh.js";
import type { RenderPlayer } from "./render.js";
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
 * Windowed Digest assembly. Selection is BY DATE WINDOW, not by novelty — the
 * report consumes nothing and stamps nothing, so re-running a window is always
 * safe (supersedes ADR 0030's novelty model).
 *
 * Rows group by (player, LEVEL), because a window can span a promotion and a
 * blended slash line across levels describes nobody (src/mlb/levels.ts: "Level
 * is a mutable location, never identity"). A 1d window groups by game instead,
 * so a doubleheader stays two rows.
 *
 * Read-only. runDigest consumes this; the preview surfaces (REST + MCP) expose
 * it directly.
 */

export interface DigestRow {
  player: RenderPlayer;
  /** "MLB" | "AAA" | ... — from the stat line's sportId, never players.level. */
  lvl: string;
  lvlRank: number;
  /** Game number for a 1d doubleheader row; null otherwise. */
  gameNumber: number | null;
  agg: Aggregate;
  /** Count of quality starts in the window; always 0 for batters. */
  qualityStarts: number;
  /** Count of wins earned in relief in the window; always 0 for batters. */
  reliefWins: number;
  /** Count of losses charged in relief in the window; always 0 for batters. */
  reliefLosses: number;
  /**
   * Per-player PROVENANCE for a game-count report (issue #153): the real first /
   * last game date this row's games span. A date-window row leaves them undefined
   * — its span is the shared `window.from`/`.to`. A game-count row carries its own
   * because two players' last-N games cover different dates; the renderer shows a
   * Span column only when they are present.
   */
  spanFrom?: string;
  spanTo?: string;
}

export interface DigestAssembly {
  window: ResolvedWindow;
  /**
   * Validated named-list display name for presentation, when this is a scoped
   * digest. Kept apart from `window` so structured window metadata remains
   * canonical and list naming does not need to be reconstructed by renderers.
   */
  listName?: string;
  /**
   * Normalized tag-selector label for presentation, when this is a tag-scoped
   * digest (#140). Same contract as `listName`: the renderer names the cohort
   * from this rather than reconstructing it, and it is the PARSER's output, never
   * the operator's raw input — see `resolveTagScope`.
   */
  tagSelector?: string;
  batters: DigestRow[];
  pitchers: DigestRow[];
  /** Distinct players with lines in the window (zero rows are not counted). */
  playerCount: number;
  /** Stored lines the window selected, fielding rows included. */
  statLineCount: number;
  /**
   * Stat keys the classification did not recognise, deduped across every row.
   *
   * These were EXCLUDED from the aggregate rather than guessed at, which is the
   * safe half of fail-closed. Reporting them is the other half: without it an
   * upstream field addition is silently dropped from every future report and
   * nobody learns the tables went stale.
   */
  unknownFields: string[];
}

export interface AssembleDeps {
  now: () => Date;
  tz: string;
  spec: WindowSpec;
  /** Recover a past slot: anchor the window on this host date, not now. */
  asOf?: string;
  /**
   * Scope the digest to a named list's ACTIVE members (issue #70 / ADR 0046).
   * Undefined ⇒ the untouched current path (all active players, no membership
   * join). When set, BOTH selection sites are scoped — the main stat-line join
   * AND the active-player set that feeds the idle/zero-row tail and
   * `seasonStartFor` — so an off-list player can never leak as a zero row.
   */
  listId?: number;
  /** Display name paired with `listId`, carried to the public presentation. */
  listName?: string;
  /**
   * Scope the digest to the players matching a tag selector (#140 / ADR 0050).
   * Undefined ⇒ no tag scope. Scoped exactly like `listId`: BOTH selection sites
   * are filtered, so an off-cohort player can never leak as a zero row. A tag
   * scope and a list scope INTERSECT when both are present.
   */
  tagScope?: TagScope;
}

export async function assembleDigest(db: Db, deps: AssembleDeps): Promise<DigestAssembly> {
  const { now, tz } = deps;
  const allActive = await loadActivePlayers(db);

  // A list scope selects the ACTIVE members of the list; `players.active` stays
  // the master gate (ADR 0046 decision 2). Both selection sites read from this
  // ONE resolved set so an off-list player cannot leak as a zero row: the join
  // is filtered by memberIds, and the idle/season set is `activePlayers` below.
  const memberIds = deps.listId !== undefined ? await listMemberIds(db, deps.listId) : null;
  const memberSet = memberIds === null ? null : new Set(memberIds);
  // The tag scope filters the SAME resolved set, for the same reason (#140): the
  // idle/zero-row tail and `seasonStartFor` both read `activePlayers`, so an
  // off-cohort player scoped out of the join alone would still leak as a zero row
  // AND could move a `ytd` window's start date. Filtering by an id SET here (not
  // an `IN (...)` bind) keeps the parameter cap out of it — rules/backend.md.
  const taggedSet =
    deps.tagScope === undefined ? null : new Set(playerIdsMatchingTags(db, deps.tagScope.tokens));
  const activePlayers = allActive.filter(
    (p) => (memberSet === null || memberSet.has(p.id)) && (taggedSet === null || taggedSet.has(p.id)),
  );

  const calendars = await loadCalendars(db);
  const window = resolveWindow(
    deps.spec,
    now(),
    tz,
    seasonStartFor(calendars, activePlayers, now(), tz),
    deps.asOf ?? null,
  );

  // Scope the main join to the list's members with a correlated EXISTS against
  // list_members, keyed by list_id. It is constant-size regardless of list size
  // (no per-member bind param, so no SQLite ~999-param ceiling), and an EMPTY
  // named list selects nothing naturally — EXISTS is false with no member rows,
  // no `1 = 0` special-case needed. No list ⇒ nothing added (path unchanged).
  const scopeCondition =
    deps.listId === undefined
      ? undefined
      : exists(
          db
            .select({ x: sql`1` })
            .from(listMembers)
            .where(
              and(eq(listMembers.listId, deps.listId), eq(listMembers.playerId, players.id)),
            ),
        );

  // The tag scope's half of the same join filter. Correlated EXISTS per token,
  // built by the tag service so this site and the id-set site above are one
  // implementation (rules/backend.md: no materialized id list in the SQL).
  const tagCondition =
    deps.tagScope === undefined ? undefined : tagScopeCondition(db, deps.tagScope.tokens);

  // One join, not one query per player (rules/backend.md).
  const rows = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(
      and(
        eq(players.active, true),
        ...(scopeCondition !== undefined ? [scopeCondition] : []),
        ...(tagCondition !== undefined ? [tagCondition] : []),
        // Regular season only: ingestion also allows postseason types, and a
        // YTD line blending playoff and regular-season stats is not a season line.
        eq(statLines.gameType, "R"),
        gte(statLines.gameDate, window.from),
        lte(statLines.gameDate, window.to),
      ),
    );

  const splits: Split[] = rows.map(({ line, player }) => ({
    line,
    player,
    stats: asRecord(line.stats),
  }));

  const playersWithLines = new Set(splits.map((s) => s.player.id));

  // A player with no games still appears, as a zero row — this replaces the old
  // "no new stats" tail, and inherits its In Season filter: a player whose
  // season is over is omitted entirely, not listed at zero for months.
  //
  // The filter can only ever touch a player with ZERO games in the window, so it
  // cannot hide anyone who actually played: a pitcher whose season ended in
  // September still has splits inside a `ytd` window and is built from those.
  const idlePlayers = activePlayers.filter(
    (p) => !playersWithLines.has(p.id) && isInSeason(p, calendars, now(), tz, window.to),
  );

  // An idle player has no stat line in the window to read a league from, but
  // sportId 16 alone cannot tell the Dominican Summer League from the domestic
  // complex leagues — so a DSL player would render "R" on the days he sits and
  // "DSL" on the days he plays. Same player, two labels, one email. His most
  // recent league is the honest answer, so look it up outside the window.
  const leagueByPlayer = await lastKnownLeagues(db, idlePlayers);

  // A player's declared position owns his digest table. Do not surface a
  // pitcher's batting appearance (or a position player's pitching appearance)
  // in the opposite table: the watch-list role is the digest's classification.
  const batting = mergeFieldingIntoBatting(splits)
    .filter((split) => isBatter(split.player))
    .map(withPlateAppearances);
  const pitching = splits.filter(
    (split) => split.line.statType === "pitching" && !isBatter(split.player),
  );

  const batters = buildRows(batting, window, "batting", idlePlayers.filter(isBatter), leagueByPlayer);
  const pitchers = buildRows(
    pitching,
    window,
    "pitching",
    idlePlayers.filter((p) => !isBatter(p)),
    leagueByPlayer,
  );

  return {
    window,
    listName: deps.listName,
    tagSelector: deps.tagScope?.label,
    batters,
    pitchers,
    playerCount: playersWithLines.size,
    statLineCount: splits.length,
    unknownFields: unknownFieldsOf(splits),
  };
}

/**
 * Each idle player's most recently seen league, for the Lvl column.
 *
 * Deliberately NOT window-limited: an idle player has no line in the window by
 * definition, so a windowed lookup would always return nothing. The question is
 * "where does he play", not "where did he play this week", and the answer must
 * not flicker between reports.
 *
 * Only sportId 16 actually needs this — it covers every rookie/complex league,
 * so the league name is the only thing separating the Dominican Summer League
 * from the domestic ones. One query for the whole idle set, not one per player.
 */
async function lastKnownLeagues(
  db: Db,
  idlePlayers: PlayerRow[],
): Promise<Map<number, string | null>> {
  const byPlayer = new Map<number, string | null>();
  if (idlePlayers.length === 0) return byPlayer;

  const rows = await db
    .select({
      playerId: statLines.playerId,
      leagueName: statLines.leagueName,
      gameDate: statLines.gameDate,
    })
    .from(statLines)
    .where(
      inArray(
        statLines.playerId,
        idlePlayers.map((p) => p.id),
      ),
    );

  const latest = new Map<number, string>();
  for (const row of rows) {
    const seen = latest.get(row.playerId);
    if (seen === undefined || row.gameDate > seen) {
      latest.set(row.playerId, row.gameDate);
      byPlayer.set(row.playerId, row.leagueName);
    }
  }
  return byPlayer;
}

/**
 * Group the window's splits into rows and aggregate each group.
 *
 * `idlePlayers` are the active players with no line in the window; each becomes
 * a zero row. The caller decides which table they belong to (batters), so the
 * policy is visible at the call site rather than buried in a statType branch.
 */
function buildRows(
  splits: Split[],
  window: ResolvedWindow,
  statType: "batting" | "pitching",
  idlePlayers: PlayerRow[],
  leagueByPlayer: Map<number, string | null>,
): DigestRow[] {
  const groups = new Map<string, Split[]>();
  const gamesPerPlayer = new Map<number, Set<number>>();
  for (const split of splits) {
    const key =
      window.groupBy === "game"
        ? `${split.line.playerId}:${split.line.gameId}`
        : `${split.line.playerId}:${split.line.sportId}`;
    const bucket = groups.get(key) ?? [];
    groups.set(key, bucket);
    bucket.push(split);

    const games = gamesPerPlayer.get(split.line.playerId) ?? new Set<number>();
    gamesPerPlayer.set(split.line.playerId, games);
    games.add(split.line.gameId);
  }

  const rows: DigestRow[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    // A 1d table carries no opponent column, so two games on one date would
    // otherwise render as two identical rows. Gm disambiguates them, and is
    // left null for anyone who played once.
    const doubleheader =
      window.groupBy === "game" && (gamesPerPlayer.get(first.line.playerId)?.size ?? 0) > 1;
    rows.push({
      player: toRenderPlayer(first.player),
      ...buildStatRowCore(bucket, statType),
      gameNumber: doubleheader ? first.line.gameNumber : null,
    });
  }

  for (const player of idlePlayers) {
    // No stat line to read a sportId from, so this is the one place a level
    // legitimately comes from the player row: he played nowhere in the window.
    const sportId = sportIdForPlayer(player) ?? -1;
    rows.push({
      player: toRenderPlayer(player),
      lvl: levelAbbrev(sportId, leagueByPlayer.get(player.id) ?? null),
      lvlRank: levelRank(sportId),
      gameNumber: null,
      agg: aggregate(statType, []),
      qualityStarts: 0,
      reliefWins: 0,
      reliefLosses: 0,
    });
  }

  return rows.sort(
    (a, b) =>
      a.lvlRank - b.lvlRank ||
      comparePlayerNames(a.player.fullName, b.player.fullName) ||
      (a.gameNumber ?? 0) - (b.gameNumber ?? 0),
  );
}

/**
 * The current season's regular-season start (sportId 1), or null when no
 * calendar row is cached — in which case `ytd` falls back to January 1
 * (src/domain/window.ts), matching the fail-open posture of season.ts.
 */
/**
 * Where `ytd` starts: the EARLIEST regular-season start among the sports the
 * watched players actually play.
 *
 * Not MLB's opening day. NCAA's season begins in February, roughly six weeks
 * before MLB's, so anchoring on sportId 1 silently truncated a college player's
 * season-to-date — his February and March games fell outside the window and the
 * report showed a partial season as if it were the whole one.
 *
 * Earliest-across-watched is safe in the other direction: an MLB player simply
 * has no games before his own opening day, so a window that starts earlier than
 * he did costs nothing. Taking the earliest is what makes one shared window
 * truthful for every row in the report.
 */
function seasonStartFor(
  calendars: CalendarEntry[],
  activePlayers: PlayerRow[],
  now: Date,
  tz: string,
): string | null {
  const season = hostDate(now, tz).slice(0, 4);
  const watchedSportIds = new Set(
    activePlayers.map((p) => sportIdForPlayer(p)).filter((id): id is number => id !== null),
  );
  const starts = calendars
    .filter((c) => c.season === season && watchedSportIds.has(c.sportId))
    .map((c) => c.regularSeasonStart)
    .filter((d): d is string => d !== null);
  return starts.length === 0 ? null : starts.reduce((a, b) => (a < b ? a : b));
}
