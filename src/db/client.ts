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
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite, close: () => sqlite.close() };
}
