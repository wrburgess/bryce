# PROJECT.md — Project Config

The **Project Config**: the one place a Host App declares its host-specific values so the Skills and
[Canonical Source](AGENTS.md) stay generic. A vendoring Host App edits the values in this file; it
does not edit `AGENTS.md` to change them.

> **Host App: Bryce** — a single-user Rails 8 application that emails a daily digest of the previous
> day's stats for a personal watch list of baseball players (MLB, MiLB, NCAA). Solid Queue for jobs,
> Hotwire for interactivity, Bootstrap 5 for styling, SQLite for storage, Minitest for tests.

> Section headings below are a contract: the parity check (`scripts/parity_check.rb`) asserts each of
> the five `##` sections is present. Rename them and the check fails.

## Quality Checks

The commands an agent must run and get green before declaring work done. The generalized Skills read
this table — they never hardcode a stack's commands.

| Purpose | Command |
|---------|---------|
| Structural parity | `ruby scripts/parity_check.rb` |
| Lint | `bin/rubocop` |
| Tests | `bin/rails test` |
| Security scan | `bin/brakeman --no-pager -q` |
| Dependency audit | `bin/bundler-audit check --update` |

Until the Rails application is scaffolded (Phase 1 of the digest build), the Rails rows have nothing
to inspect and are reported `not_run` with that stated reason. A check whose command runs but has
nothing applicable to inspect is reported `pass`/`not_run` with a stated reason — checks are **not
applicable, not skipped**, so rigor is unchanged. The structural parity check applies from day one.

## Attribution & Model Declaration

Single source of truth for agent attribution ([ADR 0007](docs/adr/0007-attribution-includes-model-version-for-audits.md)).
Bump the model here — in one place — when the host switches models. Skills sign with the
**runtime-actual** model when determinable, reconciling against these declared defaults and recording
the actual if they differ. Use human-readable names, never API ids.

| Agent (harness) | Declared model | Identity email |
|-----------------|----------------|----------------|
| Claude Code | `Claude Fable 5` | `noreply@anthropic.com` |
| Codex | `GPT (host sets model)` | `<host sets>` |
| Copilot | `model varies (GPT / Claude / Gemini)` | `<host sets>` |
| Antigravity | `Gemini Flash (host sets model)` | `<host sets>` |
| Grok Build | `Grok (host sets model)` | `<host sets>` |

- **Commit trailer:** `Co-Authored-By: <Tool Model> <email>` — e.g.
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **PR / review / comment footer:** `— <Tool> (<Model>)` — e.g. `— Claude Code (Fable 5)`.
- Attribution shows **per-agent identity** so provenance reflects which agent did the work. The
  *Agent* column names the **harness** (Claude Code · Codex · Copilot · Antigravity · Grok Build); the *Declared
  model* column names the **model** it runs — never the harness — per the naming convention in
  [ADR 0024](docs/adr/0024-harness-model-naming-convention.md). Copilot's backing model is
  variable/unknown, so its declared model reads `model varies (GPT / Claude / Gemini)`.

## Branch & PR Policy

- **Protected branches:** `main`, `master`, `develop` — this backticked list (everything up to the
  em dash) is the **authored source** the guardrails derive from. Never commit or push directly to a
  protected branch; agents work on feature branches. A host may trim or extend the backticked list,
  then run `bin/install-git-hooks` to regenerate the derived sidecar `.githooks/protected-branches`.
  Enforcement (git hooks + per-tool fast-fail) is delivered by the guardrails baseline
  ([ADR 0009](docs/adr/0009-defense-in-depth-branch-protection-all-agents.md)) and sources this list.
- **Branch naming:** `feature/` · `fix/` · `chore/` · `docs/` prefixes (host may extend).
- **One PR per branch**, opened ready-for-review (not draft).
- **Issue linking:** `Closes #N` for a leaf issue; `Part of #N` (no closing keyword, even negated) for
  an umbrella/epic sub-PR — see `AGENTS.md` → *Umbrella sub-PRs and closing keywords*.
- **Feature-branch autonomy:** commit/edit/refactor without asking on a feature branch; ask before any
  change to a protected branch.

## Review Severity Framework

Generic starter severities for `verify`/`listen`/`final` and human review. A Host App tunes the
definitions.

| Severity | Meaning | Disposition |
|----------|---------|-------------|
| **Critical** | Data loss, security hole, breaks protected-branch or auth invariants, or ships broken. | Block merge; fix before proceeding. |
| **High** | Correctness bug, missing required test, or a violated project rule. | Fix in this PR before merge. |
| **Medium** | Maintainability, clarity, or a smaller coverage gap. | Fix now or file a tracked follow-up. |
| **Low** | Style, naming, or optional polish. | Author's discretion. |

## Lifecycle Host

- **Host platform:** `GitHub` (default). The issue/PR verbs the Skills use are isolated so a Host App
  on another platform (e.g. GitLab) can remap the artifact targets without rewriting skill bodies
  ([ADR 0006](docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
- **Artifact map:** assessments/plans → issue comments; implementation → a PR; SOW → a PR comment.
- **Copilot adapter mode:** `native` (Generic Baseline default) — Copilot reads `AGENTS.md` natively
  and `.github/copilot-instructions.md` is a discovery marker. Set to `render` (a byte-for-byte
  `parity:render` block in `.github/copilot-instructions.md`) only if the host drives work through a
  legacy in-editor Copilot IDE; the parity check enforces the render matches `AGENTS.md`.
- **Human gates (host policy):** this is a single-user host; the baseline's two mandatory human gates
  are tuned as follows.
  - **Plan approval — auto-approved.** `devise` (and `ship`'s Plan phase) still posts the plan to the
    issue as its terminal artifact, but the posted plan is **deemed approved on posting**: work
    proceeds immediately to Implement with no human pause. A mid-implementation re-plan follows the
    same policy (post the revised plan, proceed).
  - **Merge — mandatory.** The one human gate. No agent ever merges; `final` posts the SOW and stops.
    The lifecycle ends with a PR ready for the HC to merge.
  - **Emergency stops are unaffected** — a failing check with no obvious fix, an ambiguous or
    architectural review comment, or an unresolvable `needs_human_call` verdict still stops and asks.

> **Trimmed surfaces (host Customization):** the Generic Baseline's intake pipeline (`scout`, `clip`,
> `follow`, `restock` and the Watchlist / Learnings Log / Manual-drop inbox / Tool Roster artifacts
> under `docs/reference/`) is not vendored in this host — Bryce is an application repo, not a
> config-research repo. The vendored `scripts/parity_check.rb` `REQUIRED_SKILLS` floor and CI workflow
> reflect the trimmed, nine-skill set.
