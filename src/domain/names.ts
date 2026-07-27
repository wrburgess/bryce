/**
 * Player-name canonicalization at the ingestion boundary (ADR 0041).
 *
 * A Player's name arrives from two independent sources — the MLB Stats API
 * (JSON) and the stats.ncaa.org scrape (HTML) — that need not agree on Unicode
 * *normalization form*. "Acuña" is a real example: `ñ` can be one precomposed
 * code point (NFC, U+00F1) or a base `n` + a combining tilde (NFD, U+006E
 * U+0303). Both render identically, but they are DIFFERENT byte strings.
 *
 * Storing whichever form a source happens to send makes two things go wrong:
 *   1. The identity-refresh compare in src/jobs/refresh.ts (`latestName !==
 *      player.fullName`) flip-flops when a source alternates forms, rewriting a
 *      name that did not actually change.
 *   2. "Byte-for-byte fidelity through every surface" has no fixed target if the
 *      stored bytes are nondeterministic.
 *
 * The fix is to pick ONE form at the boundary. NFC is chosen: it is the W3C
 * interchange form, the shortest representation, and what both sources almost
 * always already emit — so in practice this is a near-no-op that makes the
 * round-trip invariant true *by construction* rather than by luck.
 *
 * This canonicalizes the stored *identity* name only. The verbatim source
 * snapshot in `stat_lines.raw` is deliberately left untouched (it exists for
 * faithful re-processing); every surface that shows a name reads the identity
 * row, never `raw`.
 */

/**
 * The one definition of a stored player/school name: NFC-normalized, internal
 * whitespace collapsed, trimmed. Idempotent — a canonical name in yields the
 * same string out. Non-ASCII letters and punctuation (accents, apostrophes,
 * wide characters) are preserved exactly; only the normalization form and
 * surrounding/internal whitespace are regularized.
 */
export function canonicalizeName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Make a runtime-derived value safe for one greppable ASCII line
 * (rules/scripting.md): strip diacritics, collapse any whitespace/control run
 * (incl. newlines that would forge extra lines) to a single space, and replace
 * any residual non-ASCII byte with '?'. (PR #84 review.)
 *
 * NOTE what this does NOT do: `canonicalizeName` collapses `\s+`, which does
 * NOT cover `\x1b` — an ANSI escape surviving in an upstream name is stripped
 * HERE and nowhere else. That matters for any reporter whose presenter drives
 * cursor control, because an escape in a name could otherwise overwrite lines
 * the presenter already printed
 * ([ADR 0047](../../docs/adr/0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md),
 * amended for #146).
 *
 * It lives beside `canonicalizeName` — the other end of the same identity
 * pipeline — because it now has two callers: `players:batch-add`'s bulk outcome
 * reporter and the `refresh` liveness stream's presenter.
 */
export function asciiField(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accent marks (U+0300..U+036F)
    .replace(/\s+/g, " ") // collapse whitespace/newlines -> single space
    .replace(/[^\x20-\x7e]/g, "?") // any residual non-ASCII byte -> '?'
    .trim();
}
