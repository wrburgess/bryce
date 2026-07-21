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
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../ncaa/client.js";
import { queryStatLines } from "../queries/statLines.js";
import type { ServiceDeps } from "../server/deps.js";
import { healthSnapshot } from "../server/health.js";
import {
  PlayerNotFoundError,
  UnknownNcaaPlayerError,
  UnknownPersonError,
  addNcaaPlayer,
  addPlayer,
  deactivatePlayer,
  listPlayers,
  searchPlayers,
} from "../watchlist/service.js";
import {
  AddNcaaPlayerInputSchema,
  AddPlayerInputSchema,
  DeactivateInputSchema,
  DeactivateInputShape,
  DigestInputSchema,
  DigestInputShape,
  PlayerSearchInputSchema,
  PlayersListInputSchema,
  RefreshInputSchema,
  RefreshInputShape,
  SqlQueryInputSchema,
  StatLineQuerySchema,
} from "../api/schemas.js";

/**
 * The MCP server — Bryce's primary interface (ADR 0027). Eleven tools over the
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
          err instanceof UnknownNcaaPlayerError ||
          err instanceof PlayerNotFoundError ||
          err instanceof ReadonlyQueryError ||
          err instanceof MlbApiError ||
          err instanceof NcaaApiError ||
          err instanceof UnsupportedNcaaSeasonError
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
    "watchlist_add_ncaa",
    {
      description:
        "Add an NCAA player to the watch list by stats.ncaa.org stats_player_seq. His name and school are resolved from his game-log page, and his current season is backfilled immediately (his first Refresh) unless the pipeline is in Offseason Sleep.",
      inputSchema: AddNcaaPlayerInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = AddNcaaPlayerInputSchema.parse(args);
        const result = await addNcaaPlayer(deps, input.ncaaPlayerSeq);
        return jsonResult({ action: result.action, player: result.player, refresh: result.refresh });
      }),
  );

  server.registerTool(
    "watchlist_deactivate",
    {
      description:
        "Deactivate a watch-list player by personId (MLB/MiLB) or ncaaPlayerSeq (NCAA) — exactly one. His row and full stat history are kept.",
      inputSchema: DeactivateInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DeactivateInputSchema.parse(args);
        const ref =
          input.ncaaPlayerSeq !== undefined
            ? { ncaaPlayerSeq: input.ncaaPlayerSeq }
            : input.personId!;
        return jsonResult({ player: await deactivatePlayer(deps, ref) });
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
        "Preview the digest for a date window, as the Batters and Pitchers tables the email would carry. window (default '1d') is one of 1d, 7d, 14d, 21d, ytd; an unsupported value is rejected. Every window ends on the last COMPLETED host date — yesterday, not today — so the result does not depend on the hour you ask. Rows group by player and by the LEVEL each game was played at, so a player promoted mid-window gets one row per level; a 1d window groups by game instead, so a doubleheader stays two rows. Regular season only. Read-only: sends nothing, claims nothing, and writes nothing — re-running a window always returns the same content.",
      inputSchema: DigestInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DigestInputSchema.parse(args);
        const assembly = await assembleDigest(deps.db, { ...deps, spec: input.window });
        return jsonResult({
          window: assembly.window,
          statLineCount: assembly.statLineCount,
          playerCount: assembly.playerCount,
          batters: assembly.batters,
          pitchers: assembly.pitchers,
          mail: renderDigest(assembly),
        });
      }),
  );

  server.registerTool(
    "send_digest",
    {
      description:
        "Run the digest job now: send the digest email for a date window (or the offseason heartbeat). window (default '1d') is one of 1d, 7d, 14d, 21d, ytd; an unsupported value is rejected and nothing is sent. Never double-sends for a covered date. The report writes NO stat-line state, so re-running a window is always safe and always sends the same content. force (default false) is a TEST send: it overrides only the already-sent-today guard and the heartbeat's weekly rule, sending as a replay that records nothing (no delivery row is written or changed). It does NOT override an in-flight claim held by another run — that still returns claimed-by-another-run — and it does NOT override the Offseason Sleep decision, so forcing during the offseason sends a heartbeat, never a digest.",
      inputSchema: DigestInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DigestInputSchema.parse(args);
        const result = await runDigest({
          db: deps.db,
          mailer: deps.mailer,
          now: deps.now,
          tz: deps.tz,
          to: deps.digestTo,
          from: deps.digestFrom,
          spec: input.window,
          force: input.force,
        });
        return jsonResult({ ...result });
      }),
  );

  server.registerTool(
    "run_refresh",
    {
      description:
        "Run a refresh now: re-ingest the full current season for every active player, or just one player when personId (MLB/MiLB) or ncaaPlayerSeq (NCAA) is given. No-op during Offseason Sleep.",
      inputSchema: RefreshInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = RefreshInputSchema.parse(args);
        if (input.personId === undefined && input.ncaaPlayerSeq === undefined) {
          return jsonResult({ ...(await runRefresh(deps)) });
        }
        const where =
          input.ncaaPlayerSeq !== undefined
            ? eq(players.ncaaPlayerSeq, input.ncaaPlayerSeq)
            : eq(players.externalId, input.personId!);
        const player = (await deps.db.select().from(players).where(where))[0];
        if (player === undefined) {
          throw new PlayerNotFoundError(
            input.ncaaPlayerSeq !== undefined
              ? { ncaaPlayerSeq: input.ncaaPlayerSeq }
              : input.personId!,
          );
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
