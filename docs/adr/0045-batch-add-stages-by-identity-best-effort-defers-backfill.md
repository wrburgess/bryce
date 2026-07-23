# Batch-add stages players by identity, best-effort, and defers backfill

Batch-adding to the **Watch List** (issue #68) is a single service function `batchAddPlayers`,
exposed on all three surfaces (CLI, REST, MCP — ADR 0027), that takes a batch of *typed identity
entries*, resolves and inserts each best-effort, and — unlike single-add — does **not** run each new
Player's first Refresh inline. A `personId` and an `ncaaPlayerSeq` are indistinguishable positive
integers, so every entry is a discriminated `{personId}` / `{ncaaPlayerSeq}` / `{name}`; a **name** is
only an MLB-only search convenience (MLB Stats API people-search — there is no NCAA name search,
ADR 0032) that must resolve to *exactly one* hit, and an NCAA **Player** enters a batch only by
`stats_player_seq`.

## Considered Options

- **By identity, best-effort, deferred backfill (chosen).** Resolve each entry, insert the row, and let
  the next nightly **Refresh** (or an explicit `run_refresh`) backfill the season. A per-call cap bounds
  worst-case *synchronous resolution* cost (identity still resolves inline, even though backfill is
  deferred), in the spirit of `MAX_BACKUP_BYTES` (ADR 0042). The binding constraint is **NCAA identity
  latency**: resolving one NCAA `stats_player_seq` fetches a current-season game-log page at the NCAA
  client's ~3 s politeness interval, so an all-NCAA batch of N costs ≈ 3 N seconds. The cap is therefore
  set concretely to **25 entries** (worst case ≈ 75 s, comfortably under the ~100 s Cloudflare-edge
  timeout), not the ~100 a byte-style DoS bound would suggest; MLB entries (~0.5 s/call, teams cached)
  are far cheaper. A larger synchronous cap would require a background-job design, deliberately out of
  scope for a single-user host. The cap **presumes the default ~3 s NCAA delay**: raising
  `NCAA_SCRAPE_DELAY_MS` proportionally lengthens an all-NCAA batch and narrows the safe size, so an
  operator who raises it should add players in smaller batches. A client-side timeout is
  non-destructive — batch-add is best-effort and non-transactional (see Consequences), so any
  already-staged rows persist and are valid (re-run to view outcomes, or `run_refresh` to backfill). A
  config-derived dynamic cap is deliberately left out of scope for this single-user host.
- **By name with auto-pick.** Rejected: a bare name is not a domain identity; auto-picking the top
  search hit silently watches the wrong human, and names are MLB-only anyway.
- **Inline first-Refresh per entry (like single-add, ADR 0030).** Rejected for batches: N sequential
  full-season, rate-limited backfills is minutes of work — untenable inside one HTTP request or MCP
  tool call. Single-add keeps its inline backfill; the asymmetry is deliberate (see Consequences).
- **All-or-nothing (like `restorePlayerListBackup`, ADR 0042).** Rejected: one zero-hit name would kill
  a whole pasted roster. Instead, the batch's *shape* is validated strictly up front (over-cap, blank,
  untyped, in-batch duplicate → the whole call is rejected as a usage error, before any network or
  write), then each entry is *resolved* best-effort with a per-entry outcome
  `{ added, updated, unresolved, failed }`. This is the repo's standing seam — Zod-strict at the
  boundary, domain-soft on resolution.

## Consequences

- **Single-add and batch-add diverge on purpose.** Single-add stays interactive ("add Witt, see his
  season now" — inline first Refresh, ADR 0030); batch-add *stages* players and their stats appear at
  the next Refresh. A future reader should not "fix" this asymmetry — it is the whole reason batch-add
  is feasible as one call.
- **A freshly batch-added Player is briefly statless** until the next Refresh; this is expected, and the
  batch result tells the operator how many were staged so they can `run_refresh` to backfill early.
  Batch-add itself records no freshness run, so it does not affect the digest freshness gate (ADR 0043).
- **List-agnostic until #70.** Batch-add targets the single **Watch List** (there is no list object
  today); the service signature and API/MCP schemas leave an optional `list` seam so named lists
  (#70) can slot in without breaking callers. #70 owns the list model.
- **Unknown *top-level* keys are silently ignored on MCP, rejected on REST.** MCP registers
  `BatchAddInputBase.shape`, and the MCP SDK wraps that raw shape in a *non-strict* `z.object` that
  **strips** an unknown top-level sibling of `entries`/`list` rather than rejecting it (REST parses the
  `.strict()` schema directly, so it 400s the same input). This is a cosmetic surface difference only:
  the SDK still enforces each entry's `.strict()` shape, the `.min(1)`/`.max(25)` cap, and the
  exactly-one-key rule, and the service's own `BatchAddInputSchema.parse` re-runs the in-batch dedupe —
  so **entries, the cap, exactly-one-key, and in-batch dedupe are strictly enforced on every surface,
  and no malformed entry is ever staged**. `registerTool` takes a raw shape and cannot be told to be
  strict, so this is documented, not code-fixed.
- **Two input encodings, one entry model.** REST/MCP take a JSON `{ entries: [...] }` array; the CLI
  adds a paste-friendly `--file` of tagged lines (bare digits → `personId`, `ncaa:<n>` →
  `ncaaPlayerSeq`, anything else → a name, `name:` as an explicit escape; `#` comments and blank lines
  ignored, each line trimmed) alongside quick `--person-ids` / `--ncaa-seqs` / `--names` flags. Both
  encodings parse to the same typed-entry array and validate through the same downstream logic.
