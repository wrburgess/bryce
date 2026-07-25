CREATE TABLE `highlightly_box_score_cache` (
	`match_id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`rate_remaining` integer,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `highlightly_match_cache` (
	`match_id` integer PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`payload` text NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`rate_remaining` integer,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `highlightly_match_cache_season_idx` ON `highlightly_match_cache` (`season`);--> statement-breakpoint
CREATE TABLE `highlightly_player_cursors` (
	`player_id` integer PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`next_match_date` text,
	`last_complete_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "highlightly_cursor_season_ck" CHECK("highlightly_player_cursors"."season" >= 2000)
);
--> statement-breakpoint
DROP INDEX `stat_lines_player_game_type_uq`;--> statement-breakpoint
ALTER TABLE `stat_lines` ADD `source` text DEFAULT 'mlb_stats_api' NOT NULL;--> statement-breakpoint
ALTER TABLE `stat_lines` ADD `available_stats` text;--> statement-breakpoint
-- `sport_id` is immutable source history; player level is mutable and therefore unsafe here.
UPDATE `stat_lines` SET `source` = CASE WHEN `sport_id` = 22 THEN 'ncaa_html_legacy' ELSE 'mlb_stats_api' END;--> statement-breakpoint
CREATE UNIQUE INDEX `stat_lines_player_source_game_type_uq` ON `stat_lines` (`player_id`,`source`,`game_id`,`stat_type`);--> statement-breakpoint
ALTER TABLE `players` ADD `highlightly_player_id` integer;--> statement-breakpoint
ALTER TABLE `players` ADD `highlightly_team_id` integer;--> statement-breakpoint
ALTER TABLE `players` ADD `ncaa_source_state` text;--> statement-breakpoint
-- Existing NCAA history remains legacy and presentable until an explicit verified cutover.
UPDATE `players` SET `ncaa_source_state` = 'legacy_html' WHERE `level` = 'ncaa';--> statement-breakpoint
-- SQLite cannot add CHECK constraints without rebuilding the parent table. A
-- rebuild is unsafe here: stat_lines/list_members already reference players and
-- migrations run inside a transaction, where foreign_keys cannot be disabled.
-- These equivalent write guards preserve the invariant without risking history.
CREATE UNIQUE INDEX `players_highlightly_player_id_unique` ON `players` (`highlightly_player_id`);
--> statement-breakpoint
CREATE TRIGGER `players_ncaa_identity_state_insert_ck` BEFORE INSERT ON `players`
WHEN NOT ((NEW.`level` = 'ncaa' AND NEW.`external_id` IS NULL AND NEW.`ncaa_source_state` IN ('legacy_html', 'highlightly_pending', 'highlightly_active')) OR (NEW.`level` <> 'ncaa' AND NEW.`highlightly_player_id` IS NULL AND NEW.`ncaa_source_state` IS NULL))
BEGIN SELECT RAISE(ABORT, 'players NCAA identity/state constraint'); END;
--> statement-breakpoint
CREATE TRIGGER `players_ncaa_identity_state_update_ck` BEFORE UPDATE OF `level`, `external_id`, `highlightly_player_id`, `ncaa_source_state` ON `players`
WHEN NOT ((NEW.`level` = 'ncaa' AND NEW.`external_id` IS NULL AND NEW.`ncaa_source_state` IN ('legacy_html', 'highlightly_pending', 'highlightly_active')) OR (NEW.`level` <> 'ncaa' AND NEW.`highlightly_player_id` IS NULL AND NEW.`ncaa_source_state` IS NULL))
BEGIN SELECT RAISE(ABORT, 'players NCAA identity/state constraint'); END;
--> statement-breakpoint
CREATE TRIGGER `players_highlightly_active_identity_insert_ck` BEFORE INSERT ON `players`
WHEN NEW.`ncaa_source_state` = 'highlightly_active' AND NEW.`highlightly_player_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'active Highlightly player requires identity'); END;
--> statement-breakpoint
CREATE TRIGGER `players_highlightly_active_identity_update_ck` BEFORE UPDATE OF `highlightly_player_id`, `ncaa_source_state` ON `players`
WHEN NEW.`ncaa_source_state` = 'highlightly_active' AND NEW.`highlightly_player_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'active Highlightly player requires identity'); END;
