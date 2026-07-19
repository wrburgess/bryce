# 2026-07-19 — First vendoring of the baseline (bryce PR #1)

Findings from the first-ever vendoring of the ai-config Generic Baseline into a Host App
(bryce PR [#1](https://github.com/wrburgess/bryce/pull/1): vendor + trim + re-architecture session).
Evidence for all entries is the PR's two commits.

## F1 — Gate policy is fixed prose in skill bodies, not a Project Config value

**Disposition: `upstream` · Status: filed ([ai-config#94](https://github.com/wrburgess/ai-config/issues/94))**

The HC's host policy for Bryce is "plan approval auto-approved; merge is the only human stop." The
baseline hardcodes "two human gates, never bypassed" as prose in **four places** — `skills/ship`,
`skills/devise`, `docs/standards/development-lifecycle.md`, and `AGENTS.md` — so expressing a
different gate policy required forking all four vendored files. That is exactly the drift ADR
0002/0003 exist to prevent ("host values flow through PROJECT.md, never by editing the baseline").
Gate policy is a host value; PROJECT.md → *Lifecycle Host* should carry a *Human gates* declaration
(e.g. `plan-approval: required | auto`, `merge: required` — merge plausibly non-configurable) that
the skills and the lifecycle standard read.

## F2 — Vendored CI workflow is red out of the box

**Disposition: `upstream` · Status: filed ([ai-config#95](https://github.com/wrburgess/ai-config/issues/95))**

`.github/workflows/parity.yml` runs six self-tests from `test/`, but `ai-config-sync` deliberately
never vendors `test/`. Any host that vendors the bundle and pushes gets a failing CI run on day one.
Bryce rewrote the workflow down to the two checks a host actually ships (the enforce-hook self-test
and `scripts/parity_check.rb`). The baseline should ship a host-ready workflow (or have the sync
script transform/exclude it).

## F3 — The intake pipeline is not cleanly detachable

**Disposition: `upstream` · Status: filed ([ai-config#96](https://github.com/wrburgess/ai-config/issues/96))**

An application host has little use for the intake pipeline, but trimming it required coordinated
edits across `scripts/parity_check.rb` (`REQUIRED_SKILLS`), `AGENTS.md` (skill table + count),
`docs/guides/usage.md`, `CONTEXT.md` (three vocabulary sections + relationships), `PROJECT.md`
(two whole sections), the CI workflow, and dead-link cleanup in unexpected places (`ADR 0020` and
`ADR 0024` link into `docs/reference/`; the `distill` skill's Provenance links the Watchlist).
A supported trim path — an `ai-config-sync --without intake` profile or a documented trim manifest —
would make the common case safe and mechanical.

## F4 — No bootstrap path for vendoring into an empty repository

**Disposition: `upstream` · Status: filed ([ai-config#97](https://github.com/wrburgess/ai-config/issues/97))**

Bryce was a zero-commit repository: no default branch existed, so a feature-branch push would have
become the default branch and no PR base would exist. The workaround (empty root commit on `main`,
then branch) worked but is undocumented, and it collides with the branch-protection policy's
"never push to a protected branch" the moment the guardrails come up. The usage guide should
document the sanctioned bootstrap sequence (or `ai-config-sync` grow an `--init` mode).

## F5 — Bundle glossary vs. host domain glossary collision

**Disposition: `upstream` · Status: filed ([ai-config#98](https://github.com/wrburgess/ai-config/issues/98))**

The vendored `CONTEXT.md` is the *bundle's own* vocabulary (Config Bundle, Adapter, Skill…), parked
at the exact path where the host's `distill` sessions want to grow the *host domain* glossary. Bryce
plans the `CONTEXT-MAP.md` multi-context split from `distill`'s format spec, but the baseline never
says which context the vendored file is or where a host's domain glossary should live. One paragraph
of guidance in the usage guide (and/or the distill format spec) closes it.

## F6 — Host-only decisions (recorded to make the boundary explicit)

**Disposition: `host-only` · Status: recorded (deliberately not upstreamed)**

- The gate-policy **value** chosen (auto-approved plan gate) — the *mechanism* is F1; the value is
  Bryce's. A team host would likely keep both gates.
- TypeScript/SQLite/MCP-first/MacBook-Tunnel architecture (ADRs 0025–0028) and npm quality-check
  commands — host stack picks, expressed in PROJECT.md exactly as designed.
- Declared-model bump to `Claude Fable 5` — routine PROJECT.md customization, works as intended.

## F7 — TypeScript overlay seed

**Disposition: `overlay` · Status: recorded**

As Bryce's TS patterns settle (Zod-at-the-boundary, Drizzle schema conventions, Vitest idioms,
provider-agnostic mailer), they should be captured as an `ai-config-typescript` Stack Overlay seed
mirroring `docs/overlays/ai-config-rails.md` — not pushed into the stack-neutral baseline.

## F8 — Auto-approving the plan gate silently removes `ship`'s context firebreak

**Disposition: `upstream` · Status: filed (constraint comment on [ai-config#94](https://github.com/wrburgess/ai-config/issues/94#issuecomment-5016880327))**

`ship` fights context rot by treating its two human gates as **session boundaries**: waiting for
plan approval naturally forced a fresh context before the implement churn. A host that sets the
plan gate to auto-approve (Bryce) loses that firebreak as a side effect — `ship` can now flow from
plan straight into implementation in one ever-growing context, with nothing enforcing the boundary.
The gate-as-*boundary* should survive the gate-as-*approval* being waived: the skill (and the
lifecycle standard's ship section) should state that on an auto-approved plan gate, "plan posted"
remains a hard session boundary — the implement phase starts by re-reading the posted plan from the
issue, never by continuing on conversational memory; likewise the pre-`final` context check.
Related to F1 (ai-config#94): if gate policy becomes a PROJECT.md value, this is the caveat the
`auto` branch must carry. Bryce adopts this as self-imposed practice immediately.

## F9 — The Reviewer role has no wired invocation path per tool

**Disposition: `upstream` · Status: filed ([ai-config#99](https://github.com/wrburgess/ai-config/issues/99))**

The lifecycle's Reviewer role ("a different model from the AC") assumes the Reviewer can actually be
summoned, but the baseline documents no per-tool invocation path. Field test on bryce PR #1: a
`@codex review` mention did nothing (the Codex GitHub app wasn't installed on the repo — silently, no
error), while a Copilot review was requestable mechanically via the GitHub API. In a hands-off `ship`
run the AC, not the HC, needs to summon the Reviewer, so the baseline should (a) document each
configured agent's review-invocation mechanism and its preconditions (app installation, API
availability), and (b) name the fallback order in PROJECT.md → *Lifecycle Host* so the faithfulness
backstop degrades predictably instead of silently (a mention that no app receives looks identical to
a pending review). *Bryce's host answer (2026-07-19):* Reviewer declared in PROJECT.md → *Lifecycle
Host* — primary Codex (GPT-5.6) for plans and PRs, fallback Copilot code review, degrade to a
flagged SOW; Codex app installation on the repo is the HC precondition.

## F10 — Repo-centric self-references survive vendoring and mislead in a host clone

**Disposition: `upstream` · Status: filed ([ai-config#100](https://github.com/wrburgess/ai-config/issues/100); fix PR [ai-config#101](https://github.com/wrburgess/ai-config/pull/101), which also addresses #95/#97/#98)** — surfaced by Copilot's second-model review of bryce PR #1

Two vendored files speak from the upstream repo's perspective and become wrong in a host: the usage
guide's §1/§6 say "from a clone of this repo" while instructing `ruby bin/ai-config-sync` — a script
deliberately never vendored, so the command is unrunnable from a host clone; and
`.claude/hooks/enforce-branch-creation.test.sh`'s header cites coverage by
`test/guard_protected_branch.test.sh`, a file from the un-vendored `test/` tree. Bryce reworded both
locally. Upstream fix: write vendored prose host-aware ("from a clone of upstream ai-config", "covered
upstream by…") so the same sentence is true in both repos — same family as ai-config#95 (un-vendored
`test/` references) but in docs/comments rather than CI. Meta-note: both were caught by the
independent second-model review, not by self-review — evidence the faithfulness backstop earns
its keep.

## What worked (signal, not just friction)

`ai-config-sync` itself ran clean (130 files, PROJECT.md preservation semantics correct); the parity
check caught every trim mistake iteratively and its "only if present" gates behaved as documented;
the branch-protection stack (hooks + sidecar regeneration) installed without issue on a fresh host.
