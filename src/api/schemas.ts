import { z } from "zod";
import { WINDOW_SPECS } from "../domain/window.js";
import { StatLineFilterShape, StatLineQuerySchema, refineFromTo } from "../queries/statLines.js";

/**
 * Shared Zod input schemas for the REST routes and the MCP tools — one
 * validation per boundary shape, used by both surfaces (ADR 0027). Coercion is
 * deliberate: REST inputs arrive as query/path strings, MCP inputs as typed
 * JSON, and both funnel through the same schema.
 */

export const PersonIdSchema = z.coerce.number().int().positive();
export const NcaaPlayerSeqSchema = z.coerce.number().int().positive();

/**
 * STRICT, non-coercing numeric IDs for the typed-JSON MCP boundary. Over MCP,
 * personId/ncaaPlayerSeq arrive as REAL JSON, so the coercing validators above
 * (right for a REST path/query STRING) would turn `personId: [691185]` -> 691185,
 * `true` -> 1, or `"5"` -> 5 and mutate/tag the WRONG player instead of rejecting
 * the call. Non-coercing rejects those outright — the same class of bug, and the
 * same fix, as PR #84's batch-add identities and rules/security.md ("never reuse
 * a coercing validator at a typed-JSON boundary").
 */
export const StrictPersonIdSchema = z.number().int().positive();
export const StrictNcaaPlayerSeqSchema = z.number().int().positive();

export const AddPlayerInputSchema = z.object({
  personId: PersonIdSchema.describe(
    "MLB Stats API personId of the MLB/MiLB player to add. A newly added player's full current season is backfilled immediately; re-adding an existing player is a no-op update (action 'updated', refresh null) with no backfill — use run_refresh to re-pull his season.",
  ),
});

export const AddNcaaPlayerInputSchema = z.object({
  ncaaPlayerSeq: NcaaPlayerSeqSchema.describe(
    "stats.ncaa.org stats_player_seq of the NCAA player to add; his name and school are resolved from his game-log page.",
  ),
});

/**
 * Batch-add (issue #68 / ADR 0045). A batch of *typed identity entries* staged
 * in ONE call. A personId and an ncaaPlayerSeq are indistinguishable positive
 * integers, so each entry is an explicit discriminated `{personId}` /
 * `{ncaaPlayerSeq}` / `{name}` — never positional. A `name` is an MLB-only
 * people-search convenience (there is no NCAA name search, ADR 0032) that must
 * resolve to *exactly one* hit; an NCAA player enters a batch only by
 * stats_player_seq. Unlike single-add (ADR 0030), no first Refresh runs inline:
 * identity resolves now, the season backfills at the next Refresh.
 */

/**
 * Per-call entry cap. This is a LATENCY bound, not a byte-DoS bound like
 * MAX_BACKUP_BYTES: resolving one NCAA stats_player_seq fetches a game-log page
 * at the NCAA client's DEFAULT ~3 s politeness interval, so an all-NCAA batch of
 * N costs ~3 N seconds. 25 entries is a worst case ~75 s, comfortably under the
 * ~100 s Cloudflare-edge timeout (ADR 0045). MLB entries are far cheaper (teams
 * cached). The cap PRESUMES that default ~3 s delay: raising NCAA_SCRAPE_DELAY_MS
 * proportionally lengthens an all-NCAA batch and narrows the safe size, so an
 * operator who raises it should add players in smaller batches. A client-side
 * timeout is non-destructive — batch-add is best-effort and non-transactional, so
 * already-staged rows persist and are valid (re-run to view outcomes, or
 * run_refresh to backfill). A config-derived dynamic cap is out of scope for this
 * single-user host (PR #84 review).
 */
export const MAX_BATCH_ENTRIES = 25;
const BATCH_STRING_MAX = 120;

// Batch JSON identities are real JSON numbers (REST body / MCP typed input; the CLI parses tokens to
// numbers before building entries), so they must NOT coerce — z.coerce.number() would turn `true`→1
// or `[123]`→123 and stage the wrong player, defeating the strict-shape guarantee (PR #84 review).
const BatchPersonIdSchema = z.number().int().positive();
const BatchNcaaPlayerSeqSchema = z.number().int().positive();

/** One typed identity entry: exactly one of personId, ncaaPlayerSeq, or name. */
export const BatchAddEntrySchema = z
  .object({
    personId: BatchPersonIdSchema.optional().describe("MLB Stats API personId (MLB/MiLB)."),
    ncaaPlayerSeq: BatchNcaaPlayerSeqSchema.optional().describe(
      "stats.ncaa.org stats_player_seq (NCAA).",
    ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(BATCH_STRING_MAX)
      .optional()
      .describe("MLB/MiLB player name to resolve via people search; must match exactly one player."),
  })
  .strict()
  .superRefine((val, ctx) => {
    const present =
      (val.personId !== undefined ? 1 : 0) +
      (val.ncaaPlayerSeq !== undefined ? 1 : 0) +
      (val.name !== undefined ? 1 : 0);
    if (present !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "each entry must carry exactly one of personId, ncaaPlayerSeq, or name",
      });
    }
  });

/** The parsed, normalized entry (name trimmed) echoed back in each outcome. */
export type BatchAddEntry = z.infer<typeof BatchAddEntrySchema>;

/**
 * The raw object shape (exposed for the MCP tool schema, like RefreshInputShape)
 * BEFORE the in-batch duplicate refinement is layered on for the service. The
 * `list` field is the #70 named-list seam: accepted and validated for shape,
 * but unused today (there is one Watch List — ADR 0045).
 */
export const BatchAddInputBase = z
  .object({
    entries: z
      .array(BatchAddEntrySchema)
      .min(1)
      .max(MAX_BATCH_ENTRIES)
      .describe(
        `The batch of 1 to ${MAX_BATCH_ENTRIES} typed identity entries to stage; each is exactly one of personId, ncaaPlayerSeq, or name. Their seasons backfill at the next refresh, not inline.`,
      ),
    list: z
      .string()
      .trim()
      .min(1)
      .max(BATCH_STRING_MAX)
      .optional()
      .describe(
        "Reserved named-list target (issue #70). Accepted and shape-validated but IGNORED today — there is one Watch List; a value never changes behavior.",
      ),
  })
  .strict();

/**
 * The full input schema the service parses. Adds in-batch duplicate detection
 * across THREE independent identity spaces — a personId N and an ncaaPlayerSeq N
 * are DIFFERENT humans, never a duplicate; names compare trimmed + lowercased.
 * A duplicate (like an over-cap, blank, or untyped entry) fails the whole call
 * as a usage error BEFORE any network or write (ADR 0045: Zod-strict at the
 * boundary, domain-soft on resolution).
 */
export const BatchAddInputSchema = BatchAddInputBase.superRefine((val, ctx) => {
  const seenPersonId = new Set<number>();
  const seenNcaaSeq = new Set<number>();
  const seenName = new Set<string>();
  val.entries.forEach((entry, i) => {
    if (entry.personId !== undefined) {
      if (seenPersonId.has(entry.personId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i],
          message: `duplicate personId ${entry.personId} in batch`,
        });
      }
      seenPersonId.add(entry.personId);
    }
    if (entry.ncaaPlayerSeq !== undefined) {
      if (seenNcaaSeq.has(entry.ncaaPlayerSeq)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i],
          message: `duplicate ncaaPlayerSeq ${entry.ncaaPlayerSeq} in batch`,
        });
      }
      seenNcaaSeq.add(entry.ncaaPlayerSeq);
    }
    if (entry.name !== undefined) {
      const key = entry.name.trim().toLowerCase();
      if (seenName.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i],
          message: `duplicate name "${entry.name}" in batch`,
        });
      }
      seenName.add(key);
    }
  });
});

/** Shared "exactly one of personId/ncaaPlayerSeq" refinement (deactivate + tag tools). */
function refineExactlyOnePlayerRef(
  input: { personId?: number; ncaaPlayerSeq?: number },
  ctx: z.RefinementCtx,
): void {
  const count = (input.personId !== undefined ? 1 : 0) + (input.ncaaPlayerSeq !== undefined ? 1 : 0);
  if (count !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["personId"],
      message: "provide exactly one of personId or ncaaPlayerSeq",
    });
  }
}

/** Deactivate addressing: exactly one of personId or ncaaPlayerSeq (ADR 0032). */
export const DeactivateInputShape = {
  personId: PersonIdSchema.optional().describe(
    "MLB Stats API personId (MLB/MiLB). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
  ncaaPlayerSeq: NcaaPlayerSeqSchema.optional().describe(
    "stats.ncaa.org stats_player_seq (NCAA). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
};

export const DeactivateInputSchema = z
  .object(DeactivateInputShape)
  .superRefine(refineExactlyOnePlayerRef);

/**
 * STRICT (non-coercing) exactly-one addressing for the typed-JSON MCP tag tools —
 * used verbatim as player_tags_list's inputSchema, and spread into the tag-write
 * shape below. Mirrors DeactivateInputShape but with the strict IDs, so a
 * malformed `personId` over MCP (`[123]`, `true`, `"123"`) is rejected instead of
 * coerced onto the wrong player. REST tag routes keep the coercing path.
 */
export const StrictPlayerRefShape = {
  personId: StrictPersonIdSchema.optional().describe(
    "MLB Stats API personId (MLB/MiLB). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
  ncaaPlayerSeq: StrictNcaaPlayerSeqSchema.optional().describe(
    "stats.ncaa.org stats_player_seq (NCAA). Provide exactly one of personId or ncaaPlayerSeq.",
  ),
};

export const StrictPlayerRefSchema = z
  .object(StrictPlayerRefShape)
  .superRefine(refineExactlyOnePlayerRef);

export const PlayersListInputSchema = z.object({
  active: z
    .enum(["true", "false", "all"])
    .default("true")
    .describe(
      "Watch-list filter: 'true' (default) for active players only, 'false' for deactivated, 'all' for both.",
    ),
  tags: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional tag selector: comma-separated tags are AND (e.g. 'level:aaa,status:rostered' = AAA players on the roster). A bare namespace (e.g. 'prospect') matches any value in it. Only players matching every token are returned.",
    ),
});

/**
 * A manual-tag write body — SYNTAX only (namespace/value are non-empty strings).
 * The tag SERVICE owns the semantics (a manual write to a derived namespace, or
 * an unknown value, is a typed error there), so the two errors stay reachable on
 * every surface. Used verbatim as the REST POST body.
 */
export const TagWriteBodyShape = {
  namespace: z
    .string()
    .trim()
    .min(1)
    .describe("Tag namespace, e.g. 'status'. Manual writes are allowed only to non-derived namespaces."),
  value: z.string().trim().min(1).describe("Tag value within the namespace, e.g. 'rostered' or 'scouted'."),
};

export const TagWriteBodySchema = z.object(TagWriteBodyShape);

/**
 * The MCP tag-write shape: the write body PLUS external player addressing —
 * exactly one of personId/ncaaPlayerSeq. STRICT (non-coercing) IDs, because this
 * is a typed-JSON tool boundary: a malformed `personId` (`[123]`, `true`, `"123"`)
 * must be rejected, never coerced onto the wrong player. REST tag routes address
 * by path string and keep the coercing PersonIdSchema.
 */
export const TagWriteInputShape = {
  ...StrictPlayerRefShape,
  ...TagWriteBodyShape,
};

export const TagWriteInputSchema = z
  .object(TagWriteInputShape)
  .superRefine(refineExactlyOnePlayerRef);

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
    "Date window the report covers: 1d (default), 7d, 14d, 21d, 28d, 35d, 60d, or ytd; every window ends on the last completed host date.",
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
      "send_digest only: forces the daily 1d slot past its already-sent-today (or Offseason heartbeat) guard. Overriding one of those makes the send a write-free replay; forcing with no slot yet today, or over a failed slot, sends and records a delivery row normally. Accepted but ignored by digest_preview.",
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

/**
 * Presentation/Export `format` (ADR 0037). A per-surface STRING enum defaulting
 * to `json`, so every existing caller is byte-identical — a non-`json` value
 * only ADDS an alternative body. A string (never `z.coerce.boolean`) so there is
 * no truthiness trap. `send_digest` deliberately keeps the plain
 * `DigestInputShape` and never gains `format`/`table`.
 *
 * A Presentation (`html`/`md`) renders the WHOLE digest (both tables); an Export
 * (`csv`) is ONE table, chosen by `table` (default `batters`, ignored for the
 * presentation formats).
 */
const DIGEST_FORMAT_DESCRIPTION =
  "Output format (default 'json'): 'json' is the structured preview; 'html'/'md' render the WHOLE digest (both tables) as a Presentation document; 'csv' exports ONE table (chosen by table).";
const DIGEST_TABLE_DESCRIPTION =
  "Which table a 'csv' Export returns: 'batters' (default) or 'pitchers'. Ignored by json/html/md, which cover the whole digest.";

export const DigestPreviewInputShape = {
  ...DigestInputShape,
  format: z.enum(["json", "html", "md", "csv"]).default("json").describe(DIGEST_FORMAT_DESCRIPTION),
  table: z.enum(["batters", "pitchers"]).default("batters").describe(DIGEST_TABLE_DESCRIPTION),
};

export const DigestPreviewInputSchema = z.object(DigestPreviewInputShape);

export const DigestPreviewQueryInputSchema = z.object({
  ...DigestQueryInputSchema.shape,
  format: z.enum(["json", "html", "md", "csv"]).default("json").describe(DIGEST_FORMAT_DESCRIPTION),
  table: z.enum(["batters", "pitchers"]).default("batters").describe(DIGEST_TABLE_DESCRIPTION),
});

/**
 * Stat-line query + `format`, composed from the raw filter shape so the MCP
 * tool can advertise `StatLinesFormatShape` (a plain `ZodRawShape`) while the
 * handler parses `StatLinesFormatSchema` — which re-applies the from<=to
 * pairing via the shared `refineFromTo`.
 */
export const StatLinesFormatShape = {
  ...StatLineFilterShape,
  format: z
    .enum(["json", "csv"])
    .default("json")
    .describe(
      "Output format (default 'json'): 'json' returns the rows as structured JSON; 'csv' returns them as a CSV table (one column per field, stats as a JSON column).",
    ),
};

export const StatLinesFormatSchema = z.object(StatLinesFormatShape).superRefine(refineFromTo);

export const SqlQueryFormatShape = {
  ...SqlQueryInputSchema.shape,
  format: z
    .enum(["json", "csv"])
    .default("json")
    .describe(
      "Output format (default 'json'): 'json' returns { columns, rows, rowCount, truncated }; 'csv' returns the result rows as a CSV table (MCP-only, with a truncation-warning part when the row cap is hit).",
    ),
};

export const SqlQueryFormatSchema = z.object(SqlQueryFormatShape);

export { StatLineQuerySchema };
