import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { players } from "../db/schema.js";
import { assembleDigest } from "../digest/assemble.js";
import {
  digestTableRows,
  renderDigest,
  renderDigestHtmlDocument,
  renderDigestMarkdown,
} from "../digest/render.js";
import { toCsv } from "../export/csv.js";
import { statLinesToCsv } from "../export/tabular.js";
import { runDigest } from "../jobs/digest.js";
import { runRefresh, runRefreshForPlayer } from "../jobs/refresh.js";
import {
  BlankListNameError,
  DuplicateListNameError,
  UnknownListError,
  addToList,
  createList,
  deleteList,
  listLists,
  listMembersOf,
  removeFromList,
  renameList,
  resolveListByName,
} from "../lists/service.js";
import { MlbApiError } from "../mlb/client.js";
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../ncaa/client.js";
import { queryStatLines } from "../queries/statLines.js";
import type { ServiceDeps } from "../server/deps.js";
import {
  PlayerNotFoundError,
  UnknownNcaaPlayerError,
  UnknownPersonError,
  addNcaaPlayer,
  addPlayer,
  batchAddPlayers,
  deactivatePlayer,
  listPlayers,
  searchPlayers,
} from "../watchlist/service.js";
import type { PlayerRef } from "../watchlist/service.js";
import {
  AddNcaaPlayerInputSchema,
  AddPlayerInputSchema,
  DigestInputSchema,
  DigestPreviewQueryInputSchema,
  ListCreateBodySchema,
  ListMembersBodySchema,
  ListRenameBodySchema,
  NcaaPlayerSeqSchema,
  PersonIdSchema,
  PlayerSearchInputSchema,
  PlayersListInputSchema,
  RefreshInputSchema,
  StatLinesFormatSchema,
} from "./schemas.js";

/** Project a validated member reference into the service's PlayerRef union. */
function toPlayerRef(ref: { personId?: number; ncaaPlayerSeq?: number }): PlayerRef {
  return ref.personId !== undefined ? ref.personId : { ncaaPlayerSeq: ref.ncaaPlayerSeq! };
}

/**
 * Thin token-authed REST API (ADR 0027): request/response orchestration only —
 * every behavior lives in the shared service layer the MCP tools also use.
 * Mounted under /api behind the bearer middleware (src/server/auth.ts).
 */

/** Body-size ceiling for POST /players/batch — a cheap DoS guard for the 25-entry cap. */
const MAX_BATCH_BODY_BYTES = 64 * 1024;

/**
 * A non-JSON Presentation/Export body as a downloadable file (ADR 0037): set a
 * charset-tagged Content-Type and an `attachment` disposition with a
 * deterministic filename, then return the rendered string. Stays under `/api`,
 * so it inherits the same bearer auth as every other route.
 */
function fileResponse(c: Context, body: string, contentType: string, filename: string): Response {
  c.header("Content-Type", `${contentType}; charset=utf-8`);
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(body);
}

export function createApiRoutes(deps: ServiceDeps): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: "invalid-input", issues: err.issues }, 400);
    }
    if (
      err instanceof UnknownPersonError ||
      err instanceof UnknownNcaaPlayerError ||
      err instanceof PlayerNotFoundError ||
      err instanceof UnknownListError
    ) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof DuplicateListNameError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof BlankListNameError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof MlbApiError || err instanceof NcaaApiError) {
      // Upstream (MLB Stats API / stats.ncaa.org) failure: a bad gateway.
      return c.json({ error: err.message }, 502);
    }
    if (err instanceof UnsupportedNcaaSeasonError) {
      // A bundled-data gap on OUR side (src/ncaa/seasons.ts needs its annual
      // update), not an upstream failure — unavailable until the table grows.
      return c.json({ error: err.message }, 503);
    }
    if (err instanceof SyntaxError) {
      // Malformed JSON body — a client error, not a server one.
      return c.json({ error: "invalid-input", issues: [{ message: err.message }] }, 400);
    }
    throw err;
  });

  api.get("/players", async (c) => {
    const query = PlayersListInputSchema.parse(c.req.query());
    const filter = query.active === "all" ? "all" : query.active === "true" ? "active" : "inactive";
    return c.json({ players: await listPlayers(deps.db, filter) });
  });

  api.post("/players", async (c) => {
    const body = AddPlayerInputSchema.parse(await c.req.json());
    const result = await addPlayer(deps, body.personId);
    return c.json(result, result.action === "added" ? 201 : 200);
  });

  api.post("/players/ncaa", async (c) => {
    const body = AddNcaaPlayerInputSchema.parse(await c.req.json());
    const result = await addNcaaPlayer(deps, body.ncaaPlayerSeq);
    return c.json(result, result.action === "added" ? 201 : 200);
  });

  // Batch-add (issue #68 / ADR 0045). A bad shape (over-cap, blank, untyped,
  // in-batch duplicate) is a ZodError the service throws -> onError -> 400. Soft
  // per-entry outcomes (unresolved/failed) stay INSIDE the 200 body — they never
  // take the 404/502 error seam. A 64 KB body limit is a cheap DoS guard sized
  // for the 25-entry cap; the middleware short-circuits an oversize body with 413.
  api.post(
    "/players/batch",
    bodyLimit({
      maxSize: MAX_BATCH_BODY_BYTES,
      onError: (c) => c.json({ error: "payload-too-large" }, 413),
    }),
    async (c) => {
      const result = await batchAddPlayers(deps, await c.req.json());
      return c.json(result, 200);
    },
  );

  api.post("/players/ncaa/:seq/deactivate", async (c) => {
    const ncaaPlayerSeq = NcaaPlayerSeqSchema.parse(c.req.param("seq"));
    const player = await deactivatePlayer(deps, { ncaaPlayerSeq });
    return c.json({ player });
  });

  api.post("/players/:id/deactivate", async (c) => {
    const personId = PersonIdSchema.parse(c.req.param("id"));
    const player = await deactivatePlayer(deps, personId);
    return c.json({ player });
  });

  api.get("/players/search", async (c) => {
    const query = PlayerSearchInputSchema.parse(c.req.query());
    return c.json({ results: await searchPlayers(deps, query.q) });
  });

  api.get("/stat-lines", async (c) => {
    // `format` (json|csv) is validated here; queryStatLines re-parses the raw
    // query (stripping `format`) and re-checks from<=to as defense in depth.
    const query = StatLinesFormatSchema.parse(c.req.query());
    const views = await queryStatLines(deps.db, c.req.query());
    if (query.format === "csv") {
      return fileResponse(c, statLinesToCsv(views), "text/csv", "bryce-stat-lines.csv");
    }
    return c.json({ statLines: views });
  });

  api.get("/digest/preview", async (c) => {
    // An unsupported `window` or `format` is a ZodError -> 400 via onError.
    // `force` is still accepted and still means nothing here: a preview neither
    // claims nor sends, and window selection makes its CONTENT identical either
    // way. `table` is accepted for every format but used only by csv — a
    // Presentation (html/md) always renders both tables.
    const query = DigestPreviewQueryInputSchema.parse(c.req.query());
    // A `?list=` scopes the preview to that list's active members; an unknown
    // list fails closed (UnknownListError -> 404 via onError).
    const listId =
      query.list !== undefined ? (await resolveListByName(deps.db, query.list)).id : undefined;
    const assembly = await assembleDigest(deps.db, { ...deps, spec: query.window, listId });
    const spec = assembly.window.spec;
    if (query.format === "html") {
      return fileResponse(
        c,
        renderDigestHtmlDocument(assembly),
        "text/html",
        `bryce-digest-${spec}.html`,
      );
    }
    if (query.format === "md") {
      return fileResponse(
        c,
        renderDigestMarkdown(assembly),
        "text/markdown",
        `bryce-digest-${spec}.md`,
      );
    }
    if (query.format === "csv") {
      const dt = digestTableRows(assembly, query.table);
      return fileResponse(
        c,
        toCsv(dt.headers, dt.rows),
        "text/csv",
        `bryce-${query.table}-${spec}.csv`,
      );
    }
    return c.json({
      window: assembly.window,
      statLineCount: assembly.statLineCount,
      playerCount: assembly.playerCount,
      batters: assembly.batters,
      pitchers: assembly.pitchers,
      unknownFields: assembly.unknownFields,
      mail: renderDigest(assembly),
    });
  });

  api.post("/digest/send", async (c) => {
    // An empty or absent body means "no force" — the shape POST /digest/send
    // had before force existed, so every existing caller keeps working.
    // Malformed JSON is a client error (SyntaxError -> 400 via onError).
    const raw = await c.req.text();
    const body = DigestInputSchema.parse(raw.trim().length === 0 ? {} : JSON.parse(raw));
    // A `list` scopes an ON-DEMAND send to that list's members; unknown -> 404.
    const listId =
      body.list !== undefined ? (await resolveListByName(deps.db, body.list)).id : undefined;
    const result = await runDigest({
      db: deps.db,
      mailer: deps.mailer,
      now: deps.now,
      tz: deps.tz,
      to: deps.digestTo,
      from: deps.digestFrom,
      spec: body.window,
      force: body.force,
      listId,
    });
    return c.json(result, result.action === "failed" ? 502 : 200);
  });

  api.post("/refresh", async (c) => {
    // An empty or absent body means "refresh everything"; malformed JSON is a
    // client error (SyntaxError -> 400 via onError), never a full refresh.
    const raw = await c.req.text();
    const body = RefreshInputSchema.parse(raw.trim().length === 0 ? {} : JSON.parse(raw));
    if (body.personId === undefined && body.ncaaPlayerSeq === undefined) {
      return c.json(await runRefresh(deps));
    }
    const where =
      body.ncaaPlayerSeq !== undefined
        ? eq(players.ncaaPlayerSeq, body.ncaaPlayerSeq)
        : eq(players.externalId, body.personId!);
    const player = (await deps.db.select().from(players).where(where))[0];
    if (player === undefined) {
      throw new PlayerNotFoundError(
        body.ncaaPlayerSeq !== undefined ? { ncaaPlayerSeq: body.ncaaPlayerSeq } : body.personId!,
      );
    }
    return c.json(await runRefreshForPlayer(deps, player.id));
  });

  // --- Named player lists (issue #70 / ADR 0046) ---------------------------

  api.get("/lists", async (c) => {
    return c.json({ lists: await listLists(deps.db) });
  });

  api.post("/lists", async (c) => {
    const body = ListCreateBodySchema.parse(await c.req.json());
    const list = await createList(deps.db, body.name, deps.now());
    return c.json({ list }, 201);
  });

  api.get("/lists/:name", async (c) => {
    const name = c.req.param("name");
    const list = await resolveListByName(deps.db, name);
    return c.json({ list, members: await listMembersOf(deps.db, name) });
  });

  api.patch("/lists/:name", async (c) => {
    const body = ListRenameBodySchema.parse(await c.req.json());
    const list = await renameList(deps.db, c.req.param("name"), body.name, deps.now());
    return c.json({ list });
  });

  api.delete("/lists/:name", async (c) => {
    const list = await deleteList(deps.db, c.req.param("name"), deps.now());
    return c.json({ list });
  });

  api.post("/lists/:name/members", async (c) => {
    const body = ListMembersBodySchema.parse(await c.req.json());
    const result = await addToList(
      deps.db,
      c.req.param("name"),
      body.players.map(toPlayerRef),
      deps.now(),
    );
    return c.json({ list: result.list, added: result.changed, players: result.players });
  });

  api.delete("/lists/:name/members", async (c) => {
    const body = ListMembersBodySchema.parse(await c.req.json());
    const result = await removeFromList(
      deps.db,
      c.req.param("name"),
      body.players.map(toPlayerRef),
      deps.now(),
    );
    return c.json({ list: result.list, removed: result.changed, players: result.players });
  });

  return api;
}
