# A lane-scoped Refresh supersedes the whole-list sweep

**Status:** accepted

**Supersedes:** [ADR 0046](0046-named-player-lists-scoped-digests.md) decision 2 (*the refresh sweep
is left whole*).

The Refresh may sweep **a set of lanes** instead of the whole Watch List. The scope is resolved
**once**, before the run is claimed, and consumed by **both** of the job's player-selection sites; the
run records which lanes it covered, and the digest's freshness watermark is judged against that record.
`sk refresh` with no `--list` means **the default lane**; `runRefresh` with no scope still means **the
whole Watch List**.

Concretely ([issue #192](https://github.com/wrburgess/bryce/issues/192), phase 3 of the
[#189](https://github.com/wrburgess/bryce/issues/189) epic):

- `RefreshScope` (`src/jobs/refresh.ts`) carries the live lane rows, their ids, and whether the default
  lane is among them. `loadActivePlayers(db, listIds?)` narrows the selection with a correlated
  `EXISTS` over `list_members`.
- `refresh_runs` gains `scope_list_ids` (`drizzle/0013`), and `digestFreshnessFor` only accepts a run
  that covered the lane it is answering for.
- `sk refresh` takes `--list NAME` / `-l NAME`, resolves the default lane when it is absent, and prints
  `list=<name>` first on both terminal lines.

## Why this was asked

ADR 0046 decision 2 deliberately left the sweep whole: with the digest scoped and ingestion universal,
a named list cost nothing and every player's data stayed current. Lanes break that trade. Once a lane
carries `refresh_interval_minutes` ([ADR 0059](0059-explicit-default-lane-supersedes-implicit-default.md)),
"refresh every 30 minutes" has to mean *this lane's players*, or a fast lane drags every other lane's
players through the MLB API with it — and [#193](https://github.com/wrburgess/bryce/issues/193)'s
due-lane driver has nothing to drive.

The hazard is not the narrowing. It is that the narrowing is **easy to do halfway**, and halfway is
green.

## Decisions

1. **`players.active` stays the master gate, above membership.** This is the surviving half of ADR 0046
   decision 2, and it is a decision rather than an implementation detail: a deactivated Player who is
   still enrolled in an in-scope lane is never fetched. Membership narrows a set of *active* players; it
   never revives one.

2. **The scope is resolved ONCE, before the claim, and consumed by BOTH selection sites.** `runRefresh`
   reads the active-player set twice — once for the sweep, and again at settle time to recompute
   `calendarBlocksFresh` against the post-refresh world ([ADR 0043](0043-persist-refresh-freshness-and-gate-digest.md),
   issue #23 P1). Scoping only the first leaves an off-lane player in the settle-time set, where a sport
   whose calendar fetch failed downgrades an otherwise-clean lane run to `partial` — a completeness
   warning about data the run never claimed to cover.

   That defect ships **with the whole suite green**, because no pre-#192 refresh test ties either read
   to list membership. So the guard for it (`test/refresh-list.test.ts`) asserts at settle time, on the
   one observable only the second site can move, and it was **observed red** against a half-scoped
   build before the second site was scoped.

   The settle-time read is still a **re-query**, not a reuse of the first array. The scope narrows
   *which* players are read; it does not *freeze* the set, so a mid-sweep call-up or lane addition is
   still reflected. Scoped-without-re-reading and re-read-without-scoping each look correct and each is
   wrong in one direction; both are pinned by tests.

3. **`sleepWindow` and `refreshNcaaCalendar` consume the same scoped set; `runRefreshForPlayer` stays
   whole-list.** The first two already read the sweep's `activePlayers`, so scoping that one variable
   scopes them — and the semantics are the ones we want: a lane sleeps on its own levels, and the NCAA
   calendar row is seeded only when *this* sweep watches an NCAA player. Note `sleepWindow` returns
   awake for zero watched players (`src/domain/season.ts`), so an empty lane **sweeps rather than
   sleeps**.

   `runRefreshForPlayer` (the seed-time backfill) keeps its whole-list read on purpose. It uses that
   read only to ask "is the pipeline asleep?", and Offseason Sleep is a host-wide state
   ([ADR 0031](0031-offseason-sleep-world-series-to-opening-day.md)); a single-player backfill is not a lane
   operation, and narrowing it would let an unrelated lane's levels decide whether a new Player gets his
   first Refresh.

4. **The JOB defaults to the whole Watch List; the COMMAND defaults to the default lane.** `runRefresh(deps)`
   with no `scope` is byte-for-byte the pre-#192 query, which is what leaves the MCP tool
   (`src/mcp/server.ts`), the REST route (`src/api/routes.ts`), and ~60 existing refresh tests
   untouched. `sk refresh` resolves the default lane through `resolveListOrDefault`, the same funnel
   `sk players add` uses.

   They differ because **the lane default is a property of the command surface, not of the job**. A
   default is an answer to "what did the operator mean by saying nothing?", and only a surface with an
   operator has that question. Putting it in the job would have forced every programmatic caller to
   opt out of a lane it never opted into.

5. **One `claimRefreshRun` per tick; union and dedupe fall out of one query.** A multi-lane scope takes a
   single run, not one per lane: the lease is what serializes ingestion, and N claims would either
   deadlock against each other or defeat the fence. The correlated `EXISTS` means a Player on two
   in-scope lanes satisfies the predicate once and yields one row — hence one fetch — with no
   deduplication step to get wrong. `IN` is used over **lane** ids only (a handful); Player ids are
   never materialized (`rules/backend.md`).

6. **A lane sweep's claim refusal is `already-running`, not `whole-refresh-running`.** The issue text
   says the latter, and that is a conflation worth recording. `whole-refresh-running` belongs to the
   **targeted single-player** fence (`admitTargetedRefresh` / `withIngestionFence`), which answers "a
   sweep is in progress, so this one-player write is deferred". A lane sweep takes the **same
   whole-sweep claim** every sweep takes, so it refuses in that claim's vocabulary. Widening
   `RefreshSummary.reason`'s typed union for a synonym would give two names to one event.

7. **MCP and REST are unchanged this phase.** Both call `runRefresh` with no scope and keep sweeping the
   whole Watch List. Lane parameters on the MCP `refresh` tool and `POST /refresh` are out of scope here;
   stated so their absence is not read as an oversight.

8. **The freshness watermark is lane-gated, and eligibility is DERIVED, never stored.** Scoping the
   sweep opens a hole the whole-list sweep did not have: `digestFreshnessFor` took the latest `ok`/
   `partial` run regardless of scope, so `sk refresh -l Prospects` settling `ok` would make the whole
   watch list's digest banner read `fresh` — a forged completeness claim over players that run never
   touched. That is a High correctness defect **introduced by this change**, so it is closed here.

   `refresh_runs.scope_list_ids` is `NULL` for a whole-list run and otherwise the canonical
   `,1,3,10,` — ids deduped, ascending, with **leading and trailing sentinel commas**. The sentinels
   are load-bearing: a containment test for lane `1` would otherwise match `,10,` on its prefix. The
   encoding is deliberately not JSON, so the test is an `instr` that needs no JSON1/`json_each` build
   assumption. An empty scope encodes to `,,` — non-`NULL`, containing no id, certifying nothing.

   A run is watermark-eligible iff its scope is `NULL` **or** it contains the **current** default lane's
   id. Derived at read time because `set-default` **moves** the default lane, and a run that swept the
   *previous* default genuinely no longer certifies the new one; a boolean written at claim time would
   be retroactively wrong. `digestFreshnessFor` takes the lane as a **parameter** rather than resolving
   it, because its only caller — the scheduled digest — has already resolved it (it cannot claim its
   delivery slot without one). That keeps this from becoming a second "what is the default lane?"
   decision site, and it means a database with **no** default lane never reaches the question at all:
   `resolveDefaultList` has already refused with `NoDefaultListError` before the claim.

   **`refreshHealth` is deliberately NOT filtered**, and the asymmetry is the decision. `/health` and
   the MCP `status` tool answer "what did ingestion last do on this host?"; hiding a lane run that
   settled `failed` there would suppress a real operational signal because the failure happened to be
   scoped. A freshness *claim* must be narrowed to the lane it claims for; an operational *signal* must
   not be. Both halves are pinned by tests so neither reads as an oversight to be "fixed".

9. **The digest stays whole-list for one phase, and the asymmetry is expected.** After this change
   `sk refresh` means the default lane while bare `sk digest` still assembles the whole Watch List
   (`src/jobs/digest.ts` scopes only the delivery row). That is a direct consequence of the epic's phase
   ordering, not a defect; #193 closes it. Recording it here means the gap is attributable rather than
   discovered.

10. **A lane soft-deleted after resolution sweeps anyway, against the captured id.** Three reasons.
    (a) It is what "resolve the scope once, before the claim" *means* — re-checking liveness would
    reintroduce a second decision site, the exact defect class decision 2 exists to close. (b) It is
    already correct at the data layer: `deleted_at` lives on `player_lists` and a soft delete leaves
    `list_members` untouched, so the correlated `EXISTS` keeps matching and **both** reads agree; the
    alternative makes them disagree, which is the leak shape. (c) Aborting mid-sweep adds a failure mode
    with no safety benefit — the members are still active Players whose data is still wanted, and the
    run is already fenced by its lease.

    One consequence, stated rather than discovered: such a run's `scope_list_ids` names a now-dead lane,
    so it can never be watermark-eligible again (the default lane is by definition live). That is the
    fail-closed direction, and it is intended.

11. **An empty default lane settles `ok` with `playersTotal: 0`, and DOES advance the watermark.** By
    `deriveRefreshStatus`: nothing failed, nothing was passed over, nothing blocks. This is not a
    regression — an empty watch list has always behaved this way, and a sweep of zero players genuinely
    left nothing behind. It is recorded because the reading changes once a lane can be empty *while the
    host has players*: the digest for an empty lane is then correctly `fresh` and correctly empty.

12. **The orphan-player gap is real, out of scope, and tracked.** `sk seed add`
    (`src/watchlist/service.ts`) attaches a Player to **no** lane, and `drizzle/0012` enrolled only the
    players active *at migration time*. Once bare `sk refresh` means the default lane, such a Player is
    active, digested, and never ingested — the same "behaves like a correctly configured system while
    configured wrong" shape ADR 0059 named. It is outside this issue's acceptance criteria (the fix is a
    seed-path change, not a refresh-path one), so it is deferred to a tracked follow-up on the #189 epic
    rather than folded in here.

## Consequences

- **Counts become lane-sized.** `playersTotal`, the progress writes, `/health`, and the digest's N-of-M
  banner all report the lane a run swept. Intended; decision 8 is what stops a lane-sized count being
  read as a whole-list claim.

- **The terminal line changes shape, and `--quiet`'s contract is restated rather than dropped.** Both
  lines gain `list=<name>` **first** — `refresh done list=… status=… … updated=…`. A bare `sk refresh`
  silently narrowing from everyone to one lane with no output change is a fail-quiet, so the field is
  not optional; it leads the line because the run's own counters come last
  (`test/cli-refresh.test.ts`). The surviving property, asserted with exact strings: **`--quiet` prints
  exactly one terminal line and nothing else, and that line is byte-identical to the verbose run's
  terminal line.**

- **The lane name is folded like every other runtime-derived field.** It is operator-supplied free text
  on a `key=value` line, and it now leads that line — so an unfolded lane called `x status=ok players=999`
  would put forged tokens *ahead* of the real ones
  ([ADR 0047](0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md), as amended for #146). Control
  bytes are refused earlier by the router's validator and `requireName`; the vector that reaches the
  presenter is the space, and the fold closes it.

- **`drizzle/0013` is additive and its NULL backfill is semantically correct by construction.** No table
  rebuild, so none of `drizzle/0012`'s FK-ordering hazards apply. Every historical row reads `NULL`, and
  `NULL` means the whole Watch List — which is exactly what every pre-#192 run swept. Rollback drops the
  column and returns `digestFreshnessFor` to its whole-list reading, losing only the scope provenance.

- **`test/factories.ts` gains `enrollInDefaultLane`, and `insertPlayer` still does NOT enroll.** A fresh
  `testDb()` has no players at migration time, so bare `sk refresh` would sweep nobody in the CLI suite.
  Enrollment is explicit where a test needs it; making it a side effect of building a player would
  ripple through every suite and bury this change's one subtle behavior shift under mechanical edits.

- **`parseList` moved to `src/cli/flags.ts`.** `sk refresh` is its second caller, and a second copy is
  how one rule becomes two that drift (`rules/scripting.md`) — the same reason `parseFlags` lives there.
  Digest's behavior and its cases are unchanged.
