# Lane digests are claimed sends, driven by one tick, gated on per-lane coverage

**Status:** accepted

**Supersedes:** [ADR 0046](0046-named-player-lists-scoped-digests.md) decision 4 (*a named-list send is
on-demand only*).

**Amends:** [ADR 0061](0061-lane-scoped-refresh-supersedes-whole-sweep.md) decision 8 (*coverage is
recorded whole-list or not at all*) and the `scope_list_ids` column's own "provenance that nothing
parses back" contract.

**Affirms:** [ADR 0059](0059-explicit-default-lane-supersedes-implicit-default.md) *Amendment (#191)*
(*the heartbeat is host-level*), and delivers that amendment's promised per-lane owed view.

A **Lane's daily digest is a claimed send** — on every surface, not just the scheduler's — and **one
15-minute tick** replaces the two fixed launchd agents. Bare `sk digest` therefore assembles the
**default lane's** members rather than the whole Watch List, and the freshness banner asks a **per-lane**
coverage question answered from `refresh_runs.scope_list_ids`.

Concretely ([issue #193](https://github.com/wrburgess/bryce/issues/193), phase 4 of the
[#189](https://github.com/wrburgess/bryce/issues/189) epic):

- `runDigest` routes a tag-free `1d` send onto the **claimed** path whether or not it names a lane, and
  resolves the lane by id (`listById`) or as the default.
- `latestCoveringRun(db, laneId | null)` (`src/jobs/refresh-run.ts`) is the one place the coverage
  predicate is authored; `digestFreshnessFor` and the tick's refresh clock both read it.
- `src/jobs/tick.ts` + `sk tick` + `ops/templates/com.sk.tick.plist` (`StartInterval` 900) replace
  `com.sk.refresh.plist` (03:30) and `com.sk.digest.plist` (05:00).
- `HealthSnapshot` gains an additive `lanes` array.

## Why this was asked

#191 gave a Lane three configuration columns — `refresh_interval_minutes`, `digest_hour`, `digest_to` —
and shipped them **inert**. #192 made the first one real. This phase owes the other two, and the moment
you try to pay that debt three things turn out to be the same debt.

A `digest_hour` is a promise that *this lane* sends at *that hour*, which needs a scheduler that reads
the database rather than a plist that reads a clock. A scheduler that runs a lane's digest needs that
digest to be **de-duplicated** — four ticks an hour against an on-demand send would mail four copies —
which needs the claim. And a claimed lane digest reports **that lane's** players, which makes a
freshness banner judged on whole-Watch-List coverage permanently `stale` on any host whose default lane
is not everybody.

So the alternative to doing all three was doing none of them.

## Decisions

1. **A tag-free `1d` named-lane send is a CLAIMED lane send, on every surface.** This reverses
   [ADR 0046](0046-named-player-lists-scoped-digests.md) decision 4 at the **semantic** level, not
   per-surface: CLI, MCP `send_digest`, and `POST /api/digest/send` all route the same way, because a
   contract that holds on one surface and not another is not a contract.

   ADR 0046 decision 4's reason was exact and is now gone. The delivery slot was keyed
   `(kind, date_covered)` with **no list dimension**, so two lanes sending on one date would have fought
   over one slot — a 7d request refused because the day's 1d report went out, a failed attempt silently
   settled by the wrong content. #190 added `list_id` to that key. The reason expired; the routing
   outlived it, and this ADR retires it.

   Note what is *not* superseded from ADR 0046: decision 1 was already superseded by
   [ADR 0059](0059-explicit-default-lane-supersedes-implicit-default.md), decision 2's refresh half by
   [ADR 0061](0061-lane-scoped-refresh-supersedes-whole-sweep.md), and decision 2's
   `players.active`-master-gate half **stands** unchanged. A tag scope and every non-`1d` window stay
   on-demand for ADR 0046 decision 4's *original* reason, which still applies to them: the slot key has
   no tag dimension and no window dimension, and it is not getting one.

   The visible consequences are deliberate and documented on all three surfaces: a second same-day send
   for one lane is refused `already-sent-today` (`force` is the deliberate re-send), a failed lane send
   is retried, yesterday's orphaned slot is recovered, and the send goes to the lane's own recipients.

2. **`scope_list_ids` becomes a QUERYABLE COVERAGE RECORD, read by exactly one exported helper.** This
   amends [ADR 0061](0061-lane-scoped-refresh-supersedes-whole-sweep.md) decision 8 and the column's own
   documented contract, which at the end of #192 said the value was provenance that nothing parses back.

   It is the plan's one genuinely contestable call, so state the alternative plainly: a `last_refresh_at`
   column on `player_lists`, plus a migration, plus a second write path in `runRefresh`. That buys
   avoiding a `LIKE`. It costs **two sources of truth for coverage** that must be kept in step by hand,
   in a subsystem whose entire #192 loop-back was about two reads disagreeing. One column, one predicate,
   one helper is the cheaper correctness.

   The fenced encoding is what makes it exact. `,1,3,` matched by `LIKE '%,1,%'` is containment; the
   sentinel commas are why lane **11**'s sweep does not read as covering lane **1**. That was the
   prefix trap #192 closed and #193 re-opens the need for, so the encoding's own doc comment now says so
   in the present tense and a test pins the `1` vs `11` pair.

   Two callers share the predicate: the digest's freshness banner and the tick's refresh clock.
   Re-authoring the `LIKE` at either is how the fencing quietly stops matching at one of them.

   **Naming a lane is not covering its members** (added in review of
   [PR #203](https://github.com/wrburgess/bryce/pull/203)). A scoped run records the lane ID and *not the
   players it selected*, so the containment test alone is **identity one level down** — the very thing
   ADR 0061 decision 8 refused. Enroll an active Player in lane L after L's sweep began and the run still
   names L, while `assembleDigest` now reports a player whose stats were never fetched: a forged `fresh`,
   arrived at by a different route. So a **scoped** run covers L only while **no current active member of
   L joined at or after that run's `started_at`** — a correlated `EXISTS` over `list_members` in the same
   predicate. `players.active` stays the master gate (ADR 0046 decision 2) and the test reproduces the
   sweep's own selection predicate, so an *inactive* enrollee is not a gap — re-activating him is.

   **`started_at` is the SELECTION watermark, not the claim instant** (added in the delta review of PR
   #203, superseding this decision's first disclosure). That disclosure said the selection snapshot is
   taken "at (in fact just before) the claim", treating the difference as an instant. It is not an
   instant: `runRefresh` selects its players, **loads the calendars**, and only then claims — several
   database reads. Anchoring coverage on the claim dates every enrollment made inside that gap as *older*
   than the run, so the membership test reads it as a member the selection already saw while
   `activePlayers` — fixed before the selection returned and never refreshed — never fetched him. The
   forged `fresh` this decision exists to prevent, re-entered through the run's own clock. So `runRefresh`
   reads its clock **immediately before the selection query** and passes that instant to
   `claimRefreshRun`, which records it as `started_at`; `claimed_at` remains the claim instant and is the
   only column any lease decision may read. `started_at <= claimed_at` from here on, and `>=` in the
   membership test is still the rejecting side, now because the watermark is read just before the query
   whose snapshot it stands for.

   **No data migration**, and this paragraph first said "no migration" outright: the column's *meaning* is
   narrowed, not its type, and moving a run's recorded start **earlier** is conservative in every reader.
   `digestFreshnessFor` requires the start's host date to be strictly after the content date, so an
   earlier start can only weaken a freshness claim; the tick's `refreshIsDue` anchors on it, so an earlier
   anchor makes the next sweep due *sooner*. Historical rows, whose `started_at` is a claim instant, keep
   reading exactly as they did.

   **But the ORDERING it creates does need one** (added later in the same delta review, superseding the
   flat "no migration" above). `started_at <= claimed_at` went from a tautology — one `nowIso` string
   written to both columns — to a load-bearing invariant the moment the two became different instants:
   coverage is judged against `started_at`, the lease against `claimed_at`, and an inverted row would date
   every enrollment made inside a run's own selection-to-claim gap as already swept. `rules/backend.md`
   requires such an invariant in the **database, declared in the ORM schema**, so it joins the eight CHECKs
   `refresh_runs` already carries in `src/db/schema.ts`. SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so
   applying it to an existing database is a table rebuild — **`drizzle/0014`**, the same shape `drizzle/0011`
   used on this table, and the migration this decision previously said was unnecessary. It is still not a
   *data* migration: every existing row was written with the two columns equal, which `<=` admits, and
   `renewRefreshRun` only ever moves `claimed_at` forward, so nothing is rewritten and no row is at risk.

   One reader did have to move with it: `refreshHealth` ranks runs to find "the latest", and watermark
   order and claim order stopped agreeing the moment a run could select before it claims. It now orders
   by `id` — the durable generation the claim transaction already serializes, and what
   `admitTargetedRefresh` fences on — so a live sweep can never be ranked below a settled predecessor that
   happened to select later. `latestCoveringRun` keeps the `(started_at, id)` ordering, because it asks a
   different question: not which run is newest, but which provable coverage claim is strongest.

   The membership test is deliberately **scoped to scoped runs**. A whole-list run (`scope_list_ids IS
   NULL`) swept every *then-active* Player, and its claim is about players rather than lanes: moving one
   of them onto a lane afterwards changes no fact about what it fetched, and rejecting there would
   retighten pre-existing #192 behavior — flipping every lane's banner to `stale` on a host that never
   scopes a sweep. The degradation is conservative by construction: it can only demote a claim, never
   manufacture one, and it self-heals, because the tick reads the lane as due and the next sweep starts
   after the join.

3. **One 15-minute tick replaces the two fixed agents; due-selection is advisory and the claim is the
   gate.** A lane's cadence lives in a database column the HC edits with `sk players lists configure`. A
   `StartCalendarInterval` cannot read that column, and a plist per lane would put the schedule in two
   places that drift. `StartInterval` 900 can, and does.

   The plist is where that cadence is **authored**, and `TICK_PERIOD_MS` (`src/jobs/tick.ts`) is **sized
   from** it — which was itself two places holding one idea until the operational-templates gate
   (`scripts/check-operational-templates.ts`) was made to assert they agree, naming both sources in the
   failure (added in review of [PR #203](https://github.com/wrburgess/bryce/pull/203)). Edit the plist to
   30 minutes without the constant and `REFRESH_DUE_TOLERANCE_MS` stays sized for 15, silently.

   Everything the tick decides — has the interval elapsed, has the hour arrived, is today's slot already
   `sent` — is a **cheap pre-read whose only job is to keep a quiet tick quiet**. Correctness rests
   entirely on `claimDelivery` (ADR 0034) and `claimRefreshRun` (ADR 0043) underneath. That is what makes
   the manual ops migration safe: while an operator has not yet unloaded the old agents, the tick and
   `com.sk.digest` contend for the same slot and the second claimant is refused. It is also why the
   design tolerates a hour test of `>=` rather than `==` (a laptop asleep at 05:00 must still send on
   wake) — the `sent` row, not the hour, is what stops the re-send.

   A **`failed` slot reads as due**, so a lane whose send failed at 05:00 is retried at 05:15 rather than
   waiting for tomorrow's orphan recovery. Against a mailer that stays broken that is roughly four
   attempts an hour: bounded, visible in `logs/tick.log` and in the `lanes` health view, and accepted for
   a single-user host.

   **Failure is isolated per stage and per lane.** A sweep that throws still leaves every due digest
   attempted; one lane's throw still leaves the lanes after it attempted. A tick that abandoned its
   remaining work on the first fault would turn one broken lane into a silent host-wide outage, ~96 times
   a day. Exit is 1 if anything errored — *after* all due work was attempted.

   **The tick freezes a clock for its DECISIONS and passes a LIVE one to the sweep.** Due-selection, the
   host hour, and the slot date read one frozen instant, so a tick straddling an hour boundary cannot
   decide a lane is due against one hour and claim its slot against another. `runRefresh` is handed
   `deps.now` unfrozen, because it renews a *lease* per player (`renewRefreshRun`,
   [ADR 0043](0043-persist-refresh-freshness-and-gate-digest.md) fencing): a frozen clock re-writes the tick's start
   as `claimed_at` forever, so any sweep outliving the 10-minute lease is reaped `failed` (superseded) by
   the next tick and aborts mid-flight — ~4 times an hour, permanently, with no covering run ever recorded.
   `runDigest` re-freezes its own anchor internally, so it is safe with either and is given the frozen one
   for slot/date agreement.

   **Due-ness carries a tolerance of HALF A TICK PERIOD**, and the anchor stays the previous sweep's actual
   `started_at`. `StartInterval` is approximate — launchd fires late and restarts its countdown across
   sleep/wake — so each sweep records the tick's own lateness; with an exact boundary that lateness is
   permanent *and* cumulative, sliding the sweep a full tick per jittered day in one direction only. Under
   the seeded configuration (1440 minutes, `digest_hour` 5) the 03:30 sweep has ~90 minutes of headroom, so
   ~6 jittered days puts it *after* the digest and every digest from then on banners `stale` over day-old
   data. Half a period is the largest tolerance that cannot compress the scheduled cadence: a lane may be
   swept at most half a tick early, which is still the tick that would have swept it. Anchoring on the
   previous *due boundary* instead was rejected — nothing stores a boundary, so it would have to be
   back-computed from a configuration value the HC may have changed since.

4. **The heartbeat stays host-level, and only the UNSCOPED invocation substitutes it.** This affirms
   [ADR 0059](0059-explicit-default-lane-supersedes-implicit-default.md)'s *Amendment (#191)*. A heartbeat
   proves the **host** is alive; letting each scheduled lane substitute one would multiply offseason mail
   by the lane count and add no signal. So a lane invoked **by name** during Offseason Sleep skips
   **today's** digest (`reason: offseason-sleep`), and the tick's own unscoped invocation carries the
   signal. The row it writes still rides the default lane's slot, still because `list_id` is `NOT NULL` —
   the same recorded wart, unchanged.

   **Sleep suspends today's digest, never RECOVERY.** "Skipped, no claim" would be false and was: orphan
   recovery runs *above* the sleep branch inside `runDigest`, so a scoped invocation whose lane still owes
   an earlier day claims and mails that day first. That is deliberate —
   [ADR 0034](0034-digest-delivery-claim-at-least-once.md)'s recovery guarantee must not lapse for the
   length of an offseason, and a digest that failed on the season's *last* day is only ever recoverable
   while asleep. The tick therefore gives each **scheduled** lane its recovery opportunity while sleeping,
   gated on the job's own `findOrphanedDigestDate` pre-read so a quiet tick stays quiet, and bounded by the
   same one-catch-up-per-invocation rule. Left to the unscoped heartbeat alone, the default lane's drain
   rate would fall from daily to weekly and every other scheduled lane would get *zero* recovery until
   Opening Day.

5. **An ADDITIVE per-lane delivery view, keyed on LANES rather than on delivery rows.** This delivers
   ADR 0059 amendment 2's owed view. The host-wide `lastDelivery` field is untouched and stays
   byte-identical: it answers "is the host delivering at all?", which is a real question with a real
   published contract, and narrowing it would silently change that contract for every consumer.

   Keying on lanes is what makes the three states distinguishable **by construction** rather than by
   convention: a view built from delivery rows structurally cannot report a lane that has never produced
   one, and that is the case most worth seeing. `digestHour: null` is *not scheduled* (healthy by
   configuration); scheduled with no delivery is *never delivered*; scheduled with a stale one is the
   *dead lane*.

   Its ordering is the **same rule the host-wide field uses**, and now literally the same code: one
   exported `deliveryRecencyOrder()` helper spread into both `orderBy` calls — `coalesce(sent_at,
   created_at)`, then `created_at`, then `id`, all descending. Two authorings had already drifted (the
   host-wide field lacked the `id` tiebreak), so rows stamped in the same whole second made /health name a
   different "last" delivery on each surface; the fix is the same shape `latestCoveringRun` uses for the
   coverage predicate. **All statuses are included deliberately**: a newest
   `failed` or in-flight `sending` row *is* the lane's current state and supersedes an older `sent` one.
   Reporting the last *success* instead would hide exactly the signal. `kind = 'digest'` only: a
   heartbeat would forge weekly liveness for the default lane and for no other.

6. **A claimed send goes to `digest_to ?? DIGEST_TO`; an on-demand report keeps the host recipients.**
   The split follows who asked. A lane's scheduled daily digest is *for the lane*, which is what the
   `digest_to` column was added to express and exactly what its NULL has always been documented to mean.
   An explicit `sk digest -w 7d --list Prospects` is a question a person asked from a terminal, and
   answering it into a lane's subscriber list would mail the operator's ad-hoc query to other people.

7. **The ops migration is a runbook step; `bin/setup` stays launchd-free.** This is a conscious re-scope
   of the issue text, declared in the assessment. `bin/setup` is the business-neutral Config-Bundle
   installer, and launchd agents have always been copied and loaded by the operator
   (`docs/guides/running-bryce.md`) — a setup script that reached into `~/Library/LaunchAgents` would be
   both a new responsibility and a host-specific one in a file that has neither.

   The enforcement that *is* automated is the part a runbook cannot do: the retired templates are
   asserted **absent** by `scripts/check-operational-templates.ts`, so a stale copy re-added by a bad
   merge fails the gate rather than shipping. And decision 3's claim safety is what makes the
   hand-migration window harmless in either order.

## Consequences

- **Published contracts change.** MCP/REST named-list 1d sends become claimed: a second same-day call
  returns `already-sent-today`. Prose, docs, and pinned tests move in this same change.
- **Bare `sk digest` narrows** from the whole Watch List to the default lane. Behavior-preserving on any
  migrated host — `drizzle/0012` enrolled every active Player in the seeded default lane — and it is the
  endpoint `src/jobs/digest.ts` has promised in a comment since #190.
- **[#202](https://github.com/wrburgess/bryce/issues/202) (orphan Players) gets more visible.** A Player
  on no lane is now neither refreshed (#192) nor digested (this phase). Out of scope here; decision 5's
  view is the observability seam, and a test pins the narrowing with a cross-reference so the behavior is
  recorded rather than discovered.
- **Tick log volume** is ~96 quiet lines a day into `logs/tick.log`. Rotation remains out of scope, as it
  already is for `backup.log`; the runbook names the path.
- **Deleted-lane liveness is enforced inside the claim**, via a new un-forceable `requirement` hook
  beside the existing `precondition`. The distinction is load-bearing: `force` overrides de-duplication
  bookkeeping and must never override a fact about the world the mail would be addressed to.
- **A deleted lane's abandoned claim is settled by the tick, never mailed.** The un-forceable requirement
  has a corollary: a row left `sending` when its lane is soft-deleted can never be re-claimed, and nothing
  invokes a digest for a lane `liveLists` no longer returns — so it would sit in flight forever and could
  still surface as the host-wide `lastDelivery`. `reapDeadLaneClaims` settles such a row `failed` with a
  stated reason, touching only `sending` rows whose lease has EXPIRED. It cannot live in `lists delete`:
  at delete time the run may hold a live claim and be at the provider right now, and only a periodic job
  can wait a lease out.
