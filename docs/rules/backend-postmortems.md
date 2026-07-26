# Backend — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/backend.md`](../../rules/backend.md). Heavy,
subsystem-specific case studies for backend/domain code — **not** auto-loaded; read on demand when
the trigger in [`docs/rules/README.md`](README.md) fires (working in backend/domain code). Each
entry ends with a `(Reference: #NNNN)` pointer to the issue/PR that produced it.

## A new error type must reach every surface's error seam (Reference: PR #10)

**The case.** Phase 3 (issue #9 / PR #10) added the NCAA scrape adapter and with it three new typed
errors: `NcaaApiError` (upstream failure), `UnsupportedNcaaSeasonError` (bundled-data gap), and
`UnknownNcaaPlayerError` (no such player). The MLB pipeline's error types were already mapped at
three seams built in earlier phases: the MCP server's `errorResult` known-error set (structured tool
errors vs. re-throw), the REST `onError` handler (typed error → status code), and the watch-list
service's catch classification (what counts as "not found").

**What shipped and was caught in review.** Each seam individually "worked" — for the *old* errors —
and silently mishandled the new ones, three different ways: the MCP layer re-threw `NcaaApiError`
and **crashed the tool call** instead of returning a structured error; the REST handler mapped only
`MlbApiError` to 502, so NCAA upstream failures surfaced as raw 500s; and `addNcaaPlayer`'s blanket
catch converted *every* failure — including upstream 500s and the unsupported-season case — into
`UnknownNcaaPlayerError`, making "the scraper is blocked" indistinguishable from "you typed the
wrong player id" (a 404). All three were one review's findings (Copilot, PR #10), fixed together in
one commit with a sad-path test per surface.

**The rule it yields.** Introducing a typed error is not done when the throw site compiles — it is
done when **every seam that classifies errors knows the type**: the API error handler's status
mapping, the RPC/tool layer's known-error set, and each service-layer catch. Update them **in the
same change** that adds the type, and prove each with a sad-path test (wrong-status and
crash-instead-of-structured-error bugs are invisible to happy-path suites). Grep for the seams by
finding where the *existing* error types are named — those lists are the contract.

**Symptom to watch for.** A new failure mode showing up as a generic 500, a crashed RPC/tool call,
or — subtlest — as a *plausible but wrong* typed error (an upstream outage reported as "not
found"), because a blanket catch downstream of the new throw site collapsed it into the nearest
old category.

_(Reference: issue #16; findings on PR #10, fixed in 9e57c6d.)_

## An assumed-absent source field must be verified against the real payload, not the adapter map (Reference: PR #62)

**The case.** The July 2026 digest change (issue #54 / PR #62) added relief-decision columns —
`RW` (relief win) / `RL` (relief loss) — which render on every pitcher row but credit a win/loss as
relief only for an appearance with `gamesStarted == 0`. The design counted a decision as relief only
when `gamesStarted` was **present and 0**, and treated its absence as fail-closed: an NCAA pitching row
was taken to carry no start-status, so a missing `gamesStarted` was "unknown, not relief" and an NCAA
reliever's decision was silently dropped. The premise — "the NCAA source has no usable games-started" —
was carried from the adapter alone: `src/ncaa/normalize.ts`'s `PITCHING_HEADER_MAP` mapped `W`/`L`/`SV`
but not `GS`.

**What shipped and what the review caught.** The second-model Reviewer (Codex) raised the NCAA
start-status handling in the plan critique — where a fail-closed path was chosen and the `GS` mapping
deferred as out of scope — and then, in the PR review, pushed the direct fix: the page already carries
the field, so map it. A grep of the bundled fixture `test/fixtures/ncaa/gamelog_pitching.html` settled
it: the page carried a `<th>GS</th>` column all along — the NCAA source **did** report games-started per
game; the adapter simply never mapped it, so it passed through unread as `stats.GS`. The fail-closed
branch wasn't guarding a real gap; it was papering over a one-line mapping omission. The fix (commit
`7765500`) added `GS -> gamesStarted` to `PITCHING_HEADER_MAP`, so NCAA relief decisions now classify
like MLB/MiLB.

**The rule it yields.** Before you build fail-closed, degraded, or deferred behavior on the premise that
an external source omits a field, **confirm the premise against the real payload** — the bundled fixture
or a live sample — never the adapter's own mapping table, which shows only the fields you chose to read,
not the fields the source sends. "The source doesn't carry X" is a factual claim and is owed the same
citation discipline as any "verified" claim (`rules/self-review.md`): cite the fixture line (or the live
response) that actually shows the field absent. The unmapped-but-present field is the trap — missing from
the map, present on the wire.

**Symptom to watch for.** A fail-closed / "unknown" branch that only ever fires for one upstream source
while the equivalent rows from every other source classify fine — often a sign the source *does* carry
the field and the adapter just never mapped it. Grep the fixture for the column header before trusting
the map.

_(Reference: issue #54 / PR #62; the deferred-mapping premise was overturned by the second-model
Reviewer's PR-level review after a fixture check, fixed in 7765500.)_

## A persisted freshness record must survive its own concurrency: schema, clock, claim, and read path (Reference: PR #79)

**The case.** Issue #34 observed that Refresh outcome lived only in memory: `src/jobs/refresh.ts`
returned a summary and persisted nothing, `src/db/schema.ts` carried no refresh-run record, the daily
Digest sent without consulting Refresh state, and `/health` always reported `ok=true`. On a sleep/wake
laptop where launchd runs the Refresh and Digest jobs independently — late, and out of order — the
Digest could present stale or partially refreshed data as a successful proof-of-life. PR #79
implemented the chosen hybrid degrade: persist every whole-watch-list Refresh as a durable
`refresh_runs` row (migration `0005`) under a claim with a per-player renewed lease, mirroring the
ADR 0034 delivery claim, and make the daily Digest **annotate — never suppress** — when no fresh
successful Refresh backs the covered date.

**What shipped and was caught in review.** The plan critique had already forced seven corrections
before any code (anchor on the content date not the slot date; `started_at` not `finished_at`; read the
watermark before assembly to close a TOCTOU). The implementation still shipped four separable defects,
all found by the independent second-model Reviewer across two work-mode rounds:

- **The lease could be revived by its own loser (P1, High).** `renewRefreshRun` renewed
  unconditionally, so when run A's per-player request outlived the ten-minute lease and run B claimed,
  A's late-resolving `await` revived A and both sweeps continued. Round 2 sharpened it: the *final
  settle* had the same hole — a reaped run reaching its last player would flip its own row back to
  `ok`, overwriting the run that had superseded it.
- **The invariants lived only in migration SQL (P2).** Six `CHECK` constraints were hand-added to
  `0005_*.sql` while `drizzle/meta/0005_snapshot.json` recorded `checkConstraints:{}`, because the
  `sqliteTable` declaration carried no `check(...)`. Drizzle Kit generates future migrations from the
  schema and its snapshot, so a later table rebuild would have recreated `refresh_runs` without a
  single one of them. The PR had *disclosed* this in Known Limitations as an accepted trade; the
  Reviewer declined to accept it.
- **Every `/health` poll scanned the whole history (P2).** `refresh_runs` is append-only, yet both
  `refreshHealth` and `digestFreshnessFor` materialized and sorted the entire table with no index — a
  public, frequently polled endpoint paying a cost that grows with every refresh, forever.
- **The banner misdiagnosed its own cause (P2).** `stale` rendered as "no refresh ran", which is
  simply false when a qualifying run *failed* or is *currently running*.

All four were fixed in `0a98fd1` — reap expired-lease rows to `failed`, make renew return ownership and
abort the sweep on loss; declare the six `check()`s in `schema.ts` and regenerate `0005`; add a
`(status, started_at)` index and rewrite the three read paths as deterministic `LIMIT 1` queries;
reword to "No **successful** refresh has completed for `<date>`" — and in `f48ec8b`, which made the
settle conditional. The shape survives today: every settle carries `eq(refreshRuns.status, "running")`
(`src/jobs/refresh-run.ts:236,275`), and the constraints and index are declared in
`src/db/schema.ts:222-235`.

**The rule it yields.** Four, from one feature, because a durable run record is load-bearing in four
independent directions:

1. **Declare a constraint in the ORM schema, not only in migration SQL.** A constraint that exists only
   in hand-written SQL is invisible to the schema's own diff and snapshot, so the next generated
   migration or table rebuild silently drops it. Hand-writing it is not "belt and braces" — it is a
   constraint with an expiry date.
2. **Anchor a freshness or completeness claim on when the job *started*, not when it *finished*, and
   read the watermark *before* assembling the output.** Finish time overstates coverage: a run that
   began before a boundary may have processed early items under the old clock. Reading before assembly
   also closes the window where a run finishing mid-read forges a fresh verdict.
3. **Never settle or release a durable claim/lease unconditionally.** Gate every settle on *still
   owning the claim* (`WHERE status = 'running'`) and treat a no-op settle as lost ownership —
   otherwise a worker whose lease expired and was reaped mid-flight resurrects its own row over the run
   that replaced it.
4. **Never scan or sort an append-only table on a hot path.** Delivery, run, and audit histories only
   grow; fetch the latest/live/terminal rows with a suitable index and `LIMIT`.

**Symptom to watch for.** A status row that can be written by two workers and is guarded only at
*claim* time, not at every subsequent write; a "last successful run" query with no `LIMIT`; a
`CHECK`/unique constraint present in a `.sql` file but absent from the schema snapshot; and — the
subtlest — a health or freshness banner whose *wording* asserts a cause ("no refresh ran") that its
*computation* never actually established.

_(Reference: issue #34 / PR #79; Reviewer findings fixed in `0a98fd1` and `f48ec8b`; the four rules
were folded into Tier 1 at the HC's request during that PR. The residual data-write fencing — a reaped
run's post-reap `stat_lines`/`players` writes, and the unfenced single-player refresh — was **deferred
to #81**, not fixed here.)_

## Replace a live file with one atomic rename, and re-decide a dependency's question with the dependency's own criterion (Reference: PR #80)

**The case.** Issue #67 asked for a repeatable, testable backup/restore so data survives loss or a bad
migration. PR #80 shipped it: an in-app Snapshot (WAL-consistent online `.backup()`), a portable Player
List Backup, and a guarded **Restore** — the one operation in the application that can destroy the live
database. Two of its decisions were safety-critical and both were flagged in the PR's own
implementation notes as the places to look hardest: the swap protocol that installs the validated
candidate, and the test that decides whether a candidate's schema is compatible with this build.

**What shipped and was caught in review.** The swap sequence the PR asked the Reviewer to bless was
`checkpoint(TRUNCATE)` → move the live file and its `-wal`/`-shm` aside → rename the validated temp into
place → fsync the directory → drop the held-aside originals, with any *fault* restoring the originals.
The PR's own Stage-4 adversarial pass walked every fault stage, confirmed rollback held, and graded the
residue **Low**: a hard crash in the roughly two-syscall window between move-aside and rename leaves the
live path absent, "recoverable manually but unsignalled." It shipped in Known Limitations as accepted.

The independent Reviewer graded that same window **P1** and refused it: if the process is killed or
power is lost after the move-aside but before the install rename, `liveDbPath` is simply absent, and the
next startup — which self-heals by creating and migrating a database when none exists (ADR 0028) —
creates a *blank* one while the real data sits under `.restore-old-<pid>`. The distinction the
self-review had missed is the whole lesson: **rollback-on-fault is not the same property as the path
never being absent.** A fault the process observes is recoverable by the process; a kill is not, and a
sibling component's own self-heal then converts the gap into silent, total data loss.

The second finding (P2) is the same failure of reasoning in a different register. `src/db/pending.ts`
answered "is this restore candidate schema-compatible with this build?" by comparing the migration
**content hash**. But drizzle's `migrate()` does not decide what is pending by hash — it orders on
`folderMillis`, the journal's `when`. A candidate whose first hash matched but whose `created_at` was
newer than the build's head therefore passed the compatibility test, after which startup skipped the
remaining migrations and left the restored schema missing current columns. The check *looked*
equivalent to the dependency's and silently diverged from it.

Both were fixed in `8ef78e0`: the swap became a single `renameSync(tempInstall, liveDbPath)` over the
destination — POSIX `rename` replaces atomically, so the path is never absent — with the safety
Snapshot taken beforehand as the rollback source (`src/backup/restore.ts:259`); and compatibility now
compares `folderMillis` alongside the hash (`src/db/pending.ts:104-113`). That review returned nine
findings in total; all nine were fixed in that one commit, each with a regression test.

**The rule it yields.** Two:

1. **Never swap a live data file into place by moving the old one aside and then renaming the new one
   in.** Rename the validated replacement *over* the destination in a single step, and keep the prior
   copy elsewhere for rollback. Validate the exact, *closed* bytes you will install — never a mutable
   source that can still change after the check. And when you assess a crash window, ask what the
   *next* process to start will do with the state you left, not only what your own error handler will
   do.
2. **Never re-decide a dependency's question with a proxy signal instead of the dependency's own
   criterion.** The tool acts on the field *it* keys on. Compare the same input the dependency uses,
   or your check is an independent reimplementation that will drift.

**Symptom to watch for.** Any install or publish path with more than one rename between "old state
valid" and "new state valid"; a Known Limitation that describes a window in which the canonical path
does not exist; and a compatibility, staleness, or "already applied" check whose inputs differ from the
inputs of the tool whose behavior it is predicting.

_(Reference: issue #67 / PR #80; Reviewer P1 "keep the live database path present throughout the swap"
and P2 "compare migration timestamps as well as hashes", both fixed in `8ef78e0`. The same PR's
*interlock* facet is a testing lesson and lives in `docs/rules/testing-postmortems.md`.)_

## A raw control byte in a text source file makes its own diff unreviewable (Reference: PR #85)

**The case.** Issue #30 — Phase A of the #29 report engine — gave Players queryable tags: derived
`level:` / `pos:` / `prospect` namespaces reconciled against the roster, and a manual `status:`
namespace. Two new files carried the load-bearing logic: `src/tags/derive.ts` (the pure rule list) and
`src/tags/service.ts` (the source-scoped sync that reconciles only `source='derived'` rows). Both needed
a composite key to dedupe `{namespace, value}` pairs, and both joined the two fields with a delimiter
that cannot occur in either — a NUL. It was written as a **literal** NUL byte in the source.

**What shipped and was caught in review.** This one was caught by the PR's **own Stage-4 adversarial
self-review**, not by an external Reviewer — and *how* it surfaced is the entire lesson. git classifies
any file containing a NUL byte as **binary**, so `git diff` prints `Binary files differ` in place of the
change. The two files most in need of scrutiny were therefore invisible to the very diff read that pass
was performing. The self-review's own record of the finding says so plainly: they "read as *binary* to
git, so their diffs were unreviewable (which had also hidden them from this pass's own diff read)."

Graded Medium and fixed before the Reviewer was ever summoned: the delimiter became the six ASCII
characters `backslash u 0 0 0 0` (written without the spaces) — an identical runtime string, a plain-UTF-8 source file — plus a full-tree sweep
confirming no NUL bytes remained anywhere in the diff. The escape form is what ships today, at
`src/tags/service.ts:96` and `src/tags/derive.ts:131`.

What makes it worth an entry is the cost it would have carried. PR #85 went on to draw roughly twenty
findings across a plan critique and four Reviewer passes — including two Highs (`level:dsl`
misclassifying already-promoted players; coercing MCP id schemas accepting `[691185]` as a number) that
live in exactly these two files. Every one of those passes would have been reading `Binary files
differ`. **A reviewer who cannot see a diff does not report that they cannot see it — they report
nothing, and silence is indistinguishable from approval.**

**The rule it yields.** Never embed a raw control byte — most often a literal NUL — as a delimiter or
sentinel in a text source file. Write the code point as an escape sequence instead: identical runtime
string, plain-text source, reviewable diff. The property being protected is not aesthetic; it is that
your change remains *legible to the review process*, and a source file has that obligation to every
tool that reads it, not only to the compiler.

**Symptom to watch for.** `Binary files a/… and b/… differ` for a file you know is text; a PR where
review comments land on every file except one; an editor that mangles a file on save or a `grep` that
reports "binary file matches" instead of a line. The classic trap is precisely this one — a composite
dedup or index key that joins fields with a NUL *because* NUL cannot appear in the data.

**It has already recurred once.** PR #150 wrote a new dependency-free `src/tags/selector.ts` whose
composite dedup key again joined its fields with a literal NUL; git again classified the file binary
and, in that PR's own words, hid its diff "from every reviewer". It surfaced only because `grep` went
silent on a line `sed` could print, and it was found by the author while fixing an unrelated finding —
not by any review. Two separate pieces of work, months apart, reached for the same construct for the
same reason, and in both cases the failure concealed the code that contained it. That is what makes
this a resident Tier-1 rule rather than a footnote in one PR's history.

_(Reference: issue #30 / PR #85; finding 3 of the PR's own Stage-4 adversarial pass, graded Medium and
fixed before the Reviewer summon. The lesson was folded into Tier 1 in that same PR under the
`autonomous-fold` disposition. Recurrence: issue #140 / PR #150, `src/tags/selector.ts`, same construct,
found by the author while fixing an unrelated finding.)_

## Scope a query by relation, not by materializing an unbounded id set into IN (...) (Reference: PR #86)

**The case.** Issue #70 added named player lists so a digest, preview, or stat-line query can target a
curated subset of the Watch List, with the no-list default preserving existing behavior byte for byte.
The hazard the PR flagged for its Reviewer was *coverage*: `assembleDigest` selects players at **two**
coupled sites — the main `stat_lines ⨝ players` join, and the active-player set that feeds the
idle/zero-row tail and `seasonStartFor` — so a scope applied to one and not the other leaks non-members
into a digest that claims to be list-scoped. The first implementation resolved the list to a set of
member ids and passed that set to both sites, and to `src/queries/statLines.ts`, as `IN (...)`. It was
correct at both sites, it was covered by a test that fails if the second site is left unscoped, and it
was entirely fine at the size of one person's watch list.

**What shipped and was caught in review.** The Reviewer for this PR was **Copilot, reached as a
fallback** — the primary Codex CLI is structurally unreachable from a hosted session (it runs against
the HC's own local Codex session), so the summon returned `not_found` and the `PROJECT.md` failure
ladder moved down a rung. It graded the `IN (...)` scope **Medium**: the construct emits **one bind
parameter per id**, and SQLite's compiled parameter cap is commonly 999. The query therefore fails at
runtime for exactly the inputs that justify the feature — the large list — while every test over a
handful of rows passes; it also embeds the entire id set into the SQL text. A sibling finding caught the
same shape in `listLists`, which computed per-list member counts through an unbounded `IN (list ids)`.

Both were fixed to set-based SQL. The digest and stat-line scopes became a correlated `EXISTS` against
`list_members` keyed on `list_id` (`src/digest/assemble.ts:151`, `src/queries/statLines.ts:134`) —
constant-size regardless of membership, and an empty named list returns zero rows with no special case,
because `EXISTS` is false when there are no member rows. `listLists` became a single `LEFT JOIN` with a
`groupBy` count (`src/lists/service.ts:175-181`). The same review round found four N+1 write loops in
the list service and the backup restore path, all fixed to bulk resolve and bulk insert/delete.

**The rule it yields.** Never scope a query by materializing a set of ids and passing them to an
`IN (...)` list when the set size is unbounded. Scope with a correlated `EXISTS`/join keyed on the
relation instead: it stays constant-size regardless of set size, keeps the id set out of the SQL text,
and handles the empty set correctly with no special case. The set-based form is not merely faster — it
is the one that does not have a cliff.

**Symptom to watch for.** A `.map(r => r.id)` feeding an `inArray(...)`; any query whose bind-parameter
count is a function of its *input* rather than of its *text*; a scope only ever exercised against a
handful of rows in tests. "The set is small in practice" is a claim about today's data, not about the
query — and the failure mode when it stops being true is a hard runtime error, not a slow query.

_(Reference: issue #70 / PR #86; Reviewer finding "`IN(memberIds)` risks SQLite's ~999-param cap" and
its `listLists` sibling, both fixed in that PR, which also folded the lesson into Tier 1. The Reviewer
was Copilot as fallback, the primary Codex summon having failed `not_found` from a hosted session.)_

## A green verdict must not sit over data a consumer dropped because the filter itself could not be evaluated (Reference: PR #92)

**The case.** Issue #23 asked the Refresh sweep to stop aborting the whole run on the first calendar or
per-player error. PR #92 delivered collect-and-continue with a per-phase boundary and a pure
`deriveRefreshStatus` truth table settling `ok` / `partial` / `failed`. The subtlety is that the run's
terminal status is not merely a log line — the daily Digest *gates* on it: an `ok` run produces a `fresh`
watermark, and a `fresh` watermark suppresses the staleness banner. So the status is a claim made on the
consumer's behalf about data the consumer has not yet read.

**What shipped and was caught in review.** The first implementation treated calendar-fetch failures as
never affecting the terminal status: players had refreshed, so the run settled `ok`. The independent
Reviewer graded that **P1** and traced the whole path: when a watched level has no usable current-season
calendar — the first run of a new year, say — and that sport's `getSeason` request fails while player
requests succeed, the run settles `ok` and `digestFreshnessFor` reports `fresh`. But `assembleDigest`
gates idle players through `isInSeason`, and `isInSeason` **does not fail open** when no calendar row
exists: it returns false. Players with no game that day were therefore silently omitted from a digest
carrying no freshness warning at all. The finding was verified against `assemble.ts` and `season.ts`
before being accepted, rather than taken on the Reviewer's word.

Two delta reviews then caught the fix's own weaker forms, and both are the real lesson:

- **Present is not the same as usable (Δ1-a, High).** The first fix asked whether a cached calendar row
  *existed*. A row with null dates exists and is still unusable by `isInSeason` — the same silent drop,
  now behind a check that looked satisfied. Fixed by extracting `calendarHasUsableDates` into
  `src/domain/season.ts` and having *both* the consumer's predicate and the verdict's check call it, so
  the two cannot drift.
- **The verdict must be judged against the state the consumer will read (Δ1-b, High).** The watched-sport
  set was taken from the *pre*-refresh snapshot, but a call-up or demotion during the run moves which
  level a player reads from — so the run could clear a calendar it no longer depended on and miss one it
  now did. Fixed by computing the block at settle time from post-refresh players and final calendars.

A later fold round added a third correction: as first written the Tier-1 rule said *every* filter's
missing prerequisite downgrades the verdict, which is too coarse — an out-of-season player is
*legitimately* excluded and the run is honestly `ok`. Only a filter that **cannot be evaluated**
downgrades. Fixed across `004179c`, `c7fedaa`, and `7febd66`.

**The rule it yields.** When a job records a status that a consumer gates on, distinguish a filter that
*legitimately* excludes data from one that *cannot be evaluated* because its required input is absent or
present-but-unusable — and let only the latter downgrade the verdict. Judge it against the same inputs
the consumer reads: the **post-mutation** state, and a **usable** input rather than merely a present one.
Share the predicate with the consumer instead of reimplementing it, or the two definitions of "usable"
drift and the drift is invisible.

**Symptom to watch for.** A health, freshness, or completeness status computed from what the *producer*
did rather than from what the *consumer* will be able to do with the result; an existence check
(`if (row)`) standing in for a validity check; a status derived from state captured before the work
rather than after it. The signature failure is a green verdict over a quietly short result set — nothing
errors, nothing warns, there is simply less data than there should be.

_(Reference: issue #23 / PR #92; Reviewer P1 plus delta findings Δ1-a and Δ1-b, fixed in `004179c` and
`c7fedaa`; the Tier-1 rule was rescoped from "every filter" to unevaluable filters in `7febd66` after a
further Reviewer round. The shared predicate is `calendarHasUsableDates` in `src/domain/season.ts`.)_

## A central error handler is not proof that a route's thrown error reaches it (Reference: PR #150)

**The case.** Issue #140 connected the tag axis to the report surface — `digest --tags
level:aaa,status:rostered`. A malformed selector had to return a 400 from the REST digest routes, so the
first implementation did the obvious, framework-idiomatic thing: throw the `ZodError` and let the app's
central `api.onError` map it to a 400, exactly as every other route in the app relies on.

**What shipped and was caught in review.** It did not work, and the reason is that Hono's dispatch
differs by **route shape**. In this same application a synchronous throw reaches the central handler, and
so does a throw from a route carrying a param or middleware — but a rejection raised **past the first
`await`** in a static, middleware-less route does not. The typed boundary error escaped as an unhandled
500-class throw instead of the 4xx it owed the caller. It was caught by the PR's new sad-path REST
tests; every happy-path test stayed green throughout, because nothing about the success path changes.

The part that earns this an entry: **the repository had already discovered this.** The quirk was
documented in a comment on `GET /players` in `routes.ts` months earlier, by the work that first hit it.
That comment did not stop a second route from being written against the same false assumption, because a
comment on one route is a note about that route — it is not a rule, it is not resident, and nobody reads
it while writing a different handler. The fix shapes the 400 locally at both digest routes, the pattern
already established in-repo, and resolves the selector *before* the list lookup so nothing is read on
malformed input.

**The rule it yields.** Never assume a framework's central error handler catches every route's thrown
error. Prove the mapping with a sad-path test **per route**, not once per error type, and shape the
response at the call site wherever the central handler does not reach. The generalization beyond this one
framework quirk: a behavior that varies by *route shape*, *call shape*, or *dispatch path* is not
established by testing it once — the unit of proof is the shape, not the error. And when you find such a
quirk, a comment where you found it will not prevent the next occurrence; it has to become a rule
somewhere always-resident.

**Symptom to watch for.** A sad path that returns 500 where the code plainly throws a typed 4xx error; a
handler that works on one route and not its sibling; an error-mapping test suite organized by *error
type* with one representative route each, rather than by route. And, at the process level: a code comment
describing a footgun, written by someone who already paid for it, sitting next to code that is not the
code you are about to write.

_(Reference: issue #140 / PR #150; found by the PR's own new REST sad-path tests after the first
implementation relied on `api.onError`. The quirk was already commented on `GET /players` in
`src/api/routes.ts` from an earlier encounter; the second rediscovery is what promoted it to Tier 1
under the `autonomous-fold` disposition.)_
