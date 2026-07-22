---
name: create-skill
description: The authoring front door. Scaffold a new, conforming Skill for this bundle — a canonical body plus its thin Invocation Shim — after loading the repo's architecture and its whole existing skill set as exemplars, then update the bundle's bookkeeping and open a review PR with the parity gate green. Use when adding a new Skill so it conforms by construction instead of by hand. Adapted from Anthropic's skill-creator.
---

<what-to-do>

Turn "I want a new Skill that does X" into a **conforming** Skill scaffold — a canonical body at
`skills/<name>/SKILL.md` plus its thin Invocation Shim at `.claude/commands/<name>.md` — opened as a
review PR with every gate green. `create-skill` is the bundle's **authoring front door**: the Skill you
reach for to build the next Skill. Its defining move is to **load the repo's context first** — this
bundle's architecture and *every* existing Skill — so the new Skill matches the house shape by
construction rather than by a reviewer catching drift later.

`create-skill` **adds no authoring rules of its own**. The invariants a Skill must satisfy live once in
[`rules/skills.md`](../../rules/skills.md) (the Patterns/Anti-Patterns) and the bundle-development
conventions live once in [`docs/guides/authoring-the-bundle.md`](../../docs/guides/authoring-the-bundle.md)
(the floor-then-shape parity pattern, the verbatim-vs-decoupled port rule). This body **references**
those and never restates them — a copy here would fork the single source and drift the next time either
changes. What `create-skill` owns is the *front door*: loading the context, interviewing for the new
Skill's shape, emitting the paired artifacts, wiring the bookkeeping, and gating on parity before it
proposes.

Read host-specific values from [`PROJECT.md`](../../PROJECT.md): the **quality-check commands** from
*Quality Checks*, the branch/PR/issue-linking policy from *Branch & PR Policy*, the attribution/model
from *Attribution & Model Declaration*, and the lifecycle host from *Lifecycle Host*. Never hardcode a
stack command, a branch name, or a platform verb here — the body stays business- and stack-neutral, and
a Host App repoints those in Project Config, not in this Skill.

**Terminal artifact: the reviewable PR** proposing the new Skill (body + shim), the bookkeeping updates,
and — where the new Skill warrants one — an ADR. `create-skill` never commits to a protected branch and
never self-merges; a human disposes on the PR.

</what-to-do>

<procedure>

1. **Load the repo context — the defining step.** Before writing anything, read and internalize:
   - [`AGENTS.md`](../../AGENTS.md) → the Canonical-Source/Adapter model and the *Skills* section (how a
     Skill is authored once and reached through per-tool shims).
   - [`rules/skills.md`](../../rules/skills.md) → the Patterns and Anti-Patterns the new Skill must
     satisfy (read host values from `PROJECT.md`; reference, don't restate; keep the shim thin; use the
     portable Skill format).
   - **Every** `skills/<name>/SKILL.md` as an exemplar — absorb the house body shape
     (`<what-to-do>` / `<procedure>` / `<quality-gate>` or `<output>` sections, a `## Provenance` note
     where a Skill is adapted), the tone, the lifecycle-*verb* phrasing, and the "reference a composed
     Skill's body, never copy its steps" style.
   - [`PROJECT.md`](../../PROJECT.md) → the host seams a Skill reads.
   - [`docs/guides/authoring-the-bundle.md`](../../docs/guides/authoring-the-bundle.md) → the
     floor-then-shape parity pattern and the byte-neutral-vs-visible-decoupling port rule.

   *Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
   on a tool with read-only sub-agents, the exemplar sweep may be offloaded and its conclusions folded
   back in; on a tool without them, read the exemplars inline. The mechanism degrades; the context load
   and its rigor do not.

2. **Interview for the new Skill's shape.** Establish, one point at a time: the `name` (kebab-case) and
   one-line purpose; the procedure (the numbered steps); which host values it reads from `PROJECT.md`;
   whether it **composes** existing Skills (and therefore *references* their canonical bodies rather than
   restating them); its terminal artifact; and whether it is adapted from an upstream source (which
   mandates a `## Provenance` credit — see step 6). Recommend an answer for each; ask, don't guess.

3. **Write the canonical body** at `skills/<name>/SKILL.md` in the house shape: frontmatter with a
   `name:` and a `description:`, a body that reads host values from `PROJECT.md` and names lifecycle
   *verbs* (not platform commands), and a stated **terminal artifact**. Keep it business- and
   stack-neutral: **no host-specific proper noun or tool name may appear in the body** — the parity
   content-neutrality check reddens CI if one does, and this rule is scoped to `skills/<name>/SKILL.md`,
   so any illustrative host-named example belongs under `docs/`, never in the body.

4. **Write the thin shim** at `.claude/commands/<name>.md`: frontmatter `description:`, a line pointing at
   the canonical body that **contains the literal string** `skills/<name>/SKILL.md` (the parity check
   asserts this substring — a hollow stub or a differently-spelled path fails), and the standard "carries
   no procedure of its own" paragraph citing [ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)
   and [ADR 0010](../../docs/adr/0010-repo-layout-canonical-skills-at-root.md). The shim carries no
   procedure and no quality gate — only the pointer.

5. **Wire the bookkeeping — the easy-to-miss sync points.** A new Skill is not done when its two files
   exist:
   - **Reference it in [`AGENTS.md`](../../AGENTS.md)** → *Skills* — this reference is **parity-enforced**;
     a present `skills/<name>/` with no `skills/<name>/SKILL.md` reference in `AGENTS.md` reddens CI. Add
     its bullet to the shipped-Skills list.
   - **Flip the count prose** everywhere it is stated — `AGENTS.md`, [`README.md`](../../README.md),
     [`docs/guides/usage.md`](../../docs/guides/usage.md), and the Claude adapter
     [`CLAUDE.md`](../../CLAUDE.md) (which enumerates the per-tool shims) each carry a written skill count
     and/or list. These strings are **unenforced** (CI stays green if they drift), so update every one by
     discipline — grep the tree for the current count word and the phrase "set of" to catch stragglers.
   - **Pin the floor + add its self-test** if the Skill is a baseline member: add its name to
     `REQUIRED_SKILLS` in [`scripts/parity-check.ts`](../../scripts/parity-check.ts) (the one line that
     grows per Skill) and a matching parity self-test asserting **both** the non-zero exit **and** the
     specific error string — per the floor-then-shape rule
     in [`authoring-the-bundle.md`](../../docs/guides/authoring-the-bundle.md); no new floor entry ships
     without its self-test.

6. **Credit an upstream source when the Skill is adapted (HARD RULE when it applies).** A Skill copied or
   adapted from an external original ships a `## Provenance` section at the **end of the body** naming the
   source with a real URL, and the shim carries a short `> **Upstream:**` echo pointing back at it. This
   is the same source-credit discipline the bundle already applies to adapted Skills; it is **unenforced**
   by parity, so bake it in — an uncredited adaptation is a real miss, not a style nit. This credit is
   separate from the per-agent model *Attribution* below.

7. **Consider an ADR.** Offer one only when the new Skill is a genuinely new category or carries a
   hard-to-reverse design/placement decision (the three-part test in
   [`rules/skills.md`](../../rules/skills.md)'s ADR guidance / the ADR format spec). Number it by scanning
   `docs/adr/` for the highest existing number and incrementing. Do **not** rewrite an older ADR's
   historical count — ADRs are point-in-time records; add a new one instead.

8. **Run the gate, then open the PR.** Run every command in [`PROJECT.md`](../../PROJECT.md) →
   *Quality Checks* and iterate to green (for this bundle that is the structural parity check plus the
   stdlib self-tests). Then commit on a feature branch per *Branch & PR Policy* with the `Co-Authored-By`
   trailer, push, and open the PR — linking the issue per policy — with the standard PR body sections.
   Never a direct commit to a protected branch.

*Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0005](../../docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)):* on a tool
with sub-agents the exemplar read and the check/fix loop may be offloaded; on a tool without them, run
them inline. The mechanism degrades; the conformance bar, the bookkeeping, and the human-disposes gate
never do.

</procedure>

<quality-gate>

Before opening the PR — and before the run is complete: the new Skill has a **canonical body** with
`name:` frontmatter and a **thin shim** whose link contains the literal `skills/<name>/SKILL.md`; the
body is **business- and stack-neutral** (no host-specific token — grep it before committing); the Skill
is **referenced in `AGENTS.md`** and the count prose is updated in `AGENTS.md`, `README.md`,
`docs/guides/usage.md`, and `CLAUDE.md`; a baseline Skill is **pinned into `REQUIRED_SKILLS` with a matching self-test**;
an adapted Skill carries its **`## Provenance` credit** (body) and `> **Upstream:**` echo (shim); and the
host's *Quality Checks* are **green**. The output is a **reviewable PR**, **never a direct commit** to a
protected branch. Sign every lifecycle-host comment with the footer from [`PROJECT.md`](../../PROJECT.md)
→ *Attribution & Model Declaration*, using your runtime-actual model.

**The gate that never degrades:** `create-skill` **proposes** a conforming Skill; a **human disposes** on
the PR. The front door never merges a Skill on its own.

</quality-gate>

## Provenance

This Skill is **adapted from Anthropic's `skill-creator`** (<https://github.com/anthropics/skills>) — the
upstream original that popularized an interactive "author a new Skill" workflow over the portable
`SKILL.md` format. This bundle's copy is downstream and deliberately re-shaped: where the upstream emits a
single generic Skill, `create-skill` bakes in *this* repo's stricter architecture — the canonical-body +
thin-shim projection, business/stack-neutrality, `PROJECT.md`-sourced host values, and the parity gate —
and **references** [`rules/skills.md`](../../rules/skills.md) and
[`docs/guides/authoring-the-bundle.md`](../../docs/guides/authoring-the-bundle.md) rather than restating
their invariants. Watch the upstream for mechanics worth backporting (interview shape, packaging of
bundled resources). This credits the Skill's external *source*; it is separate from the repo's per-agent
model *Attribution*.
