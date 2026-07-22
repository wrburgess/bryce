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
