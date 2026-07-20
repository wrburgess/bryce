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
