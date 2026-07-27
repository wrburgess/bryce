-- #146: refresh_runs gains players_skipped / players_failed so the durable
-- ACCOUNTING carries the same three-way per-player classification the console's
-- LIVENESS stream shows (ADR 0056). SQLite has no ALTER TABLE ... ADD
-- CONSTRAINT, so the two new *_nonneg_ck CHECKs require a full table rebuild;
-- drizzle-kit generated it and it is hand-tuned below (house style: 0004, 0008,
-- 0009).
--
-- BACKFILL HONESTY. `DEFAULT 0 NOT NULL` gives every historical row
-- players_skipped = 0 and players_failed = 0. For a row settled `partial` or
-- `failed` that is FALSE — those runs did pass over or fail players, and the
-- counts were simply never recorded. A backfilled 0 on a pre-#146 row means "not
-- recorded", never "nothing happened". Chosen anyway for symmetry with how
-- players_refreshed / players_total were introduced (ADR 0043) and to keep the
-- *_nonneg_ck convention; no future reader should mistake one for the other.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refresh_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`claimed_at` text NOT NULL,
	`players_refreshed` integer DEFAULT 0 NOT NULL,
	`players_skipped` integer DEFAULT 0 NOT NULL,
	`players_failed` integer DEFAULT 0 NOT NULL,
	`players_total` integer DEFAULT 0 NOT NULL,
	`stat_lines_inserted` integer DEFAULT 0 NOT NULL,
	`stat_lines_updated` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	CONSTRAINT "refresh_runs_status_ck" CHECK("__new_refresh_runs"."status" in ('running', 'ok', 'partial', 'failed')),
	CONSTRAINT "refresh_runs_finished_iff_terminal_ck" CHECK(("__new_refresh_runs"."status" = 'running' and "__new_refresh_runs"."finished_at" is null) or ("__new_refresh_runs"."status" <> 'running' and "__new_refresh_runs"."finished_at" is not null)),
	CONSTRAINT "refresh_runs_players_refreshed_nonneg_ck" CHECK("__new_refresh_runs"."players_refreshed" >= 0),
	CONSTRAINT "refresh_runs_players_skipped_nonneg_ck" CHECK("__new_refresh_runs"."players_skipped" >= 0),
	CONSTRAINT "refresh_runs_players_failed_nonneg_ck" CHECK("__new_refresh_runs"."players_failed" >= 0),
	CONSTRAINT "refresh_runs_players_total_nonneg_ck" CHECK("__new_refresh_runs"."players_total" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_inserted_nonneg_ck" CHECK("__new_refresh_runs"."stat_lines_inserted" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_updated_nonneg_ck" CHECK("__new_refresh_runs"."stat_lines_updated" >= 0)
);
--> statement-breakpoint
-- EXPLICIT column lists on BOTH sides, OMITTING the two new columns so SQLite
-- applies their DEFAULT 0. drizzle-kit generated them on both sides, which
-- fails outright (`no such column: players_skipped`) because the OLD table has
-- 11 columns and the new one 13. `id` is copied explicitly so the AUTOINCREMENT
-- identity of every historical run is preserved across the rebuild.
INSERT INTO `__new_refresh_runs`("id", "started_at", "finished_at", "status", "claimed_at", "players_refreshed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "created_at") SELECT "id", "started_at", "finished_at", "status", "claimed_at", "players_refreshed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "created_at" FROM `refresh_runs`;--> statement-breakpoint
DROP TABLE `refresh_runs`;--> statement-breakpoint
ALTER TABLE `__new_refresh_runs` RENAME TO `refresh_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refresh_runs_status_started_idx` ON `refresh_runs` (`status`,`started_at`);