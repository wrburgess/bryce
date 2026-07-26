# PROJECT.md — Project Config

The **Project Config**: the one place a Host App declares its host-specific values so the Skills and
[Canonical Source](AGENTS.md) stay generic. A vendoring Host App edits the values in this file; it
does not edit `AGENTS.md` to change them.

> **Host App: Bryce** — a single-user, AI-and-API-first application (TypeScript on Node) that emails
> a daily digest of the previous day's stats for a personal watch list of baseball players (MLB,
> MiLB, NCAA). MCP server as the primary interface (no web UI), thin REST API alongside, SQLite
> (WAL + Litestream) for storage, Vitest for tests; hosted on the HC's MacBook behind a Cloudflare
> Tunnel. Stack/storage/interface/hosting decisions: ADRs 0025–0028.

> Section headings below are a contract: the parity check (`scripts/parity-check.ts`) asserts each of
> the six `##` sections is present. Rename them and the check fails. *Human Gates* additionally has
> its **values** checked, not just its heading — see that section.

## Quality Checks

The commands an agent must run and get green before declaring work done. The generalized Skills read
this table — they never hardcode a stack's commands.

| Purpose | Command |
|---------|---------|
| Structural parity | `npx tsx scripts/parity-check.ts` |
| Reviewer summon self-test | `bash scripts/summon_reviewer.test.sh` |
| Branch-guard self-test | `bash .claude/hooks/enforce-branch-creation.test.sh` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests | `npm test` |
| Dependency audit | `npm run audit` |

The dependency audit runs through **audit-ci** (`npm run audit`, config `audit-ci.jsonc`) rather than
raw `npm audit`, so a reviewed, non-exploitable advisory can be allowlisted with a documented reason
([#51](https://github.com/wrburgess/bryce/pull/51)) instead of failing the gate — and this is the
exact command CI runs (`.github/workflows/app.yml`).

The TypeScript application is scaffolded (the `src/` tree ships), so the npm rows — typecheck, lint,
tests, dependency audit — are **active checks** an agent runs and gets green before declaring work
done, alongside the structural parity check that applies from day one. If a specific change touches
nothing a given check inspects, that check may report `pass`/`not_run` with a stated reason — checks
are **not applicable, not skipped**, so rigor is unchanged.

## Attribution & Model Declaration

Identity-email mapping for agent attribution ([ADR 0007](docs/adr/0007-attribution-includes-model-version-for-audits.md),
[ADR 0049](docs/adr/0049-runtime-actual-attribution-supersedes-mutable-model-defaults.md)). Skills sign
with the human-readable **runtime-actual** model, never an API id. If it cannot be determined, record
the literal `unknown`; never invent or fall back to a configured model.

| Agent (harness) | Identity email |
|-----------------|----------------|
| Claude Code | `noreply@anthropic.com` |
| Codex | `<host sets>` |
| Copilot | `<host sets>` |
| Antigravity | `<host sets>` |
| Grok Build | `<host sets>` |

- **Commit trailer:** `Co-Authored-By: HARNESS MODEL <EMAIL>` — e.g.
  `Co-Authored-By: Claude Code Opus 4.8 <noreply@anthropic.com>`; an unavailable model is
  `Co-Authored-By: Claude Code unknown <noreply@anthropic.com>`.
- **PR / review / comment footer:** `— HARNESS (MODEL)` — e.g. `— Claude Code (Opus 4.8)` or
  `— Claude Code (unknown)`.
- Attribution shows **per-agent identity** so provenance reflects which harness did the work. The
  table maps each **harness** (Claude Code · Codex · Copilot · Antigravity · Grok Build) to its identity
  email; the model comes only from the runtime artifact, per the naming convention in
  [ADR 0024](docs/adr/0024-harness-model-naming-convention.md).

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
- **Reviewer (second-model review of plans and PRs):** the AC exhausts the available independent
  harnesses before involving the HC. The first rung is **Codex**, using an explicitly selected model
  distinct from the acting model (the shipped alternate is `gpt-5.6-terra`). If the AC is Codex,
  that is a different-model review, not self-review. The AC summons it — not the HC — through the
  **local Codex CLI**, wrapped by [`scripts/summon-reviewer.ts`](scripts/summon-reviewer.ts).
  These are the **complete, runnable** invocations — every required flag is present, and the summon
  self-test executes these exact lines out of this file, so a command documented here that does not
  run turns the gate red rather than silently failing in a lifecycle run:

```sh
# Plans (Stage 2) - the plan text is piped to the CLI's `exec` subcommand under an
# adversarial plan-critique prompt.
npx tsx scripts/summon-reviewer.ts --mode plan --input PLAN_FILE --out OUT_FILE --ac AC_NAME --ac-model AC_MODEL --reviewer-model REVIEWER_MODEL

# PRs / work (Stage 4) - the CLI's `review` subcommand reviews the branch's diff against its base.
npx tsx scripts/summon-reviewer.ts --mode work --base BRANCH --out OUT_FILE --ac AC_NAME --ac-model AC_MODEL --reviewer-model REVIEWER_MODEL
```

  - `PLAN_FILE` — the plan text to critique (plan mode only). `OUT_FILE` — where the review body is
    written; **required in both modes**, and the summon exits 1 with a usage error without it.
    `BRANCH` — the base to review against (default `main`).
  - `AC_NAME` / `AC_MODEL` — the **acting harness and runtime-actual model** (for example,
    `codex` / `gpt-5.6`). `REVIEWER_MODEL` is the model the Codex CLI must use (normally
    `gpt-5.6-terra`). **Always pass all three.** The script refuses unknown or matching models for
    every AC harness; same harness plus known, distinct models is an independent review.
  - `--min-bytes N` (default 200) sets the substance floor below which stdout is not a review;
    `--timeout SECONDS` (default 900) caps the wall clock. Neither is normally passed.

  The GitHub-app precondition is **gone**: the CLI runs locally against the HC's own Codex session,
  so nothing needs installing on the repository. The summon script itself makes **no network call and
  no lifecycle-host call** — it writes the review body to a file and classifies the outcome; the AC
  posts it. That keeps token handling out of the bundled script and makes every failure mode
  testable offline (`bash scripts/summon_reviewer.test.sh`).
  - **Reviewer failure ladder.** The summon classifies its outcome as `ok` or one of eight failures —
  `not_found` (no Codex CLI on PATH), `not_authenticated` (`login status` did not confirm a
  session), `exit_nonzero` (the CLI failed), `empty_output` (exit 0 but no review text),
  `insufficient_output` (exit 0 with a body below the substance floor — a banner or a one-line bail,
  not a review), `drain_timeout` (the CLI finished but its output could not be read to EOF, so the
  review was lost rather than absent), `timeout` (no review inside the wall-clock cap),
  `self_review` (the acting and reviewer model identifiers match, or either is `unknown`; an
  unverified identity cannot establish independent review).

  **The fallback trigger is the EXIT STATUS, not the classification list: `0` = review in hand; any non-zero exit = try the next independent Reviewer.** Some failures are not classifications at all
  — a usage error (a malformed or incomplete command) and an unwritable `--out` print to stderr and
  exit 1 without a classification line, and those are among the likeliest failures in practice.
  The AC must make these attempts in order, skipping only a runner that is unavailable in the current
  environment: (1) Codex with a model distinct from the AC; (2) Claude Code with a model distinct
  from the AC; (3) Copilot with a distinct selected model; (4) Antigravity/Gemini with a distinct
  selected model. For a plan, each runner must return a critique directly (a requested PR reviewer is
  not a valid plan fallback); for work, it may post or return a review. Record every failed rung and
  the harness/model that answered. Only after all available rungs fail does the degradation floor
  apply. The invocation supplies the actual selected CLI model; no attribution table provides it.
- **Reviewer degradation floor:** `stop-and-ask` — what happens when the whole Reviewer chain is
  exhausted. **This value is not configurable**: `stop-and-ask` is its only allowed value and the
  parity check hard-fails any other, on the same footing as the merge gate. A run that cannot obtain
  an independent review **must not be able to certify itself** — the AC stops and asks the HC rather
  than delivering unreviewed with a footnote. This affirms the faithfulness backstop of
  [ADR 0005](docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md) (which
  already said "stop and ask") and is recorded in
  [ADR 0044](docs/adr/0044-human-gates-autonomous-fold-and-stop-and-ask-floor.md).
- **Human gates:** declared in their own section — see [*Human Gates*](#human-gates) below.

> **Trimmed surfaces (host Customization):** the Generic Baseline's intake pipeline (`scout`, `clip`,
> `follow`, `restock` and the Watchlist / Learnings Log / Manual-drop inbox / Tool Roster artifacts
> under `docs/reference/`) is not vendored in this host — Bryce is an application repo, not a
> config-research repo. The vendored `scripts/parity-check.ts` `REQUIRED_SKILLS` floor and CI workflow
> reflect the trimmed, nine-skill set.

## Human Gates

Which lifecycle pauses require a human, declared **here** so a generic Skill body names the *gate*
instead of asserting a policy as fact. This host is single-user and ships **ungated to merge**: plan
approval is `auto`, so a hands-off `ship` run drives itself to the one standing human gate. **Merge
stays `required` and is never configurable** — it is the sole human gate
([ADR 0044](docs/adr/0044-human-gates-autonomous-fold-and-stop-and-ask-floor.md)).

| Gate | Setting | Allowed values |
|------|---------|----------------|
| **Plan approval** — the Stage-2 plan approval and the Stage-1 option pick | `auto` | `required` · `auto` |
| **Merge** — the HC merges the delivered PR | `required` | `required` (not configurable) |

- **`auto`** (this host's setting) — the AC proceeds on **its own stated recommendation** rather than
  waiting. It still **posts** the assessment and the plan to the lifecycle host — under `auto` those
  comments are the *only* durable audit trail of what was decided, so posting them becomes more
  load-bearing, not less.
- **`required`** — a host may set the **plan-approval** row (and only that row) back to `required`.
  The AC then stops and waits: it does not proceed past the assessment without a chosen option, and
  it does not write code without an approved plan. Every Skill body states **both** branches, so
  flipping this cell changes behavior without editing a skill.
- **Merge is not configurable.** `required` is the only allowed value: **no Host App may express
  self-merge.** The parity check hard-fails any other value. `final` posts the SOW; a human merges.

**These four declarations are value-checked, not merely present.** The parity check parses both gate
rows, the *Reviewer degradation floor* bullet under *Lifecycle Host*, and the disposition below, and
rejects a declaration that is missing, unparseable (e.g. a value written without backticks),
duplicated, or out of range — so an unsafe setting can never hide behind a fail-closed default.

**The two independent Reviewer gates are the plan and the PR.** The AC-runnable summon
([`scripts/summon-reviewer.ts`](scripts/summon-reviewer.ts)) has a `--mode plan` (Stage 2) and a
`--mode work` (Stage 4) and no assess mode. So the **Stage-1 assessment** is posted for the audit
trail and open to HC comment, but it is **not** a separate independent-review gate — a hands-off
`auto` run reaches the plan gate as its first independent review, and no lifecycle stage claims a
Reviewer summons that cannot be run. The Stage-1 **option pick** rides the *Plan approval* gate above:
under `auto` the AC proceeds on its own recommended option, under `required` the HC picks.

**Unconditional, whatever this section says:**

- **Merge is always human** (above), and the **Reviewer degradation floor** stays `stop-and-ask`.
- **`ship`'s emergency stops** — an unresolvable check failure; a discovery that the change touches
  core logic the plan did not anticipate; an architectural or ambiguous review comment; a handoff
  verdict the orchestrator cannot resolve — always stop and ask the HC.
- **`create-skill`'s "a human disposes" gate** ([ADR 0019](docs/adr/0019-create-skill-authoring-front-door.md))
  is out of scope: `auto` is **not** licence to auto-merge its review PR.

### Rule-suggestion disposition

How [`final`](skills/final/SKILL.md) handles the Rules-Layer / config improvements it learns during
implementation, now that a hands-off run reaches the merge gate on its own. Its shipped default is
`autonomous-fold`; allowed values `autonomous-fold | present-to-hc`. This is a **documentary** value —
prose, **not** a third row in the gate table above (the parser reads a two-row table and must stay
two-row), so it is changed by editing this paragraph.

- **`autonomous-fold`** (shipped default) — `final` **folds** well-scoped, low-risk Rules-Layer/config
  improvements into the **same PR a human merges**, so the merge gate stays the backstop for them, and
  **defers** large or contentious ones to a follow-up issue recorded in the SOW. The discretion bar:
  well-scoped **and** low-risk → fold; large **or** contentious → defer.
- **`present-to-hc`** — `final` **presents** the suggestions to the HC and waits, editing no Rules
  Layer or config without approval.

A fold changes the diff **after** `verify` closed the Reviewer summons, so `final` re-anchors the
backstop: it compares the reviewed commit SHA recorded by `verify` against `HEAD` and, when they
differ, re-summons the Reviewer on the delta. If that chain is exhausted, the floor applies and no
SOW is written. This value governs only `final`'s rule-suggestion step; it does not touch
`create-skill`'s review-PR gate.
