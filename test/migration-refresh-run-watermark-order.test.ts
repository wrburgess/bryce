import { join } from "node:path";
import type Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { MIGRATIONS_FOLDER, openDb } from "../src/db/client.js";
import { refreshRuns } from "../src/db/schema.js";
import type { TempDir, TempMigrations } from "./backup-helpers.js";
import { copyProdMigrationsThrough, makeTempDir } from "./backup-helpers.js";

/**
 * drizzle/0014 — `refresh_runs` gains `started_at <= claimed_at` as a DATABASE
 * CHECK (#193, PR #203 delta review).
 *
 * This PR made the two columns DIFFERENT instants — the SELECTION watermark and
 * the CLAIM instant — and their ORDER became load-bearing: coverage is judged
 * against `started_at`, the lease against `claimed_at`. `rules/backend.md` wants
 * such an invariant enforced by the database and DECLARED IN THE ORM SCHEMA, and
 * SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so this is a table REBUILD —
 * the third one this repo has done (0011 on this same table, 0012 on
 * player_lists / digest_deliveries).
 *
 * A rebuild is the migration shape that silently LOSES things: a CHECK that
 * lived only in an older migration's SQL, an index dropped with the old table, a
 * column reordered by a positional copy, an id renumbered by AUTOINCREMENT. So
 * these cases assert the new constraint is ENFORCED, that all eight of 0011's
 * CHECKs and 0013's column came through with it, that the index was recreated,
 * and that pre-existing rows survived value-for-value with their ids — against a
 * REAL 0013-shaped database built by running 0000-0013 through the actual
 * migrator, never a hand-seeded lookalike (rules/testing.md).
 */

/** The last migration index BEFORE the one under test. */
const PRE_ORDER_IDX = 13;

interface PreOrderDb {
  path: string;
  sqlite: Database.Database;
  /** Apply the rest of the production migrations — 0014 included. */
  applyOrderMigration: () => OpenedDb;
  cleanup: () => void;
}

function openPreOrderDb(): PreOrderDb {
  const live: TempDir = makeTempDir("bryce-watermark-");
  const through13: TempMigrations = copyProdMigrationsThrough(PRE_ORDER_IDX);
  const path = join(live.path, "bryce.db");
  const pre = openDb(path, { migrationsFolder: through13.dir });
  let opened: OpenedDb | null = null;
  return {
    path,
    sqlite: pre.sqlite,
    applyOrderMigration: () => {
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
      through13.cleanup();
      live.cleanup();
    },
  };
}

/**
 * Insert a run into the PRE-0014 schema (raw SQL: the constraint under test does
 * not exist yet there, which is the whole point — a pre-migration database can
 * hold any pair of instants, so a case may seed exactly the shape it means to).
 */
function seedRun(
  sqlite: Database.Database,
  args: { startedAt: string; claimedAt: string; scopeListIds?: string | null },
): number {
  const info = sqlite
    .prepare(
      "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, players_refreshed," +
        " players_skipped, players_failed, players_total, stat_lines_inserted, stat_lines_updated," +
        " error_message, scope_list_ids, created_at) VALUES (?, ?, 'ok', ?, 3, 1, 2, 6, 7, 1, NULL, ?, ?)",
    )
    .run(
      args.startedAt,
      "2026-07-19T07:05:00.000Z",
      args.claimedAt,
      args.scopeListIds ?? null,
      args.claimedAt,
    );
  return Number(info.lastInsertRowid);
}

/** Attempt an insert against the MIGRATED schema, returning the thrown message. */
function insertRunRaw(
  sqlite: Database.Database,
  args: { startedAt: string; claimedAt: string },
): void {
  sqlite
    .prepare(
      "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)" +
        " VALUES (?, '2026-07-19T07:05:00.000Z', 'ok', ?, ?)",
    )
    .run(args.startedAt, args.claimedAt, args.claimedAt);
}

describe("drizzle/0014 refresh_runs watermark ordering (#193, PR #203 delta review)", () => {
  let pre: PreOrderDb;

  beforeEach(() => {
    pre = openPreOrderDb();
  });

  afterEach(() => {
    pre.cleanup();
  });

  it("ENFORCES started_at <= claimed_at after the FULL migration chain", () => {
    const opened = pre.applyOrderMigration();

    // The load-bearing case: an inverted row is REFUSED, by name. A test that
    // only read the constraint out of `sqlite_master` would pass against a
    // migration that declared it somewhere SQLite never evaluates, and a
    // journal-less migration is never discovered at all — so the assertion is
    // the database's own refusal, at the end of the real chain.
    expect(() =>
      insertRunRaw(opened.sqlite, {
        startedAt: "2026-07-19T12:00:01.000Z",
        claimedAt: "2026-07-19T12:00:00.000Z",
      }),
    ).toThrow(/CHECK constraint failed: refresh_runs_started_before_claimed_ck/);
  });

  it("admits the two SHAPES the writer produces: equality, and a selection-to-claim gap", () => {
    const opened = pre.applyOrderMigration();

    // EQUALITY IS LEGAL, and this is the negative control without which the case
    // above would still pass against `<` — which would reject every pre-#193 row
    // and every caller that passes no separate watermark, i.e. the whole
    // installed base.
    expect(() =>
      insertRunRaw(opened.sqlite, {
        startedAt: "2026-07-19T12:00:00.000Z",
        claimedAt: "2026-07-19T12:00:00.000Z",
      }),
    ).not.toThrow();
    // ...and the shape this PR introduced: selected first, claimed a minute later.
    expect(() =>
      insertRunRaw(opened.sqlite, {
        startedAt: "2026-07-19T12:00:00.000Z",
        claimedAt: "2026-07-19T12:01:00.000Z",
      }),
    ).not.toThrow();

    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM refresh_runs").get()).toEqual({ n: 2 });
  });

  it("keeps every pre-existing row, id and column value alike, across the rebuild", () => {
    // Both legal historical shapes, and an id GAP: AUTOINCREMENT identity is
    // copied explicitly, so a rebuild that renumbered rows would show here.
    const equalId = seedRun(pre.sqlite, {
      startedAt: "2026-07-18T07:00:00.000Z",
      claimedAt: "2026-07-18T07:00:00.000Z",
    });
    const scopedId = seedRun(pre.sqlite, {
      startedAt: "2026-07-19T07:00:00.000Z",
      // A renewed lease: `renewRefreshRun` moves claimed_at strictly FORWARD, so
      // a long sweep's row already satisfies the new CHECK by a wide margin.
      claimedAt: "2026-07-19T07:40:00.000Z",
      scopeListIds: ",1,3,",
    });
    pre.sqlite.prepare("DELETE FROM refresh_runs WHERE id = ?").run(equalId);
    const survivorId = seedRun(pre.sqlite, {
      startedAt: "2026-07-20T07:00:00.000Z",
      claimedAt: "2026-07-20T07:00:00.000Z",
    });
    const before = pre.sqlite
      .prepare("SELECT * FROM refresh_runs ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(before.map((r) => r.id)).toEqual([scopedId, survivorId]);

    const opened = pre.applyOrderMigration();

    // Field by field against what was actually there, never against literals, so
    // the assertion cannot drift from the pre-migration row.
    const after = opened.sqlite
      .prepare("SELECT * FROM refresh_runs ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(before.length);
    before.forEach((row, i) => {
      for (const [column, value] of Object.entries(row)) {
        expect({ column, value: after[i]?.[column] }).toEqual({ column, value });
      }
    });
    // 0013's column in particular: a rebuild is exactly how a column added by an
    // earlier migration goes missing.
    expect(after.find((r) => r.id === scopedId)?.scope_list_ids).toBe(",1,3,");
    expect(after.find((r) => r.id === survivorId)?.scope_list_ids).toBeNull();

    // A row inserted AFTER the rebuild still lands past the deleted id, so the
    // AUTOINCREMENT sequence came through too rather than restarting into a
    // primary-key collision.
    insertRunRaw(opened.sqlite, {
      startedAt: "2026-07-21T07:00:00.000Z",
      claimedAt: "2026-07-21T07:00:00.000Z",
    });
    const nextId = opened.sqlite.prepare("SELECT max(id) AS id FROM refresh_runs").get() as {
      id: number;
    };
    expect(nextId.id).toBeGreaterThan(survivorId);
  });

  it("carries 0011's eight CHECKs and 0011's index through the rebuild", () => {
    const opened = pre.applyOrderMigration();

    // Not a `sqlite_master` string match: each one is asserted by the database
    // REFUSING the row it exists to refuse. A rebuild that dropped a sibling
    // CHECK would be invisible to a test that only counted constraints.
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, players_skipped, created_at)" +
            " VALUES ('2026-07-19T07:00:00.000Z', '2026-07-19T07:05:00.000Z', 'ok', '2026-07-19T07:00:00.000Z', -1, '2026-07-19T07:00:00.000Z')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed: refresh_runs_players_skipped_nonneg_ck/);
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)" +
            " VALUES ('2026-07-19T07:00:00.000Z', NULL, 'ok', '2026-07-19T07:00:00.000Z', '2026-07-19T07:00:00.000Z')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed: refresh_runs_finished_iff_terminal_ck/);
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO refresh_runs (started_at, finished_at, status, claimed_at, created_at)" +
            " VALUES ('2026-07-19T07:00:00.000Z', '2026-07-19T07:05:00.000Z', 'nonsense', '2026-07-19T07:00:00.000Z', '2026-07-19T07:00:00.000Z')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed: refresh_runs_status_ck/);

    // The index goes with the dropped table unless the migration recreates it,
    // and every hot read of this append-only table depends on it
    // (rules/backend.md: never scan-and-sort an append-only table on a hot path).
    const indexes = opened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='refresh_runs'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("refresh_runs_status_started_idx");
  });

  it("declares in the ORM schema EXACTLY the CHECKs the migrated database holds", () => {
    // THE RULE THIS FINDING WAS ABOUT (rules/backend.md): a constraint that lives
    // only in hand-written migration SQL is invisible to the drizzle snapshot, so
    // the next generated rebuild silently drops it. Nothing else in the suite can
    // see that — `openDb` builds every test database from drizzle/*.sql, so
    // deleting a `check(...)` from src/db/schema.ts leaves all 1900+ other tests
    // green while the NEXT rebuild quietly ships a weaker table.
    //
    // So this compares the two sources directly, in BOTH directions: a CHECK
    // declared in the ORM but absent from the chain is an unapplied constraint,
    // and one in the chain but undeclared is the drop-on-next-rebuild trap.
    const opened = pre.applyOrderMigration();
    const ddl = (
      opened.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='refresh_runs'")
        .get() as { sql: string }
    ).sql;

    const declared = getTableConfig(refreshRuns)
      .checks.map((c) => c.name)
      .sort();
    const applied = [...ddl.matchAll(/CONSTRAINT "([^"]+)" CHECK/g)].map((m) => m[1]!).sort();

    expect(applied).toEqual(declared);
    // Named explicitly as well, so the pair cannot agree by both being empty.
    expect(declared).toContain("refresh_runs_started_before_claimed_ck");
    expect(declared).toHaveLength(9);
  });

  it("keeps referential integrity intact across the chain", () => {
    seedRun(pre.sqlite, {
      startedAt: "2026-07-19T07:00:00.000Z",
      claimedAt: "2026-07-19T07:00:00.000Z",
    });
    const opened = pre.applyOrderMigration();

    expect(opened.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("is applied once: a second startup neither rebuilds again nor duplicates a run", async () => {
    seedRun(pre.sqlite, {
      startedAt: "2026-07-19T07:00:00.000Z",
      claimedAt: "2026-07-19T07:00:00.000Z",
    });
    const first = pre.applyOrderMigration();
    first.close();

    // A second rebuild would `CREATE TABLE __new_refresh_runs` over an existing
    // name and fail, so a clean re-open is what proves the journal bookkeeping
    // landed rather than the DDL merely having succeeded once.
    const second = openDb(pre.path, { migrationsFolder: MIGRATIONS_FOLDER });
    try {
      expect(await second.db.select().from(refreshRuns)).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
