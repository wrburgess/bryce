-- #190: player_lists becomes a LANE (is_default + per-lane cadence/recipients),
-- and digest_deliveries gains the lane dimension its slot key was missing.
-- drizzle-kit generated the DDL and it is hand-extended below (house style:
-- 0004, 0008, 0009, 0011), because the generated form is wrong in three ways
-- this migration has to fix:
--
--   1. It emitted `ALTER TABLE digest_deliveries ADD list_id integer NOT NULL
--      REFERENCES player_lists(id)`. SQLite cannot add a NOT NULL column with no
--      default, and cannot add a REFERENCES column with a non-NULL default, so
--      the delivery table is REBUILT with the constraint present from creation.
--      That also removes the need for a separate "tighten to NOT NULL" step: the
--      backfill happens inside the copy, so there is no window in which the
--      column exists un-populated.
--   2. Its player_lists rebuild copied the four NEW columns from the OLD table
--      (`no such column: is_default`). Explicit column lists, new columns
--      OMITTED so SQLite applies their defaults, is the 0011 fix.
--   3. It carried no data steps at all — no default lane, no membership
--      backfill, no delivery backfill.
--
-- WHY player_lists IS REBUILT AT ALL. Three of the four columns could be plain
-- ADD COLUMNs. The two new CHECKs cannot: SQLite has no ALTER TABLE ... ADD
-- CONSTRAINT, and rules/backend.md wants the bounds enforced by the DATABASE,
-- not only by the service. So the table is rebuilt.
--
-- WHY THE list_members SHUFFLE. `PRAGMA foreign_keys=OFF` — which drizzle-kit
-- emits, and which SQLite's own 12-step ALTER TABLE procedure calls for — is a
-- NO-OP here: drizzle's migrator wraps every migration in BEGIN/COMMIT, and
-- SQLite ignores that pragma inside a transaction. `PRAGMA defer_foreign_keys`
-- does apply inside a transaction but does not rescue this case either: dropping
-- player_lists increments the deferred-violation counter for every list_members
-- row, and renaming a replacement table into place does not decrement it, so the
-- COMMIT fails. Both were tried and both fail with `FOREIGN KEY constraint
-- failed`. The fix is to order the statements so no constraint is ever violated,
-- even under immediate enforcement: park the child rows, empty the child table,
-- swap the parent, put the child rows back verbatim (ids included, so every
-- membership keeps its identity and its list).
--
-- THE DEFAULT LANE'S NAME IS NEVER STOLEN. The lane wants to be called
-- `Watchlist`. If a LIVE list already holds that name it belongs to the HC, and
-- this migration neither adopts it, merges into it, nor renames it — silently
-- rewriting curation is worse than an odd name, and failing outright would leave
-- the app unable to start. The recursive CTE picks the smallest free integer
-- suffix instead (`Watchlist 2`, `Watchlist 3`, ...). A SOFT-DELETED namesake is
-- not a collision: the name index is partial on `deleted_at IS NULL`, so the
-- plain `Watchlist` is taken. If all 1000 candidates were somehow taken, the
-- INSERT writes no row and the delivery rebuild below fails its NOT NULL — loud
-- and at migration time, never a silently lane-less database.
--
-- BACKFILL HONESTY. Every pre-existing delivery row is stamped with the default
-- lane, including `kind = 'heartbeat'` rows, which are not lane-scoped. That is a
-- known wart, recorded here rather than discovered later (#190). Until #193
-- routes lane-scoped sends onto the claimed path, every row carries one lane, so
-- the three-column unique index behaves exactly like the two-column one it
-- replaces — the risky index change lands early and provably inert.
--
-- ROLLBACK IS FORWARD-ONLY ONCE LANES ARE LIVE. Before lane-scoped deliveries
-- exist, down is lossless (drop the columns, rebuild without list_id, restore
-- the two-column index) because every row shares one list id. After #193, two
-- rows may legitimately share (kind, date_covered), and recreating the
-- two-column unique index would either fail or demand deleting delivery history.
-- A down step must therefore ABORT with an operator-actionable error in that
-- case, never silently merge or drop deliveries.

-- === player_lists: rebuild with the lane columns and their CHECKs ===========
CREATE TABLE `__new_player_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`is_default` integer DEFAULT false NOT NULL,
	`refresh_interval_minutes` integer,
	`digest_hour` integer,
	`digest_to` text,
	CONSTRAINT "player_lists_name_nonblank_ck" CHECK(length(trim("__new_player_lists"."name")) > 0),
	CONSTRAINT "player_lists_digest_hour_range_ck" CHECK("__new_player_lists"."digest_hour" is null or ("__new_player_lists"."digest_hour" >= 0 and "__new_player_lists"."digest_hour" <= 23)),
	CONSTRAINT "player_lists_refresh_interval_positive_ck" CHECK("__new_player_lists"."refresh_interval_minutes" is null or "__new_player_lists"."refresh_interval_minutes" > 0)
);
--> statement-breakpoint
-- EXPLICIT column lists on BOTH sides, OMITTING the four new columns so SQLite
-- applies their defaults (0011's fix: drizzle-kit named them on both sides,
-- which fails against the OLD five-column table). `id` is copied explicitly so
-- every existing list keeps its identity — list_members rows point at these ids.
INSERT INTO `__new_player_lists`("id", "name", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "created_at", "updated_at", "deleted_at" FROM `player_lists`;--> statement-breakpoint
-- Park the child rows so dropping the parent violates nothing (see header).
CREATE TABLE `__lane_list_members_backup` AS SELECT * FROM `list_members`;--> statement-breakpoint
DELETE FROM `list_members`;--> statement-breakpoint
DROP TABLE `player_lists`;--> statement-breakpoint
ALTER TABLE `__new_player_lists` RENAME TO `player_lists`;--> statement-breakpoint
-- Verbatim restoration, ids included: the same membership rows against the same
-- list ids, so no curation is rewritten and the unique index is unperturbed.
INSERT INTO `list_members`("id", "list_id", "player_id", "created_at") SELECT "id", "list_id", "player_id", "created_at" FROM `__lane_list_members_backup`;--> statement-breakpoint
DROP TABLE `__lane_list_members_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `player_lists_name_live_uq` ON `player_lists` (`name`) WHERE "player_lists"."deleted_at" is null;--> statement-breakpoint
-- Partial on BOTH predicates: a soft-deleted list holding is_default must not
-- block the live one, or deleting the default would make a replacement
-- unsettable.
CREATE UNIQUE INDEX `player_lists_default_uq` ON `player_lists` (`is_default`) WHERE "player_lists"."is_default" = 1 and "player_lists"."deleted_at" is null;--> statement-breakpoint

-- === seed the default lane at a guaranteed-free name ========================
-- digest_hour 5 and refresh_interval_minutes 1440 reproduce today's schedule
-- exactly (ops/templates/com.sk.digest.plist fires at 05:00;
-- ops/templates/com.sk.refresh.plist once a day at 03:30), so the lane describes
-- the behavior the host already has rather than proposing a new one.
INSERT INTO `player_lists` ("name", "created_at", "updated_at", "is_default", "refresh_interval_minutes", "digest_hour")
WITH RECURSIVE `candidate`(`n`, `label`) AS (
	SELECT 1, 'Watchlist'
	UNION ALL
	SELECT `n` + 1, 'Watchlist ' || (`n` + 1) FROM `candidate` WHERE `n` < 1000
)
SELECT `label`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1, 1440, 5
FROM `candidate`
WHERE `label` NOT IN (SELECT `name` FROM `player_lists` WHERE `deleted_at` IS NULL)
LIMIT 1;--> statement-breakpoint

-- === membership backfill: every ACTIVE player joins the default lane ========
-- `players.active` stays the master gate (ADR 0046 decision 2), so an inactive
-- player is deliberately NOT enrolled: re-activating him is the act that should
-- put him back in a lane, not a migration guessing on his behalf.
INSERT INTO `list_members` ("list_id", "player_id", "created_at")
SELECT (SELECT `id` FROM `player_lists` WHERE `is_default` = 1 AND `deleted_at` IS NULL), `id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `players` WHERE `active` = 1;--> statement-breakpoint

-- === digest_deliveries: rebuild carrying list_id NOT NULL from creation =====
-- NOT NULL is load-bearing, not housekeeping. SQLite treats NULLs as DISTINCT in
-- a unique index, so a nullable list_id would permit unlimited
-- (digest, <date>, NULL) rows and silently void the slot uniqueness ADR 0034's
-- durable claim rests on — surfacing as duplicate digests.
CREATE TABLE `__new_digest_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`date_covered` text NOT NULL,
	`sent_at` text,
	`player_count` integer DEFAULT 0 NOT NULL,
	`stat_line_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`claimed_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`provider_message_id` text,
	`reconciled_at` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`list_id` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `player_lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Every column named EXPLICITLY on both sides, never `SELECT *`: a positional
-- copy silently reorders or drops a column, and this table's history is the
-- record of what was mailed.
INSERT INTO `__new_digest_deliveries`("id", "kind", "date_covered", "sent_at", "player_count", "stat_line_count", "status", "claimed_at", "attempt_count", "provider_message_id", "reconciled_at", "error_message", "created_at", "list_id") SELECT "id", "kind", "date_covered", "sent_at", "player_count", "stat_line_count", "status", "claimed_at", "attempt_count", "provider_message_id", "reconciled_at", "error_message", "created_at", (SELECT `id` FROM `player_lists` WHERE `is_default` = 1 AND `deleted_at` IS NULL) FROM `digest_deliveries`;--> statement-breakpoint
DROP TABLE `digest_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_digest_deliveries` RENAME TO `digest_deliveries`;--> statement-breakpoint
-- The only pre-existing index on this table was digest_deliveries_kind_date_uq
-- (drizzle/0000); it is REPLACED by the three-column key rather than recreated.
-- No other index existed to restore.
CREATE UNIQUE INDEX `digest_deliveries_kind_date_list_uq` ON `digest_deliveries` (`kind`,`date_covered`,`list_id`);
