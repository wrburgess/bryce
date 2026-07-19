CREATE TABLE `digest_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`date_covered` text NOT NULL,
	`sent_at` text,
	`player_count` integer DEFAULT 0 NOT NULL,
	`stat_line_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_deliveries_kind_date_uq` ON `digest_deliveries` (`kind`,`date_covered`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` integer,
	`full_name` text NOT NULL,
	`level` text NOT NULL,
	`milb_level` text,
	`team_name` text,
	`position` text,
	`school_name` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_external_id_unique` ON `players` (`external_id`);--> statement-breakpoint
CREATE TABLE `season_calendar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sport_id` integer NOT NULL,
	`season` text NOT NULL,
	`regular_season_start` text,
	`regular_season_end` text,
	`post_season_start` text,
	`post_season_end` text,
	`spring_start` text,
	`spring_end` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_calendar_sport_season_uq` ON `season_calendar` (`sport_id`,`season`);--> statement-breakpoint
CREATE TABLE `stat_lines` (
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
	`digest_delivery_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`digest_delivery_id`) REFERENCES `digest_deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stat_lines_player_game_type_uq` ON `stat_lines` (`player_id`,`game_id`,`stat_type`);