# Dependency Automation & Supply-Chain Hardening — Design Spec

- **Date:** 2026-07-21
- **Status:** Approved; implemented on `feature/dependency-automation` (`Part of #59`)
- **Owner:** @wrburgess
- **Scope:** Routine, low-effort dependency updates for the Bryce app that stay current *and* resist
  supply-chain poisoning ("pipeline injection").
- **Dependency surface:** npm packages + GitHub Actions only. The Ruby tooling
  (`scripts/parity_check.rb`) has no gems.

> **Revision (2026-07-21, post-Reviewer):** the design below incorporates the Codex plan critique on
> #59 (8 must-fix findings) and two HC decisions — **cooldown = 7 days**, **timezone = America/Chicago**.
> Net changes from the first draft: GitHub Action *and* Node updates are **held for review** (not
> auto-merged); workflows get least-privilege `permissions`; branch protection requires **both** CI
> contexts and is configured **before** Renovate is activated; the config validator command is
> corrected; the PR uses `Part of #59` (no closing keyword).

## 1. Problem & goals

Keep the app on current, secure dependencies with **minimal ongoing attention**, while hardening the
two poisoning vectors that matter for this repo: **malicious npm releases** and **compromised GitHub
Actions**.

**Goals**

- Updates propose (and, where safe, merge) themselves on a predictable cadence, not manually.
- A freshly-published *malicious* npm version cannot reach `main` before it has had time to be caught.
- GitHub Actions cannot be silently swapped under us via a mutable tag.
- Real CVE fixes land fast, not on the slow routine cadence.
- The human "worry surface" is a single GitHub issue glanced at occasionally.

**Non-goals**

- No paid tooling (the chosen path is free — see §3).
- No changes to what the app does; this is CI/hygiene only.
- No Merge Confidence data feed (the release-age cooldown replaces it).

## 2. Current state

- **Runtime:** Node 22 (`.nvmrc` = `22`, `engines.node` = `>=22`), TypeScript/ESM. Runtime deps
  include a **native module** (`better-sqlite3`).
- **CI:** `app.yml` job **`checks`** (`npm ci` → typecheck → lint → test → `npm run audit`) and
  `parity.yml` job **`parity`** (parity + self-tests), both on PRs. Actions were referenced by
  **mutable tags** (`@v4`, `@v1`) — the injection hole this spec closes.
- **Security gate:** `audit-ci` (`audit-ci.jsonc`) fails on **moderate+** advisories in **production**
  deps, skips dev, and carries a **documented allowlist with removal triggers** (one Hono advisory,
  non-exploitable in this deployment). Kept **as-is**.
- **Existing Dependabot:** an `origin/dependabot/npm_and_yarn/…` branch exists but there is **no
  `.github/dependabot.yml`** — Dependabot **security updates** are auto-enabled and already opening
  PRs. Reconciled in §5.4 so Dependabot and Renovate do not both open update PRs.
- **No routine update mechanism** for version currency today — bumps are manual.

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Update engine | **Renovate** | Release-age cooldown, grouping, dashboard, SHA-pin management. Built for "set and forget." |
| Hosting | **Mend Renovate GitHub App** (free) | Zero maintenance; free for unlimited private repos. Trade-off: third-party write + auto-merge access. **Fallback:** self-hosted `renovatebot/github-action` (also free). |
| Cooldown | **`minimumReleaseAge: 7 days`** | HC choice — a week for a bad release to be caught/yanked before adoption. CVE fixes bypass it. |
| Auto-merge — npm patch/minor | **Auto-merge** after green CI + cooldown | The routine, low-risk majority. Safety rides on CI + cooldown. |
| Auto-merge — GitHub Actions | **Held for review** | CI runs the very workflow revision under review, and the cooldown does not apply to action *digest* updates — so "green CI + cooldown" is not a trustworthy gate for actions. Reviewed instead. |
| Auto-merge — Node runtime | **Held for review** | `.nvmrc` + `engines.node` are an environment change; grouped and reviewed. |
| Auto-merge — any major | **Held on the dashboard** | Majors always get human eyes. |
| Vulnerability data | **Dependabot alerts (only)** → consumed by Renovate | Free GHSA/OSV feed. Dependabot's *update PRs* turned off; Renovate owns all PRs. |
| Security fixes | **Open immediately (cooldown + dashboard bypassed); auto-merge follows the patch/minor-vs-major rule** | A patch/minor CVE fix auto-merges; a **major** security fix opens a PR but is **not** auto-merged. |
| `GITHUB_TOKEN` | **Least-privilege `contents: read`** in both workflows | Limits blast radius of a compromised action. |

**Cost:** $0 (Mend app free for unlimited private repos; auto-merge is a core Renovate feature).

## 4. Architecture — two-tool division of labor

```
GitHub "Dependabot alerts" (free GHSA/OSV feed; Dependency Graph enabled)
        │  (vulnerability signal only — no Dependabot update PRs)
        ▼
   Renovate  ── opens ─▶  security PRs   (cooldown + dashboard BYPASSED, label: security)
        │                                 └ patch/minor → auto-merge; major → review
        └────── opens ─▶  routine PRs    (cooldown ENFORCED, grouped, weekly schedule)
                                │
                                ▼
                     CI (checks + parity) must be green
                                │
        ┌───────────────────────┼───────────────────────────┐
   npm patch/minor        actions / Node                 any major
   → auto-merge           → review PR                    → held on Dependency Dashboard
```

- **Dependabot** contributes only the vulnerability feed. **Renovate** is the sole opener of update PRs.
- **CI** is unchanged and is the merge gate. **`audit-ci` stays authoritative**, allowlist included;
  any Renovate PR that reintroduces a gated advisory fails CI and does not merge.

## 5. Components

### 5.1 `renovate.json` (repo root) — as implemented

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "helpers:pinGitHubActionDigests", ":dependencyDashboard", ":semanticCommits"],
  "timezone": "America/Chicago",
  "schedule": ["before 6am on monday"],
  "minimumReleaseAge": "7 days",
  "internalChecksFilter": "strict",
  "packageRules": [
    { "matchDepTypes": ["dependencies", "devDependencies"], "matchUpdateTypes": ["patch", "minor"], "automerge": true },
    { "matchManagers": ["github-actions"], "automerge": false },
    { "matchManagers": ["nvm", "npm"], "matchDepNames": ["node"], "groupName": "node", "automerge": false },
    { "matchUpdateTypes": ["major"], "automerge": false, "dependencyDashboardApproval": true }
  ],
  "lockFileMaintenance": { "enabled": true, "automerge": true, "schedule": ["before 6am on monday"] },
  "vulnerabilityAlerts": { "labels": ["security"], "minimumReleaseAge": null, "dependencyDashboardApproval": false }
}
```

Precedence notes (later `packageRules` override earlier for an overlapping package):
- A runtime/dev **patch/minor** auto-merges (rule 1); its **major** is caught by rule 4 (held).
- **GitHub Actions** never auto-merge (rule 2); an Action **major** is additionally held (rule 4).
- **Node** (nvm + engines) is grouped and held (rule 3); `.nvmrc`/`engines` are major-only (`22`)
  today, so no minor surfaces — the policy is explicit regardless.
- `vulnerabilityAlerts.dependencyDashboardApproval: false` overrides rule 4 for **security** updates so
  a **major** CVE fix opens a PR *immediately* (dashboard bypassed) yet is still not auto-merged
  (rule 4's `automerge: false` stands) — without it, rule 4's `dependencyDashboardApproval` would hold
  a major security fix on the dashboard (Copilot review finding on PR #61).
- `internalChecksFilter: "strict"` enforces the cooldown before a branch/PR is created.
- Explanatory text lives in each rule's `description` field (kept out of this snippet for brevity).

### 5.2 GitHub Actions — SHA pinning + least privilege (`.github/workflows/*.yml`)

Both workflows get a top-level `permissions: { contents: read }`. Every `uses:` is pinned to a full
40-char commit SHA (provenance-verified from the official repo — §5.6) with a `# vX.Y.Z` comment, e.g.
`- uses: actions/checkout@11d5960…62 # v4.4.0`. `helpers:pinGitHubActionDigests` then keeps the SHAs
current, surfacing bumps as **review** PRs (not auto-merged — §3). This is the primary
pipeline-injection mitigation. Applies to `app.yml` and `parity.yml`.

### 5.3 Node version handling

`.nvmrc` and `engines.node` stay `22`/`>=22`. Renovate groups Node (nvm + engines managers) and
**holds it for review** — no auto-merge, major or minor. A future Node major (e.g. 24 LTS) is a
deliberate, reviewed environment change.

### 5.4 Dependabot reconciliation (repo Settings — manual, one-time)

- **Keep ON:** **Dependency Graph** and **Dependabot alerts** (feed Renovate's `vulnerabilityAlerts`;
  the Mend app needs read access to the alerts).
- **Turn OFF:** **Dependabot security updates** (the auto-opened PRs) — Renovate now owns security PRs.
- Close the existing stale `dependabot/npm_and_yarn/…` PR after Renovate's first run.
- No `.github/dependabot.yml` is added (adding one would re-enable Dependabot PRs).

### 5.5 Branch protection (repo Settings — manual, one-time, BEFORE activating Renovate)

Configure `main` **before** installing/activating the Mend app, so `platformAutomerge` can never merge
before checks finish:

- **Require status checks:** require **both** `checks` (app.yml) **and** `parity` (parity.yml).
- **Do NOT require PR approvals** — a required human approval would deadlock Renovate's auto-merge on a
  single-maintainer repo.
- Enable GitHub's native auto-merge (Renovate uses `platformAutomerge`, on by default).

### 5.6 Pinned action provenance (recorded)

| Action | Version | Commit SHA | Used in |
|---|---|---|---|
| `actions/checkout` | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` | app.yml, parity.yml |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` | app.yml |
| `ruby/setup-ruby` | v1.320.0 | `a30dfa457ad68707b8b910ac3a244714b61c0626` | parity.yml |

SHAs resolved from each official repo's latest **current-major** release via authenticated `gh api`
(`repos/<a>/commits/<tag>`). `checkout`/`setup-node` v7 exist but are a *major* jump — left for
Renovate to propose as a held major PR, not smuggled into this hardening change.

## 6. Auto-merge rule matrix

| Update class | Cooldown | CI gate | Behavior |
|---|---|---|---|
| Dev-deps + CI tooling, patch/minor | 7 days | required | ✅ auto-merge |
| **Runtime deps, patch/minor** (incl. `better-sqlite3` minor/patch) | 7 days | required | ✅ auto-merge |
| Lockfile maintenance (weekly) | n/a | required | ✅ auto-merge |
| Security / CVE fix, patch/minor | **bypassed** | required | ✅ fast-track auto-merge |
| **GitHub Actions** (digest or minor) | n/a | required | ⏸️ review PR |
| **Node** (nvm + engines) | 7 days | required | ⏸️ review PR (grouped) |
| **Any major** (deps, dev-deps, `better-sqlite3`, Node, Action major, **major security fix**) | 7 days* | required | ⏸️ held on Dependency Dashboard (major security fix opens a PR immediately but is not auto-merged) |

*Security majors bypass the cooldown/dashboard for *opening* the PR, but are never auto-merged.

## 7. Rollout plan (protection precedes activation)

1. **Repo Settings:** enable **Dependency Graph** + **Dependabot alerts**; turn **Dependabot security
   updates OFF** (§5.4).
2. **Branch protection** on `main`: require **both** `checks` + `parity`; enable auto-merge; no
   required approvals (§5.5).
3. Merge this PR (`renovate.json` + hardened workflows).
4. **Install the Mend Renovate app** on the repo (grant Dependabot-alert read access) — after 1–2.
5. **Review the Renovate onboarding PR** (confirm SHA-pins + cooldown behave), merge it.
6. Watch the first weekly batch; confirm auto-merge fires **only** on green + past cooldown, and that
   actions/Node/majors appear as review PRs / dashboard items.
7. Close the stale Dependabot PR.

**Rollback:** disable Renovate auto-merge (or uninstall the app) and re-enable Dependabot security
updates if the first batch misbehaves.

## 8. Verification / success criteria

- `renovate-config-validator --strict` (repo mode, pinned version — §9) passes.
- After onboarding: every `uses:` in `.github/workflows/*` is SHA-pinned with a version comment.
- A ≥7-day-old patch bump auto-merges after green CI; a newer release creates **no branch/PR** but
  **does** appear on the Dependency Dashboard under "Pending Status Checks".
- A major bump appears as an unchecked item on the Dependency Dashboard, not an open PR.
- An Action or Node update appears as a **review PR**, never auto-merged.
- A vulnerability alert produces a `security`-labelled PR that ignores the cooldown (major security →
  not auto-merged).
- `audit-ci` still gates; the Hono allowlist entry is untouched.

## 9. Config validation command

```sh
RENOVATE_VER=$(npm view renovate version)
npx --yes --package "renovate@$RENOVATE_VER" -- renovate-config-validator --strict
```

Repo-mode (no explicit filename, so it auto-detects `renovate.json`), pinned version, warnings-as-errors.

## 10. Risks & mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| Aggressive auto-merge lands a broken npm bump | CI (checks + parity) gates the merge; majors/actions/Node held | A bad release that still passes the suite — bounded by test coverage |
| Poisoned npm release | 7-day `minimumReleaseAge` cooldown; audit-ci gate | A malicious release not caught within 7 days (rare) |
| Compromised GitHub Action | SHA pinning + **review** of action updates + least-privilege `GITHUB_TOKEN` | A malicious commit shipped before pinning — closed at pinning |
| Third-party app write access (Mend) | Documented self-hosted fallback + rollback | Accepted; revocable |
| Auto-merge to `main` with no deploy pipeline | Low blast radius — app runs locally via launchd | Accepted |
| Renovate vs. Dependabot PR collision | Dependabot security updates off; Renovate sole PR opener | None once §5.4 done |
| Renovate bumps the Hono line and changes advisory status | `audit-ci` re-evaluates every PR; allowlist removal trigger documented | None — gate catches it |

## 11. Follow-up (implementation)

Implemented on `feature/dependency-automation` via a PR referencing **`Part of #59`** (no closing
keyword). #59 remains open through operational acceptance (§7) and is closed by the HC after live
verification.

**Pin guard (in this PR):** [`scripts/check_action_pins.rb`](../../../scripts/check_action_pins.rb)
(stdlib-only, with a `.test.sh` self-test) fails CI if any workflow reintroduces an unpinned external
`uses:`, wired into `parity.yml` so the hardening cannot erode as new steps are added. The convention
is documented in [`rules/security.md`](../../../rules/security.md) (Patterns + Anti-Patterns).
