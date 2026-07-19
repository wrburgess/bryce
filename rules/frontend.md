# Frontend Rules

**Applies to:** UI / view-layer code — templates, view components, client-side behavior, and assets
**Deep doc:** `docs/rules/frontend-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Native / server-driven interactivity first.** Prefer your platform's native or server-driven interactivity before reaching for heavier client-side machinery; most "we need a frontend framework" cases are a small server-driven fragment plus a little scoped behavior.
- **Reusable UI as components.** Extract repeated markup into reusable UI components rather than duplicating it across templates, and unit-test each component in isolation.
- **Behavior in named, testable units.** Wire DOM behavior through named, discoverable, testable units so it is easy to find and test.
- **Style with the design system.** Use the host CSS framework's utility classes and shared stylesheets; keep markup semantic.

## Anti-Patterns

- **Never run a second, parallel UI rendering paradigm** alongside the one your app is already committed to — because it fractures the established model and doubles the rendering stack. *(Extend per host.)*
- **Never write untestable inline behavior scripting in a template/view** — because it can't be reused or tested; move it into a named, testable behavior unit. *(Extend per host.)*
- **Never add a parallel DOM-manipulation idiom** that duplicates your primary interactivity model — because your existing model already owns DOM interaction; a second idiom reintroduces a parallel, untested path. *(Extend per host.)*
- **Never add inline styles in a template** — because they bypass the design system; use utility classes or a stylesheet. *(Mailer/email templates, which require inline CSS for email-client compatibility, are the documented exception.)*
