ALTER TABLE `players` ADD `ncaa_player_seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `players_ncaa_player_seq_unique` ON `players` (`ncaa_player_seq`);