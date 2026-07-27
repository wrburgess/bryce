# Testing — Postmortems (Tier 2)

Deferred deep doc for the Tier-1 rule [`rules/testing.md`](../../rules/testing.md). Heavy,
subsystem-specific case studies for the test suite and its tooling — **not** auto-loaded; read on
demand when the trigger in [`docs/rules/README.md`](README.md) fires (working in tests). Each entry
ends with a `(Reference: #NNNN)` pointer to the issue/PR that produced it.

## Prove a cross-process invariant with a real spawned process, never a second in-process handle (Reference: PR #80)

**The case.** Issue #67 / PR #80 added a guarded **Restore** — the one operation that can destroy the
live database — behind an interlock in `src/db/lock.ts`. The plan called for a single exclusive
lockfile; the implementation deviated to a cooperative multi-holder presence registry, because an
exclusive lifetime lock would forbid the server + launchd concurrency ADR 0034 mandates. The invariant
that had to hold was therefore genuinely cross-process: *Restore refuses while any live foreign opener
is registered, and an opener starting mid-restore is refused.*

**What shipped and was caught in review.** The second-model Reviewer's finding #1 (High) was that the
restore lock did not exclude *later* DB openers — a TOCTOU window between checking and holding. The fix
was two-flag mutual exclusion (an exclusive restore marker and opener presence, each published before
checking the other). What makes this a testing postmortem rather than a locking one is *how* it had to
be proved: a second connection opened inside the test process shares the runtime's locks, caches, and
file descriptors, so it can be admitted (or refused) for reasons that have nothing to do with the
interlock. The suite grew a real harness instead — `test/helpers/lock-holder.ts`, a genuine second
process spawned with `tsx` that takes the **real** opener path (`acquireOpenLock`), prints
`HELD pid=…` when it holds and `REJECTED …` when the interlock turns it away. The tests spawn it in
**both directions** (opener-then-restore, restore-then-opener) and, critically, the test **closes its
own database handle first**, so the spawned process is the sole holder and the pass cannot be
self-referential. Stale holders self-heal via `process.kill(pid, 0)`, so a crashed process cannot wedge
Restore forever — also proved with a real spawn.

**The rule it yields.** A concurrency invariant that spans processes must be proved *across processes*.
Build the harness — a spawned holder, a subprocess CLI round-trip — and treat "this can't be tested"
as a research task, not a conclusion. When the harness is in place, remove the in-process shortcut that
could accidentally satisfy the assertion: close your own handle, so the thing under test is the only
participant.

**Symptom to watch for.** A concurrency test that passes on the first try, uses only objects the test
itself constructed, and would still pass if the lock were deleted — especially one where the test
process is itself one of the "competing" parties.

_(Reference: issue #67 / PR #80; Reviewer finding #1, fixed in `8ef78e0`; harness in
`test/helpers/lock-holder.ts`, exercised by `test/backup-lock.test.ts`. The lesson was folded into
Tier 1 in `c770b3a`.)_

## Enforce the offline invariant in the harness, and re-validate every "allowed" host (Reference: PR #90)

**The case.** `vitest.config.ts` had long *declared* that tests must never hit the network, but the
declaration was a comment: the suite was offline by convention only. Any test that forgot dependency
injection could construct a default MLB, NCAA, Postmark, or SMTP client and egress for real — flakiness,
rate limits, actual email. Issue #25 / PR #90 replaced the convention with a fail-closed guard
(`test/support/network-guard.ts`, wired through `test/support/network-setup.ts` in the config's
`setupFiles`) that patches both in-process egress surfaces — `globalThis.fetch` and
`net.connect`/`net.createConnection`/`net.Socket.prototype.connect`/`tls.connect` — allows loopback,
and both **throws** on a non-loopback attempt **and records** it as a redacted `{ surface, host, port }`
attempt. The recorded buffer is the half that defeats a provider's fail-open `catch`: a teardown
assertion fails the owning test even when the throw was swallowed.

**What shipped and was caught in review.** The guard passed its own suite and still had two holes, both
found by the independent second-model Reviewer, both in the definition of "allowed":

- **P1 (High)** — loopback was recognized by the *textual* prefix `127.`, so `127.attacker.com` — a
  perfectly valid DNS name that can resolve anywhere — was treated as loopback and passed through
  **without throwing and without recording**, on both surfaces. The fix requires a genuine IPv4 literal
  (`net.isIP(host) === 4`), applied to the `::ffff:127.x` mapped tail too.
- **P2 (Medium)** — `net.connect` accepts a caller-supplied `lookup`. For an *allowed name* such as
  `localhost`, a custom resolver could return a public address that Node then dials directly, never
  re-entering the wrapper, leaving the attempts buffer empty. The fix wraps the resolver and
  re-validates every returned address; a non-loopback result is recorded (by resolved IP, never by
  name) and the connect fails.

Both were fixed in `2ddd592` with seven proving canaries. The guard's honest scope is stated in its own
header: in-process `fetch` + TCP/TLS only — child processes do not inherit `setupFiles`, and UDP is out
of scope.

**The rule it yields.** An invariant the suite *claims* belongs in the harness, enforced fail-closed,
not in a comment or a code-review habit. And when the enforcement has an allow-list, the allow decision
is itself attack surface: validate the *resolved address*, not a string that looks like one, and
re-validate anything a caller can influence. Record every blocked attempt as well as throwing, because
a fail-open `catch` downstream can swallow an exception but cannot erase a record.

**Symptom to watch for.** A guard whose tests only exercise the obvious deny path (`https://example.com`
blocked ✓) and never the *allow* path's edges — a hostname that merely starts like a loopback literal,
a caller-supplied resolver, an internal redirect that connects below the wrapper you patched.

_(Reference: issue #25 / PR #90 (merged `5a7b505`); Reviewer findings P1/P2 fixed in `2ddd592`; must-fix
MF1 (teardown assertion + `takeAttempts()`), MF2 (scope honesty) and MF7 (redacted record shape) from
the same review.)_

## A gate is its checker plus its call site — pin both (Reference: PR #138)

**The case.** Issue #28 / PR #138 added per-file coverage floors: a `FLOORS` manifest and a pure
`evaluate()` in `scripts/coverage-floors.ts`, run after the suite against the
`coverage/coverage-summary.json` the run **actually produced**. That "produced report" framing was
itself deliberate — a threshold declared in config is compared only against the files its glob matched,
so a glob that matches nothing passes silently; anchoring on the emitted summary means a floored path
that goes *missing* (renamed, newly excluded, dropped by a narrowed `include`) fails exactly like one
that dipped below its number.

**What shipped and was caught in review.** The PR opened with 37 passing tests over the checker — and
its own Stage-4 adversarial pass found that the checker had no *caller* under test. `test:coverage`
(`vitest run --coverage && tsx scripts/coverage-floors.ts`) was the only thing invoking it, and nothing
asserted that. Deleting the `&& tsx scripts/coverage-floors.ts` clause — or reverting CI's `Test` step
to plain `npm test` — would have left all 37 tests, typecheck, lint, parity **and CI** green while every
floor went unenforced, killing the local gate and CI in one edit. Graded High and fixed by asserting
both call sites against the real `package.json` and the real `.github/workflows/app.yml`. The same
review round also caught a *false diagnosis* mode (a filtered run enumerates every `src/` file at 0%,
so the gate went red blaming seven files that never regressed) and a floor granting a point of unearned
slack. The file finished at 60 tests.

**The rule it yields.** Testing a gate's logic proves the logic. It does not prove the gate *runs*. Pin
the invocation against the real manifest and the real workflow file, with the same rigor as the logic —
otherwise the gate is one silent line-edit from being decorative. The corollary: when a diagnostic can
be wrong, prefer the direction that announces itself. A false red costs someone five minutes; a false
green costs the whole gate.

**Symptom to watch for.** A checker with a rich test file and no test naming the npm script or CI step
that calls it; a green pipeline after a one-line edit to a `&&` chain; a gate whose failure output
blames files nobody touched.

_(Reference: issue #28 / PR #138 (merged `02a19cc`); the unpinned-caller finding came from the PR's own
Stage-4 adversarial pass, fixed in `ae785fb`; call sites asserted in
`test/tooling/coverage-floors.test.ts`. The lesson was folded into Tier 1 in `e74ccf5`.)_

## A fixture's exclusion filter must not be able to match the copy root itself (Reference: PR #147)

**The case.** `test/tooling/parity-attribution.test.ts` built its fixture by copying the repository
into a tmpdir with a `cpSync` filter that rejected any source path *containing* `node_modules`,
`.git`, or `.claude/worktrees`. The intent was right — nested agent worktrees are runtime state, not
bundle content. The matching was not: when the checkout is itself `{repo}/.claude/worktrees/{name}/`,
**every** source path contains that segment, so the filter rejected everything, the destination came
back empty, and the test died on `ENOENT … PROJECT.md` six lines later, in an assertion that had
nothing to do with the cause.

**What shipped and was caught in review.** It shipped green and stayed green in CI for its whole life,
because `ubuntu-latest` checks out to a path with no such segment — while failing for **every** agent
working in a worktree, which is this repo's normal lifecycle mode. Issue #139 / PR #147 replaced the
copier with the one its sibling `parity-human-gates.test.ts` had already proved out, extracted to
`test/tooling/parity-fixture.ts`: an explicit entry list plus a filter that rejects
`join(sourceRoot, ".claude", "worktrees")` by **absolute equality**, which cannot match the copy root at
any path depth. `copyBundle` also became loud in both directions — a copy that lands no `PROJECT.md`
throws a named error, and a requested entry the source lacks throws `ENOENT` rather than being skipped
into a quietly incomplete fixture. The PR's own Stage-4 adversarial pass then caught a second defect it
had just armed: the fixture's dead-link healer builds its write path from *file content*, so a link
climbing out of the bundle would have written stubs outside the throwaway copy, into the real
filesystem. Stub creation is now contained to the copy root.

**The rule it yields.** Two, from one bug. First: an exclusion expressed as a substring test on an
absolute path will eventually match the root it is filtering *from* — compare the excluded directory by
absolute equality, or match the path relative to the copy root, and make the copier throw when the
result is unusable rather than handing back an empty tree. Second: a test whose result depends on
*where the checkout lives* proves nothing anywhere. Build each path shape inside the test — the
regression suite plants a source root under `.claude/worktrees/` and an ordinary one, so it covers both
from a worktree, from the primary checkout, and in CI alike.

**Symptom to watch for.** A test that is red for agents and green in CI (or vice versa); a missing-file
error naming a file nobody deleted; any filter written as `path.includes("some/segment")`.

_(Reference: issue #139 / PR #147 (merged `8852524`); the empty-copy failure reproduced on every
revision from a worktree, the containment fix landed in `8cba06b`, and the regression cases live in
`test/tooling/parity-fixture.test.ts`.)_

## Generated coverage and real coverage answer different questions — and neither is a mutation test (Reference: PR #162)

**The case.** Issue #159 / PR #162 replaced a hand-rolled markdown code-masker with a CommonMark parse
(see `docs/rules/scripting-postmortems.md` and ADR 0054 for the guard-design half of that story). The
*testing* half is how the broken masker kept being pronounced correct. Its evidence was a differential
fuzzer: generate a synthetic markdown document, run the masker's link extraction and the CommonMark
reference parser's over it, diff the results. That harness was genuinely good — it falsified four
successive bounds, including one whose reasoning was locally airtight (removing candidates from a
run-length pairing search can make it match strictly *more*, in 373 of 4,000 cases). The failures below
are not the fuzzer's; they are what was claimed *on top of* it.

**What shipped and was caught in review.** Three things, each a green signal that measured something
other than what was asserted.

- **A synthetic corpus stood in for the real one.** The claim "no checked file contains a multi-line code
  span" — load-bearing, because the surviving line-bounded design was correct only if that held — rested
  on **33,000 green synthetic documents**. It was never run over the 39 files actually in scope. Two of
  them, `docs/api/README.md` and `docs/mcp/README.md`, wrap a JSON example across a line break inside one
  code span, and both mis-paired. The generator answered *is the masker consistent with the parser on
  documents shaped like the ones I emit*; nobody had asked *is it correct on ours*.
- **Load-bearing guards had no failing test without them.** Twice, a branch the implementation depended
  on could have been deleted with the suite still green. A test suite that passes with the guard removed
  is not evidence about the guard.
- **A fuzz run reported clean against a revision already known to be broken.** The harness, not the
  masker, was what that run measured — and it went unnoticed until someone deliberately re-broke the code
  and the numbers did not move.

**The rule it yields.** Two, and they compose. First: **a generated corpus's silence is not a statement
about the real corpus.** Run the guard over the actual inputs before claiming it is clean on them; keep
both, because they answer different questions, and never let the cheaper one stand in for the other.
Second: **mutation is the only evidence that a green test is about the thing you think it is about.**
Break the guard on purpose — delete it, invert it — confirm a *named* test fails for the stated reason,
then restore it. This applies to the harness as much as to the code: a differential fuzzer, a
coverage-floor script, a parity check are all guards, and an unmutated one has never been tested.

**Symptom to watch for.** A correctness claim about the repository whose evidence is a generator seed
count; a guard whose deletion you cannot name a failing test for; a suite that goes green on the first
run after a risky change; a fuzz report whose numbers are identical before and after a deliberate break.

_(Reference: issue #159 / PR #162; the round-by-round reasoning errors are recorded in ADR 0054, and the
guard-design lesson in `docs/rules/scripting-postmortems.md`. The Tier-1 bullets were folded in issue
#166.)_
