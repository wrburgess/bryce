# Dependency Automation & Supply-Chain Hardening — Design Spec

- **Date:** 2026-07-21
- **Status:** Draft (design approved; pending spec review)
- **Owner:** @wrburgess
- **Scope:** Routine, low-effort dependency updates for the Bryce app that stay current *and*
  resist supply-chain poisoning ("pipeline injection").
- **Dependency surface:** npm packages + GitHub Actions only. The Ruby tooling
  (`scripts/parity_check.rb`) has no gems.

## 1. Problem & goals

Keep the app on current, secure dependencies with **minimal ongoing attention**, while hardening the
two poisoning vectors that matter for this repo: **malicious npm releases** and **compromised
GitHub Actions**.

**Goals**

- Updates propose (and mostly merge) themselves on a predictable cadence, not manually.
- A freshly-published *malicious* version cannot reach `main` before it has had time to be caught.
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
- **CI** (`.github/workflows/app.yml`): `npm ci` → typecheck → lint → test → `npm run audit`
  (`audit-ci`), on every PR and push to `main`. Actions are referenced by **mutable tags**
  (`actions/checkout@v4`, `actions/setup-node@v4`) — the injection hole this spec closes.
- **Security gate:** `audit-ci` (`audit-ci.jsonc`) fails on **moderate+** advisories in **production**
  deps, skips dev, and carries a **documented allowlist with removal triggers** (currently one Hono
  advisory that is non-exploitable in this deployment). This gate is good and is **kept as-is**.
- **Existing Dependabot:** an `origin/dependabot/npm_and_yarn/…` branch exists, but there is **no
  `.github/dependabot.yml`** — so Dependabot **security updates** are auto-enabled and already opening
  PRs. This must be reconciled so Dependabot and Renovate do not both open update PRs (see §5.4).
- **No routine update mechanism** for version currency today — bumps are manual.

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Update engine | **Renovate** | Release-age cooldown, fine-grained grouping/auto-merge, dependency dashboard, and it SHA-pins + updates Actions. Built for "set and forget." |
| Hosting | **Mend Renovate GitHub App** (free) | Zero maintenance; free for unlimited private repos. Trade-off: a third-party app gets write + auto-merge access. **Fallback:** self-hosted `renovatebot/github-action` on a cron (also free) if third-party access is unwanted. |
| Auto-merge posture | **Aggressive** | Auto-merge patch/minor for *all* deps + Action SHA bumps after green CI **and** cooldown; hold only majors. Safety rides on CI + the cooldown. |
| Vulnerability data | **Dependabot alerts (only)** → consumed by Renovate | Free GHSA/OSV feed. Dependabot's *version/security PRs* are turned off; Renovate owns all PRs. |
| Security-fix cadence | **Bypass the cooldown** | A CVE fix should not wait 5 days. |

**Cost:** $0. The Mend app is free for unlimited private repos; auto-merge is a core Renovate feature
(not paywalled). Self-hosting the OSS CLI/Action is also free.

## 4. Architecture — two-tool division of labor

```
GitHub "Dependabot alerts" (free GHSA/OSV feed)
        │  (vulnerability signal only — no Dependabot PRs)
        ▼
   Renovate  ── opens ─▶  security PRs   (cooldown BYPASSED, label: security, fast-track)
        │
        └────── opens ─▶  routine PRs    (cooldown ENFORCED, grouped, weekly schedule)
                                │
                                ▼
                     CI (typecheck·lint·test·audit-ci) must be green
                                │
                    ┌───────────┴────────────┐
              patch / minor              major
              → auto-merge          → held on Dependency Dashboard
```

- **Dependabot** contributes only the vulnerability feed.
- **Renovate** is the sole opener of update PRs, applies the cooldown, groups, schedules, and
  auto-merges per §6.
- **CI** is unchanged and is the merge gate. **`audit-ci` stays authoritative**, including its
  allowlist; any Renovate PR that reintroduces a gated advisory fails CI and does not merge.

## 5. Components

### 5.1 `renovate.json` (repo root) — target config

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended",
    "helpers:pinGitHubActionDigests", // pin Actions to SHAs + keep current
    ":dependencyDashboard",           // the single "worry surface" issue
    ":semanticCommits"
  ],
  "timezone": "America/Chicago",       // TODO: confirm owner's timezone
  "schedule": ["before 6am on monday"],// one quiet weekly batch
  "minimumReleaseAge": "5 days",       // anti-poisoning cooldown (global)
  "internalChecksFilter": "strict",    // enforce cooldown before a PR is even raised
  "packageRules": [
    {
      "description": "Aggressive: auto-merge patch+minor for all deps after green CI + cooldown",
      "matchUpdateTypes": ["patch", "minor"],
      "matchDepTypes": ["dependencies", "devDependencies"],
      "automerge": true
    },
    {
      "description": "Keep GitHub Actions SHA-pinned; auto-merge digest/minor bumps",
      "matchManagers": ["github-actions"],
      "automerge": true
    },
    {
      "description": "Hold ALL major upgrades for manual review via the dashboard",
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "dependencyDashboardApproval": true
    },
    {
      "description": "Hold Node major bumps (runtime-environment change) too",
      "matchDepNames": ["node"],
      "matchUpdateTypes": ["major"],
      "dependencyDashboardApproval": true
    }
  ],
  "lockFileMaintenance": {
    "enabled": true,
    "automerge": true,
    "schedule": ["before 6am on monday"]
  },
  "vulnerabilityAlerts": {
    "labels": ["security"],
    "minimumReleaseAge": null          // CVE fixes bypass the cooldown
  }
}
```

Notes:
- `dependencyDashboardApproval: true` on majors means a major does **not** open a PR until it is
  ticked on the dashboard issue — that issue is the entire manual surface.
- `internalChecksFilter: "strict"` guarantees the cooldown is applied *before* a PR appears, so the
  dashboard never lists an update that is not yet old enough.
- Range strategy stays Renovate's `config:recommended` default (`replace`): lockfile-only bumps for
  in-range patch/minor, `package.json` diffs only when a bump escapes the existing `^` range. This is
  intentional and keeps auto-merge diffs small.

### 5.2 GitHub Actions SHA pinning (`.github/workflows/*.yml`)

`helpers:pinGitHubActionDigests` rewrites every `uses:` to a full 40-char commit SHA with the version
as a trailing comment, e.g.:

```yaml
- uses: actions/checkout@<40-char-sha> # v4.2.2
- uses: actions/setup-node@<40-char-sha> # v4.1.0
```

Renovate then proposes SHA bumps as normal PRs (auto-merged after CI). This is the primary
pipeline-injection mitigation. Applies to both `app.yml` and `parity.yml`.

**Digest/minor vs major:** within a major tag (e.g. `v4` → newer `v4` SHA), digest bumps auto-merge.
A **major tag bump** (`v4` → `v5`) is caught by the "hold all majors" rule in §5.1 (later `packageRules`
override earlier, so `automerge:false` + `dependencyDashboardApproval` win) and is held for review —
intended, since an action's major can change behavior.

### 5.3 Node version pinning

- Keep `.nvmrc` and `engines.node`; Renovate's `node` manager proposes minor bumps (auto-merged) and
  **holds the next major** (e.g. Node 24 LTS) for review.
- Optionally tighten CI's `node-version: 22` to the concrete pinned minor for reproducibility — left
  as an implementation detail, not a blocker.

### 5.4 Dependabot reconciliation (repo Settings — manual, one-time)

- **Keep ON:** Settings → Code security → **Dependabot alerts** (feeds Renovate's `vulnerabilityAlerts`).
- **Turn OFF:** **Dependabot security updates** (the auto-opened PRs) — Renovate now owns security PRs.
- Close/supersede the existing stale `dependabot/npm_and_yarn/…` PR after Renovate's first run.
- No `.github/dependabot.yml` is added (adding one would re-enable Dependabot PRs).

### 5.5 Branch protection (repo Settings — manual, one-time)

For a solo repo, configure `main` so auto-merge only fires on green **without** blocking on a human
approval Renovate cannot provide:

- **Require status checks to pass:** require the `checks` job from `app.yml` (and `parity` if desired).
- **Do NOT require pull-request approvals** — a required human approval would deadlock Renovate's
  auto-merge on a single-maintainer repo.
- Renovate uses GitHub-native auto-merge (`platformAutomerge`, on by default), which needs the
  required-checks rule above to function.

## 6. Auto-merge rule matrix

| Update class | Cooldown | CI gate | Behavior |
|---|---|---|---|
| Dev-deps + CI tooling, patch/minor | 5 days | required | ✅ auto-merge |
| **Runtime deps, patch/minor** (incl. `better-sqlite3` minor/patch) | 5 days | required | ✅ auto-merge |
| GitHub Action digest / minor bumps (within a major tag) | 5 days | required | ✅ auto-merge |
| Lockfile maintenance (weekly) | n/a | required | ✅ auto-merge |
| Security / CVE fix | **bypassed** | required | ✅ fast-track auto-merge |
| **Any major** (deps, dev-deps, `better-sqlite3`, Node, Action major tag) | 5 days | required | ⏸️ held on Dependency Dashboard |

The aggressiveness is bounded by two hard gates that cannot be skipped: **CI must be green** and (for
everything but security) **the release must be ≥5 days old**.

## 7. Rollout plan

1. **Repo Settings:** Dependabot **alerts ON**, Dependabot **security updates OFF** (§5.4).
2. Add `renovate.json` (§5.1); validate locally with `npx --yes renovate-config-validator`.
3. Install the **Mend Renovate GitHub App** on the repo (or land the self-hosted workflow).
4. **Review the Renovate onboarding PR** — confirm SHA-pinning and cooldown behave as designed —
   before enabling auto-merge trust. Merge it.
5. **Branch protection:** require the `checks` context; no required approvals (§5.5).
6. Watch the first weekly batch; confirm auto-merge fires **only** on green + past cooldown.
7. Close the stale Dependabot PR.

## 8. Verification / success criteria

- `renovate-config-validator` passes.
- After onboarding: all `uses:` in `.github/workflows/*` are SHA-pinned with version comments.
- A deliberately-old patch bump auto-merges after CI; a `<5-day-old` release does **not** appear yet.
- A major bump appears as an unchecked item on the Dependency Dashboard, not as an open PR.
- A simulated/real vulnerability alert produces a `security`-labelled PR that ignores the cooldown.
- `audit-ci` still gates; the Hono allowlist entry is untouched and still documented.

## 9. Risks & mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| Aggressive auto-merge lands a broken runtime bump | CI (typecheck/lint/test/audit) gates the merge; majors held | A bad release that still passes the test suite — bounded by test coverage; majors excluded |
| Poisoned npm release | 5-day `minimumReleaseAge` cooldown; audit-ci gate | A malicious release not caught/yanked within 5 days (rare) |
| Compromised GitHub Action | SHA pinning + Renovate-managed digest bumps | A malicious commit shipped *before* pinning — closed at onboarding |
| Third-party app write access (Mend) | Documented self-hosted fallback (§3) | Accepted for convenience; revocable |
| Auto-merge to `main` with no deploy pipeline | Low blast radius — app runs locally via launchd, no server auto-deploy | Accepted |
| Renovate vs. Dependabot PR collision | Dependabot security updates turned off; Renovate sole PR opener | None once §5.4 done |
| Renovate bumps the Hono line and changes advisory status | `audit-ci` re-evaluates on every PR; allowlist removal trigger already documented | None — gate catches it |

## 10. Open questions (resolved)

- **Renovate vs Dependabot?** → Renovate (§3).
- **Hands-off level?** → Aggressive (§3, §6).
- **Pay for it?** → No; free path chosen (§3).
- **Timezone for the weekly schedule?** → confirm during implementation (currently `America/Chicago`).

## 11. Follow-up (implementation)

Implementation follows this repo's Branch & PR policy: this `feature/dependency-automation` branch, a
tracking issue, and one PR (`Closes #N`). Config-only + docs + Settings changes; no app-behavior
changes. The `renovate.json`, workflow SHA-pinning, and settings steps become the ordered plan.
