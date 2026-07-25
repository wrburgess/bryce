import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
    journal.entries.pop();
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
});
