import { join } from "node:path";
import type Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { MIGRATIONS_FOLDER, openDb } from "../src/db/client.js";
import { startupDb } from "../src/db/startup.js";
import { digestDeliveries, listMembers, playerLists } from "../src/db/schema.js";
import { resolveDefaultList } from "../src/lists/service.js";
import type { TempDir, TempMigrations } from "./backup-helpers.js";
import { copyProdMigrationsThrough, makeTempDir } from "./backup-helpers.js";

/**
 * drizzle/0012 — `player_lists` becomes a LANE and `digest_deliveries` gains
 * `list_id` (#190).
 *
 * EVERY case here applies the REAL 0012 to a REAL 0011-shaped database, built by
 * running migrations 0000-0011 through the actual drizzle migrator. A hand-seeded
 * lookalike would answer a different question than the one that matters — whether
 * this migration works against the schema the HC's laptop actually holds
 * (rules/testing.md). It is also the only way the staged rebuild is exercised at
 * all: the FK shuffle, the explicit column copies, and the index recreation only
 * exist because the real 0011 schema has an inbound foreign key and a full column
 * set.
 */

/** The last migration index BEFORE the one under test. */
const PRE_LANE_IDX = 11;

const NOW = "2026-07-01T00:00:00.000Z";

interface PreLaneDb {
  path: string;
  sqlite: Database.Database;
  /** Apply the rest of the production migrations — 0012 included. */
  applyLaneMigration: () => OpenedDb;
  cleanup: () => void;
}

/**
 * A database migrated through 0011 and no further, opened raw so a test can seed
 * it with the pre-lane schema's own column set.
 */
function openPreLaneDb(): PreLaneDb {
  const live: TempDir = makeTempDir("bryce-lane-");
  const through11: TempMigrations = copyProdMigrationsThrough(PRE_LANE_IDX);
  const path = join(live.path, "bryce.db");
  const pre = openDb(path, { migrationsFolder: through11.dir });
  let opened: OpenedDb | null = null;
  return {
    path,
    sqlite: pre.sqlite,
    applyLaneMigration: () => {
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
      through11.cleanup();
      live.cleanup();
    },
  };
}

/** Insert a player into the PRE-lane schema (raw SQL: the ORM knows the new shape). */
function seedPlayer(
  sqlite: Database.Database,
  args: { externalId: number; fullName: string; active: boolean },
): number {
  const info = sqlite
    .prepare(
      "INSERT INTO players (external_id, full_name, level, active, created_at, updated_at) VALUES (?, ?, 'mlb', ?, ?, ?)",
    )
    .run(args.externalId, args.fullName, args.active ? 1 : 0, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function seedList(sqlite: Database.Database, name: string, deletedAt: string | null = null): number {
  const info = sqlite
    .prepare("INSERT INTO player_lists (name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?)")
    .run(name, NOW, NOW, deletedAt);
  return Number(info.lastInsertRowid);
}

describe("drizzle/0012 lane schema migration (#190)", () => {
  let pre: PreLaneDb;

  beforeEach(() => {
    pre = openPreLaneDb();
  });

  afterEach(() => {
    pre.cleanup();
  });

  it("enrolls exactly the ACTIVE players in the seeded default lane, by player id", async () => {
    const activeIds = [
      seedPlayer(pre.sqlite, { externalId: 1, fullName: "Active One", active: true }),
      seedPlayer(pre.sqlite, { externalId: 2, fullName: "Active Two", active: true }),
      seedPlayer(pre.sqlite, { externalId: 3, fullName: "Active Three", active: true }),
    ];
    const inactiveIds = [
      seedPlayer(pre.sqlite, { externalId: 4, fullName: "Inactive One", active: false }),
      seedPlayer(pre.sqlite, { externalId: 5, fullName: "Inactive Two", active: false }),
    ];

    const opened = pre.applyLaneMigration();
    const lane = await resolveDefaultList(opened.db);
    expect(lane.name).toBe("Watchlist");

    // Asserted BY PLAYER ID, never by count: a count passes just as happily when
    // the right NUMBER of the WRONG players was enrolled, and a silent backfill
    // miss surfaces days later as quiet absence from a digest.
    const members = await opened.db
      .select()
      .from(listMembers)
      .where(eq(listMembers.listId, lane.id));
    expect(members.map((m) => m.playerId).sort((a, b) => a - b)).toEqual(activeIds);

    // `players.active` stays the master gate (ADR 0046 decision 2): no inactive
    // player is enrolled anywhere.
    const allMemberships = await opened.db.select().from(listMembers);
    for (const inactiveId of inactiveIds) {
      expect(allMemberships.map((m) => m.playerId)).not.toContain(inactiveId);
    }
  });

  it("stamps every pre-existing delivery — digest AND heartbeat — with the default lane", async () => {
    const insertDelivery = pre.sqlite.prepare(
      "INSERT INTO digest_deliveries (kind, date_covered, status, sent_at, player_count, stat_line_count, attempt_count, provider_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertDelivery.run("digest", "2026-06-28", "sent", NOW, 7, 9, 1, "postmark-a", NOW);
    insertDelivery.run("digest", "2026-06-29", "failed", null, 0, 0, 2, null, NOW);
    insertDelivery.run("heartbeat", "2026-06-30", "sent", NOW, 0, 0, 1, "postmark-b", NOW);

    const opened = pre.applyLaneMigration();
    const lane = await resolveDefaultList(opened.db);

    const rows = await opened.db.select().from(digestDeliveries).orderBy(digestDeliveries.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.listId)).toEqual([lane.id, lane.id, lane.id]);
    // A heartbeat is not lane-scoped, yet carries the default lane's id — the
    // known wart, pinned here so it is a recorded decision, not a discovery.
    expect(rows.find((r) => r.kind === "heartbeat")?.listId).toBe(lane.id);
  });

  it("preserves every delivery column value, the table's indexes, and referential integrity across the rebuild", async () => {
    pre.sqlite
      .prepare(
        "INSERT INTO digest_deliveries (kind, date_covered, status, sent_at, player_count, stat_line_count, attempt_count, provider_message_id, reconciled_at, error_message, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "digest",
        "2026-06-28",
        "sent",
        "2026-06-29T05:00:00.000Z",
        11,
        23,
        3,
        "postmark-xyz",
        "2026-06-29T05:00:01.000Z",
        "a prior failure",
        "2026-06-29T04:59:00.000Z",
        NOW,
      );
    const before = pre.sqlite.prepare("SELECT * FROM digest_deliveries").get() as Record<
      string,
      unknown
    >;

    const opened = pre.applyLaneMigration();

    // Every pre-existing column's VALUE round-trips. Compared field by field
    // against the pre-migration row rather than against literals, so the
    // assertion cannot drift from what was actually there.
    const after = opened.sqlite.prepare("SELECT * FROM digest_deliveries").get() as Record<
      string,
      unknown
    >;
    for (const [column, value] of Object.entries(before)) {
      expect({ column, value: after[column] }).toEqual({ column, value });
    }

    // The unique index is REPLACED by the three-column key; no other index
    // existed on this table to restore.
    const deliveryIndexes = opened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='digest_deliveries'")
      .all() as Array<{ name: string }>;
    expect(deliveryIndexes.map((i) => i.name)).toEqual(["digest_deliveries_kind_date_list_uq"]);

    // player_lists keeps its live-name index and gains the default index.
    const listIndexes = opened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='player_lists'")
      .all() as Array<{ name: string }>;
    expect(listIndexes.map((i) => i.name).sort()).toEqual([
      "player_lists_default_uq",
      "player_lists_name_live_uq",
    ]);

    // Nothing was orphaned by dropping and re-creating a table with an inbound FK.
    expect(opened.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("carries every membership across the player_lists rebuild, ids and all", async () => {
    const p1 = seedPlayer(pre.sqlite, { externalId: 10, fullName: "Member One", active: true });
    const p2 = seedPlayer(pre.sqlite, { externalId: 11, fullName: "Member Two", active: false });
    const listId = seedList(pre.sqlite, "Prospects");
    const insertMember = pre.sqlite.prepare(
      "INSERT INTO list_members (list_id, player_id, created_at) VALUES (?, ?, ?)",
    );
    insertMember.run(listId, p1, NOW);
    insertMember.run(listId, p2, NOW);
    const before = pre.sqlite
      .prepare("SELECT id, list_id, player_id, created_at FROM list_members ORDER BY id")
      .all();

    const opened = pre.applyLaneMigration();

    // The rebuild parks and restores these rows (there is no other way to drop
    // the parent under immediate FK enforcement). Restoring them VERBATIM — ids
    // included — is what keeps the user's curation exactly as it was, and an
    // inactive member stays a member: only the ACTIVE gate is applied at read
    // time, never by rewriting membership.
    const after = opened.sqlite
      .prepare("SELECT id, list_id, player_id, created_at FROM list_members WHERE list_id = ? ORDER BY id")
      .all(listId);
    expect(after).toEqual(before);
    expect(opened.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("never steals a live Watchlist: it takes the next free name and leaves the user's list untouched", async () => {
    const player = seedPlayer(pre.sqlite, { externalId: 20, fullName: "Curated Guy", active: true });
    const usersListId = seedList(pre.sqlite, "Watchlist");
    pre.sqlite
      .prepare("INSERT INTO list_members (list_id, player_id, created_at) VALUES (?, ?, ?)")
      .run(usersListId, player, NOW);

    const opened = pre.applyLaneMigration();

    // The lane took the next free name rather than adopting, renaming, or
    // merging into the HC's list.
    const lane = await resolveDefaultList(opened.db);
    expect(lane.name).toBe("Watchlist 2");

    // The user's list is byte-for-byte what it was: same id, same name, not the
    // default, and carrying exactly its original membership.
    const usersList = (
      await opened.db.select().from(playerLists).where(eq(playerLists.id, usersListId))
    )[0];
    expect(usersList).toMatchObject({
      id: usersListId,
      name: "Watchlist",
      isDefault: false,
      refreshIntervalMinutes: null,
      digestHour: null,
      digestTo: null,
      createdAt: NOW,
      deletedAt: null,
    });
    const usersMembers = await opened.db
      .select()
      .from(listMembers)
      .where(eq(listMembers.listId, usersListId));
    expect(usersMembers.map((m) => m.playerId)).toEqual([player]);
  });

  it("takes the plain Watchlist name when the only namesake is soft-deleted", async () => {
    seedList(pre.sqlite, "Watchlist", "2026-06-01T00:00:00.000Z");

    const opened = pre.applyLaneMigration();

    // The live-name index is partial on `deleted_at IS NULL`, so a deleted
    // namesake is not a collision and the suffix must NOT be applied.
    const lane = await resolveDefaultList(opened.db);
    expect(lane.name).toBe("Watchlist");
    const all = await opened.db.select().from(playerLists).orderBy(playerLists.id);
    expect(all.map((l) => [l.name, l.deletedAt === null])).toEqual([
      ["Watchlist", false],
      ["Watchlist", true],
    ]);
  });

  it("creates the lane with zero members on an empty database rather than failing", async () => {
    const opened = pre.applyLaneMigration();

    const lane = await resolveDefaultList(opened.db);
    expect(lane).toMatchObject({
      name: "Watchlist",
      isDefault: true,
      // The lane reproduces today's schedule (ops/templates): digest at 05:00,
      // refresh once a day.
      digestHour: 5,
      refreshIntervalMinutes: 1440,
      // Null means "fall back to the DIGEST_TO env value" — the behavior the
      // host already has.
      digestTo: null,
    });
    expect(await opened.db.select().from(listMembers)).toEqual([]);
  });

  it("is applied once: a second startup duplicates neither the lane nor its memberships", async () => {
    seedPlayer(pre.sqlite, { externalId: 30, fullName: "Only Player", active: true });
    pre.applyLaneMigration().close();

    const first = await startupDb(pre.path, { migrationsFolder: MIGRATIONS_FOLDER });
    const afterFirst = {
      lists: await first.db.select().from(playerLists),
      members: await first.db.select().from(listMembers),
    };
    first.close();

    const second = await startupDb(pre.path, { migrationsFolder: MIGRATIONS_FOLDER });
    try {
      expect(await second.db.select().from(playerLists)).toEqual(afterFirst.lists);
      expect(await second.db.select().from(listMembers)).toEqual(afterFirst.members);
      // And still exactly one live default, which is the state every unscoped
      // command depends on.
      const defaults = await second.db
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)));
      expect(defaults).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
