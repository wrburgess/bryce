# ai-config-rails — Stack Overlay (seed content)

> **Status:** seed content for the future standalone `ai-config-rails` **Stack Overlay** repo
> ([ADR 0017](../adr/0017-stack-neutral-baseline-with-stack-overlays.md)). **Interim** — it lives here
> until a follow-up issue extracts it into its own repo and removes it from the baseline. A Rails
> **Host App** vendors this overlay *alongside* the Generic Baseline to restore the concrete,
> Rails-named patterns and anti-patterns that the baseline states only as neutral, stack-agnostic
> principles.

The baseline names **no stack**. This document is the Rails **concrete layer** for it — and, until the
extraction lands, it doubles as the **old → new mapping table** for issue #48's stack-neutrality pass:
every concrete Rails identifier removed from a `rules/*.md` file appears here as a row, so nothing was
silently dropped. Each row pairs the **neutral baseline principle** (which keeps its full `— because …`
reasoning in the baseline) with the **Rails concrete** that illustrates it. A Rails host reading both
repos sees the concrete where it applies.

## Backend

| Neutral baseline principle | Rails concrete |
|---|---|
| **Framework & standard-library first** — prefer the framework's built-ins and the standard library, then well-maintained libraries, before custom code. | "Rails ecosystem first": Rails built-ins (callbacks, concerns, validations, enums, delegations, STI, polymorphic associations), then established, well-maintained **gems**. |
| **Thin controllers** — put domain logic in domain models, shared modules, or dedicated service/domain objects. | Models, **concerns**, or plain Ruby objects (POROs) under `app/services/`. |
| **Never introduce an implicit global query scope** that silently applies to every read, association, and new-record default; use explicit, named scopes. | `default_scope`; use explicit named scopes instead. |
| **Never load a whole table into memory at once** — stream large result sets in batches. | `.all.each`; use `find_each` for 100+ records. |
| **Never issue a query per loop iteration (an N+1)** — preload the data or keep a maintained count. | `.count` inside a loop; preload or use a **counter cache**. |
| **Never add a heavyweight service-object framework** where a plain object would do. | Service-object gems — **Interactor**, **Trailblazer**, **Dry-Transaction** — where a plain PORO under `app/services/` covers the case. |

## Frontend

| Neutral baseline principle | Rails concrete |
|---|---|
| **Native / server-driven interactivity first** — prefer the platform's native or server-driven interactivity before heavier client-side machinery. | "Hotwire first": Turbo (frames, streams) + Stimulus — most "we need a frontend framework" cases are a Turbo frame plus a small Stimulus controller. |
| **Reusable UI as components** — extract repeated markup into reusable, unit-tested UI components. | ViewComponents (rather than partial soup), unit-tested in isolation. |
| **Behavior in named, testable units** — wire DOM behavior through named, discoverable, testable units. | Stimulus controllers / targets / actions. |
| **Never run a second, parallel UI rendering paradigm** alongside the one the app is already committed to. | A SPA / component framework — **React**, **Vue**, **Angular**, **Alpine**, **Svelte** — bolted on alongside Hotwire. |
| **Never write untestable inline behavior scripting in a template/view.** | Inline `<script>` JavaScript in a view; move it into a Stimulus controller. |
| **Never add a parallel DOM-manipulation idiom** that duplicates the primary interactivity model. | **jQuery** (or a jQuery plugin) — Stimulus + Turbo already own DOM interaction. |
| **Never add inline styles that bypass the design system** (mailer/email templates excepted). | Inline styles in a template vs. the host CSS framework's utility classes / shared stylesheets. |

## Testing

| Neutral baseline principle | Rails concrete |
|---|---|
| **The test suite** (Applies-to header + body references). | `spec/` (RSpec). |
| **Build each case's data with programmatic builders** instead of schema-coupled static test data. | **Factories (FactoryBot)** over Rails **fixtures**. |
| **Build the test infrastructure the scenario needs** (helpers, shared setup, data builders, HTTP record/replay). | RSpec **shared contexts**, FactoryBot **factories**, VCR-style record/replay. |
| **Never insert a wall-clock wait** (a real-time sleep) in a test — control the clock instead. | `sleep`; use `freeze_time` / `travel_to` (ActiveSupport time helpers). |

## Scripting

| Neutral baseline principle | Rails concrete |
|---|---|
| **Dependency-free by default** — run on a bare runtime using only the standard library (no third-party packages, no package manager). | No **gems**, no **Bundler**; a bare `ruby` interpreter. |
| **Never add a third-party dependency to a bundled script.** | Never add a **gem** dependency; reach for the Ruby standard library. |

## Security

| Neutral baseline principle | Rails concrete |
|---|---|
| **Never trust a bare presence/truthiness check to mean "has a real value"** — a whitespace-only string or a collection of only blanks can read as present. | `present?`: `"   ".present?` and `["", nil].present?` are both true (ActiveSupport). |
