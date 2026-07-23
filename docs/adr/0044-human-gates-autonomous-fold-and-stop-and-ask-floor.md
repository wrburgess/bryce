# A `## Human Gates` section: value-checked gate policy, `autonomous-fold`, and a `stop-and-ask` Reviewer floor

**Status:** accepted — reconciles bryce's SDLC config with [ai-config PR #130](https://github.com/wrburgess/ai-config/pull/130) (issue #82).

## Context

Bryce is a diverged, customized vendoring of ai-config. Upstream [ai-config #128](https://github.com/wrburgess/ai-config/issues/128)
(shipped in [PR #130](https://github.com/wrburgess/ai-config/pull/130)) adopted the continuous
ungated-to-merge posture bryce already runs — plan approval auto, merge the sole human gate — but it
also added mechanism bryce lacked and exposed two places where bryce's config had drifted from the
canonical baseline. Three gaps, all internal to bryce's own consistency:

1. **The gate policy was prose, restated in ~8 surfaces, machine-checked nowhere.** `PROJECT.md`
   expressed "plan approval auto-approved; merge the one gate" as a bullet under *Lifecycle Host*, and
   `AGENTS.md` / `README.md` / the standards doc / four skill bodies each restated it. [ADR 0020](0020-right-size-plan-revisable-direction.md)
   recorded in writing that the agreement of those restatements is upheld by human review, not a test —
   which is precisely how a policy boundary silently drifts.

2. **`final` folded rule/config learnings by hand.** Its step 5 was *present-to-hc* ("do not edit the
   Rules Layer or config without approval"), so every rule improvement learned during implementation
   required a manual HC command — the friction ai-config #128 removed.

3. **The Reviewer degradation floor contradicted bryce's own accepted ADR.** `PROJECT.md` degraded an
   exhausted Reviewer chain to *"flag the missing review in the SOW."* But [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md)
   already declares the faithfulness backstop degrades to *"stop and ask if no second model is
   reachable."* The config was the outlier, not the ADR. ai-config makes `stop-and-ask` a
   non-configurable floor its parity check hard-fails.

These interact. Adopting (2) is what first lets `final` *write* to `rules/` and `PROJECT.md` — after
`verify` has already closed the PR-gate Reviewer summons. Shipping that while keeping a floor (3) that
permits delivering-unreviewed-with-a-footnote is the one combination that must not ship: the run least
able to obtain an independent review would also be the run allowed to certify itself and fold config
changes. So (2) and (3) are decided together, and (1)'s prose is converted to a machine-checked value
for exactly the two declarations that are policy boundaries.

Bryce's `PROJECT.md` had no `## Human Gates` and no `## Reviewer` H2 — a section-less config that a
post-#130 re-vendor would hand the parser's strict fail-safe, contradicting bryce's hardcoded `auto`
skills. All upstream enforcement is Ruby ([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)
removed Ruby here), so any port is reimplemented in TypeScript, and it must stay inside
[ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md)'s structural boundary.

## Decision

- **A dedicated `## Human Gates` section in `PROJECT.md`, value-checked.** It declares a two-row gate
  table — plan approval `auto` (allowed `required · auto`), merge `required` (not configurable) — plus
  the emergency stops and the `create-skill` carve-out. It is a sixth required Project-Config section.
  Unlike the other five, its **values** are checked, not just its heading.

- **`stop-and-ask` is the non-configurable Reviewer degradation floor.** The *Reviewer degradation
  floor* bullet under *Lifecycle Host* is `stop-and-ask`, its only allowed value; parity hard-fails any
  other, on the same footing as the merge gate. This **affirms** ADR 0005's backstop and resolves the
  config-vs-ADR contradiction in ADR 0005's favor. The floor-wording sweep replaces "flag the missing
  review in the SOW" across `devise`, `verify`, `ship`, and the standards doc.

- **`autonomous-fold` is the shipped rule-suggestion disposition** (allowed `autonomous-fold |
  present-to-hc`), a documentary prose value, deliberately **not** a third gate-table row (the parser
  reads a two-row table and must stay two-row). Under it, `final` **folds** well-scoped *and* low-risk
  Rules-Layer/config improvements into the merged PR and **defers** large *or* contentious ones to a
  tracked follow-up, recording both in a new SOW *Folded Rule/Config Changes* section.

- **`final` is reordered — dispose/fold → verify → SOW — and the backstop is SHA-anchored.** Folding is
  step 1 (commit + push), so the folded diff is what the quality checks and the SOW cover; a fold can
  never post-date the SOW. Because a fold changes the diff *after* `verify` closed the Reviewer summons,
  `verify` records the reviewed commit SHA and `final` compares it to `HEAD`: equal → the backstop
  stands; different → re-summon the Reviewer on the delta; chain exhausted → the floor applies and no
  SOW is written. This is what makes "an unreviewed PR does not reach a SOW" true rather than
  aspirational, and narrows — but does not fully close — the late-fold review gap ai-config tracks as
  [ai-config #129](https://github.com/wrburgess/ai-config/issues/129) item 2.

- **The two policy boundaries are value-checked in `scripts/parity-check.ts`.** A shared, unit-tested
  `scripts/human-gates.ts` (shaped like `scripts/protected-branches.ts`) parses the four declarations,
  reporting **parse status separately from the effective value** so a setting written without backticks
  reads as `unparseable` instead of silently falling back to the fail-closed default and passing. This
  is a deterministic value parse — structural, within ADR 0008 — and `docs/guides/authoring-the-bundle.md`
  gains a narrow carve-out for it.

- **The two independent Reviewer gates are the plan (Stage 2) and the work/PR (Stage 4); the Stage-1
  assessment is not an independent-review gate.** Surfaced during this issue's own PR review (HC
  decision on the #83 delta): `summon-reviewer.ts` has a `--mode plan` and a `--mode work` and no assess
  mode, so a vestigial "the assessment goes to the Reviewer, HC-routed" gate had no runnable mechanism
  and contradicted the hands-off `auto` run. Resolved by making the design explicit — the assessment is
  posted for the audit trail and open to HC comment, the first *independent* review is the plan
  critique — and reconciled across `assess`, `devise`, `development-lifecycle.md`, `PROJECT.md`, and the
  summon self-test (whose Stage-1 invariant flips from "requires an HC-routed assessment review" to "no
  stage claims a summons that cannot be run"). The Stage-1 option pick rides the *Plan approval* gate
  (`auto` → the AC selects; `required` → the HC selects), so every entry point agrees.

## Considered options

- **A — documentary reconciliation (prose only), no parity or test changes.** Rejected: nothing would
  guard the two boundaries, so a future edit could downgrade the floor or express self-merge with CI
  still green — the exact failure mode that produced this issue. It also leaves the new section
  unenforced, so a future re-vendor could drop it silently.
- **B — reconcile the prose AND value-check the two boundaries (chosen).** Adds a small TypeScript
  parser + parity assertions + a self-test, reusing the `protected-branches.ts` pattern bryce already
  owns end to end. Converts the two genuine policy boundaries to machine-checked values, fixes the
  "no parity self-test exists" gap `authoring-the-bundle.md` requires, and makes a future ai-config
  re-vendor a near no-op instead of a parity collision.
- **C — adopt `autonomous-fold` but keep `flag-in-SOW` as a documented divergence.** Rejected: it would
  leave `PROJECT.md` contradicting accepted ADR 0005 (requiring an ADR amendment to stay coherent), and
  it lands the disposition that makes `final` write to config after review while keeping the weaker
  floor — the two halves pushing opposite directions on the same risk.

## Consequences

- **Narrows [ADR 0020](0020-right-size-plan-revisable-direction.md).** ADR 0020's consequence that the
  gate restatements "are left untouched" and their consistency "is not machine-checked" no longer holds
  in full: the restatements are updated to name both `required`/`auto` branches and the `stop-and-ask`
  floor, and the two policy-boundary *values* (merge, floor) are now machine-checked. The ~8 restatements
  of the *narrative* remain human-upheld — the parity check reads values, not semantics (ADR 0008).
- **Affirms [ADR 0005](0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md).** The floor
  the ADR always declared is now the config's floor and is enforced.
- **A behavior change, stated plainly.** A lapsed local Codex session (bryce's Reviewer is a local CLI,
  [ADR 0024](0024-harness-model-naming-convention.md) / `summon-reviewer.ts`) now **stops** a run rather
  than footnoting it. On a single-user host with the HC present, and with Copilot the fallback rung
  before the floor, that is the intended direction.
- **A residual gap remains and is named.** The SHA-anchored delta re-review narrows the late-fold gap
  but still relies on the Reviewer being reachable a second time; the first fold's re-review can itself
  hit the floor. Tracked, not hidden — in the SOW and in `docs/ai-config-feedback/`.
- **Stays single-language.** No Ruby; the parser and its specs are TypeScript run via `tsx`
  ([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md)).
