import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { players } from "../db/schema.js";
import { assembleDigest } from "../digest/assemble.js";
import { renderDigest } from "../digest/render.js";
import { runDigest } from "../jobs/digest.js";
import { runRefresh, runRefreshForPlayer } from "../jobs/refresh.js";
import { MlbApiError } from "../mlb/client.js";
import { queryStatLines } from "../queries/statLines.js";
import type { ServiceDeps } from "../server/deps.js";
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
  PersonIdSchema,
  PlayerSearchInputSchema,
  PlayersListInputSchema,
  RefreshInputSchema,
} from "./schemas.js";

/**
 * Thin token-authed REST API (ADR 0027): request/response orchestration only —
 * every behavior lives in the shared service layer the MCP tools also use.
 * Mounted under /api behind the bearer middleware (src/server/auth.ts).
 */

export function createApiRoutes(deps: ServiceDeps): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: "invalid-input", issues: err.issues }, 400);
    }
    if (err instanceof UnknownPersonError || err instanceof PlayerNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof MlbApiError) {
      return c.json({ error: err.message }, 502);
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
    return c.json({ statLines: await queryStatLines(deps.db, c.req.query()) });
  });

  api.get("/digest/preview", async (c) => {
    const assembly = await assembleDigest(deps.db, deps);
    const mail = renderDigest({
      date: assembly.date,
      lines: assembly.lines,
      noNewStats: assembly.noNewStats,
    });
    return c.json({
      date: assembly.date,
      statLineCount: assembly.reportedIds.length,
      playerCount: assembly.playerCount,
      lines: assembly.lines,
      noNewStats: assembly.noNewStats,
      mail,
    });
  });

  api.post("/digest/send", async (c) => {
    const result = await runDigest({
      db: deps.db,
      mailer: deps.mailer,
      now: deps.now,
      tz: deps.tz,
      to: deps.digestTo,
      from: deps.digestFrom,
    });
    return c.json(result, result.action === "failed" ? 502 : 200);
  });

  api.post("/refresh", async (c) => {
    // An empty or absent body means "refresh everything"; malformed JSON is a
    // client error (SyntaxError -> 400 via onError), never a full refresh.
    const raw = await c.req.text();
    const body = RefreshInputSchema.parse(raw.trim().length === 0 ? {} : JSON.parse(raw));
    if (body.personId === undefined) {
      return c.json(await runRefresh(deps));
    }
    const player = (
      await deps.db.select().from(players).where(eq(players.externalId, body.personId))
    )[0];
    if (player === undefined) {
      throw new PlayerNotFoundError(body.personId);
    }
    return c.json(await runRefreshForPlayer(deps, player.id));
  });

  return api;
}
