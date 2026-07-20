import { z } from "zod";
import { StatLineQuerySchema } from "../queries/statLines.js";

/**
 * Shared Zod input schemas for the REST routes and the MCP tools — one
 * validation per boundary shape, used by both surfaces (ADR 0027). Coercion is
 * deliberate: REST inputs arrive as query/path strings, MCP inputs as typed
 * JSON, and both funnel through the same schema.
 */

export const PersonIdSchema = z.coerce.number().int().positive();
export const NcaaPlayerSeqSchema = z.coerce.number().int().positive();

export const AddPlayerInputSchema = z.object({
  personId: PersonIdSchema,
});

export const AddNcaaPlayerInputSchema = z.object({
  ncaaPlayerSeq: NcaaPlayerSeqSchema,
});

/** Deactivate addressing: exactly one of personId or ncaaPlayerSeq (ADR 0032). */
export const DeactivateInputShape = {
  personId: PersonIdSchema.optional(),
  ncaaPlayerSeq: NcaaPlayerSeqSchema.optional(),
};

export const DeactivateInputSchema = z.object(DeactivateInputShape).superRefine((input, ctx) => {
  const count = (input.personId !== undefined ? 1 : 0) + (input.ncaaPlayerSeq !== undefined ? 1 : 0);
  if (count !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["personId"],
      message: "provide exactly one of personId or ncaaPlayerSeq",
    });
  }
});

export const PlayersListInputSchema = z.object({
  active: z.enum(["true", "false", "all"]).default("true"),
});

export const PlayerSearchInputSchema = z.object({
  q: z.string().trim().min(1),
});

/** Raw shape (exposed for MCP tool schemas); the refined schema validates the pairing. */
export const RefreshInputShape = {
  personId: PersonIdSchema.optional(),
  ncaaPlayerSeq: NcaaPlayerSeqSchema.optional(),
};

export const RefreshInputSchema = z.object(RefreshInputShape).superRefine((input, ctx) => {
  if (input.personId !== undefined && input.ncaaPlayerSeq !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["ncaaPlayerSeq"],
      message: "provide personId or ncaaPlayerSeq, not both",
    });
  }
});

/**
 * Digest force flag (raw shape exposed for the MCP tool schemas, beside
 * RefreshInputShape). Typed JSON in, so a real boolean: an MCP client sending
 * `force: "yes"` should be told it is wrong, not silently obeyed.
 */
export const DigestInputShape = {
  force: z.boolean().default(false),
};

export const DigestInputSchema = z.object(DigestInputShape);

/**
 * The GET-query form of the same flag. Deliberately an enum of the two literal
 * strings and NOT `z.coerce.boolean()`: coercion is JS truthiness, under which
 * the string "false" is TRUE — so `?force=false` would force. Same reason
 * PlayersListInputSchema keeps `active` as string literals.
 */
export const DigestQueryInputSchema = z.object({
  force: z.enum(["true", "false"]).default("false"),
});

export const SqlQueryInputSchema = z.object({
  sql: z.string().trim().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).max(50).default([]),
});

export { StatLineQuerySchema };
