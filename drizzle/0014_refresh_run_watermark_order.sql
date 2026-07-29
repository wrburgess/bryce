-- #193 (PR #203 delta review): `started_at <= claimed_at` becomes a DATABASE
-- invariant. This PR split the two instants — `started_at` is now the sweep's
-- SELECTION watermark and `claimed_at` its CLAIM instant, several database reads
-- later — and their ORDER is load-bearing: coverage is judged against
-- `started_at` (`latestCoveringRun`'s membership test) and the lease against
-- `claimed_at`. An inverted row would claim a selection that happened AFTER the
-- claim, dating every enrollment made inside the run's own selection-to-claim
-- gap as already swept — the forged `fresh` banner the split exists to prevent,
-- re-entered through the row itself.
--
-- WHY A MIGRATION AT ALL. ADR 0062 decision 2 said the split needed none, and
-- for the split alone that was true: no column's type changed. It is the new
-- CHECK that needs one. SQLite has no ALTER TABLE ... ADD CONSTRAINT, so the
-- table is REBUILT — the same reason drizzle/0011 rebuilt this table for the two
-- *_nonneg_ck CHECKs and drizzle/0012 rebuilt player_lists for its two.
--
-- THE GENERATED DDL IS USED VERBATIM, unlike 0011's and 0012's. Those needed
-- hand-surgery because they ADDED columns, so drizzle-kit's symmetric column
-- lists named a column the OLD table did not have (`no such column:
-- players_skipped`). This migration adds NO column: all fourteen exist on both
-- sides, `id` included, so the generated explicit lists are already correct and
-- every historical run keeps its AUTOINCREMENT identity. Both statement lists
-- were read column by column against the schema rather than trusted — a
-- positional `SELECT *` copy is what silently reorders a table whose history is
-- the record of what ingestion did.
--
-- NO EXISTING ROW VIOLATES IT, and this is a fact about the writer rather than a
-- hope: before this PR `claimRefreshRun` inserted `started_at` and `claimed_at`
-- from ONE `nowIso` string (origin/main, src/jobs/refresh-run.ts), so every
-- historical row has them EQUAL, which `<=` admits. The only other writer,
-- `renewRefreshRun`, moves `claimed_at` strictly FORWARD. So the copy below
-- cannot fail on real data — and if it somehow did, drizzle wraps each migration
-- in a transaction, so the failure is a loud rollback at startup with the
-- database untouched, never a half-rebuilt table.
--
-- EVERY INDEX AND CONSTRAINT IS CARRIED, not just the new one:
-- refresh_runs_status_started_idx (drizzle/0011) is recreated after the rename —
-- a rebuild drops the old table's indexes with it — and the eight CHECKs from
-- 0011 plus `scope_list_ids` from 0013 are all present in the new definition.
-- They are declared in src/db/schema.ts, which is what makes this generated file
-- re-emit them (rules/backend.md) instead of quietly dropping the ones that
-- lived only in an older migration's SQL.
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
	`scope_list_ids` text,
	`created_at` text NOT NULL,
	CONSTRAINT "refresh_runs_status_ck" CHECK("__new_refresh_runs"."status" in ('running', 'ok', 'partial', 'failed')),
	CONSTRAINT "refresh_runs_finished_iff_terminal_ck" CHECK(("__new_refresh_runs"."status" = 'running' and "__new_refresh_runs"."finished_at" is null) or ("__new_refresh_runs"."status" <> 'running' and "__new_refresh_runs"."finished_at" is not null)),
	CONSTRAINT "refresh_runs_players_refreshed_nonneg_ck" CHECK("__new_refresh_runs"."players_refreshed" >= 0),
	CONSTRAINT "refresh_runs_players_skipped_nonneg_ck" CHECK("__new_refresh_runs"."players_skipped" >= 0),
	CONSTRAINT "refresh_runs_players_failed_nonneg_ck" CHECK("__new_refresh_runs"."players_failed" >= 0),
	CONSTRAINT "refresh_runs_players_total_nonneg_ck" CHECK("__new_refresh_runs"."players_total" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_inserted_nonneg_ck" CHECK("__new_refresh_runs"."stat_lines_inserted" >= 0),
	CONSTRAINT "refresh_runs_stat_lines_updated_nonneg_ck" CHECK("__new_refresh_runs"."stat_lines_updated" >= 0),
	CONSTRAINT "refresh_runs_started_before_claimed_ck" CHECK("__new_refresh_runs"."started_at" <= "__new_refresh_runs"."claimed_at")
);
--> statement-breakpoint
INSERT INTO `__new_refresh_runs`("id", "started_at", "finished_at", "status", "claimed_at", "players_refreshed", "players_skipped", "players_failed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "scope_list_ids", "created_at") SELECT "id", "started_at", "finished_at", "status", "claimed_at", "players_refreshed", "players_skipped", "players_failed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "scope_list_ids", "created_at" FROM `refresh_runs`;--> statement-breakpoint
DROP TABLE `refresh_runs`;--> statement-breakpoint
ALTER TABLE `__new_refresh_runs` RENAME TO `refresh_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refresh_runs_status_started_idx` ON `refresh_runs` (`status`,`started_at`);