CREATE TABLE `refresh_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`claimed_at` text NOT NULL,
	`players_refreshed` integer DEFAULT 0 NOT NULL,
	`players_total` integer DEFAULT 0 NOT NULL,
	`stat_lines_inserted` integer DEFAULT 0 NOT NULL,
	`stat_lines_updated` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	CONSTRAINT "refresh_runs_status_ck" CHECK("refresh_runs"."status" in ('running', 'ok', 'partial', 'failed')),
	CONSTRAINT "refresh_runs_finished_iff_terminal_ck" CHECK(("refresh_runs"."status" = 'running' and "refresh_runs"."finished_at" is null) or ("refresh_runs"."status" <> 'running' and "refresh_runs"."finished_at" is not null)),
	CONSTRAINT "refresh_runs_players_refreshed_nonneg_ck" CHECK("refresh_runs"."players_refreshed" >= 0),
	CONSTRAINT "refresh_runs_players_total_nonneg_ck" CHECK("refresh_runs"."players_total" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_inserted_nonneg_ck" CHECK("refresh_runs"."stat_lines_inserted" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_updated_nonneg_ck" CHECK("refresh_runs"."stat_lines_updated" >= 0)
);
--> statement-breakpoint
CREATE INDEX `refresh_runs_status_started_idx` ON `refresh_runs` (`status`,`started_at`);