# Bryce codebase and architecture adversarial review

**Baseline:** `b2cb354c68c055a13969fec38ad249bb71fd4332` (`main`, reviewed 2026-07-20)  
**Scope:** application architecture, domain correctness, operations, Claude product interface, and AI-assisted development process  
**Method:** static code, test, history, issue, ADR, and guide review; no production database, live upstream, email, tunnel, backup, or hosted Claude connector was exercised.

## Executive judgment

Bryce is a coherent small application, not an overengineered distributed system. TypeScript, one service layer, SQLite, full-season idempotent refresh, report-once delivery, an isolated NCAA adapter, and MCP plus REST are proportionate to a single-user product. The strongest properties are the compact storage model, explicit domain ADRs, fail-closed bearer authentication, read-only bounded SQL, and a substantial database-backed test suite.

The architecture nevertheless has three user-visible correctness holes: historical lines are rendered under a player's current level, digest delivery is not tied to a successful/fresh refresh, and the promised NCAA-to-professional identity transition has no implementation path. A fourth report-once edge case can render false zero statistics when batting and fielding data arrive in different refreshes. The primary Claude interface is plausible, but the hosted connector authentication path is conditional and has not been proven with the intended Cloudflare Access deployment.

No Critical issue was found. The recommended response is five focused follow-ups (three High, two substantial Medium), not a redesign. Existing issues already cover the broad testing, recovery, parity, and reviewer-process gaps and should not be duplicated.

## Evidence discipline and limits

- **Observed (O):** directly supported by the pinned tree, git history, or current project metadata.
- **Inherited (I):** evidence copied from open PR #21's review artifact, identified as such rather than presented as a fresh run.
- **Inference (N):** a consequence derived from observed control flow; it needs a focused reproducer before implementation.
- Static inventory at the baseline: 39 production modules / 4,340 lines, 19 test files / 5,418 lines, 268 `it(...)` cases, 9 declared runtime dependencies, and 177 tracked files. These are orientation metrics, not quality scores.
- The review environment was macOS arm64 with Node 26.4.0, npm 11.17.0, and Vitest 3.2.7; CI declares Node 22. A real service, real data, outbound calls, launchd, Cloudflare, R2/Litestream, and Claude clients were out of scope.
- Open PR #21 reports 89.72% statement/line, 87.48% branch, and 94% function coverage, with ten green repeated runs. Those figures are **inherited from an open PR** and were not regenerated for this review.

## Problem-solution matrix

| Problem / commitment | Current solution | Adversarial judgment | Disposition |
|---|---|---|---|
| One person across MLB/MiLB | MLB `personId` plus one mutable Player row | Works for MLB call-ups; history stays attached | Keep |
| One person from NCAA into pro | Side-by-side nullable source IDs | Domain says one row, but no link/transition operation exists | New High [F3 / #35](https://github.com/wrburgess/bryce/issues/35) |
| Stable per-game identity | DB unique key `(player_id, game_id, stat_type)` | Correct for doubleheaders and idempotent sweeps | Keep |
| Complete ingestion after downtime | Full-current-season refresh | Simple and appropriate at this scale; lacks timeout/fault isolation | Keep; #23 |
| Correct historical affiliation | Stat lines store source team/sport/league | Renderer discards those fields and uses current Player location | New High [F1 / #33](https://github.com/wrburgess/bryce/issues/33) |
| Report each new line once | `digest_delivery_id`, preserved on upsert | Sound core invariant; split arrival breaks merged batting/fielding presentation | New Medium [F4 / #36](https://github.com/wrburgess/bryce/issues/36) |
| Daily proof of life | Independent digest job, including empty digest | Can certify stale data because refresh success/freshness is not persisted | New High [F2 / #34](https://github.com/wrburgess/bryce/issues/34) |
| No duplicate delivery | Per-kind/date unique row and retry update | Concurrency/crash window remains | Existing #22 |
| Offseason quietness | Calendar-driven sleep plus weekly heartbeat | Clear policy; calendar/failure paths need isolation | Existing #23 |
| NCAA data source | Isolated scrape adapter, loud validation | Boundary is cohesive; no independent live contract run | Existing #24 |
| External network tests | Injected clients and fixtures | Fast/deterministic; egress is not mechanically blocked | Existing #25 |
| Start/recover on a Mac | CLI entrypoints, guide snippets, WAL + Litestream | Operational assets and restore behavior are not exercised | Existing #26 / #19 |
| REST and MCP consistency | Shared services and Zod schemas | Duplicate routing/error lists have already drifted once | Existing #27 |
| Diagnostic test coverage | Vitest database integration suite | Strong baseline; branch thresholds and gap reporting are absent | Existing #28 |
| Natural-language primary UI | Stateless remote MCP with 11 tools | Good fit; hosted Claude auth/Access path is unproven and conditional | New Medium [F5 / #37](https://github.com/wrburgess/bryce/issues/37) |
| Scripted/non-Claude access | Thin REST API and CLI | Useful portability, but not full feature parity with MCP | Accept debt |
| Single-user security | Fail-closed static bearer token, Access intended | Proportionate if Access and secret handling are verified; no scopes | Verify in F5 |
| Backups | SQLite WAL + Litestream guidance | Right technology; recovery remains a claim until drilled | Existing #26 |
| Report engine | Planned issues #29-#32 | Not in the reviewed baseline; absence is not a defect in current scope | Deferred |
| AI-assisted lifecycle | ADRs, rules, skills, parity, second-model review, human merge | Has caught real defects, but configuration is large and reviewer independence is incomplete | Existing #2; trim/measure |

## Actionable findings

### F1 — High — Late or backfilled history is grouped under the player's current level ([#33](https://github.com/wrburgess/bryce/issues/33))

**Evidence (O/N).** Refresh updates the Player's current level/team before sweeping every sport and the whole season ([`src/jobs/refresh.ts`](../../src/jobs/refresh.ts#L303-L370)). Each Stat Line correctly retains its source `sportId`, team, and league ([`src/jobs/refresh.ts`](../../src/jobs/refresh.ts#L374-L396)). Assembly joins the current Player and constructs `RenderLine.player` from it, ignoring those line-level affiliation fields ([`src/digest/assemble.ts`](../../src/digest/assemble.ts#L39-L69)); sectioning then uses `line.player.level` and `milbLevel` ([`src/digest/render.ts`](../../src/digest/render.ts#L136-L154)). The call-up test proves one Player can hold both sport 11 and sport 1 history after becoming MLB ([`test/refresh.test.ts`](../../test/refresh.test.ts#L220-L258)), but digest tests do not cover that transition.

**Consequence.** After a promotion/demotion, a late or first backfill can put a historical MiLB game in the MLB section (or the reverse) and show the wrong club. This is visible output corruption, not merely metadata drift.

**Preferred alternative.** Derive rendered level and affiliation from each Stat Line's `sportId` / `leagueName` / `teamName`; retain Player identity and current location only for watchlist/status views. Add promotion, demotion, and late-line digest tests.

**Tradeoff and migration.** This adds a small source-to-display mapping and clarifies NCAA fallback behavior. It requires no schema migration because the source fields already exist.

### F2 — High — Digest and health can report success over failed, stale, or overlapping refresh data ([#34](https://github.com/wrburgess/bryce/issues/34))

**Evidence (O/N).** `runRefresh` returns an in-memory summary but persists no run status or freshness watermark ([`src/jobs/refresh.ts`](../../src/jobs/refresh.ts#L62-L98)); the schema contains Players, Stat Lines, deliveries, and calendars, but no refresh-run record ([`src/db/schema.ts`](../../src/db/schema.ts#L9-L97)). `runDigest` independently assembles and sends without checking refresh state ([`src/jobs/digest.ts`](../../src/jobs/digest.ts#L34-L75)). Health always returns `ok: true` and reports only counts and last delivery ([`src/server/health.ts`](../../src/server/health.ts#L10-L52)). The guide installs refresh and digest as separate launchd jobs and notes missed jobs run on wake ([`docs/guides/running-bryce.md`](../guides/running-bryce.md#L50-L83)); ordering after wake is therefore not established by the application.

**Consequence.** A failed or still-running refresh can be followed by an empty/stale digest that looks like valid proof of life, while `/health` also remains green. The owner cannot distinguish “nobody played” from “ingestion did not complete.”

**Preferred alternative.** Persist refresh-run start/end, outcome, and season watermark. Chain the jobs or make Digest gate/annotate delivery on a recent successful refresh; expose freshness and partial failure through `status` and `/health`.

**Tradeoff and migration.** A small table and explicit policy are more state to maintain, but avoid a queue or distributed scheduler. #23 should supply player/calendar fault isolation and error details; this finding owns the persisted freshness and delivery contract.

### F3 — High — The promised NCAA-to-professional one-Player transition cannot be performed ([#35](https://github.com/wrburgess/bryce/issues/35))

**Evidence (O).** ADR 0032 explicitly requires a recruit who signs professionally to keep one row and gain `external_id` ([`docs/adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md`](../adr/0032-ncaa-identity-stats-player-seq-scrape-adapter.md#L3-L8)). `addPlayer` searches only by MLB `externalId` and inserts when absent ([`src/watchlist/service.ts`](../../src/watchlist/service.ts#L101-L149)); `addNcaaPlayer` searches only by `ncaaPlayerSeq` and likewise inserts ([`src/watchlist/service.ts`](../../src/watchlist/service.ts#L161-L227)). The CLI, REST, and MCP surfaces offer separate adds but no explicit link operation. The schema permits both identifiers on one row, but cannot determine that two identifiers describe one human ([`src/db/schema.ts`](../../src/db/schema.ts#L9-L30)).

**Consequence.** Adding the new MLB identifier for an already tracked NCAA player creates a second Player, splits history and digest grouping, and violates the central identity invariant.

**Preferred alternative.** Add an explicit, reviewed transition/link command taking the existing Player id and professional `personId`, validating both identities and updating the existing row. Never auto-link by name. Provide a reconciliation path for any duplicate rows created before the fix.

**Tradeoff and migration.** The manual confirmation adds friction at a rare, high-value lifecycle event. Updating a clean row is simple; reconciling two rows must transactionally move Stat Lines and handle key collisions.

### F4 — Medium — Split arrival of batting and fielding rows can synthesize false statistics ([#36](https://github.com/wrburgess/bryce/issues/36))

**Evidence (O/N).** Assembly selects only unreported rows, merges fielding into a simultaneously unreported batting row, and otherwise synthesizes a zero batting line ([`src/digest/assemble.ts`](../../src/digest/assemble.ts#L39-L92)). Upsert intentionally preserves `digest_delivery_id`, so an earlier counterpart remains excluded forever ([`src/jobs/refresh.ts`](../../src/jobs/refresh.ts#L399-L425)). Tests cover simultaneous batting+fielding and fielding-only input, not a counterpart arriving after the first digest ([`test/digest.test.ts`](../../test/digest.test.ts#L281-L330)).

**Consequence.** Late fielding after reported batting produces a zero batting line with errors; late batting after reported fielding omits the already reported errors. Both presentations can be factually false even though storage is correct.

**Preferred alternative.** When rendering a newly reportable row, load all stored counterparts for that player/game to build a truthful composite while marking only newly reported ids. Specify whether the message is a correction or an incremental update.

**Tradeoff and migration.** This adds one bounded companion query or join and a product decision about correction wording. No schema change is required.

### F5 — Medium — The primary hosted Claude connector path is conditional and unverified end to end ([#37](https://github.com/wrburgess/bryce/issues/37))

**Evidence (O).** Bryce requires one fixed bearer header for `/mcp` and fails closed without it ([`src/server.ts`](../../src/server.ts#L25-L50), [`src/server/auth.ts`](../../src/server/auth.ts#L13-L23)). The guide conditions hosted setup on the connector offering an auth header and layers Cloudflare Access in front ([`docs/guides/running-bryce.md`](../guides/running-bryce.md#L139-L168)). Current official Claude documentation says, “Request header authentication is in beta. This feature is being slowly rolled out to customers” ([Remote MCP connectors](https://claude.com/docs/connectors/custom/remote-mcp), accessed 2026-07-20). Claude Code explicitly supports custom headers ([Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)); hosted custom connectors support fixed static headers only where that beta is available, while OAuth is the preferred per-user path ([Connector authentication](https://claude.com/docs/connectors/building/authentication)). No hosted/mobile connection through the intended Tunnel + Access + app-token stack was exercised.

**Consequence.** The service can be healthy while its claimed primary web/mobile interaction path is unavailable to this account or blocked by one of two authentication layers. REST/CLI preserve technical operation but not equivalent natural-language accessibility.

**Preferred alternative.** First run and document a real smoke test for Claude web and mobile, including the exact Cloudflare Access policy/service-token arrangement. If fixed headers are unavailable or incompatible, implement standards-based OAuth or terminate the user-auth concern at Access rather than weakening the app token.

**Tradeoff and migration.** Verification/configuration is cheap if the beta is enabled. OAuth is materially more code and should be undertaken only if the simpler proven deployment cannot meet the product need.

## Existing open work: do not duplicate

Findings F1-F5 are tracked by issues [#33](https://github.com/wrburgess/bryce/issues/33)-[#37](https://github.com/wrburgess/bryce/issues/37). The following table instead covers pre-existing work and comes from the review artifact in **open PR #21**, not from a new execution here. Its diagnosis remains relevant:

| Existing issue | Covered risk | Relationship to this review |
|---|---|---|
| #22 | Digest/heartbeat concurrency, crash, and delivery idempotency | Complements F2; owns send atomicity |
| #23 | Refresh calendar/player failure isolation | Complements F2; owns continuation and partial errors |
| #24 | Independent NCAA live contract | Validates the intentionally isolated scraper boundary |
| #25 | Mechanical network-egress enforcement in tests | Closes a test-environment trust gap |
| #26 | Entrypoints, WAL, backup/restore, host configuration | Owns operational proof and recovery drills |
| #27 | REST/MCP conformance and rejection parity | Owns duplicated adapter/error-seam drift |
| #28 | Coverage diagnostics and thresholds | Owns diagnostic reporting, not raw test volume |

Issue #19 already owns documentation correctness/navigation. Issues #29-#32 describe the pending report engine and were not treated as defects in the pinned application. Issue #2 owns installation and validation of Codex as the designated second-model reviewer.

Other observed debt does not justify separate issues yet: upstream MLB/NCAA/Postmark calls lack explicit timeouts/retry policy (fold into #23/#22); database enum/identity relationships are mostly application-enforced (address with F3 when touching identity); same-name players can collide in a rendered section because grouping uses `fullName`; and unbounded raw payload/history growth is acceptable at current single-user scale but should be measured before it becomes a problem.

## Claude product-interface assessment

**Fit.** MCP-first is a sound product choice: the service exposes small task-shaped tools, structured validation, a shared service layer, and a stateless transport. It makes the core use cases conversational without building a bespoke UI. REST and CLI keep the data and operations outside one vendor, and email delivery is independent of Claude.

**Discoverability and accessibility.** Natural-language commands are excellent for one technical owner once connected. Without the connector, the alternatives are developer-oriented; there is no low-friction visual surface. Do not describe the system as usable from “any Claude surface” until F5's account- and deployment-specific smoke test passes.

**Security and failure behavior.** Fail-closed startup, constant-time token comparison, bounded read-only SQL, and a planned Access layer are proportionate. The single bearer token has broad watchlist, refresh, query, and send authority, so Claude tool approval and connector trust remain part of the security boundary. Known service errors are structured, but delivery/refresh state and multi-step action semantics need F2/#22/#23.

**Portability judgment.** Keep MCP as primary and REST/CLI as escape hatches. A small read-only HTML status/watchlist page should remain optional unless real nontechnical-access or connector reliability evidence creates the need; building a full UI now would add more surface than value.

## AI development-process assessment

The repository has an unusually explicit AI lifecycle: nine skills, ADR-backed rules, structural parity, attribution, second-model review, and a mandatory human merge. That machinery has produced value. PR #5's self-review caught missing `.env` loading; PR #10's review found three error-seam defects; and the backend postmortem converts them into durable guidance. Conversely, the post-merge NCAA zero-stat correction in PR #12 shows that process volume is not proof of cross-boundary correctness.

The cost is material: approximately 2,767 lines of AI configuration/process material versus 4,340 lines of production source. That ratio overstates runtime context because much is deferred or vendored, but it accurately signals maintenance surface. Structural parity detects missing shapes and projections, not semantic contradictions. The acting reviewer is Copilot while Codex installation remains open in #2; many reviews provide only summaries, and plan approval is automatic. Attribution improves provenance but does not demonstrate correctness.

Recommended policy:

1. Keep feature branches, final quality checks, evidence-backed self-review, second-model review, and the human merge gate.
2. Resolve #2 and record reviewer yield (actionable findings, false positives, escaped defects), rather than assuming a second model is independent validation.
3. Require deliberate human/domain review for identity, scrape contracts, delivery state, and architecture changes; these are precisely where local tests and generic reviewers are weakest.
4. Treat parity as structural only, periodically sync the vendored baseline, and add rules/ADRs only when a real decision or escaped defect earns them.
5. Prefer implementation and focused tests over more lifecycle ceremony. TypeScript and MCP partly improve agent ergonomics, but they also fit the product; the separate AI configuration should continue to justify its upkeep with measurable defect prevention.

## Hotspot map

| Hotspot | Why it is hot | Direction |
|---|---|---|
| `src/jobs/refresh.ts` (459 lines; highest production churn) | Calendar policy, source sweep, current identity mutation, normalization, and persistence meet here | Extract persisted run outcome and source-specific orchestration only as F2/#23 require |
| `src/watchlist/service.ts` (317 lines) | Identity creation, reactivation, location lookup, and first refresh span a failure boundary | Make add/transition transactional; implement F3 explicitly |
| `src/jobs/digest.ts` + `src/digest/assemble.ts` | Report-once state meets external email and cross-row composition | Address F2, F4, and #22 before adding report features |
| REST + MCP adapters | Same services, but duplicated route/tool/error registrations | Use #27 conformance tests before considering code generation/refactor |
| NCAA adapter | Unofficial external HTML behind a clean boundary | Preserve isolation; validate through #24, not broad mocks |
| Host operations | Guide-driven launchd/tunnel/backup configuration is outside tests | Turn #26 into repeatable install, health, and restore proof |

Historical churn also clusters in `test/api.test.ts`, `test/digest.test.ts`, `test/refresh.test.ts`, `test/mcp.test.ts`, and `test/factories.ts`; that is consistent with boundary-heavy delivery, not by itself a refactoring mandate.

## Prioritized roadmap

**Immediate correctness (before relying on daily output):** [F1 historical affiliation (#33)](https://github.com/wrburgess/bryce/issues/33); [F2 refresh freshness/health contract (#34)](https://github.com/wrburgess/bryce/issues/34) together with #22/#23; [F3 NCAA-to-pro identity transition (#35)](https://github.com/wrburgess/bryce/issues/35); [F4 split-arrival digest composition (#36)](https://github.com/wrburgess/bryce/issues/36).

**Near-term operational confidence:** #24-#28, [F5 hosted connector/Access smoke (#37)](https://github.com/wrburgess/bryce/issues/37), #26 restore drill and tracked host configuration, and #2 reviewer installation/validation.

**Longer-term debt, triggered by evidence:** request timeouts/retry policy, stronger DB `CHECK` constraints, rendered grouping by immutable Player id, and storage/index retention measurements. Report engine issues #29-#32 remain planned feature work.

**Speculative or optional:** a web UI, OAuth when static headers work, a queue/distributed scheduler, splitting the SQLite database, caching beyond the current calendars, and LLM-authored digest narrative. None is justified by present scale or evidence.

## Verification and acceptance record

After the last artifact edit, the five commands declared in `PROJECT.md` were run once: structural parity, TypeScript typecheck, ESLint, Vitest, and production dependency audit. All passed; Vitest reported 19 files and 268 tests, and the audit reported zero vulnerabilities. No source, test, dependency, lockfile, generated artifact, or production state was changed.

Acceptance criteria met:

- The review covers architecture, boundaries, data flow, persistence, external systems, failure modes, operational assumptions, and agent convenience.
- Claude product-interface quality is assessed separately from the AI development process.
- Each actionable finding includes severity, evidence, consequence, alternative, tradeoff, migration impact, and deduplication disposition.
- Open work #2, #19, #22-#28, and #29-#32 is referenced rather than duplicated; PR #21 evidence is labeled inherited/open.
- Urgent correctness, near-term confidence, longer-term debt, and speculative/optional ideas are separated.

— Codex (GPT-5.6)
