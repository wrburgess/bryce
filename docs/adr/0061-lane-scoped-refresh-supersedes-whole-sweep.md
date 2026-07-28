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

- `RefreshScope` (`src/jobs/refresh.ts`) carries the live lane rows and their ids.
  `loadActivePlayers(db, listIds?)` narrows the selection with a correlated `EXISTS` over
  `list_members`.
- `refresh_runs` gains `scope_list_ids` (`drizzle/0013`) recording whether the run covered **every**
  active Player, and `digestFreshnessFor` only accepts a run that did.
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

8. **The freshness watermark is keyed on COVERAGE — "did this run sweep every active Player?" — not on
   which lane the run named.** Scoping the sweep opens a hole the whole-list sweep did not have:
   `digestFreshnessFor` took the latest `ok`/`partial` run regardless of scope, so `sk refresh -l
   Prospects` settling `ok` would make the whole watch list's digest banner read `fresh` — a forged
   completeness claim over players that run never touched. That is a High correctness defect
   **introduced by this change**, so it is closed here.

   **This decision was rewritten during the Stage-4 self-review of PR #201, and the first version was
   wrong.** It gated the watermark on *"does this run's recorded scope contain the current default
   lane's id?"* — a **proxy** for the question above, and one that holds only while the default lane
   contains every active Player. That is true immediately after `drizzle/0012` and false as soon as
   anyone uses the lane commands #191 shipped: `players lists create --name New` →
   `players lists set-default --name New` → `refresh` sweeps zero players, settles a legitimate `ok`,
   contains the default lane, and certified the **whole** Watch List as `fresh`. Two supported
   commands reached exactly the forged claim this decision exists to prevent. The proxy is gone; the
   real question is asked directly. `rules/backend.md` already names this shape — *"never re-decide a
   dependency's question with a proxy signal instead of the dependency's own criterion"* — so no new
   rule is owed; the existing bullet was simply not applied to a predicate written in SQL.

   **How it is asked.** At claim time `runRefresh` counts the active Players its lanes do *not* reach
   (one `count()` over a correlated `NOT EXISTS`, never a row load). Zero uncovered ⇒ the run swept the
   whole Watch List ⇒ `scope_list_ids` records **`NULL`** — including for a *lane* run, which is not a
   fudge but the column's documented meaning, and such a run genuinely did sweep everyone. Otherwise
   the lane ids are recorded as **provenance for a genuinely partial run**. `digestFreshnessFor`'s
   eligibility test collapses to `scope_list_ids IS NULL`; it loses its lane parameter, and the
   `instr` containment, the `RefreshScope.includesDefaultLane` flag, and the whole notion of a
   default-lane plumbing path go with it.

   Coverage is a **claim-time snapshot**. A Player added mid-sweep is still picked up by the
   settle-time re-read that feeds `calendarBlocksFresh` (decision 2), but he does not retroactively
   change what the run's row says it covered — a recorded coverage is a statement about the world the
   run claimed against, and the next sweep re-answers it from scratch. A Player added *after* a
   complete sweep likewise leaves that run's `fresh` verdict standing; that is the pre-#192 behavior
   unchanged (a whole-list run has always certified the world it swept), and his own first Refresh is
   what fills the gap.

   **Eligibility therefore moves from read time to claim time, and the reason the old ADR gave for
   read-time derivation no longer applies.** The first version derived it on every read because
   `set-default` *moves* the default lane, which would make a claim-time boolean retroactively wrong.
   Coverage has no such dependency: whether a run swept everyone is a fact about that run, and
   re-pointing the default lane afterwards does not change it. Nothing is left that a later
   configuration change can invalidate.

   **The storage form keeps its sentinel commas, on a different and smaller basis.** `,1,3,10,` — ids
   deduped, ascending, comma-delimited, bounded. The original justification (a containment test for
   lane `1` must not match `,10,` on its prefix) died with the containment test, and is recorded here
   as dead rather than quietly restated. What survives is one present-tense reason: an **empty** scope
   must not encode to the empty string. `NULL` here means "swept everything", and `""` is a value that
   `if (!row.scopeListIds)` in TypeScript, `ifnull()` in SQL, and most CSV/JSON round-trips cannot tell
   from `NULL` — the fail-**open** direction. `,,` is falsy nowhere. Canonical ordering and dedupe stay
   for the reason they always applied: two runs over the same lanes store the same bytes, so the column
   is comparable and greppable as provenance.

   **`refreshHealth` is deliberately NOT filtered**, and the asymmetry is the decision. `/health` and
   the MCP `status` tool answer "what did ingestion last do on this host?"; hiding a lane run that
   settled `failed` there would suppress a real operational signal because the failure happened to be
   scoped. A freshness *claim* must be narrowed to what it claims for; an operational *signal* must
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

    One consequence, stated rather than discovered: unless the dead lane happened to hold every active
    Player — in which case the run recorded `NULL`, having genuinely swept everyone — such a run's
    `scope_list_ids` names a now-dead lane and can never be watermark-eligible (decision 8 accepts only
    `NULL`). That is the fail-closed direction, and it is intended.

11. **An empty default lane settles `ok` with `playersTotal: 0`, and does NOT advance the watermark.**
    The status is unchanged and correct: by `deriveRefreshStatus`, nothing failed, nothing was passed
    over, nothing blocks — and an empty watch list has always behaved this way.

    **The second half of this decision was wrong, and this records the contradiction rather than
    quietly reworded text.** The first version argued that such a run *should* advance the watermark
    because "the digest for an empty lane is then correctly `fresh` and correctly empty". That is only
    true once the digest is **lane-scoped** — and decision 9 records that bare `sk digest` still
    assembles the **whole Watch List** until #193. Decisions 9 and 11 could not both hold in this
    phase, and 11 was the one asserting a completeness claim over players the run never touched.

    Resolved by decision 8's coverage predicate rather than by argument: an empty default lane on a
    host with active players elsewhere leaves those players uncovered, so the run records its lane id,
    is not watermark-eligible, and the whole-Watch-List digest banner reads **`stale`** — which is
    true. On a host with **no** active players at all the same run covers everyone (vacuously) and does
    advance the watermark, which is also true. The distinction the proxy could not draw is exactly the
    one that matters.

12. **The orphan-player gap is real, out of scope, and tracked as
    [#202](https://github.com/wrburgess/bryce/issues/202).** `sk seed add`
    (`src/watchlist/service.ts`) attaches a Player to **no** lane, and `drizzle/0012` enrolled only the
    players active *at migration time*. Once bare `sk refresh` means the default lane, such a Player is
    active, digested, and never ingested — the same "behaves like a correctly configured system while
    configured wrong" shape ADR 0059 named. It is outside this issue's acceptance criteria (the fix is a
    seed-path change, not a refresh-path one), so it is deferred to #202 (*Part of* #189) rather than
    folded in here. Today's behavior is **pinned by a test** (`test/cli-refresh.test.ts`) so #202
    cannot change it by accident: an orphan is not swept by a bare `sk refresh`.

    **Decision 8 downgrades this gap's severity, and that is why deferring it is defensible.** Before
    the coverage predicate, a default-lane run that missed an orphan certified the whole Watch List
    anyway — the gap was a *silent lie*. Now an uncovered active Player makes the run partial-coverage,
    so the banner reads an honest `stale`. The data is still missing; the system no longer claims
    otherwise. A fail-loud gap may wait for its own issue; a fail-quiet one may not.

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

- **The lane name is folded like every other runtime-derived field, PER NAME and before the join.** It
  is operator-supplied free text on a `key=value` line, and it now leads that line — so an unfolded
  lane called `x status=ok players=999` would put forged tokens *ahead* of the real ones
  ([ADR 0047](0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md), as amended for #146). Control
  bytes are refused earlier by the router's validator and `requireName`; the vector that reaches the
  presenter is the space, and the fold closes it.

  Folding happens **per name**, and the comma that joins two lanes is neutralised inside each one
  exactly as the space is. Joining first and folding after — the shape this PR shipped and Stage-4
  caught — left `,` untouched, so a single lane genuinely named `A,B` rendered `list=A,B`,
  indistinguishable from a two-lane scope. Latent while `resolveRefreshScope` yields exactly one lane,
  and reachable the moment #193's due-lane driver passes several.

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
