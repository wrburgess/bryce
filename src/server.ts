import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { createApiRoutes } from "./api/routes.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { startupDb } from "./db/startup.js";
import { openReadonlyDb } from "./db/readonly.js";
import { createMailer } from "./mailer/index.js";
import { buildMcpServer } from "./mcp/server.js";
import { MlbClient } from "./mlb/client.js";
import { NcaaClient } from "./ncaa/client.js";
import { bearerAuth } from "./server/auth.js";
import type { ServiceDeps } from "./server/deps.js";
import { healthSnapshot } from "./server/health.js";
import { isMain } from "./cli/main.js";

/**
 * Phase 2 HTTP server (ADR 0027): the MCP server at /mcp is the primary
 * interface, a thin REST API rides at /api, and both sit behind the bearer
 * middleware. Only /health is public. Exposed remotely through the Cloudflare
 * Tunnel (ADR 0028).
 */

export interface AppDeps extends ServiceDeps {
  /** Bearer token for /api and /mcp; null/blank refuses to construct (fail closed). */
  apiToken: string | null;
}

export function createApp(deps: AppDeps): Hono {
  const token = deps.apiToken?.trim() ?? "";
  if (token.length === 0) {
    throw new Error(
      "API_TOKEN is not configured; refusing to serve /api and /mcp without authentication",
    );
  }

  const app = new Hono();

  app.get("/health", async (c) => c.json(await healthSnapshot(deps.db, deps.now(), deps.tz)));

  const auth = bearerAuth(token);
  app.use("/api/*", auth);
  app.use("/mcp", auth);

  app.route("/api", createApiRoutes(deps));

  // Stateless Streamable HTTP: a fresh McpServer + transport per request —
  // every tool is stateless over the injected deps, so nothing needs a session.
  app.all("/mcp", async (c) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const res = await transport.handleRequest(c);
    return res ?? c.body(null, 204);
  });

  return app;
}

if (isMain(import.meta.url)) {
  loadDotEnv();
  const config = loadConfig();
  // startupDb registers this process in the interlock registry, self-heals the
  // schema, and takes a pre-migration Snapshot when one is pending (ADR 0042).
  const started = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  const db = started.db;
  // Release the interlock registration on shutdown (best-effort; a crash's stale
  // entry self-heals via pid-liveness on the next startup/restore). The signal
  // handlers must ALSO exit: registering a SIGINT/SIGTERM listener overrides
  // Node's default terminate-on-signal, so without the explicit exit the server
  // would become un-killable.
  process.once("exit", () => started.lock?.release());
  const shutdown = (): void => {
    started.lock?.release();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // startupDb has just created/migrated the file, so fileMustExist is satisfied.
  const { sqlite: readonlySqlite } = openReadonlyDb(config.databasePath);
  const app = createApp({
    db,
    readonlySqlite,
    client: new MlbClient({ delayMs: config.mlbApiDelayMs }),
    ncaaClient: new NcaaClient({ delayMs: config.ncaaScrapeDelayMs }),
    mailer: createMailer(config),
    now: () => new Date(),
    tz: config.tz,
    apiToken: config.apiToken,
    // The console provider needs no real addresses; every other provider has
    // fail-closed validated these in loadConfig.
    digestTo: config.digestTo ?? "console@localhost",
    digestFrom: config.digestFrom ?? "bryce@localhost",
  });
  serve({ fetch: app.fetch, port: config.serverPort });
  process.stdout.write(`server listening port=${config.serverPort}\n`);
}
