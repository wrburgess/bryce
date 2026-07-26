import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db/client.js";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

describe("Highlightly migration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("preserves legacy NCAA rows under their immutable source namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "bryce-highlightly-migration-"));
    dirs.push(dir);
    const oldMigrations = join(dir, "old-migrations");
    cpSync(join(ROOT, "drizzle"), oldMigrations, { recursive: true });
    unlinkSync(join(oldMigrations, "0008_highlightly_ncaa.sql"));
    unlinkSync(join(oldMigrations, "meta", "0008_snapshot.json"));
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries.splice(-3);
    writeFileSync(journalPath, JSON.stringify(journal));

    const dbPath = join(dir, "bryce.db");
    const old = openDb(dbPath, { migrationsFolder: oldMigrations });
    old.sqlite.prepare(
      "INSERT INTO players (ncaa_player_seq, full_name, level, active, created_at, updated_at) VALUES (?, ?, 'ncaa', 1, ?, ?)",
    ).run(2649785, "Legacy Player", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    const playerId = (old.sqlite.prepare("SELECT id FROM players WHERE ncaa_player_seq = ?").get(2649785) as { id: number }).id;
    old.sqlite.prepare(
      "INSERT INTO stat_lines (player_id, game_id, stat_type, game_date, game_number, game_type, sport_id, stats, raw, created_at, updated_at) VALUES (?, 77, 'batting', '2026-03-01', 1, 'R', 22, '{}', '{}', ?, ?)",
    ).run(playerId, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    old.close();

    const migrated = openDb(dbPath);
    try {
      expect(migrated.sqlite.prepare("SELECT ncaa_source_state FROM players WHERE id = ?").get(playerId)).toEqual({ ncaa_source_state: "legacy_html" });
      expect(migrated.sqlite.prepare("SELECT source FROM stat_lines WHERE player_id = ?").get(playerId)).toEqual({ source: "ncaa_html_legacy" });
    } finally {
      migrated.close();
    }
  });

  it("normalizes a stale dual professional/NCAA row without changing its local id", () => {
    const dir = mkdtempSync(join(tmpdir(), "bryce-promotion-normalization-"));
    dirs.push(dir);
    const before0009 = join(dir, "before-0009");
    cpSync(join(ROOT, "drizzle"), before0009, { recursive: true });
    unlinkSync(join(before0009, "0009_dizzy_zodiak.sql"));
    unlinkSync(join(before0009, "meta", "0009_snapshot.json"));
    const journalPath = join(before0009, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries.splice(-2);
    writeFileSync(journalPath, JSON.stringify(journal));
    const dbPath = join(dir, "bryce.db");
    const old = openDb(dbPath, { migrationsFolder: before0009 });
    // Model a real stale database written before the old guard existed. The
    // migration's job is to normalize this otherwise-safe historical shape.
    old.sqlite.exec(`
      DROP TRIGGER players_ncaa_identity_state_insert_ck;
      DROP TRIGGER players_ncaa_identity_state_update_ck;
      CREATE TRIGGER players_ncaa_identity_state_insert_ck BEFORE INSERT ON players WHEN 0 BEGIN SELECT RAISE(ABORT, 'unreachable'); END;
      CREATE TRIGGER players_ncaa_identity_state_update_ck BEFORE UPDATE OF level, external_id, highlightly_player_id, ncaa_source_state ON players WHEN 0 BEGIN SELECT RAISE(ABORT, 'unreachable'); END;
    `);
    old.sqlite.prepare("INSERT INTO players (external_id, ncaa_player_seq, highlightly_player_id, highlightly_team_id, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'mlb', 1, ?, ?)")
      .run(691185, 2649785, 501, 10, "highlightly_active", "Already Pro", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    const id = (old.sqlite.prepare("SELECT id FROM players WHERE external_id = 691185").get() as { id: number }).id;
    old.close();
    const migrated = openDb(dbPath);
    try {
      expect(migrated.sqlite.prepare("SELECT id, external_id, ncaa_player_seq, highlightly_player_id, highlightly_team_id, ncaa_source_state FROM players WHERE id = ?").get(id)).toEqual({ id, external_id: 691185, ncaa_player_seq: null, highlightly_player_id: null, highlightly_team_id: null, ncaa_source_state: null });
    } finally { migrated.close(); }
  });

  it("permits an atomic direct NCAA-to-professional conversion after the migration", () => {
    const opened = openDb(":memory:");
    try {
      const now = "2026-07-01T00:00:00.000Z";
      opened.sqlite.prepare("INSERT INTO players (highlightly_player_id, highlightly_team_id, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (501, 10, 'highlightly_active', 'College', 'ncaa', 1, ?, ?)").run(now, now);
      opened.sqlite.prepare("UPDATE players SET external_id = 77, ncaa_player_seq = NULL, highlightly_player_id = NULL, highlightly_team_id = NULL, ncaa_source_state = NULL, level = 'mlb' WHERE highlightly_player_id = 501").run();
      expect(opened.sqlite.prepare("SELECT external_id, ncaa_player_seq, highlightly_player_id, highlightly_team_id, ncaa_source_state, level FROM players").get())
        .toEqual({ external_id: 77, ncaa_player_seq: null, highlightly_player_id: null, highlightly_team_id: null, ncaa_source_state: null, level: "mlb" });
    } finally { opened.close(); }
  });

  it("rejects every illegal direct NCAA-to-professional intermediate shape after the migration", () => {
    const opened = openDb(":memory:");
    try {
      const now = "2026-07-01T00:00:00.000Z";
      expect(() => opened.sqlite.prepare("INSERT INTO players (ncaa_player_seq, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (99, 'highlightly_active', 'Missing Highlightly Identity', 'ncaa', 1, ?, ?)").run(now, now)).toThrow(/active Highlightly player requires identity/);
      expect(() => opened.sqlite.prepare("INSERT INTO players (external_id, highlightly_player_id, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (77, 501, 'highlightly_active', 'Bad', 'ncaa', 1, ?, ?)").run(now, now)).toThrow(/identity\/state constraint/);
      for (const stale of [
        "ncaa_player_seq = 99",
        "highlightly_player_id = 501",
        "highlightly_team_id = 10",
        "ncaa_source_state = 'highlightly_active'",
      ]) {
        opened.sqlite.prepare("INSERT INTO players (highlightly_player_id, highlightly_team_id, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (501, 10, 'highlightly_active', 'College', 'ncaa', 1, ?, ?)").run(now, now);
        expect(() => opened.sqlite.prepare(`UPDATE players SET level = 'mlb', external_id = 77, ${stale} WHERE highlightly_player_id = 501`).run()).toThrow(/identity\/state constraint/);
        opened.sqlite.prepare("DELETE FROM players WHERE highlightly_player_id = 501").run();
      }
    } finally { opened.close(); }
  });

  it("aborts 0009 with an actionable identity diagnostic and leaves the old triggers intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "bryce-identity-audit-"));
    dirs.push(dir);
    const before0009 = join(dir, "before-0009");
    cpSync(join(ROOT, "drizzle"), before0009, { recursive: true });
    unlinkSync(join(before0009, "0009_dizzy_zodiak.sql"));
    unlinkSync(join(before0009, "meta", "0009_snapshot.json"));
    const journalPath = join(before0009, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries.splice(-2);
    writeFileSync(journalPath, JSON.stringify(journal));

    const dbPath = join(dir, "bryce.db");
    const pre = openDb(dbPath, { migrationsFolder: before0009 });
    // This was permitted by the pre-0009 trigger, but is deliberately
    // unclassifiable under the one-current-identity invariant.
    pre.sqlite.prepare(
      "INSERT INTO players (full_name, level, active, created_at, updated_at) VALUES (?, 'mlb', 1, ?, ?)",
    ).run("Unclassifiable Pro", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    pre.close();

    let migrationError: unknown;
    try {
      openDb(dbPath);
    } catch (error) {
      migrationError = error;
    }
    expect(migrationError).toBeDefined();
    // drizzle wraps the driver error with the SQL text; the actionable SQLite
    // abort remains its cause and is what startup/error reporting exposes.
    expect((migrationError as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(String((migrationError as { cause: Error }).cause.message)).toMatch(/0009 migration aborted: a player violates the current NCAA\/pro identity-state invariant/);

    // The failed migration rolls back before dropping/replacing 0008's guards.
    const raw = new Database(dbPath);
    try {
      const row = raw.prepare("SELECT external_id FROM players WHERE full_name = ?").get("Unclassifiable Pro") as { external_id: number | null };
      expect(row.external_id).toBeNull();
      const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'players_ncaa_identity_state_update_ck'").get() as { sql: string };
      expect(trigger.sql).toContain("NEW.`level` <> 'ncaa'");
      expect(trigger.sql).not.toContain("NEW.`external_id` IS NOT NULL");
    } finally {
      raw.close();
    }
  });

  it("audits a deployed active Highlightly row missing its provider identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "bryce-active-highlightly-audit-"));
    dirs.push(dir);
    const before0009 = join(dir, "before-0009");
    cpSync(join(ROOT, "drizzle"), before0009, { recursive: true });
    unlinkSync(join(before0009, "0009_dizzy_zodiak.sql"));
    unlinkSync(join(before0009, "meta", "0009_snapshot.json"));
    const journalPath = join(before0009, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries.splice(-2);
    writeFileSync(journalPath, JSON.stringify(journal));

    const dbPath = join(dir, "bryce.db");
    const pre = openDb(dbPath, { migrationsFolder: before0009 });
    // Simulate a deployed database in which the 0008 source-specific guard was
    // bypassed.  Its legacy NCAA identity is otherwise valid, so 0009's new
    // audit predicate specifically has to reject the missing Highlightly id.
    pre.sqlite.exec("DROP TRIGGER players_highlightly_active_identity_insert_ck;");
    pre.sqlite.prepare(
      "INSERT INTO players (ncaa_player_seq, ncaa_source_state, full_name, level, active, created_at, updated_at) VALUES (?, 'highlightly_active', ?, 'ncaa', 1, ?, ?)",
    ).run(2649785, "Bad Active NCAA", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    pre.close();

    let migrationError: unknown;
    try {
      openDb(dbPath);
    } catch (error) {
      migrationError = error;
    }
    expect((migrationError as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(String((migrationError as { cause: Error }).cause.message)).toMatch(
      /0009 migration aborted: a player violates the current NCAA\/pro identity-state invariant/,
    );
  });
});
