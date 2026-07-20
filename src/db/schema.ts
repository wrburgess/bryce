import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
});

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
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("digest_deliveries_kind_date_uq").on(t.kind, t.dateCovered)],
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
    /** The whole gameLog split, verbatim, for future re-processing. */
    raw: text("raw", { mode: "json" }).notNull(),
    /** Set when a Digest reports this line; a correction never clears it (ADR 0030). */
    digestDeliveryId: integer("digest_delivery_id").references(() => digestDeliveries.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // ADR 0029: per-game identity — never date-keyed (doubleheaders are two games).
    uniqueIndex("stat_lines_player_game_type_uq").on(t.playerId, t.gameId, t.statType),
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
export type SeasonCalendarRow = typeof seasonCalendar.$inferSelect;
export type NewSeasonCalendarRow = typeof seasonCalendar.$inferInsert;
