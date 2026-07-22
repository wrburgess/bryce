# Self-Review Rules

**Applies to:** every change, before declaring work done
**Deep doc:** none (this file is the checklist itself)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Run the full quality gate green before saying "done".** All of the host's checks (declared in `PROJECT.md` → *Quality Checks*) must pass, not "probably pass."
- **Re-read your own diff as a hostile reviewer would**, line by line, and fix what you would flag before anyone else sees it.
- **In a git worktree, base your diff and any reviewer-summon on `origin/main` (after `git fetch`), or on `gh pr diff N`** — a linked worktree's local `main` ref can't be updated (it's checked out in the primary worktree), so it drifts stale and `main...HEAD` shows phantom changes from already-merged work; review the authoritative scope, not the local ref's.
- **Confirm every planned item has a corresponding test**, and that each test would actually fail if the feature broke.
- **Source every "verified" / "as-of" / factual claim with a citation that actually states it** — put each claim under the exact URL that supports it and quote the load-bearing line; if you can't quote it, you have not verified it.

## Checklist

- [ ] Every item in the plan is implemented.
- [ ] Every planned test scenario is covered, with meaningful assertions (not just "it runs").
- [ ] Edge cases handled: invalid input, `nil`, duplicates, boundary values.
- [ ] No `TODO` / "needs manual testing" left behind — the test is written, not deferred.
- [ ] The full quality gate passes locally.
- [ ] If this is a lifecycle stage, its terminal artifact actually exists (e.g. `invoke` is not done until the PR exists — a commit is not the artifact).
- [ ] Any `<placeholder>`-style token in text posted to the lifecycle host (issue/PR/comment body) is written host-safe (`{name}` / `NAME`) — GitHub strips angle-bracket tokens.
- [ ] *(Bryce host extension)* If this task fought the vendored ai-config baseline — a baseline file forked, a check red out of the box, a missing procedure — the friction is recorded in [`docs/ai-config-feedback/`](../docs/ai-config-feedback/README.md) with a disposition (`upstream` / `overlay` / `host-only`).

## Anti-Patterns

- **Never declare work done on a red or un-run check** — because "probably fine" is exactly how regressions ship. *(Extend per host.)*
- **Never leave a "TODO / needs manual testing" comment in place of a test** — because it never gets written; build the test now. *(Extend per host.)*
- **Never ship minimal assertions and call it complete** — because the last 20% (edge cases, sad paths, thorough assertions) is where quality lives. *(Extend per host.)*
- **Never put `<angle-bracket>` placeholders in text you post to the lifecycle host** (issue/PR/comment bodies) — because GitHub's markdown sanitizer silently strips them (even inside backticks), so `path/<name>/file` renders as `path//file` and reads as a typo; use `{name}` or `NAME` in prose bound for a host artifact (angle brackets are fine in committed source files). *(Extend per host.)*
- **Never cite a source that doesn't support the claim placed under it** — because a dated URL manufactures false rigor: a reader who follows it finds nothing, and the "verified" label becomes a lie. Attribute each claim to the source that actually states it, and quote the exact supporting line (a structural link-check confirms a URL *resolves*, never that it *supports* the claim — that gap is author-owned). *(Provenance: issue #56 / PR #61; extend per host.)*
- **Never diff, self-review, or summon a reviewer against a git worktree's local `main`** — because a linked worktree can't update that ref (`git branch -f main` fails with "cannot force update the branch 'main' used by worktree"), so it silently lags behind and `main...HEAD` surfaces phantom files from already-merged PRs, feeding you — and the Reviewer — the wrong diff; base the comparison on `origin/main` (after `git fetch`) or on `gh pr diff N` (e.g. pass `--base origin/main` to the reviewer summon) for the authoritative scope. *(Provenance: issue #54 / PR #62; extend per host.)*
