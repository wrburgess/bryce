-- #35: a Player has one CURRENT natural identity. Clean up the only safely
-- classifiable legacy shape before tightening the write guards.
UPDATE `players` SET `ncaa_player_seq` = NULL, `highlightly_player_id` = NULL,
  `highlightly_team_id` = NULL, `ncaa_source_state` = NULL
WHERE `level` <> 'ncaa' AND `external_id` IS NOT NULL AND (`ncaa_player_seq` IS NOT NULL OR `highlightly_player_id` IS NOT NULL OR `highlightly_team_id` IS NOT NULL OR `ncaa_source_state` IS NOT NULL);
--> statement-breakpoint
-- SQLite only permits RAISE() inside a trigger.  This temporary audit trigger
-- gives an actionable invariant error (rather than the opaque former CHECK
-- failure) and, because migrations are transactional, leaves old triggers
-- intact so the offending player can be repaired safely before retrying.
CREATE TEMP TABLE `__players_identity_audit` (`player_id` integer NOT NULL);
--> statement-breakpoint
CREATE TEMP TRIGGER `__players_identity_audit_abort` BEFORE INSERT ON `__players_identity_audit`
BEGIN SELECT RAISE(ABORT, '0009 migration aborted: a player violates the current NCAA/pro identity-state invariant; repair the offending player before retrying'); END;
--> statement-breakpoint
INSERT INTO `__players_identity_audit` (`player_id`) SELECT `id` FROM `players` WHERE (`level` = 'ncaa' AND (`external_id` IS NOT NULL OR (`ncaa_player_seq` IS NULL AND `highlightly_player_id` IS NULL) OR (`ncaa_source_state` = 'highlightly_active' AND `highlightly_player_id` IS NULL) OR `ncaa_source_state` NOT IN ('legacy_html', 'highlightly_pending', 'highlightly_active') OR `ncaa_source_state` IS NULL)) OR (`level` NOT IN ('mlb', 'milb', 'ncaa')) OR (`level` IN ('mlb', 'milb') AND (`external_id` IS NULL OR `ncaa_player_seq` IS NOT NULL OR `highlightly_player_id` IS NOT NULL OR `highlightly_team_id` IS NOT NULL OR `ncaa_source_state` IS NOT NULL));
--> statement-breakpoint
DROP TRIGGER `__players_identity_audit_abort`;
--> statement-breakpoint
DROP TABLE `__players_identity_audit`;
--> statement-breakpoint
DROP TRIGGER `players_ncaa_identity_state_insert_ck`;--> statement-breakpoint
DROP TRIGGER `players_ncaa_identity_state_update_ck`;--> statement-breakpoint
DROP TRIGGER `players_highlightly_active_identity_insert_ck`;--> statement-breakpoint
DROP TRIGGER `players_highlightly_active_identity_update_ck`;--> statement-breakpoint
CREATE TRIGGER `players_ncaa_identity_state_insert_ck` BEFORE INSERT ON `players`
WHEN NOT ((NEW.`level` = 'ncaa' AND NEW.`external_id` IS NULL AND (NEW.`ncaa_player_seq` IS NOT NULL OR NEW.`highlightly_player_id` IS NOT NULL) AND NEW.`ncaa_source_state` IN ('legacy_html', 'highlightly_pending', 'highlightly_active')) OR (NEW.`level` IN ('mlb', 'milb') AND NEW.`external_id` IS NOT NULL AND NEW.`ncaa_player_seq` IS NULL AND NEW.`highlightly_player_id` IS NULL AND NEW.`highlightly_team_id` IS NULL AND NEW.`ncaa_source_state` IS NULL))
BEGIN SELECT RAISE(ABORT, 'players NCAA/pro identity/state constraint'); END;
--> statement-breakpoint
CREATE TRIGGER `players_ncaa_identity_state_update_ck` BEFORE UPDATE OF `level`, `external_id`, `ncaa_player_seq`, `highlightly_player_id`, `highlightly_team_id`, `ncaa_source_state` ON `players`
WHEN NOT ((NEW.`level` = 'ncaa' AND NEW.`external_id` IS NULL AND (NEW.`ncaa_player_seq` IS NOT NULL OR NEW.`highlightly_player_id` IS NOT NULL) AND NEW.`ncaa_source_state` IN ('legacy_html', 'highlightly_pending', 'highlightly_active')) OR (NEW.`level` IN ('mlb', 'milb') AND NEW.`external_id` IS NOT NULL AND NEW.`ncaa_player_seq` IS NULL AND NEW.`highlightly_player_id` IS NULL AND NEW.`highlightly_team_id` IS NULL AND NEW.`ncaa_source_state` IS NULL))
BEGIN SELECT RAISE(ABORT, 'players NCAA/pro identity/state constraint'); END;
--> statement-breakpoint
CREATE TRIGGER `players_highlightly_active_identity_insert_ck` BEFORE INSERT ON `players`
WHEN NEW.`ncaa_source_state` = 'highlightly_active' AND NEW.`highlightly_player_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'active Highlightly player requires identity'); END;
--> statement-breakpoint
CREATE TRIGGER `players_highlightly_active_identity_update_ck` BEFORE UPDATE OF `highlightly_player_id`, `ncaa_source_state` ON `players`
WHEN NEW.`ncaa_source_state` = 'highlightly_active' AND NEW.`highlightly_player_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'active Highlightly player requires identity'); END;
