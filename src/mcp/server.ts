import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { players } from "../db/schema.js";
import { HighlightlyError } from "../highlightly/client.js";
import { runReadonlyQuery, ReadonlyQueryError } from "../db/readonly.js";
import { assembleDigest } from "../digest/assemble.js";
import { assembleGameWindow } from "../digest/game-window.js";
import {
  digestTableRows,
  renderDigest,
  renderDigestHtmlDocument,
  renderDigestMarkdown,
} from "../digest/render.js";
import { isGameCountSpec } from "../domain/window.js";
import { toCsv } from "../export/csv.js";
import { sqlResultToCsv, statLinesToCsv } from "../export/tabular.js";
import { runDigest } from "../jobs/digest.js";
import { runRefresh, runRefreshForPlayer } from "../jobs/refresh.js";
import { MlbApiError } from "../mlb/client.js";
import { queryStatLines } from "../queries/statLines.js";
import { AmbiguousPlayerCardNameError, PlayerCardNotFoundError, assemblePlayerCard } from "../reports/player-card.js";
import { renderPlayerCardHtml, renderPlayerCardText } from "../reports/player-card-render.js";
import type { ServiceDeps } from "../server/deps.js";
import { healthSnapshot } from "../server/health.js";
import {
  ManualWriteToDerivedNamespaceError,
  UnknownTagError,
  addManualTag,
  listTags,
  removeManualTag,
  resolveTagScope,
} from "../tags/service.js";
import type { PlayerRef } from "../watchlist/service.js";
import {
  PlayerNotFoundError,
  PlayerPromotionConflictError,
  UnknownPersonError,
  addHighlightlyNcaaPlayer,
  addPlayer,
  batchAddPlayers,
  deactivatePlayer,
  listPlayers,
  promoteHighlightlyNcaaPlayer,
  searchPlayers,
} from "../watchlist/service.js";
import {
  BlankListNameError,
  CannotDeleteDefaultListError,
  DuplicateListNameError,
  NoDefaultListError,
  UnknownListError,
  addToList,
  createList,
  deleteList,
  listLists,
  listMembersById,
  removeFromList,
  renameList,
  resolveListByName,
  setDefaultList,
} from "../lists/service.js";
import {
  AddNcaaPlayerInputSchema,
  AddPlayerInputSchema,
  PromoteHighlightlyNcaaPlayerInputSchema,
  BatchAddInputBase,
  DeactivateInputSchema,
  DeactivateInputShape,
  DigestInputSchema,
  DigestInputShape,
  DigestPreviewInputSchema,
  DigestPreviewInputShape,
  ListMembersMutateSchema,
  ListMembersMutateShape,
  ListNameInputSchema,
  ListNameInputShape,
  ListRenameInputSchema,
  ListRenameInputShape,
  PlayerSearchInputSchema,
  PlayerCardInputSchema,
  PlayerCardInputShape,
  PlayersListInputSchema,
  RefreshInputSchema,
  RefreshInputShape,
  SqlQueryFormatSchema,
  SqlQueryFormatShape,
  StatLinesFormatSchema,
  StatLinesFormatShape,
  StrictPlayerRefSchema,
  StrictPlayerRefShape,
  TagWriteInputSchema,
  TagWriteInputShape,
} from "../api/schemas.js";

/** Project a validated member reference into the service's PlayerRef union. */
function toPlayerRef(ref: { personId?: number; highlightlyPlayerId?: number }): PlayerRef {
  return ref.personId !== undefined ? ref.personId : { kind: "highlightly", playerId: ref.highlightlyPlayerId! };
}

/**
 * The MCP server — Bryce's primary interface (ADR 0027). Twenty-three tools over the
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

/**
 * A non-JSON tool result: the rendered Presentation/Export string as a single
 * text content part, with NO structuredContent (ADR 0037). A deliberate,
 * documented divergence from `jsonResult` — an HTML/Markdown/CSV body is not a
 * JSON object, so it must not be advertised as one.
 */
function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): CallToolResult {
  const known =
    err instanceof ZodError
      ? `invalid input: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      : err instanceof UnknownPersonError ||
          err instanceof PlayerNotFoundError ||
          err instanceof PlayerPromotionConflictError ||
          err instanceof UnknownListError ||
          err instanceof DuplicateListNameError ||
          err instanceof BlankListNameError ||
          err instanceof CannotDeleteDefaultListError ||
          err instanceof NoDefaultListError ||
          err instanceof ManualWriteToDerivedNamespaceError ||
          err instanceof UnknownTagError ||
          err instanceof ReadonlyQueryError ||
          err instanceof MlbApiError ||
          err instanceof HighlightlyError
          || err instanceof PlayerCardNotFoundError
          || err instanceof AmbiguousPlayerCardNameError
        ? err.message
        : null;
  if (known === null) throw err instanceof Error ? err : new Error(String(err));
  return {
    content: [{ type: "text", text: `error: ${known}` }],
    // Tool clients should not have to scrape the display text to classify a
    // domain conflict. Keep the human-readable text for compatibility.
    structuredContent: { error: known },
    isError: true,
  };
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

  /** Resolve an external ref (personId or Highlightly player ID) to a row, or throw. */
  async function resolvePlayerRow(ref: PlayerRef) {
    const where = typeof ref === "number"
      ? eq(players.externalId, ref)
      : eq(players.highlightlyPlayerId, ref.playerId);
    const row = (await deps.db.select().from(players).where(where))[0];
    if (row === undefined) throw new PlayerNotFoundError(ref);
    return row;
  }

  /** exactly-one addressing → a PlayerRef (the deactivate pattern). */
  const refOf = (input: { personId?: number; highlightlyPlayerId?: number }): PlayerRef =>
    input.highlightlyPlayerId !== undefined
      ? { kind: "highlightly", playerId: input.highlightlyPlayerId }
      : input.personId!;

  server.registerTool(
    "watchlist_list",
    {
      description:
        "List watch-list players. active: 'true' (default) for active only, 'false' for deactivated, 'all' for everything. Optional tags: a comma-separated AND selector (e.g. 'level:aaa,status:rostered'); a bare namespace (e.g. 'prospect') matches any value.",
      inputSchema: PlayersListInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const query = PlayersListInputSchema.parse(args);
        const filter =
          query.active === "all" ? "all" : query.active === "true" ? "active" : "inactive";
        return jsonResult({ players: await listPlayers(deps.db, filter, query.tags) });
      }),
  );

  server.registerTool(
    "watchlist_promote_ncaa_player",
    {
      description: "Promote an active Highlightly NCAA player to an MLB/MiLB person without changing the local Player row or its history.",
      inputSchema: PromoteHighlightlyNcaaPlayerInputSchema,
    },
    (args) => guarded(async () => {
      const input = PromoteHighlightlyNcaaPlayerInputSchema.parse(args);
      return jsonResult({ player: await promoteHighlightlyNcaaPlayer(deps, input) });
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
        "Add an NCAA player by an explicit Highlightly player ID. canonicalName and teamId validate the selected provider identity; no HTML/NCAA name lookup is performed.",
      inputSchema: AddNcaaPlayerInputSchema.shape,
    },
    (args) =>
      guarded(async () => {
        const input = AddNcaaPlayerInputSchema.parse(args);
        const result = await addHighlightlyNcaaPlayer(deps, input);
        return jsonResult({ action: result.action, player: result.player, refresh: result.refresh });
      }),
  );

  server.registerTool(
    "watchlist_batch_add",
    {
      description:
        "Batch-add up to 25 players to the watch list in one call. Each entry is exactly one of an MLB/MiLB personId, an MLB-only name, or a complete explicit Highlightly NCAA identity (highlightlyPlayerId, canonicalName, teamId). Unlike watchlist_add, no season backfill runs inline; staged players backfill at the next run_refresh.",
      // The strict BatchAddInputBase object (NOT its raw .shape): the MCP SDK
      // (@modelcontextprotocol/sdk 1.29.0) accepts a full schema for inputSchema
      // and preserves its .strict(), so an unknown top-level key is rejected here
      // exactly as REST rejects it (ADR 0045) — a raw .shape would be wrapped in a
      // non-strict object that silently strips the stray key.
      inputSchema: BatchAddInputBase,
    },
    (args) =>
      guarded(async () => {
        const result = await batchAddPlayers(deps, args);
        return jsonResult({ ...result });
      }),
  );

  server.registerTool(
    "watchlist_deactivate",
    {
      description:
        "Deactivate a watch-list player by personId (MLB/MiLB) or explicit highlightlyPlayerId (NCAA) — exactly one. His row and full stat history are kept.",
      inputSchema: DeactivateInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DeactivateInputSchema.parse(args);
        const ref = refOf(input);
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
        "Query stored per-game stat lines, newest first. Filters: playerId (internal id), level (mlb/milb/ncaa), from/to (YYYY-MM-DD, inclusive), limit (max 200). format (default 'json') is 'json' or 'csv'; 'csv' returns the rows as a CSV table (one column per field, stats as a JSON column) instead of JSON.",
      inputSchema: StatLinesFormatShape,
    },
    (args) =>
      guarded(async () => {
        const input = StatLinesFormatSchema.parse(args);
        const views = await queryStatLines(deps.db, args);
        return input.format === "csv"
          ? textResult(statLinesToCsv(views))
          : jsonResult({ statLines: views });
      }),
  );

  server.registerTool(
    "report_player",
    {
      // The description LEADS WITH THE OUTCOME on purpose (ADR 0055): an agent
      // picks and interprets a tool from this string, so a description reading
      // as a data-structure spec makes it re-invent a layout no matter what the
      // default is. Flipping the default without rewriting this would not work.
      description:
        "Returns a FORMATTED, READY-TO-DISPLAY card for exactly one tracked player — show it to the user verbatim; do not reformat, summarize, or rebuild it as a table. By default (format 'console') the result is a finished monospace text card: a header line, then one table per Card Window with the batting and pitching lines already laid out. Pass format 'html' for a standalone printable document (its @media print rules make browser print -> Save as PDF paginate correctly), or format 'json' ONLY when you need the raw numbers to compute with — it is a large payload and carries no layout. Address the player with internal Bryce id or canonical exact name (not an external provider id). windows is an ordered subset of last10, last30, ytd; the last windows count distinct regular-season games, ytd runs from the player sport's calendar start through the last completed host date. Batting and pitching rows stay split by the level each game was played at, so a player promoted mid-window gets one row per level. Read-only: no digest is sent and no state is written.",
      inputSchema: PlayerCardInputShape,
    },
    (args) =>
      guarded(async () => {
        const { format, ...selection } = PlayerCardInputSchema.parse(args);
        const card = assemblePlayerCard(deps.db, { ...selection, now: deps.now, tz: deps.tz });
        // Branches exactly like digest_preview: a Presentation is TEXT, the
        // structured payload is JSON. The console rendering is the SAME pure
        // function the CLI prints, so the two surfaces cannot drift.
        if (format === "console") return textResult(renderPlayerCardText(card));
        if (format === "html") return textResult(renderPlayerCardHtml(card));
        return jsonResult(card as unknown as JsonPayload);
      }),
  );

  server.registerTool(
    "digest_preview",
    {
      description:
        "Preview the digest for a window, as the Batters and Pitchers tables the email would carry. window (default '1d') is one of the DATE windows 1d, 7d, 14d, 21d, 28d, 35d, 60d, ytd (one shared range for everyone) or the per-player GAME-COUNT windows last10games, last30games (each player over his OWN last N regular-season games, so two players can cover different date spans); an unsupported value is rejected. Every window ends on the last COMPLETED host date — yesterday, not today — so the result does not depend on the hour you ask. Rows group by player and by the LEVEL each game was played at, so a player promoted mid-window gets one row per level; a 1d window groups by game instead, so a doubleheader stays two rows. A game-count row carries a Span column with the real first–last date its games cover, and a player with fewer than N games reports his real count (GP). Regular season only. Read-only: sends nothing, claims nothing, and writes nothing — re-running a window always returns the same content. format (default 'json') is one of json, html, md, csv: json is the structured preview; html/md render the WHOLE digest (both tables) as a document; csv exports ONE table, chosen by table (default 'batters', ignored for html/md). tags scopes the preview to a cohort (e.g. 'level:dsl' or 'level:aaa,status:rostered'); with list, the two intersect. A cohort matching no players is an empty report; a malformed selector is rejected.",
      inputSchema: DigestPreviewInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DigestPreviewInputSchema.parse(args);
        const list = input.list !== undefined ? await resolveListByName(deps.db, input.list) : undefined;
        const tagScope = input.tags !== undefined ? resolveTagScope(input.tags) : undefined;
        // A game-count window is a per-player ordered limit, not a shared date
        // range, so it has its own assembly engine (issue #153); both produce the
        // same preview shape.
        const assembly = isGameCountSpec(input.window)
          ? await assembleGameWindow(deps.db, {
              now: deps.now,
              tz: deps.tz,
              spec: input.window,
              listId: list?.id,
              listName: list?.name,
              tagScope,
            })
          : await assembleDigest(deps.db, {
              ...deps,
              spec: input.window,
              listId: list?.id,
              listName: list?.name,
              tagScope,
            });
        if (input.format === "html") return textResult(renderDigestHtmlDocument(assembly));
        if (input.format === "md") return textResult(renderDigestMarkdown(assembly));
        if (input.format === "csv") {
          const dt = digestTableRows(assembly, input.table);
          return textResult(toCsv(dt.headers, dt.rows));
        }
        return jsonResult({
          window: assembly.window,
          statLineCount: assembly.statLineCount,
          playerCount: assembly.playerCount,
          batters: assembly.batters,
          pitchers: assembly.pitchers,
          unknownFields: assembly.unknownFields,
          mail: renderDigest(assembly),
        });
      }),
  );

  server.registerTool(
    "send_digest",
    {
      description:
        "Run the digest job now for a window. window (default '1d') is one of the DATE windows 1d, 7d, 14d, 21d, 28d, 35d, 60d, ytd or the per-player GAME-COUNT windows last10games, last30games (each player over his own last N regular-season games); an unsupported value is rejected and nothing is sent. The report writes NO stat-line state, so re-running a window is always safe and sends the same content. The daily '1d' window is the SCHEDULED artifact: it claims a once-per-date slot (so it never double-sends for a covered date, and a failed prior day is recovered on the next run), and during Offseason Sleep it becomes the weekly heartbeat. Any OTHER window (a date window like 7d/ytd, or a game-count window like last10games) is an on-demand report: it takes no slot and records no delivery row, and it answers even during Offseason Sleep — an explicit report is a question, not the daily liveness signal. force (default false) applies only to the daily slot: it is a TEST send overriding the already-sent-today guard and the heartbeat's weekly rule. Overriding one of those makes the send a write-free replay that records nothing; forcing with no slot yet today, or over a failed slot, sends and records a delivery row normally. It does NOT override an in-flight claim held by another run — that still returns claimed-by-another-run. tags scopes the send to a cohort (e.g. 'level:dsl'); with list, the two intersect. A tag-scoped send is on-demand by definition — it takes no daily slot and records no delivery row, whatever the window — because the slot key has no tag dimension.",
      inputSchema: DigestInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = DigestInputSchema.parse(args);
        const list = input.list !== undefined ? await resolveListByName(deps.db, input.list) : undefined;
        const tagScope = input.tags !== undefined ? resolveTagScope(input.tags) : undefined;
        const result = await runDigest({
          db: deps.db,
          mailer: deps.mailer,
          now: deps.now,
          tz: deps.tz,
          to: deps.digestTo,
          from: deps.digestFrom,
          spec: input.window,
          force: input.force,
          listId: list?.id,
          listName: list?.name,
          tagScope,
        });
        return jsonResult({ ...result });
      }),
  );

  server.registerTool(
    "run_refresh",
    {
      description:
        "Run a refresh now: re-ingest the full current season for every active player, or just one player when personId (MLB/MiLB) or highlightlyPlayerId (NCAA) is given. A whole-watch-list refresh records a freshness run; a single-player refresh does not. A targeted result skipped with reason whole-refresh-running is deferred, not refreshed.",
      inputSchema: RefreshInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = RefreshInputSchema.parse(args);
        if (input.personId === undefined && input.highlightlyPlayerId === undefined) {
          return jsonResult({ ...(await runRefresh(deps)) });
        }
        const where =
          input.highlightlyPlayerId !== undefined
            ? eq(players.highlightlyPlayerId, input.highlightlyPlayerId)
            : eq(players.externalId, input.personId!);
        const player = (await deps.db.select().from(players).where(where))[0];
        if (player === undefined) {
          throw new PlayerNotFoundError(
            input.highlightlyPlayerId !== undefined
              ? { kind: "highlightly", playerId: input.highlightlyPlayerId }
              : input.personId!,
          );
        }
        return jsonResult({ ...(await runRefreshForPlayer(deps, player.id)) });
      }),
  );

  server.registerTool(
    "player_tag_add",
    {
      description:
        "Add a MANUAL tag to a watch-list player, addressed by personId (MLB/MiLB) or highlightlyPlayerId (NCAA) — exactly one.",
      inputSchema: TagWriteInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = TagWriteInputSchema.parse(args);
        const player = await resolvePlayerRow(refOf(input));
        const tag = addManualTag(deps.db, player.id, input.namespace, input.value, deps.now());
        return jsonResult({ tag });
      }),
  );

  server.registerTool(
    "player_tag_remove",
    {
      description:
        "Remove a MANUAL tag from a watch-list player, addressed by personId (MLB/MiLB) or highlightlyPlayerId (NCAA) — exactly one.",
      inputSchema: TagWriteInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = TagWriteInputSchema.parse(args);
        const player = await resolvePlayerRow(refOf(input));
        removeManualTag(deps.db, player.id, input.namespace, input.value);
        return jsonResult({ removed: true });
      }),
  );

  server.registerTool(
    "player_tags_list",
    {
      description:
        "List every tag for a watch-list player, addressed by personId (MLB/MiLB) or highlightlyPlayerId (NCAA) — exactly one.",
      // Strict, non-coercing IDs: a typed-JSON boundary, so `personId: [123]`/`true`/`"123"`
      // is rejected (isError), never coerced onto the wrong player.
      inputSchema: StrictPlayerRefShape,
    },
    (args) =>
      guarded(async () => {
        const input = StrictPlayerRefSchema.parse(args);
        const player = await resolvePlayerRow(refOf(input));
        return jsonResult({ tags: listTags(deps.db, player.id) });
      }),
  );

  server.registerTool(
    "sql_query",
    {
      description:
        "Run a single read-only SQL query (SELECT/WITH/EXPLAIN) against the Bryce SQLite database for ad-hoc analysis. Tables: players, stat_lines, player_tags, digest_deliveries, refresh_runs, season_calendar. Writes are rejected and the connection itself is read-only. Rows are capped at 200. format (default 'json') is 'json' or 'csv'; 'csv' returns columns/rows as a CSV table, and a truncated result adds a second text part warning that the cap was hit.",
      inputSchema: SqlQueryFormatShape,
    },
    (args) =>
      guarded(async () => {
        const input = SqlQueryFormatSchema.parse(args);
        const result = runReadonlyQuery(deps.readonlySqlite, input.sql, input.params);
        if (input.format !== "csv") return jsonResult({ ...result });
        const content: CallToolResult["content"] = [
          { type: "text", text: sqlResultToCsv(result) },
        ];
        if (result.truncated) {
          content.push({
            type: "text",
            text: "warning: result truncated at 200 rows; narrow the query",
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    "status",
    {
      description:
        "Health snapshot: active player count, stored stat-line count, the last digest/heartbeat delivery, and ingestion freshness (refresh: fresh/stale/running/partial/failed, with last start/finish/success, player counts, and Stat Line inserted/updated counts; null before any refresh). Same shape as GET /health.",
      inputSchema: {},
    },
    () =>
      guarded(async () => jsonResult({ ...(await healthSnapshot(deps.db, deps.now(), deps.tz)) })),
  );

  // --- Named player lists (issue #70 / ADR 0046) ---------------------------

  server.registerTool(
    "lists_list",
    {
      description:
        "List every named player list with its active-member count. A named list scopes a digest or stat-line query to its active members; membership sits UNDER players.active (a deactivated player never appears). Read-only.",
      inputSchema: {},
    },
    () => guarded(async () => jsonResult({ lists: await listLists(deps.db) })),
  );

  server.registerTool(
    "list_create",
    {
      description:
        "Create a new named player list. The name is trimmed, non-blank, and case-sensitively unique among live lists; a duplicate name is rejected. Creating a list adds no members — use list_add_players.",
      inputSchema: ListNameInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListNameInputSchema.parse(args);
        return jsonResult({ list: await createList(deps.db, input.name, deps.now()) });
      }),
  );

  server.registerTool(
    "list_rename",
    {
      description:
        "Rename a live named list. An unknown list is rejected, as is a new name that collides with another live list.",
      inputSchema: ListRenameInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListRenameInputSchema.parse(args);
        return jsonResult({
          list: await renameList(deps.db, input.name, input.newName, deps.now()),
        });
      }),
  );

  server.registerTool(
    "list_delete",
    {
      description:
        "Soft-delete a named list: it disappears from lists_list and can no longer scope a digest/query, but its curation intent is recoverable and its NAME frees for reuse. Membership rows are left in place. An unknown list is rejected, as is the DEFAULT list — point the default elsewhere with list_set_default first.",
      inputSchema: ListNameInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListNameInputSchema.parse(args);
        return jsonResult({ list: await deleteList(deps.db, input.name, deps.now()) });
      }),
  );

  server.registerTool(
    "list_set_default",
    {
      description:
        "Point the DEFAULT list at this one — the list an unscoped command means (#190). Exactly one live list is the default; setting a new one clears the previous in the same transaction. An unknown list is rejected; setting the current default again is an idempotent no-op. The default list cannot be deleted until another is set.",
      inputSchema: ListNameInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListNameInputSchema.parse(args);
        return jsonResult({ list: await setDefaultList(deps.db, input.name, deps.now()) });
      }),
  );

  server.registerTool(
    "list_members",
    {
      description:
        "Show a named list's ACTIVE members, ordered by player id. A deactivated member is excluded (players.active stays the master gate). An unknown list is rejected.",
      inputSchema: ListNameInputShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListNameInputSchema.parse(args);
        const list = await resolveListByName(deps.db, input.name);
        return jsonResult({ list, members: await listMembersById(deps.db, list.id) });
      }),
  );

  server.registerTool(
    "list_add_players",
    {
      description:
        "Add players to a named list, idempotently. Each player reference is exactly one of personId (MLB/MiLB) or highlightlyPlayerId (NCAA).",
      inputSchema: ListMembersMutateShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListMembersMutateSchema.parse(args);
        const result = await addToList(
          deps.db,
          input.name,
          input.players.map(toPlayerRef),
          deps.now(),
        );
        return jsonResult({ list: result.list, added: result.changed, players: result.players });
      }),
  );

  server.registerTool(
    "list_remove_players",
    {
      description:
        "Remove players from a named list. Each reference is exactly one of personId or highlightlyPlayerId.",
      inputSchema: ListMembersMutateShape,
    },
    (args) =>
      guarded(async () => {
        const input = ListMembersMutateSchema.parse(args);
        const result = await removeFromList(
          deps.db,
          input.name,
          input.players.map(toPlayerRef),
          deps.now(),
        );
        return jsonResult({ list: result.list, removed: result.changed, players: result.players });
      }),
  );

  return server;
}
