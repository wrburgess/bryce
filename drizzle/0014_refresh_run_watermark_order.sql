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
-- THE GENERATED DDL IS USED AS EMITTED except for ONE expression in the copy —
-- `max("started_at", "claimed_at")` where drizzle-kit wrote a bare
-- `"claimed_at"` — for the legacy rows described next. 0011's and 0012's
-- hand-surgery was different in kind: they ADDED columns, so drizzle-kit's
-- symmetric column lists named a column the OLD table did not have (`no such
-- column: players_skipped`). This migration adds NO column: all fourteen exist
-- on both sides, `id` included, so the generated explicit lists are already
-- correct and every historical run keeps its AUTOINCREMENT identity. Both lists
-- stay explicit and identical in ORDER — 0012 already set the precedent that the
-- SELECT side may carry an expression (its `list_id` backfill subquery) while the
-- column lists stay column-for-column. They were read column by column against
-- the schema rather than trusted; a positional `SELECT *` copy is what silently
-- reorders a table whose history is the record of what ingestion did.
--
-- A LEGACY ROW CAN VIOLATE IT, so the copy REPAIRS rather than assumes. An
-- earlier revision of this header asserted no existing row could violate the new
-- CHECK, on the argument that `renewRefreshRun` "moves `claimed_at` strictly
-- FORWARD". That was an assumption stated as a fact, and it is false: before this
-- PR `renewRefreshRun` wrote a bare `now.toISOString()` with NO comparison
-- against the row's existing instants, and its live-lease WHERE
-- (`claimed_at > now - REFRESH_LEASE_MS`) does not stand in for one: that test
-- refuses a claim too OLD relative to `now`, and a clock that steps BACKWARD
-- moves the cutoff earlier with it, so the stored claim stays above the cutoff at
-- any step size. A backward clock therefore always wrote a REGRESSED
-- `claimed_at`. Such a row is perfectly valid on a pre-0014 database; copied
-- verbatim it fails the new CHECK, and because drizzle wraps each migration in a
-- transaction that failure is a rolled-back startup — `openDb()` never completes
-- and the application cannot start at all. Fatal, not loud-but-harmless.
--
-- WHY `max(started_at, claimed_at)` REPAIRS IT RATHER THAN INVENTING A VALUE.
-- Every row present when this migration runs was written by the PRE-#193 writer
-- (the split and this migration ship in the same commit, and drizzle applies the
-- chain inside `openDb` before any new-code insert can run), and that writer's
-- `claimRefreshRun` inserted `started_at` and `claimed_at` from ONE `nowIso`
-- string (origin/main, src/jobs/refresh-run.ts). So on a legacy row `started_at`
-- IS the original claim instant, and an inversion can only have come from a
-- regressed renewal. Restoring `claimed_at` to `started_at` therefore returns the
-- row to the instant it actually claimed at — it cannot extend that row's lease
-- beyond what the row itself once held, and for the ordered rows (the whole real
-- installed base) `max` returns `claimed_at` unchanged, so this is a no-op there.
-- THE ALTERNATIVE — lowering `started_at` to `claimed_at` — was rejected: it is
-- conservative for freshness (an earlier start only ever weakens a coverage
-- claim) but it discards the run's REAL selection instant and enshrines the
-- clock-error value as the watermark every coverage test keys on. Repairing the
-- corrupt column beats corrupting the sound one.
--
-- `max()` HERE IS THE TWO-ARGUMENT SCALAR FUNCTION, not the aggregate — SQLite
-- distinguishes them by arity, and with two arguments it returns the larger under
-- the usual sort order (BINARY collation on TEXT), which for the ISO-8601 UTC
-- strings both columns hold is chronological order. It returns NULL if EITHER
-- argument is NULL; that arm is unreachable here rather than merely unlikely,
-- because `started_at` and `claimed_at` are both `text NOT NULL` on the source
-- table (drizzle/0011, and drizzle/0005 before it) — and the destination declares
-- them NOT NULL too, so a NULL would abort the migration rather than pass.
--
-- GOING FORWARD the writer upholds the invariant on its own: `renewRefreshRun`
-- now clamps its write to `max(now, started_at)` (src/jobs/refresh-run.ts), so no
-- future row can be inverted and this repair covers only what pre-0014 databases
-- may already carry.
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
INSERT INTO `__new_refresh_runs`("id", "started_at", "finished_at", "status", "claimed_at", "players_refreshed", "players_skipped", "players_failed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "scope_list_ids", "created_at") SELECT "id", "started_at", "finished_at", "status", max("started_at", "claimed_at"), "players_refreshed", "players_skipped", "players_failed", "players_total", "stat_lines_inserted", "stat_lines_updated", "error_message", "scope_list_ids", "created_at" FROM `refresh_runs`;--> statement-breakpoint
DROP TABLE `refresh_runs`;--> statement-breakpoint
ALTER TABLE `__new_refresh_runs` RENAME TO `refresh_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refresh_runs_status_started_idx` ON `refresh_runs` (`status`,`started_at`);