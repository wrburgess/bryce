# 2026-07-22 — Reconciling with ai-config PR #130 (bryce issue #82)

After [ai-config PR #130](https://github.com/wrburgess/ai-config/pull/130) shipped the continuous
ungated-to-merge posture upstream, bryce reconciled its own SDLC config to it (issue #82). Most of
that was bryce *adopting* from ai-config — a `## Human Gates` section, the `autonomous-fold`
disposition, `final`'s dispose→verify→SOW reorder. This entry records the parts that flow the other
way: where bryce is **ahead of** the baseline and the design should go upstream, and where bryce made
a deliberate host call worth naming so a future re-vendor does not silently overwrite it.

## F11 — bryce's `summon-reviewer.ts` is a real local-CLI Reviewer path; ai-config still names an unreachable GitHub App

**Disposition: `upstream` · Status: recorded (to file on [ai-config#129](https://github.com/wrburgess/ai-config/issues/129) and ai-config's Reviewer *Invocation paths*)**

ai-config's Reviewer *Invocation paths* table still lists `Codex | mention @codex review on the PR |
its GitHub app is installed on the repository` — a mechanism its own PR #130 review-response comment
admits is unreachable ("the `@codex review` GitHub App is unreachable on this repo, so the CLI is the
working summons mechanism"). It treats the local Codex CLI as an undocumented workaround. bryce has
already turned that workaround into the *declared* mechanism: `scripts/summon-reviewer.ts` runs Codex
through the local CLI with no GitHub-App precondition, `--mode plan` (plan text on stdin to `exec`)
and `--mode work` (`review --base BRANCH`), writing the review body to a file and classifying the
outcome — no network or lifecycle-host call in the bundled script, so the whole thing is offline-testable
against a fake CLI (`scripts/summon_reviewer.test.sh`).

The generalizable design ai-config should adopt:

- **An 8-way failure ladder** — `ok` plus `not_found`, `not_authenticated`, `exit_nonzero`,
  `empty_output`, `insufficient_output`, `drain_timeout`, `timeout`, `self_review` — so "summoned but
  silent" has a *named* outcome distinct from "pending" (the exact silent-gap F9 in
  [`2026-07-19-first-vendoring.md`](2026-07-19-first-vendoring.md) was about).
- **The fallback trigger is the EXIT STATUS, not the classification list.** A usage error and an
  unwritable destination exit non-zero with no classification line at all; a ladder keyed only to the
  named failures would leave the likeliest operator mistakes unhandled. On any non-zero exit the AC
  requests the fallback (`Copilot`) via a requested-reviewer POST.
- **A substance floor** (`--min-bytes`, default 200) so a banner or a one-line bail (exit 0, tiny
  body) is classified `insufficient_output` rather than counted as a review.

This is bryce's answer to the unowned/unreachable-path half of ai-config #129 and to the placeholder
GitHub-App row in its *Invocation paths* table.

## F12 — bryce's `--mode plan` is a working plan-gate summons that needs no PR (answers ai-config #129 item 1)

**Disposition: `upstream` · Status: recorded (to link into [ai-config#129](https://github.com/wrburgess/ai-config/issues/129) item 1)**

[ai-config #129](https://github.com/wrburgess/ai-config/issues/129) item 1 records that under `auto`
the plan-gate Reviewer summons is **unowned and unmechanized** — both shipped ai-config mechanisms are
PR-gate-only ("on the PR" / "a PR review via the API"), so "every default run's plan gets no
independent review," and it asks for *"a plan-gate summons mechanism that does not require a PR."*
bryce already has one: `summon-reviewer.ts --mode plan` critiques plan **text** with no PR in
existence, and bryce's `devise` skill owns the summon (the AC, not the HC, runs it after posting the
plan and blocks the handoff to `invoke` on the critique). That is precisely the missing mechanism *and*
a decided owner. ai-config can close #129 item 1 by adopting this shape rather than ratifying "no
plan-gate review by default."

## F13 — bryce aligns its Reviewer degradation floor to `stop-and-ask` (was `flag-in-SOW`)

**Disposition: `host-only` · Status: adopted (bryce issue #82 / [ADR 0044](../adr/0044-human-gates-autonomous-fold-and-stop-and-ask-floor.md))**

bryce's config previously degraded an exhausted Reviewer chain to *"flag the missing review in the
SOW"* — a divergence from ai-config's non-configurable `stop-and-ask` floor, which ai-config's parity
**hard-fails** for any other value. Issue #82 resolved this by **aligning to `stop-and-ask`**, for a
reason internal to bryce: bryce's own accepted [ADR 0005](../adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)
already declared the backstop degrades to "stop and ask," so `flag-in-SOW` contradicted an accepted
ADR. Aligning also dissolves the **re-vendor collision** the divergence would otherwise cause: had
bryce kept `flag-in-SOW` and later re-synced ai-config's Reviewer section, ai-config's parity hard-fail
would have tripped. This is recorded `host-only` because it documents a boundary decision, not a change
ai-config needs — ai-config is already at `stop-and-ask`; bryce simply stopped diverging.

The trade, named plainly: bryce's Reviewer is a *local* Codex CLI, so `not_found` / `not_authenticated`
happens whenever the HC's Codex session lapses. Under `stop-and-ask` that now **stops** a run rather
than footnoting it. On a single-user host with the HC present, and with Copilot the fallback rung ahead
of the floor, that is the correct direction — the run least able to obtain an independent review is
exactly the run that must not certify itself.

## What worked (signal, not just friction)

- **The feedback ledger closed a real loop.** F9's host resolution built `summon-reviewer.ts`;
  three months later that same script is mature enough to feed *back up* as the answer to two upstream
  open items (#129 item 1 and the *Invocation paths* placeholder). A host running ahead of the baseline
  on one surface, and the ledger capturing it, is the mechanism working as designed.
- **Mechanizing the two policy boundaries reused a pattern bryce already owned.** The value-check
  parser (`scripts/human-gates.ts`) is a second instance of the `scripts/protected-branches.ts` shape
  — same parse-from-`PROJECT.md`, same unit-test + `--root` self-test discipline — so converting the
  gate/floor prose to machine-checked values added a check without inventing machinery.
- **An internal contradiction, not just an upstream diff, drove the floor decision.** The strongest
  argument for `stop-and-ask` was bryce's own ADR 0005, found during assessment — evidence that reading
  the repo's own accepted decisions catches drift a cross-repo comparison alone would miss.
