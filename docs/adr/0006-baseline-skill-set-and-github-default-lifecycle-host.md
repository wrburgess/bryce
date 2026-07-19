# Baseline skill set is eight; GitHub is the default (pluggable) lifecycle host

> Note (#73): the names and counts below predate later changes — the baseline has since grown to **twelve** skills and six were renamed (grill-with-docs→distill, cplan→devise, impl→invoke, rtr→listen, drop→clip, voice→follow). This ADR records the original decision as of its date; see `AGENTS.md` / `REQUIRED_SKILLS` for the current set.

**Status:** accepted

## Skill set

The Generic Baseline ships exactly **eight** Skills:

`grill-with-docs`, `assess`, `cplan`, `impl`, `verify`, `rtr`, `final`, `ship`.

`impl` is included even though it was not in the original headline list — it is a hard dependency of `ship`'s phase sequence and useful standalone. `grill-with-docs` is a first-class brainstorming skill for shaping new issues/projects, not only plan-grilling.

**Explicitly excluded** from the baseline (the no-s matter as much as the yes-s): `explore`, `orch`, `compare`, `memory-review`, `dep-review`, `db-health`. None are required for the agents to run the lifecycle — codebase exploration is *embedded* in `assess` via a read-only sub-agent (ADR 0005). `memory-review` (keeps the Rules Layer lean) and `dep-review` (PR dependency review) are the two strongest **future** candidates; `compare`/`db-health` are inherently host-specific and won't be generic.

## Lifecycle host

The lifecycle is issue/PR-shaped: `assess`/`cplan` post to an issue, `impl` opens a PR, `verify`/`rtr`/`final` operate on that PR. **GitHub is the default lifecycle host** (it is what we use). It is **not hardcoded** — the host platform is a **Project Config** value, and the issue/PR verbs the skills use are isolated so a Host App on another platform (GitLab is the plausible one; Linear untested) can remap the artifact targets without rewriting skill bodies.

## Consequences

- Adding an excluded skill later is a Host App Customization or a follow-up baseline issue — not a breaking change.
- The abstraction cost is paid only at the seam where skills name platform verbs; the default GitHub path stays concrete and unabstracted for the common case.
