# A stack-neutral baseline; stack specifics live in overlay (sidecar) bundles

**Status:** accepted

The Generic Baseline calls itself business-neutral, but its Rules Layer baked Ruby/Rails in as the
assumed stack — `default_scope`, `find_each`, Hotwire/Turbo/Stimulus, ViewComponent, RSpec `spec/`,
fixtures, POROs (issue #48). The *principle* behind each of those is universal; only the vocabulary is
stack-locked. We decided the baseline rule text will name **no stack** and state each rule as a
neutral, stack-agnostic principle, and that every concrete stack-named pattern/anti-pattern is
**extracted out of the baseline entirely** into a separate **Stack Overlay** (a.k.a. Sidecar Bundle) —
`ai-config-rails` being the first — that a Host App vendors *alongside* the baseline. See
[`CONTEXT.md`](../../CONTEXT.md) → *Stack Overlay*.

## Considered options

- **Truly stack-neutral core (chosen).** Rule text names no stack; concrete method/tool names are
  relocated. Honest about the business-/stack-neutral promise `AGENTS.md` makes.
- **Rails-as-default-placeholder (rejected).** Keep Rails concretely in the rules as the shipped
  default (like `PROJECT.md`'s placeholder model). Teaches concretely, but leaves the baseline
  substantively Rails-partisan — the exact drift #48 exists to remove.
- **Within the neutral core: inline demoted examples vs. extract to an overlay.** We first considered
  keeping one concrete anchor *inline* per rule (`e.g. Rails' default_scope`). We chose instead to move
  the concrete layer **out** of the baseline into the overlay, so the baseline is genuinely
  stack-agnostic rather than "Rails with a fig leaf." The neutral principle keeps its full `— because …`
  reasoning (most of the pedagogical value); a Rails host that vendors both repos sees the concrete
  example in the overlay, where it applies.

## How the extraction works

- **Uniform concrete-layer extraction.** Every rule file keeps its neutral principle + reasoning + a
  generic overlay pointer (`Extend per host — concrete stack examples live in the matching overlay,
  e.g. ai-config-rails`). Structure is untouched: the seven `rules/*.md` files, their `## Patterns` /
  `## Anti-Patterns` sections ([ADR 0004](0004-two-tier-rules-layer-progressive-context.md)), and the
  trigger table all survive — the parity contract stays green. No rule file is deleted or emptied.
- **Re-anchor opinionated anti-patterns on their universal harm, not the named technology.** Where an
  anti-pattern encodes a *stance* a host would reject (frontend's "never introduce a SPA framework"
  reads as wrong to a React host), the neutral rule names the universal harm — "never run a second,
  parallel UI rendering paradigm alongside the one the app is committed to" — and demotes the framework
  names to the overlay. The teeth (the concrete harm) survive and the rule becomes correct for any host.
- **Trigger table re-keyed by role.** The "Working in…" column names roles (backend/domain code,
  UI/view code, tests) rather than Rails path globs; a host binds each role to its own globs in
  `PROJECT.md` or its overlay.

## Consequences

- The standalone `ai-config-rails` repo is a **follow-up**, out of this issue's scope. Interim, a
  single staging document `docs/overlays/ai-config-rails.md` seeds it and doubles as the old→new
  mapping table (issue #48's acceptance criterion: nothing silently dropped). The follow-up extracts
  that doc into its own repo and removes it here.
- The baseline loses its *inline* concrete anchors; a host that wants them vendors the matching
  overlay. The neutral principle + reasoning + overlay pointer is what ships in the baseline.
- Baseline references to the not-yet-existing overlay repo/doc are **inert backticked text, never
  markdown links**, per the forward-reference convention in
  [`docs/rules/README.md`](../rules/README.md), so the parity link-checker stays green.
- Rules-neutrality is guarded by author + review, not a machine check — see
  [ADR 0018](0018-neutrality-pass-scope-tooling-and-enforcement.md).
