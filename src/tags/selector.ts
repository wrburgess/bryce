/**
 * The tag-selector GRAMMAR, alone — and deliberately **dependency-free**.
 *
 * It lives apart from `src/tags/service.ts` (which pulls in drizzle, the schema,
 * and query helpers) so `src/cli/router.ts` can validate a `--tags` value during
 * **preflight**, before any leaf module is imported. The router "intentionally
 * imports no configuration or service modules": route resolution, help, and
 * option preflight are pure, and a leaf is loaded only once that work succeeds.
 * Without this split, `sk digest --tags level:AAA` would load `digest.main` and
 * run `startupDb` — snapshotting, migrating, and re-deriving tags — before the
 * selector was ever rejected, so an invalid command could mutate state on its way
 * to exit 1 (#140 / PR #150, Reviewer finding).
 *
 * The alternative — a second copy of the rules in the router — is the thing this
 * file exists to prevent. One grammar, two callers: the router validates with it,
 * and the service throws its ZodError from it.
 *
 * Nothing here imports anything, including zod: the functions return an error
 * STRING (the shape the router's `validate` hook wants) and the service maps that
 * string onto the typed boundary error every surface already handles.
 */

/** A parsed selector token: `ns:value`, or a bare `ns` (value=null → any value). */
export interface TagToken {
  namespace: string;
  value: string | null;
}

/**
 * The one shape a namespace or value may take: lowercase alphanumerics and
 * internal hyphens, bounded in length. This is not a stylistic bound — it is the
 * SECURITY boundary for the cohort label (#140). A parsed selector is rendered
 * back into an email subject (an SMTP/Postmark header), an HTML heading, and a
 * Markdown heading; constraining the charset HERE makes the label safe in all of
 * those sinks by construction, rather than relying on each sink to escape
 * correctly. A CR/LF inside a value would otherwise survive `trim()` (which only
 * strips the ENDS of a token) and reach a mail header.
 *
 * Verified sufficient for every value the system can store: `level:` (mlb, aaa,
 * aa, high-a, single-a, rookie, dsl, ncaa), `pos:` (POSITION_MAP emits lowercase
 * granular + coarse values, including the leading-digit `1b`), `prospect`, and
 * `status:` (rostered, scouted).
 */
export const MAX_TAG_SEGMENT_LENGTH = 64;
const TAG_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The most tokens a selector may carry (a cheap denial-of-service bound). */
export const MAX_SELECTOR_TOKENS = 16;

/**
 * Longest the RENDERED label may be. A per-segment bound alone is not enough:
 * {@link MAX_SELECTOR_TOKENS} tokens at {@link MAX_TAG_SEGMENT_LENGTH} each
 * still render ~2,094 characters, well past the 998-octet physical header line
 * RFC 5322 allows — so the aggregate is what must be bounded, not the parts.
 * 512 leaves room for the subject's prefix and window suffix inside that limit
 * while staying ~20x the longest selector anyone would actually type.
 */
export const MAX_SELECTOR_LABEL_LENGTH = 512;

/**
 * Render parsed tokens back to their normalized display form (`level:aaa,
 * status:rostered`) — deduped and order-preserving, because that is what the
 * parser produced. Presentation reads THIS rather than the operator's raw input,
 * so a label can never carry text the parser did not accept.
 */
export function formatTagSelector(tokens: readonly TagToken[]): string {
  return tokens.map((tok) => (tok.value === null ? tok.namespace : `${tok.namespace}:${tok.value}`)).join(", ");
}

/**
 * Parse a selector, returning either its tokens or a human-readable reason. The
 * non-throwing half of the grammar: {@link parseTagSelector} turns `error` into
 * the typed ZodError every surface maps to 400 / MCP isError / CLI exit 1, and
 * the router's preflight uses {@link validateTagSelector} to reject the same
 * inputs before a leaf module loads.
 */
export function parseTagSelectorOrError(expr: string): { tokens: TagToken[] } | { error: string } {
  const segments = expr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const tokens: TagToken[] = [];
  for (const segment of segments) {
    const colon = segment.indexOf(":");
    const namespace = colon === -1 ? segment : segment.slice(0, colon);
    const value = colon === -1 ? null : segment.slice(colon + 1);
    if (!TAG_SEGMENT.test(namespace) || (value !== null && !TAG_SEGMENT.test(value))) {
      return { error: `malformed tag token '${segment}'` };
    }
    // NUL as the composite-key separator, written as an ESCAPE so the source
    // stays plain text and git keeps diffing it (rules/backend.md, issue #30).
    const key = `${namespace}\u0000${value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ namespace, value });
  }
  // A PROVIDED expression that normalizes to zero tokens (only separators or
  // whitespace, e.g. `,,,` or `  `) is malformed — NOT an absent filter. Left to
  // fall through, an empty token list would read as "no filter" and return the
  // whole roster, silently bypassing the validation error. An ABSENT `tags` param
  // never reaches here (callers guard on undefined), so this only rejects a
  // present-but-empty selector.
  if (tokens.length === 0) return { error: `tag selector '${expr}' has no tokens` };
  if (tokens.length > MAX_SELECTOR_TOKENS) {
    return { error: `too many tag tokens (max ${MAX_SELECTOR_TOKENS})` };
  }
  // Bound what actually reaches the mail header: the RENDERED label, not the
  // segments it is built from. Checked last, so a caller sees the specific reason
  // (malformed / too many tokens) before this catch-all size limit.
  const label = formatTagSelector(tokens);
  if (label.length > MAX_SELECTOR_LABEL_LENGTH) {
    return {
      error: `tag selector is too long: ${label.length} characters (max ${MAX_SELECTOR_LABEL_LENGTH})`,
    };
  }
  return { tokens };
}

/**
 * The router's `validate` hook shape: null when the selector is well-formed, an
 * "expected …" fragment when it is not. Same rules as the parser, by
 * construction — it IS the parser, with the tokens discarded.
 */
export function validateTagSelector(value: string): string | null {
  const parsed = parseTagSelectorOrError(value);
  return "error" in parsed ? `a valid tag selector (${parsed.error})` : null;
}
