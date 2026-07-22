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
	CONSTRAINT `refresh_runs_status_ck` CHECK (`status` IN ('running', 'ok', 'partial', 'failed')),
	CONSTRAINT `refresh_runs_finished_iff_terminal_ck` CHECK ((`status` = 'running' AND `finished_at` IS NULL) OR (`status` <> 'running' AND `finished_at` IS NOT NULL)),
	CONSTRAINT `refresh_runs_players_refreshed_nonneg_ck` CHECK (`players_refreshed` >= 0),
	CONSTRAINT `refresh_runs_players_total_nonneg_ck` CHECK (`players_total` >= 0),
	CONSTRAINT `refresh_runs_stat_lines_inserted_nonneg_ck` CHECK (`stat_lines_inserted` >= 0),
	CONSTRAINT `refresh_runs_stat_lines_updated_nonneg_ck` CHECK (`stat_lines_updated` >= 0)
);
