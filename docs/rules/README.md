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
  markdown links**, and **only** in its explicit `LINK_CHECKED` file list. A markdown link to a file that doesn't exist yet
  reddens CI with a dead-link failure; a backticked path is inert text the validator ignores. A
  separate repository-wide Markdown scan checks only local `[ADR NNNN](MMMM-...md)` links for a
  disagreement between their displayed and target ADR numbers; it does not resolve additional links.
- This is what lets the Rules Layer ship a trigger table — and any forward-reference to a
  planned-but-absent file — **without creating empty placeholder files** just to satisfy the checker.

**The rule:** a reference to a path that may not exist yet must be a **backticked inline-code path**
(or plain text), never a markdown link. **Promote it to a real `[text](path)` link only once the
target file exists.** A contributor who "helpfully" converts a backticked path into a link before its
target lands will break the parity gate.

*(Provenance: PR #13 forward-references and #7 / PR #17's trigger table both relied on this unwritten
rule; captured here per issue #19.)*

## Convention: a Tier-1 bullet carries the lesson, not the case study

The split above is the whole point of two tiers, so it is enforced rather than merely stated
([ADR 0051](../adr/0051-tier-1-per-bullet-narrative-budget.md)). `scripts/parity-check.ts`
(`checkRulesNarrative`) fails any `rules/*.md` bullet longer than **600 characters** that does not carry
its own domain's case-study pointer.

It is measured **per bullet, not per file**, and a bullet that carries its pointer is **exempt at any
length** — so a rule file may grow indefinitely in well-shaped lessons, and the check never asks more of
a bullet that has already been trimmed (the longest such bullet today is 604 characters). What it
catches is the one thing the two-tier split forbids: a case narrative written inline instead of pushed
down here.

When it fires, the remedy depends on the state of your domain's deep doc — the error message says which
one applies, read from disk:

| Your domain's deep doc | Remedy |
|---|---|
| **exists** (`backend`, `skills`, `testing`) | Move the narrative into it and leave a backticked pointer in the bullet, **or** shorten the bullet. |
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

*(Provenance: issue #152 — PR #149 trimmed `rules/testing.md` and the accretion resumed in the very next
merged PR, past the size the trim started from, because every individual bullet was defensible and
nothing asked whether its narrative belonged in Tier 2.)*
