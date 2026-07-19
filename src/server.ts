import { serve } from "@hono/node-server";
import { count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import type { Db } from "./db/client.js";
import { openDb } from "./db/client.js";
import { digestDeliveries, players, statLines } from "./db/schema.js";
import { isMain } from "./cli/main.js";

/**
 * Phase 1 HTTP stub: a single health endpoint. The REST API proper is Phase 2.
 */
export function createApp(db: Db): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const playerCount = (
      await db.select({ n: count() }).from(players).where(eq(players.active, true))
    )[0];
    const statLineCount = (await db.select({ n: count() }).from(statLines))[0];
    // A retried delivery is updated in place (sentAt moves, createdAt does not),
    // so "last" means latest activity: sentAt when sent, createdAt for failed rows.
    const last = (
      await db
        .select()
        .from(digestDeliveries)
        .orderBy(
          desc(sql`coalesce(${digestDeliveries.sentAt}, ${digestDeliveries.createdAt})`),
          desc(digestDeliveries.createdAt),
        )
        .limit(1)
    )[0];
    return c.json({
      ok: true,
      players: playerCount?.n ?? 0,
      statLines: statLineCount?.n ?? 0,
      lastDelivery:
        last === undefined
          ? null
          : {
              kind: last.kind,
              dateCovered: last.dateCovered,
              status: last.status,
              sentAt: last.sentAt,
            },
    });
  });

  return app;
}

if (isMain(import.meta.url)) {
  loadDotEnv();
  const config = loadConfig();
  const { db } = openDb(config.databasePath);
  const app = createApp(db);
  serve({ fetch: app.fetch, port: config.serverPort });
  process.stdout.write(`server listening port=${config.serverPort}\n`);
}
