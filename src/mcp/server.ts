import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { players } from "../db/schema.js";
import { runReadonlyQuery, ReadonlyQueryError } from "../db/readonly.js";
import { assembleDigest } from "../digest/assemble.js";
import { renderDigest } from "../digest/render.js";
import { runDigest } from "../jobs/digest.js";
import { runRefresh, runRefreshForPlayer } from "../jobs/refresh.js";
import { MlbApiError } from "../mlb/client.js";
import { queryStatLines } from "../queries/statLines.js";
import type { ServiceDeps } from "../server/deps.js";
import { healthSnapshot } from "../server/health.js";
import {
  PlayerNotFoundError,
  UnknownPersonError,
  addPlayer,
  deactivatePlayer,
  listPlayers,
  searchPlayers,
} from "../watchlist/service.js";
import {
  AddPlayerInputSchema,
  PlayerSearchInputSchema,
  PlayersListInputSchema,
  RefreshInputSchema,
  SqlQueryInputSchema,
  StatLineQuerySchema,
} from "../api/schemas.js";

/**
 * The MCP server — Bryce's primary interface (ADR 0027). Ten tools over the
 * same service layer and Zod schemas the REST routes use; every result is
 * JSON, returned both as structuredContent and as a text part for clients
 * that read only text. Mounted at /mcp behind the bearer middleware.
 */

const APP_VERSION = "0.2.0";

type JsonPayload = Record<string, unknown>;

function jsonResult(payload: JsonPayload): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(err: unknown): CallToolResult {
  const known =
    err instanceof ZodError
      ? `invalid input: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      : err instanceof UnknownPersonError ||
          err instanceof PlayerNotFoundError ||
          err instanceof ReadonlyQueryError ||
          err instanceof MlbApiError
        ? err.message
        : null;
  if (known === null) throw err instanceof Error ? err : new Error(String(err));
  return { content: [{ type: "text", text: `error: ${known}` }], isError: true };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return errorResult(err);
  }
}

export function buildMcpServer(deps: ServiceDeps): McpServer {
  const server = new McpServer({ name: "bryce", version: APP_VERSION });

  server.registerTool(
    "watchlist_list",
    {
      description:
        "List watch-list players. active: 'true' (default) for active only, 'false' for deactivated, 'all' for everything.",
      inputSchema: PlayersListInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const query = PlayersListInputSchema.parse(args);
        const filter =
          query.active === "all" ? "all" : query.active === "true" ? "active" : "inactive";
        return jsonResult({ players: await listPlayers(deps.db, filter) });
      }),
  );

  server.registerTool(
    "watchlist_add",
    {
      description:
        "Add a player to the watch list by MLB Stats API personId. A new player's whole current season is backfilled immediately (his first Refresh) unless the pipeline is in Offseason Sleep.",
      inputSchema: AddPlayerInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = AddPlayerInputSchema.parse(args);
        const result = await addPlayer(deps, input.personId);
        return jsonResult({ action: result.action, player: result.player, refresh: result.refresh });
      }),
  );

  server.registerTool(
    "watchlist_deactivate",
    {
      description:
        "Deactivate a watch-list player by personId. His row and full stat history are kept.",
      inputSchema: AddPlayerInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = AddPlayerInputSchema.parse(args);
        return jsonResult({ player: await deactivatePlayer(deps, input.personId) });
      }),
  );

  server.registerTool(
    "player_search",
    {
      description:
        "Search MLB/MiLB players by name (MLB Stats API people search), with each hit resolved to a current team and level.",
      inputSchema: PlayerSearchInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = PlayerSearchInputSchema.parse(args);
        return jsonResult({ results: await searchPlayers(deps, input.q) });
      }),
  );

  server.registerTool(
    "stat_lines",
    {
      description:
        "Query stored per-game stat lines, newest first. Filters: playerId (internal id), level (mlb/milb), from/to (YYYY-MM-DD, inclusive), limit (max 200).",
      inputSchema: StatLineQuerySchema.shape,
    },
    (args) =>
      guarded(async () => jsonResult({ statLines: await queryStatLines(deps.db, args) })),
  );

  server.registerTool(
    "digest_preview",
    {
      description:
        "Preview what the next digest would report (unreported stat lines plus the in-season no-new-stats tail). Read-only: sends nothing, marks nothing.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const assembly = await assembleDigest(deps.db, deps);
        const mail = renderDigest({
          date: assembly.date,
          lines: assembly.lines,
          noNewStats: assembly.noNewStats,
        });
        return jsonResult({
          date: assembly.date,
          statLineCount: assembly.reportedIds.length,
          playerCount: assembly.playerCount,
          lines: assembly.lines,
          noNewStats: assembly.noNewStats,
          mail,
        });
      }),
  );

  server.registerTool(
    "send_digest",
    {
      description:
        "Run the digest job now: send the digest email (or offseason heartbeat) and mark reported lines. Never double-sends for a covered date.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const result = await runDigest({
          db: deps.db,
          mailer: deps.mailer,
          now: deps.now,
          tz: deps.tz,
          to: deps.digestTo,
          from: deps.digestFrom,
        });
        return jsonResult({ ...result });
      }),
  );

  server.registerTool(
    "run_refresh",
    {
      description:
        "Run a refresh now: re-ingest the full current season for every active player, or just one player when personId is given. No-op during Offseason Sleep.",
      inputSchema: RefreshInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = RefreshInputSchema.parse(args);
        if (input.personId === undefined) {
          return jsonResult({ ...(await runRefresh(deps)) });
        }
        const player = (
          await deps.db.select().from(players).where(eq(players.externalId, input.personId))
        )[0];
        if (player === undefined) {
          throw new PlayerNotFoundError(input.personId);
        }
        return jsonResult({ ...(await runRefreshForPlayer(deps, player.id)) });
      }),
  );

  server.registerTool(
    "sql_query",
    {
      description:
        "Run a single read-only SQL query (SELECT/WITH/EXPLAIN) against the Bryce SQLite database for ad-hoc analysis. Tables: players, stat_lines, digest_deliveries, season_calendar. Writes are rejected and the connection itself is read-only. Rows are capped at 200.",
      inputSchema: SqlQueryInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = SqlQueryInputSchema.parse(args);
        const result = runReadonlyQuery(deps.readonlySqlite, input.sql, input.params);
        return jsonResult({ ...result });
      }),
  );

  server.registerTool(
    "status",
    {
      description:
        "Health snapshot: active player count, stored stat-line count, and the last digest/heartbeat delivery (same shape as GET /health).",
      inputSchema: {},
    },
    () =>
      guarded(async () => jsonResult({ ...(await healthSnapshot(deps.db)) })),
  );

  return server;
}
