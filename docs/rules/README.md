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
