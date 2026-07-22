# Security Rules

**Applies to:** Code handling secrets, auth, or input
**Deep doc:** `docs/rules/security-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Keep secrets out of the repo.** Use per-environment encrypted credentials or the deploy platform's secret store; read config from there, never from committed literals.
- **Run the scanners before every commit/push.** Wire the host's static-analysis and dependency-audit tools into the required workflow so a vulnerability is caught locally, not in review.
- **Pin third-party CI actions to an immutable ref.** Reference every external CI action by a full commit SHA (`owner/repo@<40-hex>`), not a mutable tag or branch, and let a dependency bot keep the SHA current. Wire a guard into the required workflow so a newly-added unpinned reference fails the build (this host: [`scripts/check-action-pins.ts`](../scripts/check-action-pins.ts)).
- **Fail closed on authorization.** Deny by default; an action that forgets to authorize should be inaccessible, not open.
- **Normalize input at the boundary** before any authorization or "require a filter" guard.

## Anti-Patterns

- **Never commit secrets, API keys, or tokens** — because history is forever and public mirrors get scraped; if one lands, rotate it immediately and scrub the history. *(Extend per host.)*
- **Never blanket-disable a scanner warning without a documented justification** — because an unexplained suppression hides real regressions; annotate it with a reason, who approved it, and the date. *(Extend per host.)*
- **Never reference a CI action by a mutable tag or branch** (`@v4`, `@main`) — because whoever controls that action's repo can repoint the tag to malicious code that runs in your pipeline with your secrets; pin to a full commit SHA and let a bot keep it current. *(Extend per host.)*
- **Never trust a bare presence/truthiness check to mean "has a real value"** — because a whitespace-only string (`"   "`) or a collection of only blanks (`["", nil]`) still reads as present; strip/coerce input at the boundary before guarding on it. *(Extend per host.)*
- **Never emit user-influenced text into a CSV, spreadsheet, Markdown, or HTML cell without that format's own escaping** — because a value beginning `=`/`+`/`-`/`@` (or a newline) becomes a live spreadsheet formula, an unescaped `|`/newline forges extra table columns or rows, and `![x](url)`/`<img>` auto-loads a remote resource; run every exported cell through a format-specific quote/escape (RFC-4180 quoting + an OWASP formula-guard for CSV; delimiter + link/image escaping for Markdown; HTML-entity escaping for HTML). *(Extend per host.)*
- **Never front a headless agent/MCP endpoint with an interactive identity gate** (e.g. a Cloudflare Access browser-login policy) — because a hosted AI connector or CLI agent cannot complete the interactive login and is bounced before it reaches the app's own auth, so the endpoint silently fails to connect; exempt that path from the interactive policy (leaving the app's bearer/token as its layer — and note it is then single-layer) or protect it with a non-interactive service token. *(Provenance: #37 / PR #75; extend per host.)*
