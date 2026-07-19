import { z } from "zod";
import { StatLineQuerySchema } from "../queries/statLines.js";

/**
 * Shared Zod input schemas for the REST routes and the MCP tools — one
 * validation per boundary shape, used by both surfaces (ADR 0027). Coercion is
 * deliberate: REST inputs arrive as query/path strings, MCP inputs as typed
 * JSON, and both funnel through the same schema.
 */

export const PersonIdSchema = z.coerce.number().int().positive();

export const AddPlayerInputSchema = z.object({
  personId: PersonIdSchema,
});

export const PlayersListInputSchema = z.object({
  active: z.enum(["true", "false", "all"]).default("true"),
});

export const PlayerSearchInputSchema = z.object({
  q: z.string().trim().min(1),
});

export const RefreshInputSchema = z.object({
  personId: PersonIdSchema.optional(),
});

export const SqlQueryInputSchema = z.object({
  sql: z.string().trim().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).max(50).default([]),
});

export { StatLineQuerySchema };
