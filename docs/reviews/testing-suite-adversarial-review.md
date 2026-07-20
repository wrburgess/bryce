# Bryce Testing Suite: Adversarial Review

Reviewed 2026-07-20 for issue #18 against repository SHA
`b2cb354c68c055a13969fec38ad249bb71fd4332`. This is an analysis artifact: it changes no
production behavior, test behavior, dependency declaration, or CI policy.

## Executive assessment

Bryce has a fast, deterministic, behavior-oriented suite with unusually good coverage of its core
domain for an application of this size. The measured baseline is 268 passing tests in 19 files; ten
additional full-suite runs all passed. V8 measured 89.72% statements/lines, 87.48% branches, and
94.00% functions when every `src/**/*.ts` file was included. Those percentages are navigation
evidence, not the conclusion.

The conclusion is more qualified: the suite gives strong confidence in pure baseball rules,
single-process service behavior, storage keys, rendering, authorization, and REST/MCP happy and
known-error paths. It does not yet justify the product's strongest operational claims. A digest can
be sent twice if invocations overlap or the process dies after the provider accepts the message but
before SQLite records it. One player's refresh failure aborts all later players. NCAA tests prove
the implementation agrees with constructed fixtures, but not that those fixtures and opaque
category identifiers still agree with the live unofficial source. These are three High findings.

Four substantial Medium findings cover unenforced network isolation, untested production
entrypoints/recovery wiring, incomplete rejection-parity checks across interfaces, and the absence
of a durable risk-oriented coverage diagnostic. None warrants slowing the current suite or chasing
a repository-wide vanity target. The recommended strategy is to protect the risky seams first,
then institutionalize focused diagnostics.

## Method and evidence labels

The review traced `docs/domain/CONTEXT.md`, ADRs 0029-0033, all 39 production TypeScript modules,
all 19 test files, test fixtures/factories, `vitest.config.ts`, `package.json`, the app workflow, and
the operational guide. Quantitative runs used the commands in [Reproduction](#reproduction).

Matrix and finding labels mean:

- **Direct**: a test calls the behavior or boundary and makes meaningful content/state assertions.
- **Indirect**: the module executes behind a higher-level test, or compile-time/type-only behavior
  has no meaningful runtime branch to exercise.
- **Missing/weak**: no test reaches the production path, or the evidence is circular/incomplete for
  the risk claimed.
- **Demonstrated**: visible directly in code, tests, or a diagnostic result.
- **Inferred risk**: a plausible production failure derived from that demonstrated evidence; it
  was not triggered against production services during this review.

## Requirement and invariant traceability

| Requirement or invariant | Existing protection | Confidence and explicit gap |
|---|---|---|
| One Player row survives promotion/demotion; Level is mutable | `test/refresh.test.ts:220-258`; `test/watchlist.test.ts:74-149` | **Direct, strong.** The call-up test asserts one row and retained cross-level history. |
| Watch List is the active subset; deactivation retains history | `test/watchlist.test.ts:265-408`; `test/api.test.ts:275-333,560-573`; `test/mcp.test.ts:216-274`; `test/seed.test.ts:119-137` | **Direct, strong.** Service and three interfaces assert row/history retention and digest exclusion. |
| Stat Lines are per game and role; doubleheaders do not collide (ADR 0029) | `test/schema.test.ts:8-64`; `test/queries.test.ts:64-84`; `test/digest.test.ts:240-279`; `test/ncaa.test.ts:48-53,112-123` | **Direct, strong.** The database uniqueness key and presentation behavior are both asserted. |
| Full current-season sweep has no date window (ADR 0030) | `test/refresh.test.ts:70-114`; `src/jobs/refresh.ts:332-370` | **Direct for one successful player.** All six MLB/MiLB sport IDs and three groups are asserted; multi-player failure continuation is missing (H2). |
| Re-fetch is idempotent; corrections update quietly | `test/schema.test.ts:95-139`; `test/refresh.test.ts:163-218`; `test/ncaa-refresh.test.ts:137-174` | **Direct, strong** for sequential runs. Concurrent refresh and per-player rollback are not exercised. |
| Digest reports novelty, catches late lines, and does not re-announce corrections (ADR 0030) | `test/digest.test.ts:46-137,333-361`; `test/refresh.test.ts:187-218` | **Direct for sequential success/provider rejection.** External send and durable marking are not one atomic action (H1). |
| Digest sends daily even when empty; In Season players get a `No new stats` tail and out-of-season players are omitted | `test/digest.test.ts:105-119,222-238`; `test/digest-preview.test.ts:126-207`; `test/season.test.ts:72-95` | **Direct, strong.** Both preview and sending paths cover the inclusion rule. |
| Offseason Sleep pauses refresh, sends weekly heartbeat, wakes at earliest watched opening day, and excludes spring training (ADR 0031) | `test/season.test.ts:96-176`; `test/refresh.test.ts:260-287`; `test/ncaa-refresh.test.ts:193-276`; `test/digest.test.ts:377-462` | **Direct, strong.** Boundaries, NCAA wake, zero network calls, and heartbeat cadence are asserted with an injected clock. |
| NCAA identity uses unique `ncaa_player_seq`; external identity stays separate (ADR 0032) | `test/schema.test.ts:66-93`; `test/watchlist.test.ts:154-264`; `test/api.test.ts:203-304`; `test/mcp.test.ts:168-246` | **Direct, strong** for uniqueness and surface behavior. The database does not enforce the complete level/identity pairing, but internal typed services maintain it. |
| NCAA contest ID is preferred; deterministic hash preserves no-ID doubleheaders | `test/ncaa.test.ts:78-88,287-307`; `src/ncaa/normalize.ts:136-196` | **Direct for examples.** A small property/fuzz suite could strengthen collision/boundary evidence, but this is optional polish. |
| NCAA malformed tables fail loudly and annual lookup gaps make no requests | `test/ncaa.test.ts:61-76,372-384`; `test/ncaa-refresh.test.ts:231-276` | **Direct for constructed shapes. Weak as an independent contract** with the live site (H3). |
| Fixed batting/pitching stat set, baseball IP math, single-game rates, and fielding merge (ADR 0033) | `test/rates.test.ts:11-102`; `test/render.test.ts:4-105`; `test/digest.test.ts:262-331`; `test/ncaa-refresh.test.ts:278-311` | **Direct, strong** including invalid IP, exact rate boundaries, zeros, fielding-only games, and end-to-end NCAA rendering against constructed input. |
| MCP is primary, REST is thin, both share behavior and validation (ADR 0027) | `test/mcp.test.ts:46-394`; `test/api.test.ts:34-573`; shared schemas in `src/api/schemas.ts` | **Broad direct coverage.** Rejection cases are duplicated selectively rather than enforced by a shared conformance matrix (M3). |
| `/api` and `/mcp` fail closed; `/health` is public | `test/api.test.ts:86-109`; `test/mcp.test.ts:130-142`; `test/env.test.ts:40-67` | **Direct, strong.** Missing/blank/wrong/malformed token behavior and public health are asserted. |
| Read-only SQL is defense in depth, row/size capped, and file connection is truly read-only | `test/readonly.test.ts:11-128`; `test/mcp.test.ts:366-385` | **Direct, strong.** Keyword, compiled statement, connection mode, multi-statement, parameter, row, and size guards are exercised. |
| SQLite opens in WAL mode, migrates on startup, and is recoverable via Litestream | `test/factories.ts:36-66`; `test/readonly.test.ts:124-128`; `src/db/client.ts:20-34`; `docs/guides/running-bryce.md:96-113` | **Direct only for fresh migration/open and a second file connection. Missing/weak** for WAL assertion, incremental upgrade, backup, and restore (M2). |
| Scheduled CLIs and server use real configuration/dependencies and observable exits | `test/seed.test.ts:25-269`; in-process server tests | **Partial.** Seed command logic is direct; digest/refresh/migrate/probe mains and server listener wiring are unexecuted (M2). |

## Production and boundary coverage matrix

Coverage is reported as V8 **line / branch** percentage. A percentage beside a weak boundary does
not upgrade its confidence label.

| Production area and every module | Test evidence | Quantitative evidence | Adversarial assessment |
|---|---|---:|---|
| REST routes and shared inputs — `src/api/routes.ts`, `src/api/schemas.ts` | `test/api.test.ts`; service tests; some MCP reuse | 99.13 / 93.10; 87.23 / 88.88 | **Direct.** Rich content/state and known-error assertions. The both-identities refinement at `schemas.ts:53-60` was uncovered (M3). |
| Configuration and dotenv — `src/config.ts`, `src/env.ts` | `test/mailer.test.ts:141-180`; `test/env.test.ts` | 100 / 100; 100 / 100 | **Direct.** Defaults, fail-closed provider fields, whitespace, precedence, missing file, and token normalization are asserted. |
| SQLite open/migrate/WAL — `src/db/client.ts` | Every database test migrates a fresh database; `test/factories.ts:36-66` uses memory and file DBs | 100 / 100 | **Direct for fresh open; weak operationally.** No journal-mode assertion, migration-from-prior-version case, or restore rehearsal (M2). |
| SQLite schema — `src/db/schema.ts` | `test/schema.test.ts`; all integration tests | 100 / 100 | **Direct.** Per-game and NCAA uniqueness are database-level tests; not every semantic identity combination is constrained. |
| Read-only database — `src/db/readonly.ts` | `test/readonly.test.ts`; `test/mcp.test.ts:366-385` | 95.45 / 85.71 | **Direct, strong boundary test** including a real read-only file connection. Uncovered normalization branches are low-risk types. |
| Digest assembly — `src/digest/assemble.ts` | `test/digest-preview.test.ts`; `test/digest.test.ts` | 97.77 / 88.88 | **Direct.** Read-only preview state, fielding merge, active/in-season filtering, and exact send parity are asserted. |
| Rate math — `src/digest/rates.ts` | `test/rates.test.ts`; render/digest integration | 100 / 100 | **Direct, strong unit boundary coverage.** Property-based notation generation is optional, not a current confidence blocker. |
| Rendering — `src/digest/render.ts` | `test/render.test.ts`; digest/preview/API/MCP tests | 99.41 / 92.59 | **Direct.** Exact text/HTML, ordering, doubleheaders, fixed stat formats, and heartbeat output are protected. |
| Season domain — `src/domain/season.ts` | `test/season.test.ts`; refresh/digest integrations | 97.40 / 92.85 | **Direct.** Date-zone and opening/closing boundaries use injected time; no wall-clock waits. |
| Digest job — `src/jobs/digest.ts` | `test/digest.test.ts`; API/MCP send tests | 98.97 / 92.59 | **Direct for sequential behavior; weak at external transaction seam.** Coverage does not expose overlapping sends or post-send crashes (H1). |
| Refresh job — `src/jobs/refresh.ts` | `test/refresh.test.ts`; `test/ncaa-refresh.test.ts`; watch-list/API/MCP/seed integrations | 95.54 / 78.02 | **Direct for success, idempotency, season, and correction cases. Missing** multi-player provider/parse failure continuation and fault reporting (H2). |
| Mailer selection/protocols — `src/mailer/index.ts`, `src/mailer/console.ts`, `src/mailer/postmark.ts`, `src/mailer/smtp.ts`, `src/mailer/types.ts` | `test/mailer.test.ts`; digest tests use `CapturingMailer` | 93.10 / 83.33; 100 / 100; 100 / 100; 73.91 / 100; type-only | **Direct contract doubles.** Exact Postmark request and SMTP message shape/error propagation are asserted; default Nodemailer construction and live provider acceptance are not. Live delivery need not run in every PR, but a controlled smoke belongs in operations (M2). |
| MCP server — `src/mcp/server.ts` | `test/mcp.test.ts` over Streamable HTTP | 98.68 / 91.22 | **Direct.** Tool inventory, structured results/errors, state changes, SQL, preview, status, and auth are covered. Rejection parity is not systematic (M3). |
| MLB/MiLB client contract — `src/mlb/client.ts`, `src/mlb/schemas.ts`, `src/mlb/levels.ts`, `src/mlb/gameTypes.ts` | `test/mlb-client.test.ts` with captured MLB payloads; `test/refresh.test.ts` | 92.85 / 80.64; 100 / 100; 100 / 100; 100 / 100 | **Direct and independently grounded.** Captured payloads, malformed responses, required `sportId`, all level mappings, delays, and game-type allowlist are covered. There is no scheduled fixture refresh, a Medium-term contract-maintenance concern rather than a current High gap. |
| NCAA scrape boundary — `src/ncaa/client.ts`, `src/ncaa/parse.ts`, `src/ncaa/normalize.ts`, `src/ncaa/seasons.ts` | `test/ncaa.test.ts`; `test/ncaa-refresh.test.ts` | 94.44 / 86.95; 95.08 / 80.35; 100 / 100; 100 / 100 | **Direct but circular contract evidence.** Selectors, headers, opaque IDs, and normalized stats are only checked against constructed inputs; fielding IDs are explicitly unverified (H3). |
| Stat queries — `src/queries/statLines.ts` | `test/queries.test.ts`; API/MCP tests | 100 / 100 | **Direct.** Joins, level/date/player bounds, doubleheaders, caps, coercion, malformed dates, and empty results are asserted. |
| HTTP application/auth/health/dependency shape — `src/server.ts`, `src/server/auth.ts`, `src/server/health.ts`, `src/server/deps.ts` | `test/server.test.ts`; API/MCP tests call `createApp` | 66.66 / 77.77; 100 / 100; 100 / 60; type-only | **Direct in process. Missing production bootstrap** at `server.ts:61-83`: real config, DB/read-only handles, clients, listener, and shutdown are not smoked (M2). |
| Watch-list service — `src/watchlist/service.ts` | `test/watchlist.test.ts`; API/MCP/seed integrations | 95.23 / 88.33 | **Direct.** Add/reactivate/deactivate/search/cache/location/error seams and first refresh are asserted across MLB and NCAA. |
| CLI dispatch helper and seed — `src/cli/main.ts`, `src/cli/seed.ts` | `test/seed.test.ts` calls command logic with captured output and asserts ASCII | 100 / 50; 74.54 / 73.43 | **Direct for seed logic; partial for process behavior.** Executable bootstrap and real env/DB lifecycle remain outside the test. |
| Digest, refresh, migrate, and NCAA probe entrypoints — `src/cli/digest.ts`, `src/cli/refresh.ts`, `src/cli/migrate.ts`, `src/cli/ncaa-probe.ts` | Underlying jobs/client/parser are tested; no entrypoint test | 0 / 0 for each | **Missing as production wiring** (M2). These are the actual scheduled/maintenance commands. |
| Network isolation boundary — default global `fetch` in MLB, NCAA, and Postmark; Nodemailer socket transport | Tests inject fakes/transports; `vitest.config.ts:6-7` is a comment only | Not meaningfully represented by line coverage | **Weak.** The current suite appears offline by convention, but a regression is not mechanically blocked (M1). |
| Host operations — launchd, Cloudflare Tunnel/Access, Litestream/R2 | Prose only in `docs/guides/running-bryce.md` | Outside V8 | **Missing operational smoke/recovery evidence** (M2). Cloudflare itself should not run in unit tests; checked config validation and periodic host smoke are proportionate. |

All 39 `src/**/*.ts` modules appear in the matrix above. All material external boundaries—MLB,
NCAA HTML, Postmark, SMTP, SQLite/WAL/migrations, read-only SQLite, REST, MCP, bearer auth, CLI and
scheduled jobs, server listener, filesystem environment, Litestream/R2, and Cloudflare—are either
mapped to evidence or explicitly marked missing/weak.

## Coverage findings by severity

There are no Critical findings under `PROJECT.md`: this review did not demonstrate data loss, a
security hole, a protected-branch/auth invariant break, or an application that cannot operate.

### H1 — High: digest “never double-sends” is not protected across concurrency or a post-send crash

**Demonstrated evidence.** `src/jobs/digest.ts:45-63` performs a read-before-send check,
`src/jobs/digest.ts:74-75` sends externally, and only afterward does
`src/jobs/digest.ts:96-132` record the sent delivery and mark lines. The unique database key at
`src/db/schema.ts:32-47` can collapse two delivery records, but cannot retract an already accepted
email. `test/digest.test.ts:95-103` covers sequential re-entry, while
`test/digest.test.ts:333-360` covers provider rejection before acceptance. Neither overlaps two
calls nor injects failure after provider acceptance. `src/mcp/server.ts:200-218` nevertheless
describes the tool as “Never double-sends for a covered date.”

**Inferred failure mode and impact.** A launchd run overlapping a manual REST/MCP send can let both
calls pass the initial query and send two emails. A process/SQLite failure after Postmark or SMTP
accepts the message but before the transaction commits leaves the lines unmarked, so retry sends
them again. This violates a named product invariant and produces duplicate user-visible reports.

**Concrete improvement.** Define the actual delivery guarantee, then implement a durable delivery
state machine/reservation plus a provider idempotency strategy where supported (or explicitly adopt
at-least-once delivery with duplicate observability). Serialize same-date claims in SQLite and make
stale in-flight recovery deliberate. Do not claim atomic exactly-once behavior across SQLite and an
external provider without a protocol that supplies it.

**Regression expectation.** A gated mailer test must start two same-date calls concurrently and
prove only one reaches `send`. Fault-injection tests must exercise failure immediately before send,
provider rejection, provider acceptance followed by persistence failure, and stale-reservation
recovery, asserting mail count, delivery state, and stat-line marking each time.

### H2 — High: one refresh fault prevents every later watched player from refreshing

**Demonstrated evidence.** `src/jobs/refresh.ts:81-90` awaits each player in a loop without a
per-player error boundary. An exception from identity lookup or any one of the 18 MLB/MiLB log calls
at `src/jobs/refresh.ts:313-357`, or from any NCAA category at `src/jobs/refresh.ts:263-270`, exits
the whole job. MLB identity is updated at `src/jobs/refresh.ts:313-330` before all log calls have
succeeded, while stat rows are not upserted until `src/jobs/refresh.ts:370`; the failure has no
durable per-player status. `test/refresh.test.ts:70-341` covers successful single/mixed refresh,
idempotency, correction, filtering, and sleep, but has no three-player case with a middle failure.
API/MCP upstream-error tests exercise a requested NCAA player, not continuation of the scheduled
whole-watch-list job.

**Inferred failure mode and impact.** One transient API error, malformed payload, or NCAA markup
shift leaves every later player stale for that run. Earlier players may already be updated, the
failing MLB player's identity may change without its stats, and the summary that would identify
partial completion is never returned. Ordering therefore determines who gets fresh data.

**Concrete improvement.** Make the whole-watch-list orchestrator isolate failures per player,
continue later players, and return/persist a structured success/failure summary that makes the job
exit non-zero or otherwise alert on partial failure. Define per-player atomicity for identity plus
stat updates; avoid silently presenting a partial mutation as a completed player refresh.

**Regression expectation.** With three players, force the middle player's identity call, an
intermediate game-log call, and an NCAA category parse to fail in separate cases. Assert the first
and third players refresh, the failed player obeys the chosen atomicity rule, exact failure metadata
is surfaced, a later retry heals it, and duplicate rows/report markers are unchanged.

### H3 — High: NCAA tests are not independent evidence of the live scrape contract

**Demonstrated evidence.** ADR 0032 lines 27-30 says live HTML could not be captured and fixtures
were constructed from reference implementations. `test/ncaa.test.ts:18-88` labels and exercises
those constructed fixtures; `test/factories.ts:31-33,481-579` also generates NCAA HTML in the shape
the parser expects. `src/ncaa/parse.ts:11-18` records the same provenance. The parser validates only
generic Date/Opponent/Result structure at `src/ncaa/parse.ts:57-75`; normalization trusts the caller's
requested category and maps known headers at `src/ncaa/normalize.ts:26-107`. `src/ncaa/seasons.ts:33-40,53-80`
marks every bundled fielding category ID unverified. A wrong opaque ID can therefore return a
structurally valid page whose stat headers do not match the requested category; unmapped headers
pass through and the renderer defaults missing canonical values to believable zeros. The regression
test at `test/ncaa-refresh.test.ts:278-311` proves correct numbers only for generated pages.

**Inferred failure mode and impact.** A selector/header change, category-ID error, or Akamai
response change can make NCAA digests omit games, attach the wrong category, or render plausible
zero values while the full suite remains green. This is not theoretical assurance: the current
tests are intentionally derived from the same assumed contract they validate.

**Concrete improvement.** Establish an independent contract artifact: capture and sanitize real
batting, pitching, and fielding pages on the host; preserve their provenance/date; validate category-
specific required headers and non-empty semantic samples; and run a polite scheduled/on-demand live
probe outside the per-PR suite. Make the annual `NCAA_SEASONS` update require successful probes for
all three categories before the IDs are accepted.

**Regression expectation.** Tests must parse real captured pages without builder involvement,
reject a valid-looking wrong-category page, reject missing required stat headers, and flow at least
one known non-zero value from each category through normalization and digest rendering. A host smoke
must verify the current opaque IDs and record an actionable failure without hammering the source.

### M1 — Medium: “tests never hit the network” is a comment, not an enforced invariant

**Demonstrated evidence.** `vitest.config.ts:6-7` states the rule but declares no setup file or
network interceptor. Default constructors use global `fetch` in `src/mlb/client.ts:52-56`,
`src/ncaa/client.ts:114-125`, and `src/mailer/postmark.ts:19-21`; SMTP creates a real Nodemailer
transport at `src/mailer/smtp.ts:14-20`. Current tests consistently inject fakes, which is good
practice, but nothing makes a missed injection fail before attempting egress.

**Inferred failure mode and impact.** A future test can become slow, flaky, rate-limit NCAA, or send
data to a real service while passing locally. The bounded sample cannot detect a path no test took.

**Concrete improvement and regression expectation.** Add a global test setup that rejects all
unapproved socket/fetch egress, with an explicit scoped opt-in only for separately labelled contract
smokes. Add a canary test proving default MLB, NCAA, Postmark, and SMTP network paths fail locally
before egress. Keep injected fake tests as the normal fast path.

### M2 — Medium: production entrypoints and recovery wiring have no executable smoke

**Demonstrated evidence.** Coverage was 0% for `src/cli/digest.ts`, `refresh.ts`, `migrate.ts`, and
`ncaa-probe.ts`, and 66.66% lines for `src/server.ts` because bootstrap lines 61-83 never ran.
`test/seed.test.ts` calls seed command logic but not a child process with real configuration.
`src/db/client.ts` is exercised on fresh memory/file databases, but no test asserts WAL mode,
applies migrations from the prior checked-in schema, corrupts/restores a copy, or checks a
Litestream restore. Launchd, Litestream, and Cloudflare configuration exists only as example prose
in `docs/guides/running-bryce.md:50-149`, not checked configuration that a test can validate.

**Inferred failure mode and impact.** Unit/service tests can remain green while a CLI import,
environment name, close/exit path, listener dependency, migration upgrade, backup instruction, or
host configuration is broken. The failure would surface during a scheduled run, reboot, or restore,
where diagnosis is slower and data freshness/durability matters.

**Concrete improvement and regression expectation.** Add bounded subprocess smokes using a temp
file DB and console/fake-safe configuration for migrate, refresh-sleep, digest-empty, seed, and
server start/health/termination. Add a migration-upgrade fixture and assert `journal_mode=wal` on a
file DB. Check in sanitized launchd/Litestream/Cloudflare templates and validate their references.
Run a documented periodic restore drill against disposable data; do not put live Cloudflare/R2 or
email credentials in the PR suite.

### M3 — Medium: REST/MCP behavior sharing is strong, but rejection parity is selective

**Demonstrated evidence.** Both surfaces use `src/api/schemas.ts` and shared services, and their
large tests cover most successful operations and several known errors. However, the coverage run
left `src/api/schemas.ts:55-60`—the `run_refresh` case supplying both identities—uncovered. API tests
at `test/api.test.ts:461-559` and MCP tests at `test/mcp.test.ts:347-365` do not assert that case.
Other invalid combinations are asserted on one surface more often than both, so adding a shared
error type or refinement still depends on reviewers remembering parallel cases.

**Inferred failure mode and impact.** A schema/service/error-seam change can produce different HTTP
and MCP classifications or accept an ambiguous identity on one interface, while each surface's
independent happy-path tests pass.

**Concrete improvement and regression expectation.** Create a small table-driven conformance
matrix for shared operations. Feed the same valid and invalid semantic cases through REST and MCP,
then assert equivalent domain outcome and each surface's intended error envelope. Include missing,
both-identities, malformed/zero IDs, blank search, query bounds, provider failures, unsupported NCAA
season, and unknown player cases. Keep surface-specific transport assertions in their existing files.

### M4 — Medium: coverage diagnostics are ad hoc, so risk-bearing blind spots are easy to reintroduce

**Demonstrated evidence.** `package.json` has no coverage provider/script and
`.github/workflows/app.yml:19-24` runs typecheck, lint, and plain tests only. This review needed a
temporary matched provider to discover four 0%-covered scheduled entrypoints and the untested shared
schema branch. The overall 89.72% line figure would still look healthy if those operational files
remained untouched.

**Inferred failure mode and impact.** Maintainers receive no changed-file or subsystem signal when
new risky branches land untested. A future percentage gate added without this context could reward
easy unit lines while leaving delivery, refresh, contract, and recovery seams exposed.

**Concrete improvement and regression expectation.** Add the Vitest-version-matched V8 provider as
a declared dev dependency, a reproducible local script, and a CI text/machine-readable artifact.
After H1-H3/M1-M3 tests land, set reviewable per-file or risk-area expectations for the jobs,
boundaries, and executable wiring rather than immediately imposing a high global number. Add a
configuration test or documented check that the coverage include glob contains every
`src/**/*.ts` file, including unimported modules.

### Low/optional polish

- The normal suite prints two expected “no bundled NCAA season” warnings on every run because the
  tests do not capture/assert stderr. Capturing them would make genuine warnings easier to spot.
- Targeted property tests for baseball IP strings, date boundaries, and NCAA fallback game IDs, and
  a narrowly scoped mutation pilot for digest/refresh predicates, could measure assertion strength.
  Whole-repository fuzzing or mutation testing is not proportionate while H1-H3 remain open.
- MLB fixtures are real captures and therefore stronger than NCAA fixtures, but their provenance
  and refresh cadence are not machine-readable. A periodic, reviewed capture refresh would be useful
  maintenance, not a per-PR live dependency.

## Testing approach assessment

### Test-layer balance

The suite has a healthy center of gravity:

- **Unit/domain tests** cover season math, rates, rendering, schemas, NCAA parsing/normalization,
  level mapping, and allowlists with exact boundary assertions.
- **Service/database integration tests** dominate refresh, digest, watch-list, query, schema, and
  read-only behavior. They run real Drizzle migrations and real SQLite, not a mocked repository.
- **In-process interface tests** drive Hono REST and MCP Streamable HTTP through the same injected
  service bundle. They assert response content and database/mail side effects, not only status.
- **Contract tests** are good for MLB captured JSON, Postmark request shape, and SMTP handoff. NCAA
  contract evidence is constructed and is the major asymmetry.
- **End-to-end/operational smoke** is the missing layer: no actual scheduled command, listener,
  provider acceptance, backup/restore, or host configuration path runs.

The right correction is a thin smoke/contract cap and fault-injection at risky seams, not more
low-value unit examples.

### Isolation and determinism

`test/factories.ts` supplies programmatic database builders, a fresh migrated database per test,
unique temp-file databases when a second connection is needed, injected clocks, injected fetches,
capturing mail, and injected fake delays. Tests use fake timers for polite-delay behavior and contain
no wall-clock sleeps. The ten repeat runs and serial comparison found no cleanup-dependent failure.
File parallelism is therefore providing real speed without observed isolation loss.

The remaining isolation weakness is preventive: egress is conventional rather than blocked (M1).
Expected stderr also leaks between tests and runner output. Global mutable test state is limited to a
factory uniqueness counter within each worker; database state itself is not shared.

### Fixtures and factories

Database cases use builders rather than schema-coupled row dumps, matching `rules/testing.md`.
MLB client tests use captured upstream payloads and builders model those real shapes. NCAA fixtures
and builders are explicitly constructed; they are useful implementation examples but cannot serve
as independent evidence of a volatile HTML contract (H3). The suite retains raw upstream data in
storage cases, which helps future regression construction.

### Assertion and failure quality

Assertions are generally high quality: digest tests check exact text and HTML plus delivery/line
state; API/MCP tests check content and side effects; schema tests prove database rejection; read-only
tests attempt bypasses; and invalid/missing values appear throughout. Failures are likely to identify
the behavior that changed because test names are specific and fixtures are local.

Failure injection exists for provider rejection, malformed payload/table, unknown identities,
unsupported seasons, SQL abuse, and auth. It stops short of the failure windows that matter most:
concurrency, crash after external acceptance, multi-player partial failure, migration upgrade, and
restore. No LLM-generated behavior exists in the current production modules, so an LLM eval is not
applicable.

## Testing efficiency assessment

### Baseline

All runs were from the same macOS arm64 checkout and used Node 26.4.0, npm 11.17.0, and Vitest
3.2.7. Times are observations, not benchmarks; process/cache warmup and worker scheduling varied.

| Run | Result | Vitest duration | External wall | Aggregate collect | Aggregate tests |
|---|---:|---:|---:|---:|---:|
| Default full suite | 19 files / 268 tests passed | 3.26s | 4.24s | 13.21s | 1.97s |
| Verbose full suite | 19 / 268 passed | 3.07s | 3.67s | 12.10s | 1.93s |
| Serial files (`--no-file-parallelism`) | 19 / 268 passed | 7.98s | 8.59s | 4.96s | 0.777s |
| V8 coverage | 19 / 268 passed | 3.73s | 4.66s | 14.42s | 2.05s |

Vitest's collect/test values are aggregate worker time, so they are not added to wall time. Default
parallel execution completed 4.72s (59%) sooner than serial by Vitest's duration despite consuming
more aggregate CPU time. Disabling isolation/parallelism would be a poor trade at this scale.

The default run's slowest files were `test/mcp.test.ts` (462ms), `test/api.test.ts` (325ms),
`test/watchlist.test.ts` (182ms), and `test/seed.test.ts` (177ms). In the verbose run, the slowest
single case was MCP tool inventory at 92ms; the next two were an NCAA ingest case and an MCP NCAA
error case at 56ms each. There is no urgent slow test.

### Bounded repeat sample

Ten consecutive default full-suite runs all passed 268/268 tests. Vitest duration ranged from 2.94s
to 3.29s (mean 3.060s); external wall time ranged from 3.56s to 3.96s (mean 3.689s). This is evidence
of stability for this bounded local sample, not proof that CI, Node 22, another platform, or rarely
scheduled paths cannot flake.

### Setup and feedback cost

Fresh migration/database setup repeats frequently, and API/MCP/seed tests intentionally repeat some
service scenarios to protect transport parity. At a roughly four-second external wall time, replacing
real SQLite with mocks or deduplicating those surface checks would sacrifice confidence for negligible
benefit. Maintainers can already run a focused regression file, for example
`npx vitest run test/digest.test.ts`, then rely on the full CI gate.

Useful efficiency work is diagnostic rather than micro-optimization: capture expected stderr, add a
coverage command, and keep future live/provider/restore smokes in a separate labelled cadence so the
fast offline PR suite remains fast.

## Coverage measurement

The successful matched V8 run included all production files, including unimported entrypoints:

| Metric | Covered / total | Percent |
|---|---:|---:|
| Statements | 2,680 / 2,987 | 89.72% |
| Branches | 699 / 799 | 87.48% |
| Functions | 141 / 150 | 94.00% |
| Lines | 2,680 / 2,987 | 89.72% |

The highest-value information is not the total: the four actual scheduled/maintenance entrypoints
were 0%, server bootstrap was 66.66%, and refresh branch coverage was 78.02%. Conversely, 98.97%
line coverage on the digest job did not protect the send/persist distributed failure window. This is
why the future gate should follow H1-H3 risk, not choose a round global target first.

## Prioritized future strategy

### Confidence gains — do first

1. **Close H1:** define and test digest delivery semantics under simultaneous invocation and every
   send/persist failure window.
2. **Close H2:** isolate per-player refresh faults, surface partial failure, and test recovery with a
   failing player in the middle of the watch list.
3. **Close H3:** replace circular NCAA contract evidence with sanitized live captures,
   category-specific semantic validation, and a polite host probe tied to annual IDs.
4. **Close M1 and M3:** mechanically block accidental network access and introduce a compact shared
   REST/MCP rejection-conformance matrix.
5. **Close M2:** add subprocess bootstrap smokes, migration-upgrade/WAL checks, checked host config,
   and a periodic disposable restore drill.
6. **Close M4 after the seam tests exist:** persist V8 diagnostics and apply expectations to risk
   areas/changed files before considering a repository-wide floor.

### Optional polish — only after the confidence gaps

- Capture expected warnings and record fixture provenance/refresh dates.
- Add small property suites around IP/date/hash invariants.
- Pilot mutation testing only on digest claim/marking, refresh continuation, and NCAA semantic
  guards. Expand only if it catches meaningful survivors at acceptable cost.
- Revisit database setup sharing only if the suite grows enough for local feedback to become
  materially slow; today's parallel isolated databases are worth their cost.

## Follow-up issue candidates

Each High and substantial Medium finding should become one bounded leaf issue:

| Candidate title | Severity | Required test outcome |
|---|---|---|
| Make digest delivery concurrency- and crash-aware | High | Concurrent and fault-injection matrix proves the documented delivery guarantee and durable recovery. |
| Continue whole-watch-list refresh after per-player failures | High | Three-player failure cases prove later players refresh, partial failure is observable, and retry heals safely. |
| Establish an independent live NCAA scrape contract | High | Sanitized real captures and a host probe validate category IDs/headers/non-zero values end to end. |
| Enforce zero network egress in the default test suite | Medium | Canary tests prove all default provider/client network paths are rejected before egress. |
| Add production entrypoint and SQLite recovery smokes | Medium | Subprocess, migration-upgrade, WAL, checked config, and disposable restore checks cover actual operations. |
| Add REST/MCP rejection conformance cases | Medium | Shared semantic cases prove equivalent outcomes/error classifications across both interfaces. |
| Add risk-oriented V8 coverage diagnostics to local and CI workflows | Medium | All production files appear in machine-readable output; expectations focus on agreed high-risk areas. |

Broad fixes remain out of scope for this review.

## Reproduction

Run from the repository root at the reviewed SHA. The variable name is deliberately task-specific;
all generated reports/logs are outside the repository.

```sh
git rev-parse HEAD
node --version
npm --version
npx vitest --version
uname -a

BRYCE_AUDIT_DIR=$(mktemp -d /tmp/bryce-testing-review.XXXXXX)

/usr/bin/time -p npm test \
  > "$BRYCE_AUDIT_DIR/default.log" \
  2> "$BRYCE_AUDIT_DIR/default.time"

/usr/bin/time -p npm test -- --reporter=verbose \
  > "$BRYCE_AUDIT_DIR/verbose.log" \
  2> "$BRYCE_AUDIT_DIR/verbose.time"

/usr/bin/time -p npm test -- --no-file-parallelism \
  > "$BRYCE_AUDIT_DIR/serial.log" \
  2> "$BRYCE_AUDIT_DIR/serial.time"

for BRYCE_RUN_INDEX in 1 2 3 4 5 6 7 8 9 10; do
  /usr/bin/time -p npm test \
    > "$BRYCE_AUDIT_DIR/repeat-${BRYCE_RUN_INDEX}.log" \
    2> "$BRYCE_AUDIT_DIR/repeat-${BRYCE_RUN_INDEX}.time"
done
```

Coverage used the exact installed Vitest version. `--no-save --no-package-lock` leaves
`package.json` and `package-lock.json` unchanged; hashes were checked before and after. Coverage
output goes to the temporary directory. The provider exists only as local diagnostic tooling in
`node_modules` until the dependency is formally adopted by a follow-up.

```sh
shasum package.json package-lock.json > "$BRYCE_AUDIT_DIR/package-hashes.before"
npm install --no-save --no-package-lock @vitest/coverage-v8@3.2.7

/usr/bin/time -p npx vitest run \
  --coverage.enabled \
  --coverage.provider=v8 \
  --coverage.all \
  --coverage.include='src/**/*.ts' \
  --coverage.reporter=text \
  --coverage.reporter=json-summary \
  --coverage.reportsDirectory="$BRYCE_AUDIT_DIR/coverage" \
  > "$BRYCE_AUDIT_DIR/coverage.log" \
  2> "$BRYCE_AUDIT_DIR/coverage.time"

shasum package.json package-lock.json > "$BRYCE_AUDIT_DIR/package-hashes.after"
diff -u \
  "$BRYCE_AUDIT_DIR/package-hashes.before" \
  "$BRYCE_AUDIT_DIR/package-hashes.after"
jq '.total' "$BRYCE_AUDIT_DIR/coverage/coverage-summary.json"
```

Vitest documents the provider and reporters used here in its official
[coverage guide](https://vitest.dev/guide/coverage.html) and
[reporter guide](https://vitest.dev/guide/reporters.html).

## Environment, assumptions, and limitations

- Local environment: macOS Darwin 25.5.0 arm64, Node v26.4.0, npm 11.17.0, Vitest 3.2.7. The app CI
  workflow declares Node 22; timing and repeat observations were not reproduced under Node 22.
- Ten repeats are a bounded sample on one machine. They cannot prove the absence of flakes.
- Default, verbose, serial, and coverage runs occurred sequentially, so cache warmth and machine
  scheduling limit direct timing comparisons. External wall time includes npm/process startup.
- V8 coverage is dynamic execution evidence. It does not measure assertion quality, external
  contract truth, concurrency schedules not taken, or operational recovery.
- No live MLB/NCAA/Postmark/SMTP, Cloudflare, R2, Litestream, launchd, crash, or destructive restore
  operation was run. Network remained mocked by test convention. Those unverified boundaries are
  reported as gaps, never as passes.
- The NCAA source is unofficial and Akamai-protected. No claim is made that constructed fixtures
  represent the live page as of the review date.
- `rules/testing.md` refers to `docs/rules/testing-postmortems.md`, but that deferred file is absent
  from this checkout. The lean testing rule was applied; no missing deep guidance was invented.
- Package manifest hashes were identical before and after temporary provider installation and the
  coverage run. No generated report, log, or timing artifact is stored in the repository.
