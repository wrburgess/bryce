CREATE TABLE `player_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "player_tags_source_ck" CHECK("player_tags"."source" in ('derived', 'manual')),
	CONSTRAINT "player_tags_namespace_nonblank_ck" CHECK(length("player_tags"."namespace") > 0),
	CONSTRAINT "player_tags_value_nonblank_ck" CHECK(length("player_tags"."value") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_tags_player_ns_value_uq` ON `player_tags` (`player_id`,`namespace`,`value`);--> statement-breakpoint
CREATE INDEX `player_tags_ns_value_idx` ON `player_tags` (`namespace`,`value`);--> statement-breakpoint
CREATE UNIQUE INDEX `player_tags_level_single_uq` ON `player_tags` (`player_id`,`namespace`) WHERE "player_tags"."namespace" = 'level';