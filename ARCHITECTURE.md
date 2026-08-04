# Architecture

A map of Bryce for a reviewer who reads MVC fluently and has never read this tree. It answers four
questions — **where does code live**, **how does a request get in**, **what happens on the one path
that matters most**, and **who is allowed to write what** — and then hands off to the per-surface
references rather than restating them.

The vocabulary is [`docs/domain/CONTEXT.md`](docs/domain/CONTEXT.md): *Player*, *Lane*, *Tick*,
*Digest*, *Window*, *Sweep*, *Stat Line*, *Roll-up*. Capitalized terms below are that glossary's,
not English.

**Currency.** This map is normative for review, so **a PR that invalidates a row here updates it in
the same PR**. A directory added under `src/` and absent from the table below is, by that rule, an
incomplete change — not a documentation debt to file later.

## The MVC map

Bryce has no web UI at all ([ADR 0027](docs/adr/0027-mcp-first-interface-no-web-ui.md)), so it is
not an MVC framework — but the three roles still name what each directory is *for*. **Controllers**
validate and orchestrate; **Models** hold rules and state; **Views** turn a finished result into
bytes a human or a spreadsheet reads. Two directories genuinely carry two roles and say so here
rather than being forced into one, and one is honestly cross-cutting.

This table is the authoritative inventory: 21 directories plus 3 root files.

| Path | Role | What lives there |
|---|---|---|
| `src/api` | Controller | The Hono route table and its Zod request schemas (`schemas.ts`); one `onError` maps every typed domain error to a status. |
| `src/backup` | Model (persistence ops) | Snapshot create/validate/prune/restore and the versioned Player List Backup envelope ([ADR 0042](docs/adr/0042-snapshot-and-player-backup-complement-litestream.md)). |
| `src/cli` | Controller | The `sk` router, its pure preflight, and one presenter per command — the only presenter of results ([ADR 0056](docs/adr/0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md)); a job's diagnostic sink defaults to stderr only when its caller injects none. |
| `src/db` | Model (schema + storage lifecycle) | Only `schema.ts` is Model in the strict sense; `client/startup/pending/lock/readonly` are storage lifecycle — migration seam, advisory presence registry, read-only handle. |
| `src/digest` | Model **+** View | `assemble.ts`, `game-window.ts`, `rows.ts`, `rates.ts` select and roll up; `render.ts` alone turns an assembly into HTML/text/Markdown. |
| `src/domain` | Model (pure rules) | No database and no clock of its own: NFC name canonicalization ([ADR 0041](docs/adr/0041-normalize-player-names-nfc-at-ingestion.md)), Offseason Sleep math ([ADR 0031](docs/adr/0031-offseason-sleep-world-series-to-opening-day.md)), Window resolution. |
| `src/export` | View | RFC-4180 CSV with an OWASP formula-injection guard; every CSV surface funnels through it ([ADR 0037](docs/adr/0037-presentation-export-formats-digest-and-tabular.md)). |
| `src/highlightly` | Model (adapter) | The only live NCAA adapter — a typed boundary around Highlightly/RapidAPI that never logs credentials. |
| `src/jobs` | Controller (shared use cases) | The orchestration layer every door calls: `tick.ts`, `digest.ts`, `refresh.ts`, `refresh-run.ts`, `delivery-claim.ts`, `refresh-progress.ts`. |
| `src/lists` | Model (service) | Named List / Lane semantics: create, rename, soft-delete, membership, default-lane, cadence. |
| `src/mailer` | View (delivery channel) | Postmark, SMTP, and console behind one `Mailer` interface, plus the optional `findAccepted` reconciliation lookup. |
| `src/mcp` | Controller | The MCP tool table — the primary interface — over the same services and the *same* `src/api/schemas.ts` shapes. |
| `src/mlb` | Model (adapter) | MLB Stats API client for MLB and every MiLB level, its Zod response contracts, the sportId↔Level map, and the gameType allowlist. |
| `src/ncaa` | Model (bundled data) | The stats.ncaa.org season table ([ADR 0032](docs/adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md)) that seeds the NCAA calendar row. A data table, **not** an adapter. |
| `src/presentation` | View | Report-neutral table and document primitives shared by the Digest and the Player Card, plus the `format` vocabulary. |
| `src/queries` | Model | Read-side Stat Line queries for the API and MCP surfaces, bounds-validated at the boundary. |
| `src/reports` | Model **+** View | `player-card.ts` assembles a Card; `player-card-render.ts` renders it ([ADR 0055](docs/adr/0055-player-card-presentation-per-surface-defaults-no-pdf.md)). |
| `src/server` | Cross-cutting | Bearer middleware, the injected `ServiceDeps` contract, and the one `/health` snapshot both the route and the MCP `status` tool read. |
| `src/stats` | Model | Stat-key classification (counter / rate / innings / excluded, unknown ⇒ excluded) and windowed aggregation. |
| `src/tags` | Model | The dependency-free selector grammar, the pure derivation engine, and the service that reconciles derived rows against it. |
| `src/watchlist` | Model (largest service) | Add / deactivate / list / search / stage / attach / promote, and the Player List Backup **restore**. |
| `src/server.ts` | Composition root | Loads config, starts the database, builds `AppDeps`, mounts `/health` (public), `/api` and `/mcp` (bearer), binds the listener, owns shutdown. |
| `src/config.ts` | Cross-cutting (config boundary) | The Zod env schema. Fail-closed: a provider that could not actually send is a config error at startup, never a runtime surprise. |
| `src/env.ts` | Cross-cutting (config boundary) | `.env` loading only, and a real environment variable always wins over the file. |

## The front doors

There are **four** ways work starts. Three are user-driven and one is time-driven.

| Door | Entry | Reference |
|---|---|---|
| CLI | `sk …` → `src/cli/router.ts` → a presenter | [`docs/cli/README.md`](docs/cli/README.md) |
| REST | `POST /api/…` behind bearer auth → `src/api/routes.ts` | [`docs/api/README.md`](docs/api/README.md) |
| MCP | a tool call at `/mcp` behind the same auth → `src/mcp/server.ts` | [`docs/mcp/README.md`](docs/mcp/README.md) |
| The Tick | `launchd` every 15 min (`ops/templates/com.sk.tick.plist`, `StartInterval 900`) → `sk tick` → `src/jobs/tick.ts` | [`docs/guides/running-bryce.md`](docs/guides/running-bryce.md) |

**The invariant: a door validates and translates; it never computes.** Every door parses its input
with a Zod schema, resolves names to ids, and calls the same job or service. Nothing about *what a
Digest contains* or *when a Sweep is owed* lives in a door.

The evidence is textual and testable. `src/mcp/server.ts` imports its input shapes from
`src/api/schemas.ts` — the REST module — so the two surfaces cannot drift in what they accept. All
four doors call the same `runDigest` / `runRefresh` / `assembleDigest` / service functions.
`test/interface-conformance.test.ts` asserts REST and MCP differ *only* in the Player Card's default
format and are otherwise byte-identical, and that both project the same rejection contracts without
mutating state.

**The honest counter-example.** Two lookups genuinely leak past the watchlist service, in the same
two shapes on both HTTP doors:

- **Resolving a Player for a tag operation.** `resolvePlayer` in `src/api/routes.ts` (serving
  `GET/POST/DELETE /api/players/:id/tags` and the `/api/players/ncaa/:highlightlyPlayerId/tags`
  trio) and `resolvePlayerRow` in `src/mcp/server.ts` (serving `player_tag_add`,
  `player_tag_remove`, `player_tags_list`) each query the `players` table directly instead of
  asking the service.
- **Resolving a Player for a targeted refresh.** The `POST /api/refresh` handler and the
  `run_refresh` tool each repeat that same direct query in their single-player branch.

Neither is a correctness bug today, and both are cited by symbol rather than line so the reference
survives an edit. They are named here because this is exactly the drift a reviewer is meant to
catch: one rule, four places, no shared home.

## Walkthrough: the daily Digest

The one path worth reading end to end. It runs identically whether the Tick, `sk digest`,
`POST /api/digest/send`, or the `send_digest` tool started it — a tag-free `1d` send is the
*scheduled artifact* for its Lane on every surface
([ADR 0062](docs/adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) decision 1,
superseding [ADR 0046](docs/adr/0046-named-player-lists-scoped-digests.md) decision 4). Any other
Window, and any Tag scope, routes to the on-demand path instead: no claim, no delivery row, nothing
written.

### The happy path

1. **The Tick wakes** (`src/jobs/tick.ts`). It freezes one instant for every decision that must
   agree — due-selection, host hour, slot date — reads the live Lanes, and asks what is owed.
2. **Refresh runs first, in one sweep.** Lanes whose `refresh_interval_minutes` has elapsed since a
   *covering* run started are swept together, so a Lane whose digest hour has arrived reports data
   this same Tick just fetched. The sweep gets the **live** clock, not the frozen one, because it
   renews a lease per Player.
3. **Digest due-selection.** For each Lane with a `digest_hour`: due when the host hour has reached
   it *and* today's slot holds no `sent` row. Due-selection is deliberately advisory — the claim
   below is the gate.
4. **The durable claim** (`src/jobs/delivery-claim.ts`,
   [ADR 0034](docs/adr/0034-digest-delivery-claim-at-least-once.md)). One `BEGIN IMMEDIATE`
   transaction reserves the `(kind, date_covered, list_id)` slot as `status = 'sending'`; the
   database's unique index — not app code — is what makes it exclusive. Lane liveness is re-checked
   *inside* that transaction, so a concurrent `lists delete` cannot slip into the gap.
5. **The freshness watermark is read before assembly** ([ADR
   0043](docs/adr/0043-persist-refresh-freshness-and-gate-digest.md)). It is judged against the
   *content* date and only accepts a run that covered *this* Lane. It annotates (`fresh` /
   `partial` / `stale`); it never suppresses.
6. **Assemble → render → send → settle.** `src/digest/assemble.ts` selects the Window and rolls it
   up, `src/digest/render.ts` produces the HTML and text parts, the mailer sends to the Lane's own
   recipients (falling back to the host `DIGEST_TO`), and `settleSent` records the delivery.

**The send never runs inside a transaction.** better-sqlite3 transactions are synchronous, so a
network call cannot live in one — which is why claim and settle are two separate writes with the
provider call between them, and why every sad path below exists.

### The sad paths

- **The claim is refused** → `action: "skipped"` with the reason, and nothing is mailed. The
  reasons are `claimed-by-another-run` (another surface holds a live lease), `already-sent-today`,
  `heartbeat-sent-within-week`, and `lane-deleted`. The lease branch answers **first** and `force`
  can never override it; `lane-deleted` is likewise un-forceable, because "this cohort still
  exists" is a fact about the world rather than de-duplication bookkeeping.
- **The send throws** → `settleFailed` writes `status = 'failed', sent_at = NULL` and the run
  returns `action: "failed"`. The slot is now re-claimable, so a later Tick the same day retries it
  (a `failed` slot reads as due again); once the date rolls over, `findOrphanedDigestDate` catches
  it — **one** orphaned prior day per invocation, so a backlog drains a day at a time instead of
  arriving as a burst. Orphan recovery deliberately runs *before* the Offseason Sleep check, so a
  send that failed on the season's last day is still recovered.
- **The process dies between provider acceptance and settlement** → the row stays `sending`. Its
  lease bounds the damage: after `LEASE_MS` (10 minutes) the next run may take the slot over. That
  recovered claim does **not** re-send blind — it first asks the provider whether the crashed
  attempt already landed, via `mailer.findAccepted(deliveryKey, previousClaimedAt)`, keyed on the
  slot-stable `bryce:<kind>:<date>:list-<id>`. Only a positive `accepted` suppresses the send, and
  it settles `reconciled` instead. Every other answer — `not-found`, `unavailable`, a provider with
  no lookup at all, or one that throws despite the contract — resends. The asymmetry is deliberate:
  a duplicate email is the accepted failure, a silently missing Digest is not.
- **A Lane is soft-deleted while one of its deliveries is in flight** → that `sending` row would
  otherwise be unsettleable forever, since no future claim may re-take it and the Lane is never
  offered again. The Tick's `reapDeadLaneClaims` settles such rows `failed` with an explanatory
  message — only ones whose lease has already **expired**, so a live run is never settled out from
  under itself.
- **A stage or a Lane throws** → failure is isolated per stage and per Lane. A sweep that throws
  still lets every Digest run (annotated `stale` by its own banner); one Lane's throw does not
  suppress the Lanes after it; a fault after Lane A sent does not erase the record that it did. The
  Tick reports `ok: false` if any attempted action failed, and the CLI turns that into exit 1.

## Data flow and ownership

**Entry points.** `src/mlb` (MLB Stats API — MLB plus every MiLB level), `src/highlightly`
(Highlightly/RapidAPI — NCAA), and `src/ncaa` (the bundled season table that seeds the NCAA
`season_calendar` row).

**Normalization happens in three layers, in this order.**

1. **Shape** — a Zod contract parses every provider response, and unknown stat keys classify as
   `null` and are *excluded* rather than summed. Fail-closed has two halves here: excluding the key
   is the safe one, and warning that it was excluded is the other.
2. **Identity** — names are canonicalized to NFC at the boundary
   ([ADR 0041](docs/adr/0041-normalize-player-names-nfc-at-ingestion.md)); sportId maps to Level and
   MiLB Level, which are mutable *locations*, never identity; in-progress games are excluded from
   ingestion ([ADR 0040](docs/adr/0040-exclude-in-progress-games-from-ingestion.md)).
3. **Persistence** — every ingestion write funnels through `src/jobs/refresh.ts` and passes the
   ingestion fence ([ADR 0048](docs/adr/0048-fence-all-ingestion-writes.md)), so a superseded Sweep
   cannot write over the winner's rows. Stat Line identity is a database-level unique index on
   `[player_id, game_id, stat_type]` — per game, never per date
   ([ADR 0029](docs/adr/0029-stat-lines-per-game-keyed-by-game-id.md)).

**Ownership — all 11 tables.**

| Table | Writer(s) |
|---|---|
| `stat_lines` | `src/jobs/refresh.ts` only |
| `digest_deliveries` | `src/jobs/delivery-claim.ts` only |
| `refresh_runs` | `src/jobs/refresh-run.ts` only |
| `season_calendar` | `src/jobs/refresh.ts` only |
| `highlightly_match_cache` | `src/jobs/refresh.ts` only |
| `highlightly_box_score_cache` | `src/jobs/refresh.ts` only |
| `players` | `src/watchlist/service.ts` **+** `src/jobs/refresh.ts` (identity refresh) |
| `player_lists` | `src/lists/service.ts` **+** `src/watchlist/service.ts` (Player List Backup restore) |
| `list_members` | `src/lists/service.ts` **+** `src/watchlist/service.ts` (restore) |
| `player_tags` | `src/tags/service.ts` **+** `src/watchlist/service.ts` (restore) |
| `highlightly_player_cursors` | `src/jobs/refresh.ts` **+** `src/watchlist/service.ts` (promotion cleanup) |

**The rule this table states: single writer is the default.** A second writer is legitimate only as
a named, narrowly-scoped path — restore, promotion cleanup, identity refresh — and only if it is
listed above. **An unlisted second writer is an ownership violation**, and finding one is precisely
what a reviewer of this codebase is checking for.

## Review questions for the HC

Ten questions this map is meant to make answerable. They are ordered from the ones a defect most
often hides behind.

1. **Is every new boundary value parsed by Zod, and does it fail closed?** Config, HTTP body,
   query, MCP tool input, provider response, backup payload. Not "is it validated" — is the
   *unvalidated* path impossible?
2. **Is there business logic in a front door?** The worked example is the direct `players` query
   duplicated across `resolvePlayer` / `resolvePlayerRow` and the two targeted-refresh handlers: one
   rule, four places, no shared home.
3. **Does the change reach all four doors — or deliberately skip some?** A capability that lands on
   MCP and not the CLI is a decision; landing there by accident is drift.
4. **If the schema moved, is the migration reconcilable with the ORM declaration?** A migration and
   a Drizzle table are two statements of one fact, and they only diverge silently.
5. **Does a new table appear in the ownership table above, with exactly one owner?** If it has two,
   is the second a named, narrow path — or a convenience?
6. **Is a new MCP tool's schema and description complete enough for an agent that has never seen
   the code?** The description is the whole interface: an agent picks and interprets the tool from
   that string alone.
7. **Are the sad paths planned, not just the happy one?** For anything touching delivery or
   ingestion: refusal, throw-and-retry, crash-mid-flight, and lease expiry each need a test, and
   the fixture has to be able to make the assertion fail.
8. **Does any job print?** A job returns a typed result and never presents it; the CLI is the only
   presenter of results ([ADR 0056](docs/adr/0056-refresh-emits-typed-progress-events-cli-is-the-only-presenter.md)).
   The sanctioned exception: a job's *diagnostic* sink — `warn` in the digest run, the legacy
   notice channel in refresh — defaults to `stderr` when the caller injects none. New job output
   belongs behind an injected sink a test can capture, never a direct `console`/`process` write.
9. **Does anything bypass a durable claim or the ingestion fence?** A read that decides eligibility
   must sit inside the transaction that reserves the slot, or a concurrent writer lands in the gap.
10. **Did new vocabulary land in the glossary?** A term used in code and absent from
    [`docs/domain/CONTEXT.md`](docs/domain/CONTEXT.md) is a concept nobody has agreed on yet.

## How this fits the other documents

- [`docs/domain/CONTEXT.md`](docs/domain/CONTEXT.md) — the domain glossary and relationships. This
  map uses its terms and does not redefine them.
- [`docs/cli/README.md`](docs/cli/README.md) · [`docs/api/README.md`](docs/api/README.md) ·
  [`docs/mcp/README.md`](docs/mcp/README.md) — the canonical per-surface references. Commands,
  routes, and tools are listed *there*, never here.
- [`docs/guides/running-bryce.md`](docs/guides/running-bryce.md) — production operations: launchd,
  the tunnel, backup and restore runbooks, stuck deliveries.
- [`docs/product/daily-baseball-digest-handoff.md`](docs/product/daily-baseball-digest-handoff.md) —
  the product spec. Read its **2026-07-19 architecture revision** section, which is current; its
  older `## Architecture` section describes a superseded design (a Rails/web-UI shape) and is kept
  only as the product-requirements record.
- [`docs/adr/`](docs/adr/) — the decisions. The load-bearing ones for this map:
  [ADR 0025](docs/adr/0025-typescript-node-stack.md) (TypeScript on Node),
  [ADR 0026](docs/adr/0026-sqlite-over-postgres.md) (SQLite),
  [ADR 0027](docs/adr/0027-mcp-first-interface-no-web-ui.md) (MCP-first, no web UI),
  [ADR 0028](docs/adr/0028-local-macbook-hosting-cloudflare-tunnel.md) (hosting),
  [ADR 0034](docs/adr/0034-digest-delivery-claim-at-least-once.md) (the delivery claim),
  [ADR 0043](docs/adr/0043-persist-refresh-freshness-and-gate-digest.md) (freshness),
  [ADR 0048](docs/adr/0048-fence-all-ingestion-writes.md) (the ingestion fence),
  [ADR 0059](docs/adr/0059-explicit-default-lane-supersedes-implicit-default.md) (the Default Lane),
  [ADR 0061](docs/adr/0061-lane-scoped-refresh-supersedes-whole-sweep.md) (Lane-scoped Refresh), and
  [ADR 0062](docs/adr/0062-lane-digests-claimed-tick-scheduler-per-lane-coverage.md) (the Tick).
