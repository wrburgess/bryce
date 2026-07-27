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
| Tests | `npm run test:coverage` |
| Dependency audit | `npm run audit` |

The **Tests** row runs `npm run test:coverage` — the same offline suite as `npm test`, plus the
coverage report and `scripts/coverage-floors.ts`, which fails when a floored file drops below its
per-file minimum or stops being measured at all ([#28](https://github.com/wrburgess/bryce/issues/28)).
Plain `npm test` remains the fast local loop while iterating; the coverage command is what closes out
the gate, and it is what CI runs.

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
    every AC harness; same harness plus known, distinct models is an independent review. The script
    never defaults or infers an actor, accepts only the declared harnesses (`claude`, `codex`,
    `copilot`, `antigravity`, or `grok-build`; `claude-code` is an alias), and normalizes their
    spelling before checking independence.
  - `--min-bytes N` (default 200) sets the substance floor below which stdout is not a review;
    `--timeout SECONDS` (default 900) caps the wall clock. Neither is normally passed.

  The GitHub-app precondition is **gone**: the CLI runs locally against the HC's own Codex session,
  so nothing needs installing on the repository. The summon script itself makes **no network call and
  no lifecycle-host call** — it writes the review body to a file and classifies the outcome; the AC
  posts it. That keeps token handling out of the bundled script and makes every failure mode
  testable offline (`bash scripts/summon_reviewer.test.sh`).
  - **Reviewer evidence.** A successful CLI summon is only an artifact body, not a PR review by
    itself. The AC posts that body as a new PR comment, records its resulting comment URL, and verifies
    that `HEAD` still equals the SHA captured immediately before the summon. The PR must then contain
    one compact, machine-locatable `Reviewer Evidence` block with: `request-marker`, `reviewed-sha`,
    `baseline`, `reviewer`, `reviewer-model`, `disposition`, and `artifact-url`. The request marker
    identifies the particular summon attempt; the baseline is the exact review base (normally
    `origin/main`, or the prior reviewed SHA for a delta). `final` rejects missing, malformed, or stale
    evidence rather than treating a local transcript as sufficient provenance.
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
  apply. The invocation supplies the actual selected CLI model; no attribution table provides it. A
  runner with no request mechanism or artifact is `unreachable`; a request with no response by its
  declared deadline is `timed-out`. An asynchronous success is usable only with trustworthy
  `commit_id` evidence for the reviewed SHA; otherwise it fails closed.
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

How [`final`](skills/final/SKILL.md) and [`listen`](skills/listen/SKILL.md) handle the Rules-Layer /
config improvements they learn during implementation. Its shipped default is `present-to-hc`; allowed
values `autonomous-fold | present-to-hc`. This is a **documentary** value — prose, **not** a third row
in the gate table above (the parser reads a two-row table and must stay two-row), so it is changed by
editing this paragraph. The four outcomes below are the **menu**; they are *not* additional allowed
values of this setting — `scripts/human-gates.ts` pins the range to the two above and the parity check
hard-fails anything else.

**Every rule suggestion resolves to exactly one of four outcomes.** This section once offered two —
fold or defer — and neither of them was "drop it", so nothing was ever dropped and the corpus grew by
~2 permanent Tier-1 bullets per shipped issue ([#185](https://github.com/wrburgess/bryce/issues/185)).

1. **Enforce** — write the guard and its regression test. The default for any mechanically checkable
   invariant.
2. **Retain a concise rule** — only where the invariant needs human judgment or encodes a non-obvious
   threat model. Must record: the triggering failure and its severity, *why a guard alone is
   insufficient*, the consuming task, and **either an enforcing artifact or an existing bullet retired
   in exchange**.
3. **Record as an expiring finding** — in the findings log described below.
4. **Do nothing** — the outcome that did not exist before, and the reason the corpus only grew.

**What this setting governs, and what it never governs.** It decides the fate of the **Rules-Layer or
config artifact**: a rule bullet, a config edit. It has never governed the **defect fix, its guard, or
its regression test**, none of which is Rules Layer or config. Those are ordinary implementation work
inside the PR, already backed by the merge gate — so **outcome 1 is available under both values,
without approval**. Only outcome 2, the prose, waits on the setting.

**A high-severity first occurrence takes outcome 1 immediately** — fix, guard, test, in this PR, under
either setting. `final`'s requirement that every Critical and High finding be resolved before the SOW
outranks this setting. A flat wait-for-recurrence rule would have deferred [#163](https://github.com/wrburgess/bryce/issues/163), a fail-open
containment guard.

- **`autonomous-fold`** — `final` picks the outcome and acts on it: an outcome 1 or 2 is **folded** into
  the **same PR a human merges**, so the merge gate stays the backstop for it, and a large or
  contentious one is **deferred** to a tracked follow-up recorded in the SOW. The discretion bar:
  well-scoped **and** low-risk → fold; large **or** contentious → defer.
- **`present-to-hc`** (shipped default) — `final` picks a **recommended** outcome and **presents** it,
  editing no Rules Layer or config without approval. Per suggestion it records that recommendation and
  the state `pending HC decision` in the SOW; a `pending` row never blocks the SOW, because presenting
  it **is** what this setting delivers. The HC's selection is captured as a reply on the PR — no new
  artifact. An approved outcome 1 or 2 is applied **in that PR**, which moves `HEAD` and re-anchors the
  backstop below, unless the HC elects to defer it. A `pending` row the HC never answers is answered by
  the merge itself, and defaults to outcome 4.

**The findings log (outcome 3).** A single append-only log at `docs/findings-log.md` — deliberately one
file and *not* one issue per finding, because an issue per finding is the accretion this section exists
to stop. Following this repository's absent-until-needed convention for deep docs, it is **created when
the first finding is recorded**, never as an empty placeholder. Each entry carries: normalized failure
class · severity and blast radius · enforcement status · recurrence count · the PR or issue that
surfaced it · date recorded · **review date, written absolute, = date recorded + 90 days**. An entry is
**active** until it is moved under the log's `## Archived` heading, and **archived** once it is; that
heading is the whole boundary, and nothing under it is ever due again. The HC is its reviewer, inside a
corpus review; independently of that, **`final` sweeps the log at the start of its disposition step** and
processes every **active** entry whose review date has passed — an entry recorded once and never met
again must not be able to sit here indefinitely, which would be this section's own accretion in slower
form. At the review date: recurrence `0` and nothing having cited it → **archive** the entry (move it
under `## Archived` — do not delete, because the record of what was considered and dropped is the point);
recurrence `≥ 1` → it becomes eligible for outcome 1 or 2 and enters that run's disposition. **The default
at expiry is archival, never promotion**, so an unattended finding shrinks the corpus rather than growing
it.

**A due entry never survives its own sweep as active — whichever branch it takes.** It is archived on no
recurrence; archived **with a pointer to what it became** when it is promoted and that outcome is applied;
and archived as *presented; outcome 4 unless a resumed pass records otherwise* — the **same wording** the
paragraph below requires — when a `pending HC decision` row is still open. Only entries whose
review date has not yet passed stay active. Bounding just the archived side would leave the promotion side
unbounded — a promoted entry that is presented, never answered, and defaults to *do nothing* would still
be active, still carry the same past review date, and be re-presented identically by every later `final`
run: the same re-report-forever failure this outcome exists to prevent, one branch over.

**The pending row is archived by the run that presents it, not by the merge.** Merge is the last event in
the lifecycle — no stage runs after it — so a rule that waited for the merge to close the entry would
never execute, and the entry would stay active forever. So `final` archives it **in the run that presents
it**, with the disposition recorded as *presented; outcome 4 unless a resumed pass records otherwise* — a
line that is already correct if no answer ever comes, so it never reads as stale. Archival records that an
entry was **considered**, never that it was resolved a particular way, so nothing is misfiled by archiving
before the answer arrives.

**An HC decision on a `pending` row re-opens `final` as a new pass.** `final` posts its SOW and ends, and a
`pending` row deliberately does not block that, so an approval arrives with no run in flight to apply it —
it cannot be handled "in the same run", and treating it as an edit would slip a change past the backstop.
The resumed pass applies the outcome, re-runs the *Quality Checks*, **re-anchors the Reviewer backstop on
the resulting commit** (it moved `HEAD` past the reviewed SHA like any other late change), and reposts the
SOW with the entry's pointer updated. **No approved post-SOW change reaches merge without Reviewer
evidence covering it.** If no decision arrives, nothing resumes and the row inherits outcome 4 at merge.

**The trigger is the HC's reply itself** — there is no automation watching for it, and none is implied. The
HC invokes a resumed pass the way any stage is invoked; the reply is what makes one *owed*, not what
performs it. This is why the archived line must be correct **before** the answer arrives: an unanswered
row is the expected steady state, not a dropped one.

**A later recurrence opens a NEW entry** citing the archived one, rather than reviving it — archival stays
terminal without discarding genuine recurrence signal, and the new entry's recurrence count carries
forward so a finding that keeps coming back visibly escalates toward outcome 1.

**The recursion bound.** Any post-`verify` change that moves `HEAD` past the reviewed SHA triggers a
delta review — an `autonomous-fold`, an HC-approved fold under `present-to-hc`, a `listen` fix, or a
high-severity containment fix. `final` re-anchors the backstop across it: it compares the reviewed
commit SHA recorded by `verify` against `HEAD` and, when they differ, re-summons the Reviewer on the
delta; if that chain is exhausted the floor applies and no SOW is written. **A rule suggestion arising
from such a delta review may not be resolved by outcome 2** — it resolves to outcome 1, 3, or 4 only.
Without that, fold → delta review → fold still runs even with four outcomes available. The bound
governs the growth of Tier-1 prose and nothing else: `final`'s duty to resolve every Critical and High
delta finding is unchanged and outranks it, and outcome 1 stays available at every depth, which is what
makes the bound safe to state absolutely. The SOW records, per delta review, the commit that triggered
it and the reviewed SHA it was based on, so the chain is reconstructable from the PR alone.

**Minting freeze.** No new Tier-1 rule bullet until this gate is live. The freeze **lifts** when (a) the
four-outcome disposition is in this file and in both skill bodies, and (b) a bounded corpus review has
dispositioned the 45 loop-added bullets measured in [#185](https://github.com/wrburgess/bryce/issues/185). An open-ended freeze is the same failure mode
inverted, so its exit is named up front.

This setting governs only the rule-suggestion step of `final` and `listen`; it does not touch
`create-skill`'s review-PR gate.
