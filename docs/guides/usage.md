# Usage & Customization Guide

How a **Host App** adopts this Config Bundle end to end: **vendor** the Generic Baseline in,
**activate** the guardrails, **customize** through the Project Config, and **run** the development
lifecycle from any of the five configured agents (Claude, Codex, Copilot, Antigravity, Grok Build).

- Vocabulary (Config Bundle, Generic Baseline, Adapter, Skill, Project Config, Customization…) →
  [`CONTEXT.md`](../../CONTEXT.md).
- This guide is **business-neutral**: it names no company, product, or stack. Every host-specific value
  lives in [`PROJECT.md`](../../PROJECT.md), never here.

---

## 1. Vendor the baseline in

Copy the baseline into your Host App — distributed by **copying files in**, no submodule/package/upstream
tracking ([ADR 0001](../adr/0001-distribute-as-copy-in-sync-script.md)). The `ai-config-sync` script
lives only in the upstream [ai-config](https://github.com/wrburgess/ai-config) repo (it is never
vendored into a Host App), so run these **from a clone of upstream ai-config**:

```bash
# Preview what would be copied (writes nothing):
ruby bin/ai-config-sync --dry-run /path/to/host-app

# Vendor the bundle in:
ruby bin/ai-config-sync /path/to/host-app
```

- The Host App owns **plain files** at their expected paths (real files, never symlinks).
- Copies each top-level surface **only if it exists**, so it behaves the same as the baseline grows.
- Does **not** copy this repo's meta files (`README.md`, `LICENSE`, `.gitignore`, `test/`, the
  `ai-config-sync` script itself), and never touches your Host App's own `.gitignore`.
- Preserves your Host App's own `PROJECT.md` and `bin/setup` on a re-sync (see §6).

## 2. Activate the guardrails

Wire the defense-in-depth branch protection that stops any agent — or accidental human — from
committing/pushing to a protected branch
([ADR 0009](../adr/0009-defense-in-depth-branch-protection-all-agents.md)). Git hooks are inactive on a
fresh clone until `core.hooksPath` is set:

```bash
bin/setup   # runs bin/install-git-hooks (sets core.hooksPath, regenerates the sidecar)
```

- Run this **once after vendoring, before your first commit**.
- The protected-branch list is authored in [`PROJECT.md`](../../PROJECT.md) → *Branch & PR Policy* and
  derived into the sidecar the guards read.
- Full setup + the AI-vs-human exemption → [`branch-protection.md`](branch-protection.md).

## 3. Customize through the Project Config

Author host-specific content as **Customization**, never by editing the baseline files in place — that
split is what keeps future updates mergeable.

1. **Edit [`PROJECT.md`](../../PROJECT.md)** — the single Customization surface the agents read. Replace
   the business-neutral placeholders in each of its five sections:
   - **Quality Checks** — the real commands an agent must run green before "done" (lint, tests,
     security, dependency audit).
   - **Attribution & Model Declaration** — the per-agent tool + model for commit trailers and comment
     footers ([ADR 0007](../adr/0007-attribution-includes-model-version-for-audits.md)).
   - **Branch & PR Policy** — protected branches, branch-naming prefixes, issue-linking rules. After
     editing the protected-branch list, re-run `bin/install-git-hooks` to regenerate the sidecar.
   - **Review Severity Framework** — tune the Critical/High/Medium/Low definitions the
     `verify`/`listen`/`final` skills classify against.
   - **Lifecycle Host** — the platform hosting issues/PRs and the artifact map (GitHub by default,
     remappable — [ADR 0006](../adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md)).
2. **Add your domain rules** to the [Rules Layer](../../rules/) as Customization — host-specific
   Patterns and Anti-Patterns, kept separate from the baseline starters
   ([ADR 0004](../adr/0004-two-tier-rules-layer-progressive-context.md)). Heavy, subsystem-specific case
   studies go in the deferred Tier-2 deep docs (`docs/rules/`), read on demand via the trigger table.
3. **Leave [`AGENTS.md`](../../AGENTS.md) and the Adapters as the baseline** so every tool stays in
   lockstep. Host values flow in through `PROJECT.md`, not by forking the Canonical Source — the parity
   check (§5) enforces this.

## 4. Run each skill per tool

This host vendors **nine Skills** (the baseline's thirteen minus the intake-pipeline set — a
Customization; see `PROJECT.md`), each authored **once** as a canonical body at `skills/<name>/SKILL.md`
and reached through a thin, tool-specific **Invocation Shim** — so the procedure and quality gates are
identical on every tool, and only tool-specific execution enhancements degrade gracefully
([ADR 0003](../adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):

- `distill` — the plan-grilling / glossary + ADR capture session.
- The six **lifecycle** skills — `assess`, `devise`, `invoke`, `verify`, `listen`, `final`.
- `ship` — the orchestrator that sequences those six end to end.
- `create-skill` — the authoring front door (scaffolds a new, conforming skill from full repo context).

**How each configured agent invokes a Skill:**

| Tool | Invocation |
|------|------------|
| **Claude Code** | A slash command from the thin shim at `.claude/commands/<name>.md` — e.g. `/assess 11`, `/devise 11`, `/invoke 11`, `/ship 11`, `/create-skill`. The shim points at the canonical body. |
| **Codex** | Reads `AGENTS.md` natively, so **the documented procedure is the shim**: to run a Skill, read `skills/<name>/SKILL.md` and follow it. |
| **Copilot** | Same — its PR surfaces read `AGENTS.md` natively; read `skills/<name>/SKILL.md` and follow it. |
| **Antigravity** | Same — `GEMINI.md` imports `AGENTS.md`; read `skills/<name>/SKILL.md` and follow it. |
| **Grok Build** | Same — reads `AGENTS.md` natively (like Codex); read `skills/<name>/SKILL.md` and follow it. |

No tool needs a per-tool copy of a procedure: Claude reaches the one canonical body through its slash
shim, and the native-discovery tools reach the same body by the documented "read and follow it" path
([ADR 0010](../adr/0010-repo-layout-canonical-skills-at-root.md)).

**The lifecycle** runs **Assess → Plan → Implement → Verify → Deliver**, plus a review-response step:
`assess` → `devise` → `invoke` → `verify` → `listen` → `final`.

- Issue-scoped stages (`assess`, `devise`, `invoke`) take the **issue** id; PR-scoped stages (`verify`,
  `listen`, `final`) take the **PR** id that `invoke` opens.
- The **merge** gate (after `final`) is mandatory and never bypassed; the **plan-approval** gate
  (after `devise`) is auto-approved in this host per `PROJECT.md` → *Lifecycle Host* → *Human gates*.
- Full stage spec, terminal artifacts, and when to compress stages →
  [`development-lifecycle.md`](../standards/development-lifecycle.md).
- To run the whole lifecycle hands-off, the [`ship`](../../skills/ship/SKILL.md) orchestrator sequences
  all six, stopping only at merge (plus unconditional emergency stops).

## 5. Keep the bundle green in-host

A vendored copy must keep the shipped [`parity_check.rb`](../../scripts/parity_check.rb) **green
in-host**. Run it any time after vendoring or customizing:

```bash
ruby scripts/parity_check.rb
```

Because the Host App runs the same structural check this repo does
([ADR 0008](../adr/0008-structural-parity-check-not-model-in-the-loop.md)), two invariants hold for the
vendoring installer — and a Customization must not break them:

- **Every parity-link target is shipped.** The whole `docs/` tree is vendored because `AGENTS.md` and
  `.github/copilot-instructions.md` link into it; a copy missing any link target would redden the host's
  own parity check.
- **Content is copied faithfully.** `ai-config-sync` never rewrites files on copy — that would drift the
  Adapters from the Canonical Source and break the re-sync `git diff` a host uses to reconcile.

Both are guarded by `test_vendored_copy_passes_parity_check`, which runs `parity_check.rb --root DEST`
against a vendored copy of the real bundle. Before changing what `ai-config-sync` copies, remember:
dropping a link target or rewriting content on copy would break a host silently.

## 6. Update / re-sync

Updating is a **re-run of the sync followed by a manual merge**
([ADR 0001](../adr/0001-distribute-as-copy-in-sync-script.md)) — again from a clone of upstream
ai-config, since the script is not vendored:

```bash
ruby bin/ai-config-sync /path/to/host-app
```

- Baseline files are overwritten; **`PROJECT.md` and an existing `bin/setup` are preserved** (pass
  `--force` to overwrite `PROJECT.md` too for a deliberate reset).
- Review the changes with `git diff` in the Host App and reconcile any Customization.
- Re-run the quality gate (§5) to confirm the bundle is still green.
