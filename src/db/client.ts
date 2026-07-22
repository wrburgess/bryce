import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDb {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * The production migrations directory (`<pkg>/drizzle`). Exported so the startup
 * seam (src/db/startup.ts) and the pending-migration check (src/db/pending.ts)
 * resolve the SAME folder openDb migrates from — a test can inject a fixture
 * folder in its place, and the pending check can never disagree with what
 * migrate() would actually apply.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

/** How long a connection waits for a contended write lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenDbOptions {
  /**
   * Apply pending migrations on open (default true). Set false to open the raw
   * file without migrating — the startup seam does this so it can take a
   * pre-migration Snapshot in between (ADR 0042). Every existing caller omits
   * this and is byte-identical to before.
   */
  migrate?: boolean;
  /** Migrations directory; defaults to the production folder. Injectable for tests. */
  migrationsFolder?: string;
}

/**
 * Open (creating if needed) the SQLite database, enable WAL, and (by default)
 * apply any pending migrations programmatically — jobs self-heal their schema at
 * startup (ADR 0028: the laptop host must recover from anything after a reboot).
 */
export function openDb(databasePath: string, options: OpenDbOptions = {}): OpenedDb {
  const shouldMigrate = options.migrate ?? true;
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Delivery claims take BEGIN IMMEDIATE write locks (ADR 0034), so a second
  // PROCESS contending for one must wait rather than fail. better-sqlite3
  // ALREADY defaults busy_timeout to 5000ms (its `timeout` constructor option),
  // so this line pins that value rather than introducing it — it is defensive
  // against a future driver-default change, not a behaviour change today.
  // Five seconds is far longer than a claim holds the lock (a few statements;
  // no network call ever runs inside one).
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const db = drizzle(sqlite, { schema });
  if (shouldMigrate) {
    migrate(db, { migrationsFolder });
  }
  return { db, sqlite, close: () => sqlite.close() };
}
