# Deferred Deep Docs (Tier 2)

Tier 2 of the two-tier Rules Layer ([ADR 0004](../adr/0004-two-tier-rules-layer-progressive-context.md)). Heavy, subsystem-specific case studies live here as `docs/rules/<domain>-postmortems.md`. They are **not** auto-loaded: an agent reads one **on demand** (or via a dispatched sub-agent) when its work touches that subsystem, guided by the trigger table below. Keeping this depth *out* of the Tier-1 Lean Core (`rules/*.md`) is what actually keeps session context lean — a Tier-1 file that grows heavy is a signal to push detail down here, not to bloat the core.

## Baseline note

The Generic Baseline ships this structure and the trigger table; the deep docs themselves are **absent until a host has a real postmortem to record**. Create `docs/rules/<domain>-postmortems.md` when you write the first case study for that domain, add its `(Reference: #NNNN)` entries, and point the matching Tier-1 file's header at it. This "absent until needed" default keeps the baseline free of empty placeholder files while leaving each host an obvious place to grow depth.

## Trigger table

Each Tier-1 rule names the deferred deep doc to read when working in its area:

| Working in… | Tier-1 rule | Deferred deep doc |
|---|---|---|
| Backend / domain code | `rules/backend.md` | `docs/rules/backend-postmortems.md` |
| UI / view code | `rules/frontend.md` | `docs/rules/frontend-postmortems.md` |
| Tests | `rules/testing.md` | `docs/rules/testing-postmortems.md` |
| Code handling secrets, auth, or input | `rules/security.md` | `docs/rules/security-postmortems.md` |
| Bundled / CLI scripts | `rules/scripting.md` | `docs/rules/scripting-postmortems.md` |
| Skill bodies + shims | `rules/skills.md` | `docs/rules/skills-postmortems.md` |
| before declaring work done | `rules/self-review.md` | (none — the checklist is the whole rule) |

A host binds each role to its own path globs — declare them in `PROJECT.md` or its stack overlay.
Extend this table per host as you add domains.

## Convention: reference a not-yet-existing path as a backticked path, never a markdown link

Notice that every deferred deep doc above (e.g. `docs/rules/scripting-postmortems.md`) is written as a
**backticked inline-code path**, not a `[text](path)` markdown link — even though it names a real
target pattern. That is deliberate and load-bearing:

- The parity check's dead-link validator (`checkLinks` in `scripts/parity-check.ts`) resolves **only
  markdown links**, and **only** in its explicit `LINK_CHECKED` file list. In one of those files, a
  markdown link to a file that doesn't exist yet
  reddens CI with a dead-link failure; a backticked path is inert text the validator ignores. A
  separate repository-wide Markdown scan checks only local `[ADR NNNN](MMMM-...md)` links for a
  disagreement between their displayed and target ADR numbers; it does not resolve additional links.
- This is what lets the Rules Layer ship a trigger table — and any forward-reference to a
  planned-but-absent file — **without creating empty placeholder files** just to satisfy the checker.

**The form rule (repo-wide):** a reference to a path that may not exist yet must be a **backticked
inline-code path** (or plain text), never a markdown link. A contributor who "helpfully" converts a
backticked path into a link before its target lands will break the parity gate.

**Promotion.** Once the target file exists you may promote the reference to a real `[text](path)` link
— but write the link the way Markdown resolves it: **relative to the file you are writing in**, not to
the repo root. From a Tier-1 rule in `rules/`, that is `[the deep doc](../docs/rules/x-postmortems.md)`.
The repo-root spelling `[the deep doc](docs/rules/x-postmortems.md)` names a real file yet renders as a
404, so it is rejected. This is the one place the two forms differ: a **backticked path is prose naming
a repo-root path**; a **link is a link**.

**The resolution rule (Tier-1 rule files).** Inside `rules/*.md` a deep-doc path must additionally
**resolve** — checked by `checkRulesPointers` in `scripts/parity-check.ts`, which is the *only*
validator these files get, since `rules/*.md` is deliberately not in `LINK_CHECKED`. One exception: the
`**Deep doc:**` header **may forward-reference a deep doc that does not exist yet**, in bare form. That
header is a *declaration* of where the domain's deep doc lives; `rules/frontend.md`,
`rules/security.md`, and `rules/scripting.md` all rely on it today. A dead *link* in that same header is
still dead, and is still rejected.

A **body** pointer gets no such exemption, because it means something different: it stands in for a case
study that was **moved** out of Tier 1 (the trim in issue #148), so a pointer at a file that does not
exist has silently lost that content. Note the ordering this implies — and it matches the workflow in
*Baseline note* above: create the deep doc, write its entries, *then* point at it. You cannot move
content into a file you have not written, so a forward-referencing body bullet is not a real authoring
pattern; if you need to name a planned deep doc, the header is where it goes.

*(Provenance: PR #13 forward-references and #7 / PR #17's trigger table both relied on this unwritten
rule; captured here per issue #19. The promotion and resolution rules were pinned in issue #154, after
the checker added in #149 rejected every link unconditionally and so made the promotion step above
impossible to follow.)*

## Convention: a Tier-1 bullet carries the lesson, not the case study

The split above is the whole point of two tiers, so it is enforced rather than merely stated
([ADR 0051](../adr/0051-tier-1-per-bullet-narrative-budget.md)). `scripts/parity-check.ts`
(`checkRulesNarrative`) fails any `rules/*.md` bullet longer than **600 characters** that does not carry
its own domain's case-study pointer.

It is measured **per bullet, not per file**, and a bullet that carries its pointer is **exempt at any
length** — so a rule file may grow indefinitely in well-shaped lessons, and the check never asks more of
a bullet that has already been trimmed (the longest such bullet today is 604 characters). What it
catches is the one thing the two-tier split forbids: a case narrative written inline instead of pushed
down here. A bullet is counted across its wrapped continuation lines, so re-flowing it changes nothing.

When it fires, the remedy depends on the state of your domain's deep doc — the error message says which
one applies, read from disk:

| Your domain's deep doc | Remedy |
|---|---|
| **exists** (`backend`, `skills`, `testing`) | Move the narrative into it and leave a pointer in the bullet — **either** the backticked repo-root path **or** a promoted link written relative to the rule file, per *Promotion* above — **or** shorten the bullet. |
| **declared but not yet written** (`frontend`, `security`, `scripting`) | **Author the deep doc first** (per *Baseline note* above), then point at it — **or** shorten the bullet. Pointing at a file that does not exist fails the rules-pointer check. |
| **none by design** (`self-review`) | Shorten the bullet. |

Whichever remedy you pick, **the instruction never moves behind the pointer** — `rules/skills.md`
forbids that, because Copilot does not follow links. Only the *narrative* moves; the imperative and its
rationale stay resident in Tier 1.

**The grandfathered backlog only shrinks.** The bullets that were already over the limit when the guard
landed sit in `NARRATIVE_ALLOWLIST` in `scripts/parity-check.ts`, keyed by their exact bolded
imperative. Deleting an entry (by trimming its bullet) is welcome and needs no other edit; **adding**
one is a deliberate, reviewable act. An entry that is stale, ambiguous, or no longer needed is itself a
parity failure, so a trim turns the gate red until the now-pointless entry is removed — the backlog
cannot quietly stop shrinking.

That is not theoretical: issue #151's trim of `rules/backend.md` landed while this guard was in review,
and merging it turned parity red with five "no longer needed" errors until those entries were deleted.

*(Provenance: issue #152 — PR #149 trimmed `rules/testing.md` and the accretion resumed in the very next
merged PR, past the size the trim started from, because every individual bullet was defensible and
nothing asked whether its narrative belonged in Tier 2.)*

## Convention: an invariant may be stated in both moods, keyed on the failure mode

A Tier-1 invariant **may** appear in both `## Patterns` and `## Anti-Patterns`. The mirrored pair is the
Lean Core's shape, not accretion — 21 such pairs across the seven Tier-1 files, five of which mirror a
*majority* of their Patterns, and [ADR 0004](../adr/0004-two-tier-rules-layer-progressive-context.md)
makes the imperative-negative
form a *required* section precisely because it steers effectively where the positive framing does not
([ADR 0053](../adr/0053-mirrored-pattern-anti-pattern-pairs-are-the-tier-1-convention.md)).

**The unit is the failure mode, not the principle.** One Pattern may be mirrored by as many
Anti-Patterns as there are distinct ways to get it wrong — `rules/frontend.md`'s "Native / server-driven
interactivity first" is mirrored by *two*, one for a parallel rendering paradigm and one for a parallel
DOM idiom, because those fail differently.

**What each mood owes** — this is the bar a pair must clear:

| Mood | Must carry |
|---|---|
| **Pattern** | The action to take **before the code exists**: the positive imperative and what to do instead. |
| **Anti-Pattern** | The failure **mechanism and its consequence** — the "*because*" clause ADR 0004 requires, and what goes wrong when it is ignored. |

**Both halves must carry content the other lacks.** A bullet that spends its length restating the other
mood's job has not earned its place: **delete it, do not keep it for symmetry.** That is the whole
constraint — without it, "an invariant may appear in both moods" is a licence rather than a rule.

**Tolerated, not justified:** restating the shared invariant, and naming the same remedy, in both moods.
Five files do this and none of it is a defect. But note *why* it is only tolerated — every consumer reads
a rule file **whole** (the trigger table above binds a *file* to a working context, not a section, and
`skills/create-skill/SKILL.md` cites both sections together as one surface), so duplicated prose is a
real context cost with no offsetting benefit. Prefer the tighter phrasing where you have the choice.

**Not allowed:** a second bullet for the *same* failure mode, or a pair whose two halves are both written
in the same mood.

**There is no checker for this one, deliberately.** "Each half carries content the other lacks" is a
semantic judgment; the mechanical proxy — a verbatim-overlap check between bullets — was measured and
rejected, because the most-duplicated pair in the tree shares only 26 characters and ranks *seventh*
behind six unrelated pairs, so any threshold that catches it reddens on ordinary shared vocabulary. The
measurement is in [ADR 0053](../adr/0053-mirrored-pattern-anti-pattern-pairs-are-the-tier-1-convention.md)
so the next leanness pass does not re-propose a guard that was rejected on evidence rather than
overlooked. What *is* enforced is the per-bullet narrative budget above.

*(Provenance: issue #160 — deferred from PR #156 as a convention decision rather than a cleanup, after
three passes at `rules/backend.md` kept rediscovering one mirrored pair and reading it as accretion. The
audit that answered it also corrected this convention's own first draft, which would have declared
`rules/frontend.md`'s one-Pattern-to-two-Anti-Patterns fan-out non-conforming.)*
