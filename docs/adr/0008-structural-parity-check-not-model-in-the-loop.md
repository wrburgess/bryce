# Parity is verified structurally, not by model-in-the-loop output testing

**Status:** accepted — the *Ruby language* choice is superseded by [ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md) (issue #64); the structural-not-model-in-the-loop decision below stands unchanged.

Cross-model parity — the guarantee that all four agents receive equivalent instructions — is verified by a **lightweight, dependency-free Ruby script run in GitHub Actions** that asserts *structural invariants*:

- Every Adapter (`CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) resolves to / references the Canonical `AGENTS.md`.
- Every Skill has a canonical body and its expected per-tool shim(s).
- Every Tier-1 rule referenced by `AGENTS.md` exists and declares its required Anti-Patterns section.
- The Project Config has its required sections.
- Markdown links resolve.

We **deliberately do not** build a model-in-the-loop test that feeds each tool and diffs their output. It is flaky, slow, costs four provider calls per run, and proves little that structural parity plus human/second-model review doesn't already cover. A future contributor may be tempted to add it — this ADR records that the omission is intentional, not an oversight.

Ruby (not bash) is chosen because this is a Rails-oriented config: contributors have Ruby, and structured checks are easier to grow. The script ships in the baseline so a Host App runs the same check after Customization (catching a broken pointer).

> **Superseded in part ([ADR 0039](0039-repo-tooling-unifies-on-typescript-remove-ruby.md), issue #64):** the *language* choice here — Ruby — is reversed; the parity check is now TypeScript run via `tsx`, because Bryce is a committed Node/TS app rather than a portable bundle. The structural-not-model-in-the-loop decision above is unaffected.
