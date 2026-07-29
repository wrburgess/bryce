import type Database from "better-sqlite3";
import { Column, SQL, is } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  SQLiteSyncDialect,
  SQLiteTable as SQLiteTableClass,
  getTableConfig,
} from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { MIGRATIONS_FOLDER, openDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

/**
 * SCHEMA ↔ MIGRATION PARITY — the general guard behind `rules/backend.md`'s
 * "declare invariants in the ORM schema, not only in migration SQL".
 *
 * THE GAP THIS CLOSES, MEASURED (#193, PR #203). Nothing else in this suite
 * builds DDL from `src/db/schema.ts`: `openDb`/`testDb` apply `drizzle/*.sql`,
 * so the database every other test sees comes from the MIGRATIONS alone. Delete
 * a `check(...)`, a `uniqueIndex(...)`, or an `index(...)` from the ORM schema
 * and all ~1900 other tests stay green — while the drizzle snapshot silently
 * forgets the constraint and the NEXT drizzle-kit-generated table rebuild ships
 * a weaker table. SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so a rebuild
 * is how this repo evolves a constrained table (0011, 0012, 0014 all rebuild
 * one) — which makes that silent drop a live hazard, not a theoretical one.
 *
 * PR #203 closed it for `refresh_runs` alone, inside
 * `test/migration-refresh-run-watermark-order.test.ts` ("declares in the ORM
 * schema EXACTLY the CHECKs the migrated database holds"). This file is that
 * case generalized to EVERY table and to indexes, columns, and foreign keys.
 *
 * BOTH SIDES ARE INTROSPECTED, NEITHER IS RESTATED. The ORM side comes from
 * drizzle's own `getTableConfig` and the database side from a REAL database
 * built by running the production `drizzle/*.sql` chain through the real
 * migrator. Neither side parses `src/db/schema.ts` as text and neither side
 * carries a hand-written expectation table: a third, hand-maintained model of
 * the schema is the very thing being guarded against — it would drift exactly
 * as silently, and would then have to be edited (i.e. weakened) by the same
 * change that dropped the constraint.
 *
 * THE TABLE LIST IS DYNAMIC — every `SQLiteTable` the schema module exports —
 * so a table added later is covered the moment it is declared, with no edit
 * here and no chance of being forgotten. A static list would make coverage a
 * thing an author must remember, which is the failure mode, one level up.
 *
 * WHAT IS COMPARED, per table: CHECK constraints by NAME; indexes by name,
 * uniqueness, ordered key columns, and partial `WHERE` predicate; columns by
 * name, type affinity, NOT NULL, primary-key membership, and DEFAULT; foreign
 * keys by columns, referenced table/columns, and actions.
 *
 * WHAT IS DELIBERATELY NOT COMPARED — stated here as the contract, and argued
 * at each site: (1) CHECK EXPRESSIONS — names only, so a same-named but weaker
 * expression passes here and is covered instead by the per-migration cases that
 * make the database refuse the row; (2) COLUMN ORDER — `players` legitimately
 * differs, because 0008 appended four columns with `ALTER TABLE`; (3) SQLite's
 * IMPLICIT `sqlite_autoindex_*` indexes, which have no `CREATE` statement and
 * no ORM counterpart; (4) table-level `unique()` and composite `primaryKey()`
 * builders, which this schema does not use and which are asserted ABSENT rather
 * than silently ignored.
 */

/** Renders a drizzle `SQL` object (an index predicate, a default) to text. */
const dialect = new SQLiteSyncDialect();

interface DeclaredTable {
  /** The `src/db/schema.ts` export name — what a failure message should name. */
  exportName: string;
  /** The physical table name, as `sqlite_master` knows it. */
  name: string;
  table: SQLiteTable;
}

/**
 * Every table the schema module exports, discovered by drizzle's own runtime
 * type test rather than by a maintained list (see the header).
 */
const DECLARED_TABLES: DeclaredTable[] = Object.entries(schema)
  .flatMap(([exportName, value]) =>
    is(value, SQLiteTableClass) ? [{ exportName, name: getTableConfig(value).name, table: value }] : [],
  )
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The tables this file was written against. Asserted as a LOWER BOUND, never as
 * an equality: a new table must be covered automatically (the point of the
 * dynamic enumeration), while enumeration that silently stopped finding tables
 * — the one failure that would make every case below vacuously pass — reddens.
 */
const TABLES_AT_TIME_OF_WRITING = [
  "digest_deliveries",
  "highlightly_box_score_cache",
  "highlightly_match_cache",
  "highlightly_player_cursors",
  "list_members",
  "player_lists",
  "player_tags",
  "players",
  "refresh_runs",
  "season_calendar",
  "stat_lines",
];

/**
 * Identifier QUOTING and WHITESPACE only — deliberately not case, and
 * deliberately not string literals.
 *
 * `rules/testing.md`: never normalize away the difference the assertion exists
 * to catch. Lowercasing would fold `= 'Level'` into `= 'level'` inside a partial
 * index predicate — a genuine divergence in the exact place this guard is
 * sharpest — so keyword case is left alone and a cosmetic case difference is
 * reported rather than swallowed. Quoting style (`"x"` vs `` `x` ``) carries no
 * meaning for the identifiers this schema uses (none contains a space or a
 * reserved word), so folding it is safe.
 */
function normalizeSql(text: string): string {
  return text.replace(/[`"]/g, "").replace(/\s+/g, " ").trim();
}

interface IndexFact {
  name: string;
  unique: boolean;
  /** Key columns, IN ORDER — a composite index's order is its access path. */
  columns: string[];
  /** The partial `WHERE` predicate, normalized; null for a full index. */
  where: string | null;
}

interface ColumnFact {
  name: string;
  /** Declared type affinity, upper-cased (`integer` and `INTEGER` agree). */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  /**
   * `{ kind: "none" }`, an EVALUATED literal default, or the text of an SQL
   * expression default. See `ormColumnDefault` for why the two are compared
   * differently.
   */
  default: { kind: "none" } | { kind: "value"; value: unknown } | { kind: "expression"; sql: string };
}

interface ForeignKeyFact {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
}

// ---------------------------------------------------------------------------
// The ORM side — drizzle's own view of what src/db/schema.ts declares.
// ---------------------------------------------------------------------------

function ormChecks(table: SQLiteTable): string[] {
  return getTableConfig(table)
    .checks.map((c) => c.name)
    .sort();
}

function ormIndexes(table: SQLiteTable): IndexFact[] {
  const config = getTableConfig(table);
  const declared: IndexFact[] = config.indexes.map((idx) => ({
    name: idx.config.name,
    unique: idx.config.unique,
    columns: idx.config.columns.map((col) =>
      is(col, Column) ? col.name : normalizeSql(dialect.sqlToQuery(col).sql),
    ),
    where: idx.config.where ? normalizeSql(dialect.sqlToQuery(idx.config.where).sql) : null,
  }));
  // A column-level `.unique()` is an index in the database but is NOT in
  // `config.indexes` — drizzle-kit emits it as `CREATE UNIQUE INDEX
  // <uniqueName>`. Omitting these would make every one of them read as an
  // UNDECLARED database index and turn `players` permanently red.
  const columnLevel: IndexFact[] = config.columns
    .filter((col) => col.isUnique)
    .map((col) => ({
      name: col.uniqueName ?? `${config.name}_${col.name}_unique`,
      unique: true,
      columns: [col.name],
      where: null,
    }));
  return [...declared, ...columnLevel].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the ORM says this column's DDL default is, in the DATABASE's terms.
 *
 * A literal default is mapped through the column's OWN `mapToDriverValue` —
 * drizzle's real JS-to-storage conversion, so a `mode: "boolean"` `true` becomes
 * `1` exactly as it does on a write, rather than through a second conversion
 * table written here that could disagree with it. The database side evaluates
 * its stored default expression through SQLite (`SELECT true` → `1`), so the two
 * meet as VALUES and a purely textual difference (`DEFAULT true` vs `DEFAULT 1`)
 * neither passes as a divergence nor hides one.
 *
 * An SQL-expression default cannot be compared that way — evaluating, say,
 * `unixepoch()` yields a different answer on each side — so those compare as
 * normalized TEXT. This schema currently has none; the branch exists so adding
 * one is covered rather than spuriously red.
 */
function ormColumnDefault(column: Column): ColumnFact["default"] {
  if (column.default === undefined) return { kind: "none" };
  if (is(column.default, SQL)) {
    return { kind: "expression", sql: normalizeSql(dialect.sqlToQuery(column.default).sql) };
  }
  return { kind: "value", value: column.mapToDriverValue(column.default) };
}

function ormColumns(table: SQLiteTable): ColumnFact[] {
  return getTableConfig(table)
    .columns.map((col) => ({
      name: col.name,
      type: col.getSQLType().toUpperCase(),
      notNull: col.notNull,
      primaryKey: col.primary,
      default: ormColumnDefault(col),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ormForeignKeys(table: SQLiteTable): ForeignKeyFact[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => {
      const reference = fk.reference();
      return {
        columns: reference.columns.map((c) => c.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((c) => c.name),
        // drizzle omits an unset action and SQLite reports the default it then
        // applies, so the ORM's `undefined` IS `NO ACTION`.
        onUpdate: (fk.onUpdate ?? "no action").toUpperCase(),
        onDelete: (fk.onDelete ?? "no action").toUpperCase(),
      };
    })
    .sort((a, b) => a.columns.join().localeCompare(b.columns.join()));
}

// ---------------------------------------------------------------------------
// The database side — a REAL database built by the production migration chain.
// ---------------------------------------------------------------------------

function dbTableDdl(sqlite: Database.Database, table: string): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`table ${table} is declared in the ORM schema but the migrated database has no such table`);
  return row.sql;
}

/**
 * The CHECK constraint NAMES written into the table's own DDL. All three
 * identifier quoting styles are accepted because the migrations are drizzle-kit
 * output that this repo then hand-edits (0012, 0014), and quoting is not the
 * difference this guard is about.
 *
 * NAMES ONLY — the expressions are deliberately excluded; see the CHECK case
 * below for what that costs and what covers it.
 */
function ddlCheckNames(ddl: string): string[] {
  return [...ddl.matchAll(/CONSTRAINT\s+(?:"([^"]+)"|`([^`]+)`|(\w+))\s+CHECK/gi)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
}

/**
 * The checks a table enforces through a matched PAIR of write-guard TRIGGERS
 * rather than through a CHECK constraint.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A LOOPHOLE. `players` declares two
 * `check(...)`s that the migrated `players` table does not carry as CHECK
 * constraints — the database enforces them as `BEFORE INSERT` / `BEFORE UPDATE`
 * triggers that `RAISE(ABORT, ...)` on the negated predicate (0008, tightened by
 * 0009). That was deliberate and is recorded in 0008: "SQLite cannot add CHECK
 * constraints without rebuilding the parent table. A rebuild is unsafe here:
 * stat_lines/list_members already reference players and migrations run inside a
 * transaction, where foreign_keys cannot be disabled." The invariant is
 * enforced; only the DDL OBJECT differs, and the ORM's `check(...)` is what a
 * future rebuild will emit.
 *
 * The naming convention is the contract: a check `X_ck` is stood in for by
 * `X_insert_ck` AND `X_update_ck`. BOTH are required — an insert-only guard is
 * not equivalent to a CHECK, which is re-evaluated on every UPDATE, so a lone
 * one leaves this set and reddens the comparison rather than passing as
 * "enforced". Dropping either trigger, or dropping the ORM declaration, still
 * fails the case. The predicates themselves are pinned behaviourally — the
 * database is made to REFUSE each illegal shape — in
 * `test/highlightly-migration.test.ts` and again, in miniature, below.
 */
function triggerGuardedCheckNames(sqlite: Database.Database, table: string): string[] {
  const triggers = new Set(
    (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
        .all(table) as Array<{ name: string }>
    ).map((t) => t.name),
  );
  const guarded: string[] = [];
  for (const name of triggers) {
    const stem = /^(.*)_insert_ck$/.exec(name)?.[1];
    if (stem && triggers.has(`${stem}_update_ck`)) guarded.push(`${stem}_ck`);
  }
  return guarded;
}

/** Every check the migrated database actually enforces, however it spells it. */
function dbEnforcedCheckNames(sqlite: Database.Database, table: string): string[] {
  return [
    ...ddlCheckNames(dbTableDdl(sqlite, table)),
    ...triggerGuardedCheckNames(sqlite, table),
  ].sort();
}

/** The partial predicate of a `CREATE INDEX ... WHERE ...`, or null. */
const INDEX_WHERE_TAIL = /\)\s*WHERE\s+([\s\S]+)$/i;

function dbIndexes(sqlite: Database.Database, table: string): IndexFact[] {
  // `sql IS NOT NULL` drops SQLite's IMPLICIT indexes — the ones it creates for
  // a PRIMARY KEY or an inline UNIQUE and names `sqlite_autoindex_*`. They have
  // no `CREATE` statement and no counterpart object in the ORM schema, so they
  // are excluded rather than compared; the constraints that cause them are
  // compared as columns (primary key) and as index facts (column-level unique).
  const rows = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table) as Array<{ name: string; sql: string }>;
  const partiality = new Map(
    (sqlite.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string; partial: number }>).map(
      (r) => [r.name, r.partial === 1],
    ),
  );
  return rows
    .map((row) => {
      const where = INDEX_WHERE_TAIL.exec(row.sql)?.[1] ?? null;
      // The predicate is the fact most easily lost by a sloppy parse, and a lost
      // one would read as "no predicate" on BOTH sides the moment the ORM lost
      // it too. SQLite itself knows whether the index is partial, so disagreeing
      // with it is a harness bug and must throw rather than compare.
      if (partiality.get(row.name) !== (where !== null)) {
        throw new Error(
          `could not read the partial predicate of index ${row.name}; SQLite reports partial=${String(partiality.get(row.name))} but the DDL parsed to ${where === null ? "no predicate" : "a predicate"}: ${row.sql}`,
        );
      }
      return {
        name: row.name,
        unique: /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(row.sql),
        columns: (
          sqlite.prepare(`PRAGMA index_info("${row.name}")`).all() as Array<{ seqno: number; name: string | null }>
        )
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name ?? "<expression>"),
        where: where === null ? null : normalizeSql(where),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dbColumns(sqlite: Database.Database, table: string): ColumnFact[] {
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  return rows
    .map((row) => ({
      name: row.name,
      type: row.type.toUpperCase(),
      notNull: row.notnull === 1,
      primaryKey: row.pk > 0,
      default:
        row.dflt_value === null
          ? ({ kind: "none" } as const)
          : dbEvaluatedDefault(sqlite, row.dflt_value),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Evaluate a stored DDL default through SQLite so it meets the ORM's mapped
 * value as a VALUE. A non-literal (function-call) default cannot be compared
 * that way and is kept as text — the mirror of `ormColumnDefault`'s branch.
 */
function dbEvaluatedDefault(sqlite: Database.Database, expression: string): ColumnFact["default"] {
  try {
    const row = sqlite.prepare(`SELECT ${expression} AS v`).get() as { v: unknown };
    return { kind: "value", value: row.v };
  } catch {
    return { kind: "expression", sql: normalizeSql(expression) };
  }
}

function dbForeignKeys(sqlite: Database.Database, table: string): ForeignKeyFact[] {
  const rows = sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const byConstraint = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = byConstraint.get(row.id) ?? [];
    group.push(row);
    byConstraint.set(row.id, group);
  }
  return [...byConstraint.values()]
    .map((group) => {
      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      return {
        columns: ordered.map((r) => r.from),
        foreignTable: ordered[0]!.table,
        foreignColumns: ordered.map((r) => r.to),
        onUpdate: ordered[0]!.on_update.toUpperCase(),
        onDelete: ordered[0]!.on_delete.toUpperCase(),
      };
    })
    .sort((a, b) => a.columns.join().localeCompare(b.columns.join()));
}

describe("src/db/schema.ts declares what drizzle/*.sql actually built (rules/backend.md)", () => {
  let opened: OpenedDb;

  beforeAll(() => {
    // The REAL chain, not a lookalike: `openDb` runs 0000..N through drizzle's
    // migrator, which is exactly what production startup does (ADR 0028). An
    // in-memory database is the same DDL a file database gets.
    opened = openDb(":memory:", { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(() => {
    opened.close();
  });

  it("enumerates every table the schema module exports, so a table added later needs no edit here", () => {
    const found = DECLARED_TABLES.map((t) => t.name);
    // Containment, not equality — a NEW table is covered automatically. The
    // bound is what fails if the runtime type test ever stopped matching and
    // every case below started iterating an empty list.
    for (const name of TABLES_AT_TIME_OF_WRITING) expect(found).toContain(name);
    expect(found.length).toBeGreaterThanOrEqual(TABLES_AT_TIME_OF_WRITING.length);
  });

  it("models every constraint KIND this schema uses, so nothing goes silently uncompared", () => {
    // The comparisons below model column-level uniques, table-level indexes,
    // CHECKs, foreign keys, and column-level primary keys. drizzle also offers
    // table-level `unique()` and composite `primaryKey()`, which this file does
    // NOT model. Rather than guess how drizzle-kit emits them, they are asserted
    // ABSENT: the day one is declared, this case fails and points the author
    // here — instead of the new constraint quietly falling outside the guard.
    for (const { exportName, table } of DECLARED_TABLES) {
      const config = getTableConfig(table);
      expect({ exportName, uniqueConstraints: config.uniqueConstraints.length }).toEqual({
        exportName,
        uniqueConstraints: 0,
      });
      expect({ exportName, compositePrimaryKeys: config.primaryKeys.length }).toEqual({
        exportName,
        compositePrimaryKeys: 0,
      });
    }
  });

  it("compares predicates and key columns as VALUES on BOTH sides — the comparison is not vacuous", () => {
    // rules/testing.md: a guard nobody broke is indistinguishable from one that
    // enforces nothing, and the first face of that failure is a comparison whose
    // two sides are both empty. These three are the load-bearing declarations in
    // the schema, asserted here as CONTENT on each side independently, so a
    // `getTableConfig` shape change or a parse that silently produced `null`
    // cannot leave the per-table cases agreeing about nothing.
    const ormLists = ormIndexes(schema.playerLists);
    const dbLists = dbIndexes(opened.sqlite, "player_lists");
    for (const side of [ormLists, dbLists]) {
      const nameLive = side.find((i) => i.name === "player_lists_name_live_uq");
      expect(nameLive?.unique).toBe(true);
      expect(nameLive?.columns).toEqual(["name"]);
      expect(nameLive?.where).toBe("player_lists.deleted_at is null");
      const defaultUq = side.find((i) => i.name === "player_lists_default_uq");
      expect(defaultUq?.where).toBe("player_lists.is_default = 1 and player_lists.deleted_at is null");
    }
    // ADR 0034's durable slot key, with #193's lane dimension (ADR 0062).
    for (const side of [ormIndexes(schema.digestDeliveries), dbIndexes(opened.sqlite, "digest_deliveries")]) {
      const slot = side.find((i) => i.name === "digest_deliveries_kind_date_list_uq");
      expect(slot?.unique).toBe(true);
      expect(slot?.columns).toEqual(["kind", "date_covered", "list_id"]);
    }
    // And the CHECK sets really carry names, on both sides, for a table other
    // than the one PR #203 already covered.
    expect(ormChecks(schema.playerTags)).toEqual([
      "player_tags_namespace_nonblank_ck",
      "player_tags_source_ck",
      "player_tags_value_nonblank_ck",
    ]);
    expect(dbEnforcedCheckNames(opened.sqlite, "player_tags")).toEqual(ormChecks(schema.playerTags));
  });

  it("accepts `players`' TRIGGER write guards only because the database really does refuse the rows", () => {
    // The anti-vacuity control for `triggerGuardedCheckNames`. Matching a pair of
    // trigger NAMES is a claim about enforcement, and a name is cheap — 0009's
    // own test suite had to simulate a deployed database whose guard had been
    // replaced by `WHEN 0` (test/highlightly-migration.test.ts), which is exactly
    // what a name-only allowance would wave through. So each of the two checks
    // this allowance covers is exercised here as BEHAVIOUR, on the same migrated
    // database the case above introspects.
    const now = "2026-07-01T00:00:00.000Z";
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO players (ncaa_player_seq, ncaa_source_state, full_name, level, active, created_at, updated_at)" +
            " VALUES (99, 'highlightly_active', 'Missing Highlightly Identity', 'ncaa', 1, ?, ?)",
        )
        .run(now, now),
    ).toThrow(/active Highlightly player requires identity/);
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO players (external_id, ncaa_source_state, full_name, level, active, created_at, updated_at)" +
            " VALUES (77, 'legacy_html', 'Pro With NCAA State', 'mlb', 1, ?, ?)",
        )
        .run(now, now),
    ).toThrow(/identity\/state constraint/);
    // The negative control: a legal row still inserts, so the two cases above
    // are not passing because the table refuses everything.
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO players (external_id, full_name, level, active, created_at, updated_at)" +
            " VALUES (77, 'Legal Pro', 'mlb', 1, ?, ?)",
        )
        .run(now, now),
    ).not.toThrow();
    opened.sqlite.prepare("DELETE FROM players WHERE external_id = 77").run();
  });

  describe.each(DECLARED_TABLES)("$name", ({ exportName, name, table }) => {
    it("declares EXACTLY the CHECK constraints the migrated database holds", () => {
      // Both directions matter: a CHECK declared in the ORM but absent from the
      // chain is an UNAPPLIED constraint (the app believes an invariant the
      // database never enforces), and one in the chain but undeclared is the
      // drop-on-next-rebuild trap this file exists for.
      //
      // DELIBERATELY EXCLUDED — the check EXPRESSION. Only names are compared:
      // a rebuild leaves SQLite's stored DDL qualified by whichever table name
      // the CREATE used, and this repo hand-edits its rebuild migrations, so the
      // two sides' expression TEXT can differ without any semantic divergence.
      // The consequence is honest and bounded: an ORM check re-declared with the
      // same name and a WEAKER expression would not redden here. What covers
      // that is the per-migration suite, which asserts each load-bearing CHECK
      // by having the database REFUSE the row it exists to refuse (e.g.
      // test/migration-refresh-run-watermark-order.test.ts, test/schema.test.ts).
      //
      // The database side counts a matched pair of write-guard TRIGGERS as the
      // check it stands in for — see `triggerGuardedCheckNames`, which is why
      // `players` passes despite carrying no CHECK constraint in its DDL.
      expect({ table: exportName, checks: dbEnforcedCheckNames(opened.sqlite, name) }).toEqual({
        table: exportName,
        checks: ormChecks(table),
      });
    });

    it("declares EXACTLY the indexes the migrated database holds — uniqueness, key columns, and partial predicate", () => {
      // Uniqueness and the partial predicate are compared, not just the name: a
      // unique index degraded to a plain one, or a partial predicate widened,
      // changes WHICH rows collide while the index keeps its name — and both
      // `player_lists` predicates are load-bearing (a live-name uniqueness that
      // lost `deleted_at is null` would refuse to let a deleted list's name be
      // reused; a default-lane uniqueness that lost it would make a replacement
      // default unsettable).
      expect({ table: exportName, indexes: dbIndexes(opened.sqlite, name) }).toEqual({
        table: exportName,
        indexes: ormIndexes(table),
      });
    });

    it("declares EXACTLY the columns the migrated database holds — type, NOT NULL, primary key, and default", () => {
      // DELIBERATELY EXCLUDED — column ORDER. `players` proves the exclusion is
      // required rather than convenient: 0008 added four columns with `ALTER
      // TABLE`, so they sit at the END of the physical table while the schema
      // declares them beside the identity columns they belong with. Order is not
      // an invariant here; both sides are compared name-sorted.
      //
      // NOT NULL is compared because it is load-bearing, not cosmetic:
      // `digest_deliveries.list_id`'s NOT NULL is what keeps the slot's unique
      // index total (SQLite treats NULLs as distinct), so losing it would void
      // ADR 0034's durable claim without touching the index at all.
      expect({ table: exportName, columns: dbColumns(opened.sqlite, name) }).toEqual({
        table: exportName,
        columns: ormColumns(table),
      });
    });

    it("declares EXACTLY the foreign keys the migrated database holds", () => {
      expect({ table: exportName, foreignKeys: dbForeignKeys(opened.sqlite, name) }).toEqual({
        table: exportName,
        foreignKeys: ormForeignKeys(table),
      });
    });
  });
});
