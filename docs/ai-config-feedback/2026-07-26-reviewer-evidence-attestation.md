# 2026-07-26 — Reviewer evidence needs an attestation boundary (bryce issue #106)

## F14 — Asynchronous reviewer routes need trustworthy reviewed-commit evidence

**Disposition: `upstream` · Status: recorded (ai-config#141)**

A local CLI can return a review body synchronously, but a requested asynchronous reviewer may only
produce a later platform artifact. A request event alone does not prove that it reviewed the current
commit, and a review comment without a trustworthy `commit_id` cannot prove which diff it covers.

Bryce records compact PR evidence for every usable review: a request marker, reviewed SHA, baseline,
reviewer harness/model, disposition, and artifact URL. It accepts an asynchronous response only when
the platform supplies trustworthy `commit_id` evidence that equals the recorded reviewed SHA.
Otherwise the route fails closed: no request/artifact is `unreachable`; a request without a response by
the deadline is `timed-out`; an artifact without commit attestation cannot satisfy the Reviewer gate.

This should be adopted upstream because every lifecycle host with asynchronous reviewer integrations
faces the same provenance gap. It deliberately does not prescribe a generic event log, lease, or
adapter protocol: the minimum durable PR evidence is enough to make the final gate reject stale or
unattested reviews.
