# Findings Log

Outcome 3 of the four-outcome rule-suggestion disposition
([`PROJECT.md`](../PROJECT.md) → *Human Gates* → *Rule-suggestion disposition*, shipped in
[#187](https://github.com/wrburgess/bryce/pull/187)): a lesson real enough to record, but not yet
earning a Tier-1 bullet or a guard.

**Deliberately one append-only file, not one issue per finding** — an issue per finding is the
accretion that section exists to stop. Following this repository's absent-until-needed convention, it
was created when the first finding was recorded, never as an empty placeholder.

Each entry carries: normalized failure class · severity and blast radius · enforcement status ·
recurrence count · the PR or issue that surfaced it · date recorded · **review date** (absolute,
= recorded + 90 days).

**How an entry ends.** [`final`](../skills/final/SKILL.md) sweeps this log at the start of its
disposition step and processes every **active** entry whose review date has passed. Recurrence `0` and
nothing having cited it → **archive**. Recurrence `≥ 1` → eligible for *enforce* or *retain a concise
rule*, entering that run's disposition. **The default at expiry is archival, never promotion.** An entry
is *active* until it sits under `## Archived` and *archived* once it does; that heading is the entire
boundary. A later recurrence opens a **new** entry citing the archived one rather than reviving it,
carrying the recurrence count forward.

---

## Active

### F001 — A measurement of today's corpus was used to license a behavior widening

- **Normalized failure class:** measurement-as-guard — treating "this does not occur in the corpus
  today" as sufficient justification for *widening* what a checker exempts, rather than as the
  snapshot it is.
- **Severity and blast radius:** **High** as it occurred. Two Tier-1 checks (`checkRulesPointers`,
  `checkRulesDuplicateKeys`) went silent on any bullet carrying a stray four-space indent — a typo, not
  a marked-up code example. Blast radius is the whole Tier-1 tree, and the failure is silent: the gate
  stays green while enforcing nothing on the affected lines.
- **Enforcement status:** **the specific defect is enforced** — narrowed to fenced-only, with
  regression tests in `test/tooling/parity-rules-pointers.test.ts` and
  `test/tooling/parity-rules-duplicate-keys.test.ts` that redden when it is re-introduced
  (mutation-verified). **The general lesson is not enforceable** — "is this justification a snapshot?"
  is a judgment about an argument, not a property of the code.
- **Recurrence count:** 0 (first occurrence).
- **Surfaced by:** [PR #188](https://github.com/wrburgess/bryce/pull/188) (issue
  [#179](https://github.com/wrburgess/bryce/issues/179)), Stage-4 Reviewer, High finding.
- **Date recorded:** 2026-07-27
- **Review date:** 2026-10-25

**Why outcome 3 rather than 2.** The nearest existing Tier-1 bullet is `rules/testing.md`'s *"Never read
a generated corpus's silence as a statement about the real one"* — which is the **mirror** of this, not
this. That bullet says a *generated* corpus cannot speak for the real one, and its remedy is "run the
guard over the actual corpus." Here the guard **was** run over the actual corpus, all 102 bullets and 30
pointers, and the measurement was correct — it just did not license the widening it was offered for. The
gap is adjacent and narrow.

Outcome 2 is unavailable regardless: the **minting freeze** is in force until the bounded corpus review
dispositions the 45 loop-added bullets measured in
[#185](https://github.com/wrburgess/bryce/issues/185). Recording it here keeps the observation without
growing Tier 1 during the freeze, and lets recurrence — not an author's conviction in the moment it was
learned — decide whether it earns a bullet.

**If it recurs:** promote toward *enforce* first. The mechanically checkable form, if one exists, is a
check that any widening of a checker's exemption set ships with a test proving the newly-exempted shape
is one an author marked deliberately, rather than one a formatting accident produces.

---

### F002 — A durable external key was derived from a role flag the product lets you move

- **Normalized failure class:** mutable-identity-in-a-durable-key — naming an entity in a key that
  outlives the process by a **role** it currently holds (`is_default`, "primary", "current") rather than
  by an identifier that cannot be reassigned.
- **Severity and blast radius:** **Critical** as it occurred. `deliveryKey`, the provider-side
  idempotency key stale-claim recovery looks up to decide whether to suppress a send, exempted the
  default lane from its lane suffix. `set-default` moves that flag, so lane B could inherit lane A's
  key, find A's accepted message, and settle itself as delivered **without ever sending**. Blast radius
  is a scheduled digest silently not sent while the delivery row records success — loss that reports
  itself as success. It was reachable through an operation the same phase shipped.
- **Enforcement status:** **the specific defect is enforced structurally** — `DeliveryLane` is deleted
  and `deliveryKey`/`reconciled` take a `listId: number`, so the flag-dependent form no longer
  type-checks; `test/digest.test.ts` pins that a `set-default` leaves each lane's key untouched
  (mutation-verified). **The general lesson is not mechanically checkable** — "is this identifier
  reassignable?" is a question about product semantics, not a property of the code.
- **Recurrence count:** 0 (first occurrence).
- **Surfaced by:** [PR #195](https://github.com/wrburgess/bryce/pull/195) (issue
  [#190](https://github.com/wrburgess/bryce/issues/190)), Stage-4 Reviewer, P1.
- **Date recorded:** 2026-07-28
- **Review date:** 2026-10-26

**Why outcome 3 rather than 2.** The **minting freeze** is in force until the bounded corpus review
dispositions the 45 loop-added bullets measured in
[#185](https://github.com/wrburgess/bryce/issues/185), so outcome 2 is unavailable regardless of merit.
It is also genuinely adjacent to existing guidance rather than absent from it: `rules/security.md`
already says to pin a CI action to an immutable SHA rather than a mutable tag, and `rules/backend.md`
already says to validate the closed bytes rather than a mutable source. Both are the same shape one
domain over, which is an argument for recurrence deciding this rather than conviction in the moment.

**What made it hard to see:** the exemption was **deliberate and well-argued** — it preserved
compatibility with keys already in the provider's history, and its reasoning was written down. What the
reasoning never asked was whether the property it keyed on could change. That is the question worth
carrying forward, not "avoid exemptions."

**If it recurs:** promote toward *enforce* first. The mechanically checkable form, if one exists, is a
check that any value handed to an external system as a durable identifier is derived only from primary
keys and immutable columns — not from any column the codebase also writes an `UPDATE` against.

---

### F003 — One decision was answered by two reads, and they could disagree fail-open

- **Normalized failure class:** two-snapshot decision — computing a **derived predicate about a set**
  (coverage, completeness, "did we get everyone?") in a *second* query, after the query that selected
  the set has already returned, so a concurrent write landing in the gap makes the two answers describe
  different worlds.
- **Severity and blast radius:** **High** as it occurred. `runRefresh` selected the sweep's players and
  then separately counted whether its lanes covered every active player. Enrolling an already-active,
  off-lane player into an in-scope lane between the two made selection miss them while coverage counted
  them covered — so the run recorded `scope_list_ids = NULL` ("swept the whole Watch List") over a
  player it never fetched, became watermark-eligible, and made the whole-list digest banner read
  `fresh`. Blast radius is a digest that asserts completeness it does not have — the same
  "loss that reports itself as success" shape as [F002](#f002--a-durable-external-key-was-derived-from-a-role-flag-the-product-lets-you-move),
  and reached through an ordinary lane enrollment. **Graded one notch below F002's Critical, and the
  shape-similarity is not the grading:** F002 lost a *whole scheduled digest* while recording it
  delivered; F003 omits the *players a racing enrollment adds* from an otherwise-complete sweep. Same
  failure shape, an order of magnitude apart in blast radius.
- **Enforcement status:** **the specific defect is enforced structurally** — the standalone
  second-query function `coversEveryActivePlayer(db, listIds)` is deleted, and `selectSweepPlayers`
  now returns the swept set and a `coversEveryActivePlayer` **field** as two projections of **one**
  statement, so there is no second snapshot to disagree with. (The *name* survives as that field —
  `grep` still finds it. Said precisely because an append-only entry cannot be quietly corrected, and
  an auditor who greps for a deleted identifier would otherwise read a contradiction.)
  `test/refresh-list.test.ts`
  injects the racing enrollment at the moment the first `players` read completes and asserts the player
  is unfetched **and** the run is not watermark-eligible (mutation-verified red against `14fd568`).
  **The general lesson is not mechanically checkable** — "are these two reads answering one decision?"
  is a question about intent, not a property the code exposes.
- **Recurrence count:** 0 (first occurrence).
- **Surfaced by:** [PR #201](https://github.com/wrburgess/bryce/pull/201) (issue
  [#192](https://github.com/wrburgess/bryce/issues/192)), Stage-4 Reviewer, P1.
- **Date recorded:** 2026-07-28
- **Review date:** 2026-10-26

**Why outcome 3 rather than 2.** The **minting freeze** is in force until the bounded corpus review
dispositions the 45 loop-added bullets measured in
[#185](https://github.com/wrburgess/bryce/issues/185), so outcome 2 is unavailable regardless of merit.

The nearest existing bullet is `rules/backend.md`'s *"never swap a live data file into place by moving
the old one aside and then renaming the new one in"*, and the honest reading is that it is **near, not
the same**. That bullet is about **one actor crashing** between two non-atomic steps, leaving a path
*absent*; this is about **a second actor writing** into a read-read gap, leaving a predicate *present
and plausible but false*. Different cause, different symptom — only the two-steps-with-a-gap silhouette
is shared. That makes F003 **more** novel than a "one domain over" framing would suggest, which
strengthens the case for recording it rather than weakening it; what it does not do is make the case
for minting a bullet today, which the freeze settles anyway. Recurrence, not conviction in the moment,
decides that.

**Outcome bifurcation, stated rather than left to be reconstructed.** The policy says every suggestion
resolves to exactly one outcome. Here the **defect** took outcome 1 — fixed, guarded, and
mutation-tested in `e26794c`, which the policy makes available under either setting and requires
immediately for a high-severity first occurrence. The **suggestion** this entry records is the general
two-snapshot lesson, which is a different artifact and takes outcome 3. One suggestion, one bucket; the
fix was never the suggestion.

**What made it hard to see:** the two-read shape was introduced *as the fix* for an earlier defect in
this same PR — the freshness gate had been keyed on a proxy (`rules/backend.md`: *never re-decide a
dependency's question with a proxy signal*), and replacing the proxy with a real coverage question was
correct. The regression was in *where the answer came from*, not in what was asked. A fix that gets the
question right can still get the snapshot wrong, and the second mistake hides behind the first one's
correctness.

**If it recurs:** promote toward *enforce* first. The mechanically checkable form, if one exists, is a
check that no code path issues two reads of the same table between a selection and the durable write
that records what the selection covered — narrower and more tractable than a general TOCTOU rule.

---

### F004 — A mutation harness restored with `git checkout`, so it graded unmodified source

- **Normalized failure class:** self-invalidating verification — a harness that proves a guard by
  breaking it restores between runs with a command that discards **all** uncommitted work, not just the
  mutation, so every run after the first measures the *pre-change* source. Its output still looks like
  mutation evidence: tests go red, by name, in plausible numbers.
- **Severity and blast radius:** **Medium** as it occurred, and it self-corrected before anything was
  claimed. A four-mutation loop over uncommitted source used `git checkout -- src/...` to restore.
  Mutation A ran correctly; its restore reverted the whole change, so B, C, and D each mutated source
  that no longer contained the feature. All three reported ~7 failures — a superset of the truth,
  including the mutation-A failure repeated in every round, which is what exposed it. The near-miss is
  the point: those numbers were one step from a PR body, under the heading *evidence*. Blast radius is
  a reviewer trusting mutation coverage that was never measured — worse than absent evidence, because
  absent evidence invites the question and false evidence closes it. Graded below
  [F003](#f003--one-decision-was-answered-by-two-reads-and-they-could-disagree-fail-open) because no
  shipped behavior was ever wrong; only the *proof* was, and the proof was re-run.
- **Enforcement status:** **not enforced, and not mechanically checkable in general.** The specific
  harness was rebuilt to restore from a file-level copy taken before the first mutation, and the valid
  run is recorded in [PR #205](https://github.com/wrburgess/bryce/pull/205). But "does this restore
  step discard more than it mutated?" is a question about a throwaway shell loop, not a property of the
  repository — there is no artifact to lint. The *detector* generalizes better than the rule: a
  mutation that reddens tests **unrelated to what it mutated** means the harness, not the code, is
  broken. That is checkable by eye in every run, and it is what caught this one.
- **Recurrence count:** 0 (first occurrence).
- **Surfaced by:** [PR #205](https://github.com/wrburgess/bryce/pull/205) (issue
  [#204](https://github.com/wrburgess/bryce/issues/204)), Stage-3 self-verification — found by the AC,
  not by a Reviewer.
- **Date recorded:** 2026-07-28
- **Review date:** 2026-10-26

**Why outcome 3 rather than 2.** The **minting freeze** is in force until the bounded corpus review
dispositions the 45 loop-added bullets measured in
[#185](https://github.com/wrburgess/bryce/issues/185), so outcome 2 is unavailable regardless of merit.

The nearest existing bullet is `rules/testing.md`'s *"never believe a guard you have not broken on
purpose"* — and this sits one level **above** it. That bullet governs the guard; this governs the
apparatus that breaks it. The bullet was followed here in full, and it is precisely *because* it was
followed that the bad evidence existed to be believed: a repo that never mutates its guards cannot
produce a broken mutation harness. So the honest reading is that F004 is the failure mode that arrives
**after** a team adopts that rule, not an instance of ignoring it.

**Why not outcome 4.** The tempting argument is that this was caught, cost nothing, and belongs to a
throwaway script. But the thing that caught it was noticing a *shape* in the output — the same test
failing in every round — and that noticing was luck adjacent to skill. An entry costs one review date;
being wrong about "we would always catch it" costs a PR body asserting verification that never
happened.

**If it recurs:** promote toward *enforce*. The tractable form is not a lint but a harness convention —
capture the pre-mutation bytes of exactly the files to be mutated, restore from those, and assert the
restored tree is byte-identical to the captured one before the next mutation. That is a five-line
discipline, and a recurrence would justify writing it down as one.

---

## Archived

_None yet._
