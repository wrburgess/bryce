# Two-tier Rules layer for progressive context loading

**Status:** accepted

Knowledge (patterns + anti-patterns + domain guidance) lives in a **two-tier Rules layer**, kept separate from the Project Config (which is settings only). This is the mechanism for "load the right amount of context per session, load more when needed."

- **Tier 1 — Lean Core.** Small, invariant per-domain rule files, always resident. Reachable from `AGENTS.md` so **every** tool receives them; Claude's `.claude/rules/` auto-load is a tool-specific accelerator over the same content. Each file carries a **Patterns** section and an **Anti-Patterns** section, plus a header stating its trigger and a pointer to its deep file.
- **Tier 2 — Deferred Deep Docs.** Heavy, subsystem-specific case studies in `docs/rules/<domain>-postmortems.md`. **Not** auto-loaded — read on demand (or via a dispatched sub-agent) when work touches that subsystem. Keeping these out of Tier 1 is what actually keeps session context lean.

An explicit **trigger table** tells an agent *when* to load a deferred doc (e.g. "working in `app/models/` → read `backend-postmortems.md`").

## Anti-Patterns are first-class

The imperative anti-pattern format ("**Never** X — *because* Y", with an optional host-filled reference slot) has proven effective at steering agents away from choices we never want. It is a **required section** of every rule file, not an afterthought.

## Baseline ships a generic starter set

The Generic Baseline ships a small, business-neutral set of widely-accepted Rails rules (e.g. `testing.md`, `security.md`, `self-review.md`, generic `backend.md`/`frontend.md`) with real starter Anti-Patterns (`never default_scope`, `prefer find_each`, `no fixtures — factories`) marked "extend per host." No domain/business content. Two tiers exist from day one so hosts grow depth into an existing structure rather than inventing one.

## Consequences

- Every rule file must separate always-true invariants (Tier 1) from deep case studies (Tier 2); a rule that grows heavy is a signal to push detail down to Tier 2, not to bloat the core.
- The CI parity check should confirm every Tier-1 rule referenced by `AGENTS.md` exists and that each declares its Anti-Patterns section.
