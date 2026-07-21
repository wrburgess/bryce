PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stat_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`game_id` integer NOT NULL,
	`stat_type` text NOT NULL,
	`game_date` text NOT NULL,
	`game_number` integer DEFAULT 1 NOT NULL,
	`game_type` text NOT NULL,
	`is_home` integer,
	`opponent_name` text,
	`team_name` text,
	`sport_id` integer NOT NULL,
	`league_name` text,
	`stats` text NOT NULL,
	`raw` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_stat_lines`("id", "player_id", "game_id", "stat_type", "game_date", "game_number", "game_type", "is_home", "opponent_name", "team_name", "sport_id", "league_name", "stats", "raw", "created_at", "updated_at") SELECT "id", "player_id", "game_id", "stat_type", "game_date", "game_number", "game_type", "is_home", "opponent_name", "team_name", "sport_id", "league_name", "stats", "raw", "created_at", "updated_at" FROM `stat_lines`;--> statement-breakpoint
DROP TABLE `stat_lines`;--> statement-breakpoint
ALTER TABLE `__new_stat_lines` RENAME TO `stat_lines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stat_lines_player_game_type_uq` ON `stat_lines` (`player_id`,`game_id`,`stat_type`);