# Player names are normalized to NFC at the ingestion boundary

A Player's name reaches storage from two independent sources — the MLB Stats API (JSON) and the
stats.ncaa.org scrape (HTML) — that need not agree on Unicode *normalization form*. `Acuña` can be
stored as precomposed `ñ` (NFC, U+00F1) or as `n` + a combining tilde (NFD, U+006E U+0303): the same
name to a reader, two different byte strings to the code. Left verbatim, that makes the
identity-refresh compare in `src/jobs/refresh.ts` (`latestName !== player.fullName`) flip-flop and
rewrite an unchanged name whenever a source alternates forms, and it leaves "byte-for-byte fidelity
through every surface" (the #65 goal) with no fixed target.

We normalize to **NFC at the two ingestion boundaries** — the MLB `PersonSchema.fullName` Zod
transform and the NCAA `parseGameLogPage` name/school extraction — through one shared
`canonicalizeName` (`src/domain/names.ts` = `normalize("NFC")` + whitespace squish + trim). NFC is the
W3C interchange form, the shortest representation, and what both sources almost always already emit, so
this is a near-no-op that makes the round-trip invariant true *by construction*. Every surface
downstream (storage, REST API, MCP, digest HTML/text, CSV export) then carries one stable form and is
asserted byte-identical.

## Consequences

- **Boundary-enforced, not DB-enforced.** SQLite has no NFC constraint, so the invariant lives at the
  app ingestion boundary. Every write of an identity name flows through a canonicalizing source
  (`PersonSchema`, `parseGameLogPage`); do not add a write path that bypasses them.
- **`stat_lines.raw` stays verbatim by design.** Only the identity name is canonicalized; the raw
  gameLog snapshot (and `GameLogSplitSchema.player.fullName`, which feeds it) is left exactly as the
  source sent it, for faithful re-processing. Every name a surface *shows* comes from the identity row,
  never from `raw`.
- **One-time convergence.** A name already stored in NFD is rewritten to NFC on its next refresh, then
  stable (idempotent). No migration is needed.
- **Deliberately out of scope (#65):** East-Asian *wide*-character column alignment in the plain-text
  digest (the sources emit Latin transliterations only; the HTML part aligns regardless — a wide name
  still round-trips intact, only its plain-text column may be ragged); team/opponent-name
  normalization (display-only, not identity-compared); a speculative `TextDecoder` on the NCAA fetch
  (no evidence of a charset defect — the on-host `npm run ncaa:probe` remains the catch); and CLI-stdout
  ASCII policy (a separate doctrine question against ADR 0011 / `rules/scripting.md`).
