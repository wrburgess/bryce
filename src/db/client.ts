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

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

/** How long a connection waits for a contended write lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (creating if needed) the SQLite database, enable WAL, and apply any
 * pending migrations programmatically — jobs self-heal their schema at startup
 * (ADR 0028: the laptop host must recover from anything after a reboot).
 */
export function openDb(databasePath: string): OpenedDb {
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
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite, close: () => sqlite.close() };
}
