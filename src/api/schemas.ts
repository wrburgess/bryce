import { z } from "zod";
import { WINDOW_SPECS } from "../domain/window.js";
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
  personId: PersonIdSchema.describe(
    "MLB Stats API personId of the MLB/MiLB player to add; his full current season is backfilled on add.",
  ),
});

export const AddNcaaPlayerInputSchema = z.object({
  ncaaPlayerSeq: NcaaPlayerSeqSchema.describe(
    "stats.ncaa.org stats_player_seq of the NCAA player to add; his name and school are resolved from his game-log page.",
  ),
});

/** Deactivate addressing: exactly one of personId or ncaaPlayerSeq (ADR 0032). */
export const DeactivateInputShape = {
  personId: PersonIdSchema.optional().describe(
    "MLB Stats API personId (MLB/MiLB). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
  ncaaPlayerSeq: NcaaPlayerSeqSchema.optional().describe(
    "stats.ncaa.org stats_player_seq (NCAA). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
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
  active: z
    .enum(["true", "false", "all"])
    .default("true")
    .describe(
      "Watch-list filter: 'true' (default) for active players only, 'false' for deactivated, 'all' for both.",
    ),
});

export const PlayerSearchInputSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .describe("Name or partial name to search MLB/MiLB players by, via the MLB Stats API people search."),
});

/** Raw shape (exposed for MCP tool schemas); the refined schema validates the pairing. */
export const RefreshInputShape = {
  personId: PersonIdSchema.optional().describe(
    "MLB Stats API personId (MLB/MiLB) to refresh; omit both fields to refresh every active player.",
  ),
  ncaaPlayerSeq: NcaaPlayerSeqSchema.optional().describe(
    "stats.ncaa.org stats_player_seq (NCAA) to refresh; omit both fields to refresh every active player.",
  ),
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
 * Which date window the report covers. An unsupported value is REJECTED rather
 * than defaulted, on every surface — the window is the content, so quietly
 * sending a different report than the operator asked for is the failure this
 * fails closed against. Absent means `1d`, the daily artifact.
 */
const WindowSchema = z
  .enum(WINDOW_SPECS)
  .default("1d")
  .describe(
    "Date window the report covers: 1d (default), 7d, 14d, 21d, or ytd; every window ends on the last completed host date.",
  );

/**
 * Digest inputs (raw shape exposed for the MCP tool schemas, beside
 * RefreshInputShape). Typed JSON in, so `force` is a real boolean: an MCP
 * client sending `force: "yes"` should be told it is wrong, not silently obeyed.
 */
export const DigestInputShape = {
  force: z
    .boolean()
    .default(false)
    .describe(
      "send_digest only: daily-slot test replay overriding the already-sent-today guard; accepted but ignored by digest_preview.",
    ),
  window: WindowSchema,
};

export const DigestInputSchema = z.object(DigestInputShape);

/**
 * The GET-query form. `force` is deliberately an enum of the two literal
 * strings and NOT `z.coerce.boolean()`: coercion is JS truthiness, under which
 * the string "false" is TRUE — so `?force=false` would force. Same reason
 * PlayersListInputSchema keeps `active` as string literals.
 */
export const DigestQueryInputSchema = z.object({
  force: z
    .enum(["true", "false"])
    .default("false")
    .describe("Accepted for symmetry with POST /digest/send but a no-op here: a preview never claims or sends."),
  window: WindowSchema,
});

export const SqlQueryInputSchema = z.object({
  sql: z
    .string()
    .trim()
    .min(1)
    .describe(
      "A single read-only SQL statement (SELECT/WITH/EXPLAIN) over the Bryce SQLite database; writes are rejected.",
    ),
  params: z
    .array(z.union([z.string(), z.number(), z.null()]))
    .max(50)
    .default([])
    .describe(
      "Positional bind parameters for the '?' placeholders in sql, in order; up to 50 strings, numbers, or nulls.",
    ),
});

export { StatLineQuerySchema };
