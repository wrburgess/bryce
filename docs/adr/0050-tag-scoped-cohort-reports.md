# Tag selectors scope cohort reports

The windowed Digest accepts a **tag selector** (`tags`) beside its named-list scope, so a report can be
asked for by *attribute* — `level:dsl`, `status:scouted`, `level:aaa,status:rostered` — rather than only
by hand-curated membership (#140, the terminal phase of the report-engine umbrella #29). The selector
grammar, the tag model, and the derivation rules are unchanged from Phase A (#30 / ADR-less, `player_tags`);
this ADR records only what it means to point that selector at a **report**.

ADR 0046 deliberately kept a *list* (curated membership) and a *tag* (queryable attribute) distinct and
**composable**, with "no coupling to unbuilt #30." #30 is now built; this composes them without collapsing
the distinction — a list is still membership, a tag is still an attribute, and a report may be scoped by
either or both.

## Considered Options

- **A second scope on the digest read (chosen).** `AssembleDeps`/`RunDigestDeps` take an optional
  `tagScope`, applied at both selection sites; `listId` plumbing is untouched. Smallest change over
  shipped, reviewed code; the list path is additive-only.
- **Materialize the cohort as an ephemeral named list.** Resolve the selector to ids, write a transient
  `player_lists` + `list_members` pair, reuse the list scope, delete after. Rejected: it **writes to the
  database to answer a read-only question** — the founding constraint of #29 — and adds orphaned-list,
  naming-collision, and concurrent-run failure modes in exchange for avoiding a well-understood scoping
  change.
- **Unify list, tags, and (future) roster behind one `PlayerScope` abstraction.** The better end state,
  and where #69 (fantasy rosters) should take us. Rejected *for now*: it rewrites the shipped list path,
  and #69's roster source of truth is still undecided, so the abstraction would be designed against one
  built consumer and one speculative one. The extracted `tagScopeCondition` seam is deliberately what
  that unification would consume.

## Consequences

The five decisions this ADR fixes:

1. **Both selection sites are scoped, or the report is wrong.** `assembleDigest` selects players in the
   `stat_lines ⨝ players` join **and** via the active-player set that feeds the idle/zero-row tail and
   `seasonStartFor`. A tag scope filters both — a correlated `EXISTS` per token in the join
   (`tagScopeCondition`), and the matched-id set for the active list — or an off-cohort player leaks as a
   real row, as a zero row, or by moving a `ytd` window's start date. This is ADR 0046's hazard, restated
   because it does not become less true the second time. Pinned by `test/digest-tags.test.ts`.

2. **`tags` and `list` intersect.** Both present ⇒ players in the list **and** matching every token. It is
   the only reading consistent with AND-semantics inside the selector, and it makes "the DSL guys on my
   fantasy roster" expressible without inventing a third concept.

3. **An empty cohort is an empty report; a malformed selector is an error.** A selector matching no
   players renders empty, exactly as an empty named list does — a report about nobody is a valid answer.
   A selector that cannot be *parsed* is rejected on every surface (400 / MCP `isError` / CLI exit 1), so
   a typo can never masquerade as an honest empty cohort. One consequence is deliberate: an unknown tag
   *value* (`status:banana`) is well-formed, so it yields an empty report rather than an error — the
   selector stays a pure query and is not coupled to the derived-value catalogue.

4. **A tag-scoped send is on-demand, never the scheduled slot.** The delivery slot key
   `(kind, date_covered)` has no tag dimension, so two cohorts sent on one date would collide on one slot.
   Any run carrying a tag scope routes to the no-claim, no-delivery-row path, whatever its window —
   identical to ADR 0046 decision 4 for lists. The scheduler passes no tags, so the daily `1d` slot is
   untouched. Per-cohort *scheduled* deliveries remain a documented follow-up.

5. **The selector's charset is the security boundary for the cohort label.** A namespace and a value must
   each match `/^[a-z0-9][a-z0-9-]*$/`. This is not style: the parsed selector is rendered back into an
   **SMTP subject header**, an **HTML heading**, and a **Markdown heading**, and `trim()` strips only the
   ends of a token — so an interior CR/LF would otherwise survive into a mail header. Constraining the
   charset at the boundary makes the label safe in *every* sink by construction rather than requiring each
   sink to escape correctly; the HTML path still escapes, as defense in depth and because a list **name**
   (control-character-free, but otherwise free text) shares that sink.

Further consequences:

- **Two deliberate behavior changes on the shipped watch-list surface.** The charset rule makes the
  documented grammar true — `docs/domain/tags.md` has always said a value with stray colons is rejected,
  while the parser split on the first colon and accepted `foo:bar:baz`. That selector, and an uppercase
  one (`level:AAA`, which could never match a lowercase stored value), now fail closed with a validation
  error instead of returning a silently empty result. The test that pinned the old acceptance was flipped
  rather than deleted.
- **One implementation, two selection sites.** `playerIdsMatchingTags` is defined in terms of
  `tagScopeCondition`, so the SQL-scoped site and the id-set site cannot diverge; a parity test asserts
  they select the same players.
- **No `IN (...)`.** The join scope is a correlated `EXISTS` per token, never a bound id list — SQLite's
  ~999-parameter cap would otherwise fail for exactly the large cohorts the feature exists to serve
  (`rules/backend.md`, provenance #70 / PR #86).
- **Nothing is written.** The report stamps no `digest_delivery_id` and touches no stat-line state, so the
  nightly digest's report-once bookkeeping is unaffected (#29's founding constraint).
