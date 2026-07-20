# PROJECT.md — Project Config

The **Project Config**: the one place a Host App declares its host-specific values so the Skills and
[Canonical Source](AGENTS.md) stay generic. A vendoring Host App edits the values in this file; it
does not edit `AGENTS.md` to change them.

> **Host App: Bryce** — a single-user, AI-and-API-first application (TypeScript on Node) that emails
> a daily digest of the previous day's stats for a personal watch list of baseball players (MLB,
> MiLB, NCAA). MCP server as the primary interface (no web UI), thin REST API alongside, SQLite
> (WAL + Litestream) for storage, Vitest for tests; hosted on the HC's MacBook behind a Cloudflare
> Tunnel. Stack/storage/interface/hosting decisions: ADRs 0025–0028.

> Section headings below are a contract: the parity check (`scripts/parity_check.rb`) asserts each of
> the five `##` sections is present. Rename them and the check fails.

## Quality Checks

The commands an agent must run and get green before declaring work done. The generalized Skills read
this table — they never hardcode a stack's commands.

| Purpose | Command |
|---------|---------|
| Structural parity | `ruby scripts/parity_check.rb` |
| Reviewer summon self-test | `bash scripts/summon_reviewer.test.sh` |
| Branch-guard self-test | `bash .claude/hooks/enforce-branch-creation.test.sh` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests | `npm test` |
| Dependency audit | `npm audit --omit=dev` |

Until the TypeScript application is scaffolded (Phase 1 of the digest build), the npm rows have
nothing to inspect and are reported `not_run` with that stated reason. A check whose command runs
but has nothing applicable to inspect is reported `pass`/`not_run` with a stated reason — checks are
**not applicable, not skipped**, so rigor is unchanged. The structural parity check applies from day
one.

## Attribution & Model Declaration

Single source of truth for agent attribution ([ADR 0007](docs/adr/0007-attribution-includes-model-version-for-audits.md)).
Bump the model here — in one place — when the host switches models. Skills sign with the
**runtime-actual** model when determinable, reconciling against these declared defaults and recording
the actual if they differ. Use human-readable names, never API ids.

| Agent (harness) | Declared model | Identity email |
|-----------------|----------------|----------------|
| Claude Code | `Claude Opus 4.8` | `noreply@anthropic.com` |
| Codex | `GPT-5.6` | `<host sets>` |
| Copilot | `model varies (GPT / Claude / Gemini)` | `<host sets>` |
| Antigravity | `Gemini Flash (host sets model)` | `<host sets>` |
| Grok Build | `Grok (host sets model)` | `<host sets>` |

- **Commit trailer:** `Co-Authored-By: <Tool Model> <email>` — e.g.
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **PR / review / comment footer:** `— <Tool> (<Model>)` — e.g. `— Claude Code (Opus 4.8)`.
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
- **Reviewer (second-model review of plans and PRs):** the **primary** Reviewer is **Codex**
  (harness) running **GPT-5.6** (model — set in Codex settings; per ADR 0024 the harness and model
  are named separately, matching the Attribution table above). The AC summons it — not the HC —
  through the **local Codex CLI**, wrapped by [`scripts/summon_reviewer.rb`](scripts/summon_reviewer.rb).
  These are the **complete, runnable** invocations — every required flag is present, and the summon
  self-test executes these exact lines out of this file, so a command documented here that does not
  run turns the gate red rather than silently failing in a lifecycle run:

```sh
# Plans (Stage 2) - the plan text is piped to the CLI's `exec` subcommand under an
# adversarial plan-critique prompt.
ruby scripts/summon_reviewer.rb --mode plan --input PLAN_FILE --out OUT_FILE --ac AC_NAME

# PRs / work (Stage 4) - the CLI's `review` subcommand reviews the branch's diff against its base.
ruby scripts/summon_reviewer.rb --mode work --base BRANCH --out OUT_FILE --ac AC_NAME
```

  - `PLAN_FILE` — the plan text to critique (plan mode only). `OUT_FILE` — where the review body is
    written; **required in both modes**, and the summon exits 1 with a usage error without it.
    `BRANCH` — the base to review against (default `main`).
  - `AC_NAME` — the **acting agent** (`claude`, `codex`, …). **Always pass it.** It is the only thing
    that makes the `self_review` refusal reachable: the default is `claude`, so a run where Codex is
    the AC would otherwise stage Codex reviewing its own work — the one case the guard exists for.
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
  `self_review` (the acting agent *is* Codex, so it would not be a second model).

  **The fallback trigger is the EXIT STATUS, not the classification list: on ANY non-zero exit the
  AC falls back.** Some failures are not classifications at all — a usage error (a malformed or
  incomplete command) and an unwritable `--out` print to stderr and exit 1 without a classification
  line, and those are among the likeliest failures in practice. A ladder keyed to the named
  classifications alone would leave them unhandled, so the rule is the exit status: `0` = review in
  hand, anything else = fall back.

  **What "fall back" means differs by gate, because the fallback mechanism is PR-scoped.**

  - **Work reviews (Stage 4) — fallback: Copilot.** A requested-reviewer POST on the PR naming
    `Copilot` (the same mechanism the HC used by hand on PR #38, which recorded the timeline event
    `review_requested by wrburgess -> Copilot`). Copilot's declared model is
    `model varies (GPT / Claude / Gemini)`. If Copilot returns nothing either, the gate degrades to
    a flagged missing review in the SOW.
  - **Plan critiques (Stage 2) — no second mechanism exists; a failed plan summon degrades straight
    to a flag.** Copilot code review is requested *on a pull request*.
    At the plan gate **no PR exists** yet — Stage 3 is what opens one, and Stage 3 is blocked on this
    very critique, so the PR fallback cannot serve this gate at all. There is no
    issue-scoped Copilot review to request, so **a failed plan summon flags the missing plan review
    on the issue** and `final` carries that flag into the SOW. Re-running the summon is a retry, not
    a fallback (same CLI, same model, same failure), so it is not counted as one: one retry is
    permitted, and a second non-zero exit flags. **Do not invent a plan-gate fallback in a skill
    body** — a gate that names a mechanism nobody can execute is worse than an honest flag, because
    it reads as covered.

  Under either gate the faithfulness backstop degrades to **flagging the missing review** — never to
  silently skipping it. A skipped Reviewer gate is always visible in the delivered artifact.
- **Human gates (host policy):** this is a single-user host; the baseline's two mandatory human gates
  are tuned as follows.
  - **Plan approval — auto-approved.** `devise` (and `ship`'s Plan phase) still posts the plan to the
    issue as its terminal artifact, but the posted plan is **deemed approved on posting**: work
    proceeds immediately to Implement with no human pause. A mid-implementation re-plan follows the
    same policy (post the revised plan, proceed).

    **This waives the HUMAN wait, not the REVIEWER one.** They are different gates that happen to sit
    at the same point: the plan critique above **blocks the handoff to Implement** until it is
    answered (must-fix findings folded into a posted revision) or its ladder is exhausted (summon
    failed, retried, and the missing plan review flagged on the issue). "Auto-approved" is never a
    licence to start coding with a critique outstanding — every entry point into Stage 3 (`invoke`
    directly, `ship`'s Plan → Implement step, the standard's Stage 3 trigger) states this
    precondition, because a gate that only the skill that *runs* it knows about is one any other door
    walks straight past.
  - **Merge — mandatory.** The one human gate. No agent ever merges; `final` posts the SOW and stops.
    The lifecycle ends with a PR ready for the HC to merge.
  - **Emergency stops are unaffected** — a failing check with no obvious fix, an ambiguous or
    architectural review comment, or an unresolvable `needs_human_call` verdict still stops and asks.

> **Trimmed surfaces (host Customization):** the Generic Baseline's intake pipeline (`scout`, `clip`,
> `follow`, `restock` and the Watchlist / Learnings Log / Manual-drop inbox / Tool Roster artifacts
> under `docs/reference/`) is not vendored in this host — Bryce is an application repo, not a
> config-research repo. The vendored `scripts/parity_check.rb` `REQUIRED_SKILLS` floor and CI workflow
> reflect the trimmed, nine-skill set.
