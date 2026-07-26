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
import { HighlightlyClient } from "./highlightly/client.js";
import { bearerAuth } from "./server/auth.js";
import type { ServiceDeps } from "./server/deps.js";
import { healthSnapshot } from "./server/health.js";
import { isMain } from "./cli/main.js";
import { exitAfterDrain } from "./cli/main.js";
import { preflightDirect } from "./cli/router.js";
import type Database from "better-sqlite3";
import type { StartedDb } from "./db/startup.js";

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

export interface ClosableListener {
  close: (callback: () => void) => unknown;
}

/** Close both handles before releasing the opener lock after a failed bind. */
export function closeFailedBind(
  readonlySqlite: Pick<Database.Database, "close">,
  started: Pick<StartedDb, "close">,
  markLockReleased: () => void,
): void {
  try {
    readonlySqlite.close();
  } finally {
    try {
      started.close();
    } finally {
      markLockReleased();
    }
  }
}

export interface ErrorAwareListener extends ClosableListener {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
  removeListener(event: "error" | "listening", listener: (() => void) | ((error: Error) => void)): unknown;
}

/** Wait for the first terminal result of binding the HTTP listener. */
function waitForListener(listener: ErrorAwareListener): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      listener.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      listener.removeListener("listening", onListening);
      reject(error);
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
  });
}

/**
 * Create and bind the listener while the database ownership is still covered by
 * the failed-bind cleanup boundary. `serve` can throw synchronously (for
 * example, for an invalid port) as well as emit an asynchronous bind error.
 */
export async function createBoundListener(
  createListener: () => ErrorAwareListener,
  readonlySqlite: Pick<Database.Database, "close">,
  started: Pick<StartedDb, "close">,
  markLockReleased: () => void,
): Promise<ErrorAwareListener> {
  try {
    const listener = createListener();
    await waitForListener(listener);
    return listener;
  } catch (error) {
    // A caller can catch a bind failure and keep its process alive (unlike the
    // CLI wrapper, which exits). Close BOTH database handles in that case: a
    // released advisory lock alone would leave the writable SQLite connection
    // open and could interfere with the caller's next open or restore.
    try {
      closeFailedBind(readonlySqlite, started, markLockReleased);
    } catch {
      // The bind error is the actionable failure; best-effort cleanup must not
      // replace it, and the helper already attempted every teardown step.
    }
    throw error;
  }
}

/**
 * Signal handlers override Node's default termination, so they must close the
 * listener themselves. Closing first stops new requests; only then do we drain
 * diagnostics and exit. The injectable seams make this lifecycle testable.
 */
export function createShutdown(
  listener: ClosableListener,
  release: () => void,
  finish: (code: number) => Promise<never> = exitAfterDrain,
): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    listener.close(() => {
      release();
      void finish(0);
    });
  };
}

/** Start the service through the same explicit argv/status adapter as every CLI. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failure = preflightDirect(["server"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
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
  let lockReleased = false;
  const releaseLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    started.lock?.release();
  };
  process.once("exit", releaseLock);
  // startupDb has just created/migrated the file, so fileMustExist is satisfied.
  const { sqlite: readonlySqlite } = openReadonlyDb(config.databasePath);
  const app = createApp({
    db,
    readonlySqlite,
    client: new MlbClient({ delayMs: config.mlbApiDelayMs }),
    highlightlyClient: new HighlightlyClient({ apiKey: config.highlightlyApiKey }),
    mailer: createMailer(config),
    now: () => new Date(),
    tz: config.tz,
    apiToken: config.apiToken,
    // The console provider needs no real addresses; every other provider has
    // fail-closed validated these in loadConfig.
    digestTo: config.digestTo ?? "console@localhost",
    digestFrom: config.digestFrom ?? "bryce@localhost",
  });
  // `serve` reports an occupied port asynchronously. Do not claim readiness
  // until the listener has actually bound: a launchd retry or subprocess smoke
  // must never mistake a pending (or failed) bind for a usable server. The
  // factory belongs inside this boundary because `serve` can also throw before
  // it returns a listener (for example, for a malformed port).
  const listener = await createBoundListener(
    () => serve({ fetch: app.fetch, port: config.serverPort }) as ErrorAwareListener,
    readonlySqlite,
    started,
    () => { lockReleased = true; },
  );
  const shutdown = createShutdown(listener, releaseLock);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write(`server listening port=${config.serverPort}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
