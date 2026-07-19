# AGENTS.md — Canonical Source

This is the **Canonical Source**: the one authored, model-neutral set of instructions every
configured AI coding agent (Claude, Codex, Copilot, Antigravity, Grok Build) reads. Author instructions **here,
once**; each tool's own config file is a thin **Adapter** that resolves back to this file, so the
agents never receive drifted instructions. See [`CONTEXT.md`](CONTEXT.md) for the vocabulary used
throughout (Config Bundle, Adapter, Skill, Rules Layer, Project Config, …).

> This file is **business-neutral**. It carries no company, product, or domain content. A Host App
> adds that as **Customization** after vendoring — never here.

## How each tool consumes this file

Verified per-tool (issue #3 → [`docs/research/tool-config-discovery.md`](docs/research/tool-config-discovery.md),
Antigravity re-verified #56); decision in [ADR 0002](docs/adr/0002-agents-md-canonical-pointer-projection.md):

- **Claude Code** — reads `CLAUDE.md`, which imports this file via `@AGENTS.md` (expanded at launch).
- **Codex** — reads `AGENTS.md` **natively** by filename. No Adapter needed.
- **Copilot** — its PR-relevant surfaces read `AGENTS.md` **natively**; `.github/copilot-instructions.md`
  is only a discovery marker, not a copy.
- **Antigravity** (Google; succeeded Gemini CLI) — reads `GEMINI.md`, which imports this file via
  `@AGENTS.md` (or names it via `context.fileName`), and also reads `AGENTS.md` natively.
  (CLI-transition history lives in the [research doc](docs/research/tool-config-discovery.md).)
- **Grok Build** (xAI) — reads `AGENTS.md` **natively** by filename (like Codex). No Adapter needed.

Resolution is always **import-expansion** (`@AGENTS.md`) or **native discovery**, never a free-text
pointer; the parity check ([ADR 0008](docs/adr/0008-structural-parity-check-not-model-in-the-loop.md))
keeps every Adapter resolving here.

## Project Config

Host-specific values live in **one** place — [`PROJECT.md`](PROJECT.md) — so these instructions stay
generic. Read it for: the quality-check commands, the attribution format and per-agent **model
declaration**, the branch/PR policy, the review-severity framework, and the lifecycle host. Never
hardcode any of those here; read them from `PROJECT.md`.

## Attribution

Every agent signs with **both its tool and model version**, from the single declaration in
[`PROJECT.md`](PROJECT.md) → *Attribution & Model Declaration*
([ADR 0007](docs/adr/0007-attribution-includes-model-version-for-audits.md)). Sign with your
**runtime-actual** model (human-readable, e.g. `Claude Opus 4.8`, never an API id). Commits use a
`Co-Authored-By: <Tool Model> <email>` trailer; PRs/reviews/comments use a footer, e.g.
`— Claude Code (Opus 4.8)`.

## Branch & PR policy

Read the authoritative rules from [`PROJECT.md`](PROJECT.md) → *Branch & PR Policy*. In summary: work
on feature branches (never commit directly to a protected branch), open one PR per branch, and link
the issue with `Closes #N` for a leaf issue.

### Umbrella sub-PRs and closing keywords

For an umbrella/epic, reference sub-PRs as `Part of #N` — **never** a closing keyword
(`close`/`closes`/`fix`/`fixes`/`resolve`/`resolves`) adjacent to `#N`, **even negated** ("does not
close #N" still registers; GitHub ignores the negation). A closing keyword auto-closes the umbrella when
the first sub-PR merges, orphaning the remaining phases — close the specific phase sub-issue instead.

## Development lifecycle

The lifecycle is issue/PR-shaped: **Assess → Plan → Implement → Verify → Deliver**, plus a
review-response step. `assess`/`devise` post to an issue; `invoke` opens a PR; `verify`/`listen`/`final`
operate on that PR. The **merge** gate is mandatory and never bypassed; the **plan-approval** gate is
**auto-approved** in this host per its gate policy ([`PROJECT.md`](PROJECT.md) → *Lifecycle Host* →
*Human gates*) — the plan is still posted to the issue, but work proceeds without waiting.
GitHub is the default lifecycle host, set in `PROJECT.md` and remappable
([ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)). The full stage
spec — stages, roles, gates, and terminal artifacts — is
[`docs/standards/development-lifecycle.md`](docs/standards/development-lifecycle.md).

## Skills

This host vendors **nine Skills** (the Generic Baseline's thirteen, minus the intake-pipeline set —
`scout`, `clip`, `follow`, `restock` — trimmed as a Customization). Each is authored once as a canonical body
(`skills/<name>/SKILL.md`, Anthropic's portable Skill format: YAML frontmatter + markdown + optional
bundled files) and reached through a thin, tool-specific Invocation Shim; the procedure and quality
gates are identical on every tool, and only tool-specific execution enhancements degrade gracefully
([ADR 0003](docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md),
[ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md),
[ADR 0010](docs/adr/0010-repo-layout-canonical-skills-at-root.md)).

### Invoking a Skill

- **Claude Code** — a slash command from the thin shim at `.claude/commands/<name>.md` (e.g.
  `/distill`), which points at the canonical body.
- **Codex / Copilot / Antigravity / Grok Build** — no slash command; these tools read `AGENTS.md` natively, so **the
  documented procedure is the shim**: read and follow the canonical body at `skills/<name>/SKILL.md`.

| Skill | Purpose | Body | ADR(s) |
|-------|---------|------|--------|
| **distill** | Grill a plan against the domain model; capture decisions as a `CONTEXT.md` glossary + `docs/adr/` ADRs. | [SKILL.md](skills/distill/SKILL.md) | [0003](docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md) |
| **assess** | Lifecycle 1 — research an issue, post an assessment with options. | [SKILL.md](skills/assess/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **devise** | Lifecycle 2 — turn the chosen option into an ordered, testing-first plan. | [SKILL.md](skills/devise/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **invoke** | Lifecycle 3 — execute the approved plan, run checks to green, open the PR. | [SKILL.md](skills/invoke/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **verify** | Lifecycle 4 — self-review the PR against its plan before the Reviewer. | [SKILL.md](skills/verify/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **listen** | Review-response — classify review threads by severity, then fix and reply. | [SKILL.md](skills/listen/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **final** | Lifecycle 5 — re-verify green, post the SOW, link it from the issue (never self-merges). | [SKILL.md](skills/final/SKILL.md) | [0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md) |
| **ship** | Hands-off orchestrator sequencing the six lifecycle Skills, honoring the host's gate policy. | [SKILL.md](skills/ship/SKILL.md) | [0005](docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md) |
| **create-skill** | Authoring front door — scaffold a conforming new Skill (body + shim) and open a review PR. | [SKILL.md](skills/create-skill/SKILL.md) | [0019](docs/adr/0019-create-skill-authoring-front-door.md) |

The six lifecycle Skills (`assess`→`devise`→`invoke`→`verify`→`listen`→`final`) each read host values
from [`PROJECT.md`](PROJECT.md) and post to its *Lifecycle Host*; their five-stage spec is
[`docs/standards/development-lifecycle.md`](docs/standards/development-lifecycle.md).

## Rules Layer

Host guidance loads in two tiers so session context stays lean
([ADR 0004](docs/adr/0004-two-tier-rules-layer-progressive-context.md)): **Tier 1 — Lean Core**
(`rules/*.md`, always-resident, each with a **Patterns** + required **Anti-Patterns** section; ships
business-neutral, *extend per host*) and **Tier 2 — Deferred Deep Docs**
(`docs/rules/<domain>-postmortems.md`, not auto-loaded — read on demand when a trigger fires; see
[`docs/rules/README.md`](docs/rules/README.md)). The trigger table binds each tier:

| Working in… | Tier-1 rule (Lean Core) | Tier-2 deep doc (on demand) |
|---|---|---|
| Backend / domain code | [`rules/backend.md`](rules/backend.md) | `docs/rules/backend-postmortems.md` |
| UI / view code | [`rules/frontend.md`](rules/frontend.md) | `docs/rules/frontend-postmortems.md` |
| Tests | [`rules/testing.md`](rules/testing.md) | `docs/rules/testing-postmortems.md` |
| Secrets, auth, or input | [`rules/security.md`](rules/security.md) | `docs/rules/security-postmortems.md` |
| Before-done checklist | [`rules/self-review.md`](rules/self-review.md) | — |
| Bundled / CLI scripts | [`rules/scripting.md`](rules/scripting.md) | `docs/rules/scripting-postmortems.md` |
| Skill bodies + shims | [`rules/skills.md`](rules/skills.md) | `docs/rules/skills-postmortems.md` |

A host binds each role to its own path globs (in `PROJECT.md` or its stack overlay). Claude's
`.claude/rules/` auto-load may mirror the Lean Core; the Generic Baseline keeps a single canonical home
under `rules/` and leaves that projection to a host.

## Quality gate

Before declaring any work in this repository done, run its quality check and get it green:

```
ruby scripts/parity_check.rb
```

A Host App's own checks (tests, linters, security scanners) are declared in
[`PROJECT.md`](PROJECT.md) → *Quality Checks*; run those too when working in a Host App.
