# Branch protection is defense-in-depth; git hooks are the universal enforcement layer

**Status:** accepted

All four agents must be prevented from committing/pushing to protected branches. Because a Claude `PreToolUse` hook only binds Claude, real "all agents" coverage requires enforcement **below the tool level**. The baseline ships three layers:

1. **Server-side GitHub branch protection** (remote) — the catch-all at the push/merge boundary; fires regardless of what runs locally, including an agent in an environment with no hooks installed. Documented setup step, optionally asserted by a workflow.
2. **Local git hooks** (`.githooks/{pre-commit,pre-push,pre-merge-commit,pre-rebase}` → `bin/guard-protected-branch`, plus an installer wired into `bin/setup`) — **invocation-agnostic**: they fire on the real git operation no matter which of the four agents (or a human) triggered it. This is the portable primary enforcement and the reason "all agents" holds locally.
3. **Per-tool fast-fail accelerators** — the Claude `PreToolUse` hook (blocks the write before it happens; best UX) and equivalent guards for any other tool that supports one. Conveniences over the same invariant, per the graceful-degradation rule (ADR 0003).

## Configurable, not Markaz-specific

The protected-branch list and the agent-vs-human exemption (humans pass; agents are blocked — via env-var/TTY detection) are **Project Config** values, not hardcoded branch names.

## Consequences

- Git hooks are **not** active on a fresh clone until `core.hooksPath` is set — the installer must run (via `bin/setup`), and docs must say so, or layer 2 is silently absent.
- Layer 3 accelerators must never be the *only* guard for a tool; if a tool has no hook mechanism, layers 1–2 still cover it.
