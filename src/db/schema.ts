import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Storage schema. Invariants live in the database, not just app code
 * (rules/backend.md): the Stat Line identity key is a DB-level unique index on
 * [player_id, game_id, stat_type] — per-game, never per-date (ADR 0029).
 */

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** MLB Stats API personId — stable across MLB and every MiLB level. Null for NCAA (ADR 0032). */
  externalId: integer("external_id").unique(),
  /**
   * stats.ncaa.org stats_player_seq — the source-native NCAA identity, its own
   * column so external_id stays MLB-only and one human is still one row across
   * levels (ADR 0032). Null for MLB/MiLB; unique among NCAA rows.
   */
  ncaaPlayerSeq: integer("ncaa_player_seq").unique(),
  /** Highlightly's explicit NCAA player identity; never inferred from a name. */
  highlightlyPlayerId: integer("highlightly_player_id").unique(),
  /** Provider team identity captured with the explicit player attachment. */
  highlightlyTeamId: integer("highlightly_team_id"),
  /** Legacy rows stay visible until an explicitly attached Highlightly backfill completes. */
  ncaaSourceState: text("ncaa_source_state", {
    enum: ["legacy_html", "highlightly_pending", "highlightly_active"],
  }),
  fullName: text("full_name").notNull(),
  level: text("level", { enum: ["mlb", "milb", "ncaa"] }).notNull(),
  /** Triple-A | Double-A | High-A | Single-A | Rookie — only for level = milb. */
  milbLevel: text("milb_level"),
  teamName: text("team_name"),
  position: text("position"),
  schoolName: text("school_name"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // Player-card exact-name resolution is a read-only, indexed lookup. Names are
  // canonicalized at every write boundary (ADR 0041), but deliberately are not
  // unique: two watched players may genuinely have the same name.
  index("players_full_name_idx").on(t.fullName),
  // Keep identity state meaningful in the database as well as in services.
  check(
    "players_ncaa_identity_state_ck",
    sql`(${t.level} = 'ncaa' and ${t.externalId} is null and (${t.ncaaPlayerSeq} is not null or ${t.highlightlyPlayerId} is not null) and ${t.ncaaSourceState} in ('legacy_html', 'highlightly_pending', 'highlightly_active')) or (${t.level} in ('mlb', 'milb') and ${t.externalId} is not null and ${t.ncaaPlayerSeq} is null and ${t.highlightlyPlayerId} is null and ${t.highlightlyTeamId} is null and ${t.ncaaSourceState} is null)`,
  ),
  check(
    "players_highlightly_active_identity_ck",
    sql`${t.ncaaSourceState} <> 'highlightly_active' or ${t.highlightlyPlayerId} is not null`,
  ),
]);

/**
 * A named player list for scoped digests/queries (issue #70 / ADR 0046), and —
 * since #190 — a LANE: a list that additionally carries its own refresh cadence,
 * digest hour, and recipients. A list is CURATED membership over the Watch List
 * — distinct from a tag (a queryable attribute, #30) and a fantasy roster (a
 * future specialization, #69).
 *
 * Soft-deleted (`deleted_at`) so the HC's curation intent is recoverable like a
 * deactivated player; the PARTIAL unique index frees the name for reuse once a
 * list is deleted. Named-list scope selects active players who are members —
 * `players.active` stays the master gate (ADR 0046 decision 2).
 *
 * Declared ABOVE `digest_deliveries` because that table now references it.
 */
export const playerLists = sqliteTable(
  "player_lists",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Null while live; set on soft-delete. The partial unique index keys on this. */
    deletedAt: text("deleted_at"),
    /**
     * THE default lane: what an unscoped command means (#190). Reverses ADR
     * 0046 decision 1's implicit default — a seeded row the migration backfills,
     * so "no `--list`" resolves to a real, nameable, re-pointable list instead
     * of to the whole Watch List by accident.
     */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /**
     * Minutes between this lane's automatic refreshes; null = never
     * auto-refreshes. An interval rather than a cron expression (decided in
     * #190): it avoids a parser dependency and its test surface at the cost of
     * not expressing "weekdays only". Inert until #192 reads it.
     */
    refreshIntervalMinutes: integer("refresh_interval_minutes"),
    /**
     * Host-timezone hour (0-23) this lane digests at; null = never
     * auto-digests. Read by the tick (#193): a lane is due once the host hour
     * has REACHED it and today's slot holds no `sent` row — `>=`, not `==`, so a
     * laptop asleep at the hour still sends on wake.
     */
    digestHour: integer("digest_hour"),
    /**
     * This lane's recipients; null = fall back to the DIGEST_TO env value.
     * Read by the CLAIMED digest path (#193): a lane's scheduled daily send goes
     * here. An on-demand report keeps the host recipients — it answers the person
     * who asked for it, not the lane's subscribers.
     */
    digestTo: text("digest_to"),
  },
  (t) => [
    // A name is unique among LIVE lists only: a soft-deleted list keeps its row
    // but frees its name, so a fresh list may reuse it (ADR 0046 decision 3).
    // The invariant lives in the DB, DECLARED in the schema (rules/backend.md).
    uniqueIndex("player_lists_name_live_uq")
      .on(t.name)
      .where(sql`${t.deletedAt} is null`),
    // At most ONE LIVE default (#190). Partial on BOTH predicates: a soft-deleted
    // list holding is_default must not block the live one, or deleting the
    // default would make a replacement unsettable.
    uniqueIndex("player_lists_default_uq")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = 1 and ${t.deletedAt} is null`),
    check("player_lists_name_nonblank_ck", sql`length(trim(${t.name})) > 0`),
    // Cadence bounds live in the DATABASE, DECLARED here (rules/backend.md), so
    // a drizzle table rebuild re-emits them. Both ends are named explicitly:
    // a negative hour or interval is rejected as squarely as an over-large one.
    check(
      "player_lists_digest_hour_range_ck",
      sql`${t.digestHour} is null or (${t.digestHour} >= 0 and ${t.digestHour} <= 23)`,
    ),
    check(
      "player_lists_refresh_interval_positive_ck",
      sql`${t.refreshIntervalMinutes} is null or ${t.refreshIntervalMinutes} > 0`,
    ),
  ],
);

export const digestDeliveries = sqliteTable(
  "digest_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["digest", "heartbeat"] }).notNull(),
    /** Host-timezone calendar date (YYYY-MM-DD) this delivery covers. */
    dateCovered: text("date_covered").notNull(),
    sentAt: text("sent_at"),
    playerCount: integer("player_count").notNull().default(0),
    statLineCount: integer("stat_line_count").notNull().default(0),
    /**
     * Delivery state machine (ADR 0034). `sending` is a durable CLAIM on this
     * (kind, date_covered) slot held under the unique index below; it carries a
     * lease so a crashed run's slot heals instead of blocking forever.
     *
     * Every member is reachable: no speculative state is declared here, because
     * an unwritable state still forces every consumer of DeliveryStatus (the
     * health seam, and both surfaces it feeds) to handle a case that cannot
     * occur.
     */
    status: text("status", { enum: ["sending", "sent", "failed"] }).notNull(),
    /** When the current `sending` claim was taken — the lease clock (ADR 0034). */
    claimedAt: text("claimed_at"),
    /** How many times this slot has been claimed; >1 means a retry or a recovery. */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Provider-side id of the accepted message, when the provider returns one. */
    providerMessageId: text("provider_message_id"),
    /**
     * Set when this delivery settled `sent` because the PROVIDER confirmed the
     * previous, crashed attempt already landed — not because this run mailed
     * anything (ADR 0034 amendment). Null on every ordinary send. It is what
     * makes the fail-open lookup trustworthy in practice: an operator can tell
     * "we sent this" from "the provider told us it was already accepted", and a
     * reconciled row's zero counts read as recorded-nothing rather than
     * sent-nothing.
     */
    reconciledAt: text("reconciled_at"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    /**
     * The LANE this delivery belongs to (#190). NOT NULL is load-bearing, not
     * housekeeping: SQLite treats NULLs as DISTINCT in a unique index, so a
     * nullable list_id would let unlimited `(digest, <date>, NULL)` rows coexist
     * and would silently void the slot uniqueness ADR 0034's durable claim rests
     * on — surfacing as duplicate digests, the one failure this table exists to
     * prevent. The migration carries the constraint from the rebuilt table's
     * creation rather than tightening it afterwards (drizzle/0012).
     *
     * `kind: "heartbeat"` rows are not lane-scoped yet still carry the default
     * lane's id — a known wart, recorded rather than discovered (#190).
     */
    listId: integer("list_id")
      .notNull()
      .references(() => playerLists.id),
  },
  (t) => [
    // The slot key carries the lane dimension: two lanes may digest the same
    // date, one lane may not digest it twice. That third column is load-bearing
    // as of #193 (ADR 0062 decision 1), which routes every tag-free 1d send —
    // including an explicitly named lane's, on any surface — onto the claimed
    // path. Rows genuinely differ by lane now, where before the migration every
    // one carried the default lane and this behaved like the two-column key it
    // replaced.
    uniqueIndex("digest_deliveries_kind_date_list_uq").on(t.kind, t.dateCovered, t.listId),
  ],
);

export const statLines = sqliteTable(
  "stat_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    /** Source-native game identifier (MLB Stats API gamePk). */
    gameId: integer("game_id").notNull(),
    /** Provider namespace prevents legacy NCAA and Highlightly match ids colliding. */
    source: text("source", {
      enum: ["mlb_stats_api", "ncaa_html_legacy", "highlightly_ncaa"],
    })
      .notNull()
      .default("mlb_stats_api"),
    statType: text("stat_type", { enum: ["batting", "pitching", "fielding"] }).notNull(),
    gameDate: text("game_date").notNull(),
    gameNumber: integer("game_number").notNull().default(1),
    gameType: text("game_type").notNull(),
    isHome: integer("is_home", { mode: "boolean" }),
    opponentName: text("opponent_name"),
    teamName: text("team_name"),
    sportId: integer("sport_id").notNull(),
    leagueName: text("league_name"),
    /** The split's stat object (hits, atBats, inningsPitched, ...), verbatim. */
    stats: text("stats", { mode: "json" }).notNull(),
    /** Canonical provider keys supplied on this played line; omitted means unavailable, not zero. */
    availableStats: text("available_stats", { mode: "json" }).$type<string[] | null>(),
    /** The whole gameLog split, verbatim, for future re-processing. */
    raw: text("raw", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // ADR 0029: per-game identity — never date-keyed (doubleheaders are two games).
    uniqueIndex("stat_lines_player_source_game_type_uq").on(t.playerId, t.source, t.gameId, t.statType),
    // The player card scans one player's regular-season games in deterministic
    // recency order before it joins companion batting/pitching/fielding lines.
    index("stat_lines_player_regular_game_order_idx").on(
      t.playerId,
      t.gameType,
      t.gameDate,
      t.gameNumber,
      t.id,
    ),
  ],
);

/** Durable, fair NCAA backfill cursor. It advances only after an installed page. */
export const highlightlyPlayerCursors = sqliteTable(
  "highlightly_player_cursors",
  {
    playerId: integer("player_id").primaryKey().references(() => players.id),
    season: integer("season").notNull(),
    nextMatchDate: text("next_match_date"),
    lastCompleteAt: text("last_complete_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [check("highlightly_cursor_season_ck", sql`${t.season} >= 2000`)],
);

/** Shared provider responses make retries quota-efficient and make coverage auditable. */
export const highlightlyMatchCache = sqliteTable(
  "highlightly_match_cache",
  {
    matchId: integer("match_id").primaryKey(),
    season: integer("season").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    complete: integer("complete", { mode: "boolean" }).notNull().default(false),
    rateRemaining: integer("rate_remaining"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [index("highlightly_match_cache_season_idx").on(t.season)],
);

export const highlightlyBoxScoreCache = sqliteTable("highlightly_box_score_cache", {
  matchId: integer("match_id").primaryKey(),
  payload: text("payload", { mode: "json" }).notNull(),
  complete: integer("complete", { mode: "boolean" }).notNull().default(false),
  rateRemaining: integer("rate_remaining"),
  fetchedAt: text("fetched_at").notNull(),
});

export const refreshRuns = sqliteTable(
  "refresh_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * When the sweep took its PLAYER SELECTION snapshot — the freshness anchor
     * (ADR 0043). Freshness is judged on the START, never the finish: a run that
     * started after the content day ended captured every player under ADR 0040's
     * forward-clock finality gate, whereas a midnight-straddling run started
     * before is conservatively stale.
     *
     * THE SELECTION INSTANT, NOT THE CLAIM INSTANT (PR #203 Reviewer P1). A
     * sweep selects its players, loads calendars, and only then claims, so the
     * two differ by several database reads. Every coverage test — most sharply
     * `latestCoveringRun`'s "did this lane gain an active member since?" — is
     * really asking what the SELECTION saw, and a claim-instant anchor would
     * date an enrollment made inside that gap as older than the run and read it
     * as covered by a selection that never saw it. So `runRefresh` stamps the
     * instant it read its clock before selecting, and `started_at <= claimed_at`
     * holds; `claimed_at` alone is the lease clock.
     */
    startedAt: text("started_at").notNull(),
    /** Null WHILE running; stamped when the run settles (CHECK below enforces the iff). */
    finishedAt: text("finished_at"),
    /**
     * The run state machine (ADR 0043). Each run owns its OWN row — a stream, not
     * a shared slot — so a late-settling superseded run only writes its older row,
     * and the freshness watermark is the latest by (started_at, id). Every member
     * has a writing path (claim → running; settle → ok/partial/failed); no
     * speculative state, so no consumer of RefreshRunStatus handles a case that
     * cannot occur (rules/backend.md).
     */
    status: text("status", { enum: ["running", "ok", "partial", "failed"] }).notNull(),
    /**
     * The lease clock (ADR 0034's pattern), RENEWED after each player. A healthy
     * long sweep keeps renewing and stays live; a crashed run stops and its lease
     * expires after REFRESH_LEASE_MS, so another run may claim without waiting.
     *
     * The CLAIM instant, and the only column a lease decision may read — its
     * initial value is when the row was inserted, at or after `started_at` (PR
     * #203 Reviewer P1). Measuring a lease from the selection watermark instead
     * would let a slow-to-claim sweep be reaped by the very next claim.
     */
    claimedAt: text("claimed_at").notNull(),
    playersRefreshed: integer("players_refreshed").notNull().default(0),
    /**
     * Passed-Over Players this sweep — watched players a running sweep chose not
     * to fetch (out-of-season NCAA, no external id). NOT a Skipped Sweep, which
     * records no run at all (docs/domain/CONTEXT.md, #146). Recorded so the
     * Accounting surfaces (`/health`, MCP `status`) carry the SAME three-way
     * classification the console's Liveness stream shows, and
     * `refreshed + skipped + failed = players_total` holds for a settled run.
     *
     * Historical rows migrated before #146 carry a backfilled `0` that means
     * "not recorded", not "nothing was passed over" — see drizzle/0011.
     */
    playersSkipped: integer("players_skipped").notNull().default(0),
    /** Watched players whose refresh threw and was collected, not fatal (#23). Same backfill caveat. */
    playersFailed: integer("players_failed").notNull().default(0),
    playersTotal: integer("players_total").notNull().default(0),
    statLinesInserted: integer("stat_lines_inserted").notNull().default(0),
    statLinesUpdated: integer("stat_lines_updated").notNull().default(0),
    errorMessage: text("error_message"),
    /**
     * WHETHER this run swept THE WHOLE WATCH LIST, and if not, which lanes it
     * did cover (#192, ADR 0061 decision 8).
     *
     * `NULL` means **every active Player was swept** — the only thing a pre-#192
     * run could ever have done, so drizzle/0013's NULL backfill is semantically
     * correct by construction rather than a placeholder. A LANE run whose lanes
     * happened to hold every active Player also records `NULL`, because it too
     * swept everyone; `runRefresh` decides that from the SAME claim-time read
     * that selected the sweep, so the two can never disagree.
     *
     * Otherwise the value is the canonical encoding of the lanes it did cover —
     * ascending, deduped, comma-delimited, sentinel-wrapped (`,1,3,10,`).
     *
     * IT IS QUERIED, not merely recorded (#193, ADR 0062 decision 2 — which
     * amends the "provenance that nothing parses back" contract #192 left here).
     * `latestCoveringRun` is the ONE reader and asks two things of it: `IS NULL`
     * for the whole-list question, and fenced containment (`LIKE '%,1,%'`, which
     * is why the sentinel commas are load-bearing) for the per-lane one. A lane
     * hit by containment is covered only while its active membership has not
     * grown since that run's `started_at` — naming a lane is not covering its
     * members (PR #203). {@link encodeScopeListIds} is the one writer.
     *
     * Declared HERE, not only in drizzle/0013, so a future drizzle-kit table
     * rebuild re-emits the column (`rules/backend.md`).
     */
    scopeListIds: text("scope_list_ids"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // refresh_runs is append-only and read on every /health poll (public) plus
    // every digest and every claim's live-lease check. This composite index
    // serves those hot, LIMIT-bounded reads — WHERE status (IN ...) ORDER BY
    // started_at — so none of them full-scans and sorts the whole table.
    index("refresh_runs_status_started_idx").on(t.status, t.startedAt),
    // The invariants live in the DATABASE, DECLARED in the schema (rules/backend.md)
    // — not only in hand-written migration SQL — so the drizzle snapshot records
    // them and a future drizzle-kit table rebuild re-emits every CHECK.
    check("refresh_runs_status_ck", sql`${t.status} in ('running', 'ok', 'partial', 'failed')`),
    // finished_at is NULL exactly while running: terminal iff finished.
    check(
      "refresh_runs_finished_iff_terminal_ck",
      sql`(${t.status} = 'running' and ${t.finishedAt} is null) or (${t.status} <> 'running' and ${t.finishedAt} is not null)`,
    ),
    check("refresh_runs_players_refreshed_nonneg_ck", sql`${t.playersRefreshed} >= 0`),
    check("refresh_runs_players_skipped_nonneg_ck", sql`${t.playersSkipped} >= 0`),
    check("refresh_runs_players_failed_nonneg_ck", sql`${t.playersFailed} >= 0`),
    check("refresh_runs_players_total_nonneg_ck", sql`${t.playersTotal} >= 0`),
    check("refresh_runs_stat_lines_inserted_nonneg_ck", sql`${t.statLinesInserted} >= 0`),
    check("refresh_runs_stat_lines_updated_nonneg_ck", sql`${t.statLinesUpdated} >= 0`),
  ],
);

/**
 * Membership join between a list and a player (issue #70 / ADR 0046). Hard-delete
 * on remove — a single join row carries no irreplaceable state (the player and
 * his stats are untouched), so scoped reads need no `deleted_at` filter.
 */
export const listMembers = sqliteTable(
  "list_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listId: integer("list_id")
      .notNull()
      .references(() => playerLists.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // One membership per (list, player): re-adding a member is idempotent under
    // this unique index rather than duplicating the join row (ADR 0046).
    uniqueIndex("list_members_list_player_uq").on(t.listId, t.playerId),
  ],
);

export const playerTags = sqliteTable(
  "player_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    /** Tag family, e.g. `level`, `pos`, `prospect`, `status`. */
    namespace: text("namespace").notNull(),
    /** Tag value within the namespace, e.g. `aaa`, `ss`, `rostered`. */
    value: text("value").notNull(),
    /**
     * The load-bearing column (Phase A of #29): `derived` rows are recomputed on
     * every Refresh (level/pos/prospect), `manual` rows are user-set (status).
     * Derivation rewrites ONLY `derived` rows, so the two never fight.
     */
    source: text("source", { enum: ["derived", "manual"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // A tag's identity: one (namespace, value) per player, across BOTH sources.
    uniqueIndex("player_tags_player_ns_value_uq").on(t.playerId, t.namespace, t.value),
    // The selector's access path — WHERE namespace = ? (AND value = ?).
    index("player_tags_ns_value_idx").on(t.namespace, t.value),
    // At most ONE `level:` tag per player, enforced by the DB, not only by
    // deriveTags: a partial unique index (SQLite honors the WHERE predicate), so
    // dsl-supersedes-rookie can never leave two level rows behind.
    uniqueIndex("player_tags_level_single_uq")
      .on(t.playerId, t.namespace)
      .where(sql`${t.namespace} = 'level'`),
    // The invariants live in the DATABASE, DECLARED in the schema (rules/backend.md)
    // — not only in hand-written migration SQL — so the drizzle snapshot records
    // them and a future drizzle-kit table rebuild re-emits every CHECK.
    check("player_tags_source_ck", sql`${t.source} in ('derived', 'manual')`),
    check("player_tags_namespace_nonblank_ck", sql`length(${t.namespace}) > 0`),
    check("player_tags_value_nonblank_ck", sql`length(${t.value}) > 0`),
  ],
);

export const seasonCalendar = sqliteTable(
  "season_calendar",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sportId: integer("sport_id").notNull(),
    season: text("season").notNull(),
    regularSeasonStart: text("regular_season_start"),
    regularSeasonEnd: text("regular_season_end"),
    postSeasonStart: text("post_season_start"),
    postSeasonEnd: text("post_season_end"),
    springStart: text("spring_start"),
    springEnd: text("spring_end"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [uniqueIndex("season_calendar_sport_season_uq").on(t.sportId, t.season)],
);

export type PlayerRow = typeof players.$inferSelect;
export type NewPlayerRow = typeof players.$inferInsert;
export type StatLineRow = typeof statLines.$inferSelect;
export type NewStatLineRow = typeof statLines.$inferInsert;
export type DigestDeliveryRow = typeof digestDeliveries.$inferSelect;
/**
 * The delivery state machine's alphabet. Exported so every surface that reports
 * a delivery status (src/server/health.ts, and through it GET /health and the
 * MCP `status` tool) consumes the schema's own union instead of restating it —
 * widening the enum can never leave a surface behind (rules/backend.md).
 */
export type DeliveryStatus = DigestDeliveryRow["status"];
export type DeliveryKind = DigestDeliveryRow["kind"];
export type RefreshRunRow = typeof refreshRuns.$inferSelect;
/**
 * The refresh-run state machine's alphabet (ADR 0043). The DERIVED health
 * vocabulary (fresh/stale/running/partial/failed) is a SEPARATE type in
 * src/server/health.ts — never this one — because "fresh"/"stale" are computed
 * against a clock, not stored.
 */
export type RefreshRunStatus = RefreshRunRow["status"];
export type SeasonCalendarRow = typeof seasonCalendar.$inferSelect;
export type NewSeasonCalendarRow = typeof seasonCalendar.$inferInsert;
export type PlayerListRow = typeof playerLists.$inferSelect;
export type NewPlayerListRow = typeof playerLists.$inferInsert;
export type ListMemberRow = typeof listMembers.$inferSelect;
export type NewListMemberRow = typeof listMembers.$inferInsert;
export type PlayerTagRow = typeof playerTags.$inferSelect;
export type NewPlayerTagRow = typeof playerTags.$inferInsert;
