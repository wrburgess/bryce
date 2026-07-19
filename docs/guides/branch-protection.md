# Branch protection — defense in depth

This bundle prevents any of the five agents (Claude, Codex, Copilot, Antigravity, Grok Build) — and an accidental
human — from committing or pushing to a protected branch. Enforcement is layered so that no single
missing piece leaves a gap ([ADR 0009](../adr/0009-defense-in-depth-branch-protection-all-agents.md)).

The **protected-branch list is not hardcoded**: it is authored once in
[`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy* and derived into the sidecar
`.githooks/protected-branches` that every guard reads. Edit the list in `PROJECT.md`, then run
`bin/install-git-hooks` to regenerate the sidecar.

## The three layers

| Layer | What | Binds | Activation |
|-------|------|-------|------------|
| **1 — Server-side** | GitHub branch protection rules | Everyone, at the push/merge boundary — even an agent in an environment with no local hooks | Configured on GitHub (below) |
| **2 — Local git hooks** (portable primary) | `.githooks/{pre-commit,pre-push,pre-merge-commit,pre-rebase}` → `bin/guard-protected-branch` | Any tool or human, invocation-agnostic (git runs them on the real operation) | `bin/install-git-hooks` (via `bin/setup`) |
| **3 — Per-tool fast-fail** | Claude `.claude/hooks/enforce-branch-creation.sh` (PreToolUse) | Claude Code tool calls — blocks the write before it happens (best UX) | Wired in `.claude/settings.json` |

Layer 3 is a convenience over the same invariant; layers 1–2 still cover any tool that has no hook
mechanism.

## Layer 2 — activate the local git hooks

Git hooks are **not** active on a fresh clone until `core.hooksPath` is set. Run once after cloning:

```bash
bin/setup            # runs bin/install-git-hooks
# or directly:
bin/install-git-hooks
```

`bin/install-git-hooks` sets `core.hooksPath=.githooks` and regenerates `.githooks/protected-branches`
from `PROJECT.md`. It is idempotent. Confirm with:

```bash
git config --get core.hooksPath   # => .githooks
```

Only **AI Contributors** are blocked; **Human Contributors** with an interactive terminal pass. An AC
is detected by an env var (`CLAUDE_CODE`, `CODEX`, `GITHUB_COPILOT_AGENT`) or, as a catch-all for any
other agent (e.g. Antigravity), a non-interactive shell.

## Layer 1 — GitHub server-side branch protection

Configure this on GitHub so the boundary holds even where no local hooks are installed. For each
protected branch (`main`, and `master`/`develop` if the host uses them):

1. **Settings → Branches → Add branch ruleset** (or *Add classic branch protection rule*).
2. Set the branch name pattern to the protected branch (e.g. `main`).
3. Enable:
   - **Require a pull request before merging** (blocks direct pushes).
   - **Require status checks to pass** — select the `parity` check.
   - **Do not allow bypassing the above settings** (applies the rule to admins too).
   - Optionally **Restrict who can push** to no one, so all changes arrive via PR.
4. Save.

With this in place, a direct push to a protected branch is rejected by GitHub regardless of the local
environment.

> An optional CI workflow could assert these rules are enabled via the GitHub API; that assertion is
> deferred — the documented setup above is the baseline.

## Customizing the protected-branch list

1. Edit the `- **Protected branches:**` line in [`PROJECT.md`](../../PROJECT.md) (the backticked names
   up to the em dash are the authored list).
2. Run `bin/install-git-hooks` to regenerate `.githooks/protected-branches`.
3. Commit both files. The `parity` check fails if the sidecar drifts from `PROJECT.md`.
