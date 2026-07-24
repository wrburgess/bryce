CREATE TABLE `player_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "player_lists_name_nonblank_ck" CHECK(length(trim("player_lists"."name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_lists_name_live_uq` ON `player_lists` (`name`) WHERE "player_lists"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `list_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `player_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_members_list_player_uq` ON `list_members` (`list_id`,`player_id`);
