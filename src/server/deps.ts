import type Database from "better-sqlite3";
import type { Db } from "../db/client.js";
import type { Mailer } from "../mailer/types.js";
import type { MlbClient } from "../mlb/client.js";
import type { NcaaClient } from "../ncaa/client.js";

/**
 * The one dependency bundle the REST routes and MCP tools share — injected by
 * createApp, never reached for globally (no module singletons; the clock is
 * always `now`).
 */
export interface ServiceDeps {
  db: Db;
  /** Second, read-only connection for the sql_query tool (src/db/readonly.ts). */
  readonlySqlite: Database.Database;
  client: MlbClient;
  ncaaClient: NcaaClient;
  mailer: Mailer;
  now: () => Date;
  tz: string;
  digestTo: string;
  digestFrom: string;
}
