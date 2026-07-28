import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { MIGRATIONS_FOLDER, openDb } from "../src/db/client.js";
import { refreshRuns } from "../src/db/schema.js";
import type { TempDir, TempMigrations } from "./backup-helpers.js";
import { copyProdMigrationsThrough, makeTempDir } from "./backup-helpers.js";

/**
 * drizzle/0013 — `refresh_runs` gains `scope_list_ids` (#192, ADR 0061).
 *
 * Applied to a REAL database built by running 0000-0012 through the actual
 * drizzle migrator, not a hand-seeded lookalike: the question that matters is
 * whether this migration works against the schema the HC's laptop holds
 * (rules/testing.md), and `refresh_runs` in particular was already rebuilt once
 * by 0011 and left alone by 0012's table shuffle.
 *
 * The load-bearing assertion is `PRAGMA table_info` AFTER THE FULL CHAIN. A test
 * that only applied the `.sql` by hand would pass with the drizzle JOURNAL entry
 * missing — and a journal-less migration is never discovered, so the column
 * would silently not exist, every scope would be written nowhere, and the
 * freshness guard would be an inert no-op WITH THE SUITE GREEN (a fresh test
 * database is built from that same journal).
 */

/** The last migration index BEFORE the one under test. */
const PRE_SCOPE_IDX = 12;

interface PreScopeDb {
  path: string;
  sqlite: Database.Database;
  /** Apply the rest of the production migrations — 0013 included. */
  applyScopeMigration: () => OpenedDb;
  cleanup: () => void;
}

function openPreScopeDb(): PreScopeDb {
  const live: TempDir = makeTempDir("bryce-scope-");
  const through12: TempMigrations = copyProdMigrationsThrough(PRE_SCOPE_IDX);
  const path = join(live.path, "bryce.db");
  const pre = openDb(path, { migrationsFolder: through12.dir });
  let opened: OpenedDb | null = null;
  return {
    path,
    sqlite: pre.sqlite,
    applyScopeMigration: () => {
      pre.close();
      opened = openDb(path, { migrationsFolder: MIGRATIONS_FOLDER });
      return opened;
    },
    cleanup: () => {
      try {
        opened?.close();
      } catch {
        // already closed
      }
      try {
        pre.close();
      } catch {
        // already closed
      }
      through12.cleanup();
      live.cleanup();
    },
  };
}

/** Insert a settled run into the PRE-scope schema (raw SQL: the ORM knows the new shape). */
function seedRun(sqlite: Database.Database, startedAt: string): number {
  const info = sqlite
    .prepare(
      "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, players_refreshed," +
        " players_skipped, players_failed, players_total, stat_lines_inserted, stat_lines_updated," +
        " error_message, created_at) VALUES (?, ?, 'ok', ?, 3, 0, 0, 3, 7, 1, NULL, ?)",
    )
    .run(startedAt, "2026-07-19T07:05:00.000Z", startedAt, startedAt);
  return Number(info.lastInsertRowid);
}

describe("drizzle/0013 refresh_runs scope column (#192)", () => {
  let pre: PreScopeDb;

  beforeEach(() => {
    pre = openPreScopeDb();
  });

  afterEach(() => {
    pre.cleanup();
  });

  it("adds scope_list_ids to refresh_runs when the FULL migration chain runs", () => {
    const opened = pre.applyScopeMigration();

    // The journal-entry guard: discovered by the migrator, or this is absent.
    const columns = opened.sqlite
      .prepare("PRAGMA table_info(refresh_runs)")
      .all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
    const scope = columns.find((c) => c.name === "scope_list_ids");
    expect(scope).toBeDefined();
    // Nullable and undefaulted: NULL is a MEANING here ("the whole Watch List"),
    // so the column must be able to hold it.
    expect(scope).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("leaves every pre-existing run NULL — the whole-Watch-List reading, correct by construction", async () => {
    const olderId = seedRun(pre.sqlite, "2026-07-18T07:00:00.000Z");
    const newerId = seedRun(pre.sqlite, "2026-07-19T07:00:00.000Z");

    const opened = pre.applyScopeMigration();

    const rows = await opened.db.select().from(refreshRuns);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([olderId, newerId]);
    for (const row of rows) expect(row.scopeListIds).toBeNull();
    // Every other column survived the additive ALTER untouched.
    expect(rows.find((r) => r.id === newerId)).toMatchObject({
      status: "ok",
      playersRefreshed: 3,
      playersTotal: 3,
      statLinesInserted: 7,
      statLinesUpdated: 1,
    });
  });

  it("keeps referential integrity intact across the chain", () => {
    seedRun(pre.sqlite, "2026-07-19T07:00:00.000Z");
    const opened = pre.applyScopeMigration();

    expect(opened.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("is applied once: a second startup neither re-adds the column nor duplicates a run", async () => {
    seedRun(pre.sqlite, "2026-07-19T07:00:00.000Z");
    const first = pre.applyScopeMigration();
    first.close();

    // A re-run of `ALTER TABLE ... ADD COLUMN` is an error, not a no-op, so this
    // is what proves the journal bookkeeping landed rather than the DDL merely
    // having succeeded once.
    const second = openDb(pre.path, { migrationsFolder: MIGRATIONS_FOLDER });
    try {
      expect(await second.db.select().from(refreshRuns)).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
