# Backend Rules

**Applies to:** Backend / domain code — models, controllers, background jobs, and service objects
**Deep doc:** `docs/rules/backend-postmortems.md` (Tier 2 — deferred; read on demand when a trigger fires)

> Tier-1 Lean Core ([ADR 0004](../docs/adr/0004-two-tier-rules-layer-progressive-context.md)): always-resident invariants. Keep this file lean — push heavy, subsystem-specific case studies down to the deep doc. These are business-neutral, stack-neutral starters; **extend per host** — concrete stack-named examples live in the matching **Stack Overlay** (e.g. `ai-config-rails`), vendored alongside the baseline.

## Patterns

- **Framework & standard-library first.** Before building anything custom, prefer your framework's built-ins and the standard library, then established, well-maintained libraries. Reach for custom code only when nothing fits — and say why in the assessment/plan.
- **Thin controllers.** Keep controller actions to request/response orchestration; put domain logic in domain models, shared modules, or dedicated service/domain objects.
- **Authorize every non-public action** with the host's authorization layer — deny by default, never hardcode role checks inline.
- **Enforce invariants in the database too.** Pair model validations with DB-level constraints (`NOT NULL`, unique indexes, foreign keys); a validation is not a guarantee under concurrency.
- **Thread every new error type through every surface's error seam.** When you introduce a typed error, update each surface's mapping in the same change — the API error handler's status mapping, any RPC/tool layer's known-error set, and every service-layer catch that classifies errors — and add a sad-path test per surface. A seam that doesn't know the type mishandles it silently: a crash, a wrong status code, or a misleading classification. *(Host case study: `docs/rules/backend-postmortems.md`.)*
- **Confirm an external source's actual fields before coding around an assumed absence.** Before building fail-closed, degraded, or deferred behavior on the premise that a source omits a field, verify that premise against the real payload — the bundled fixture or a live sample — not the adapter's own mapping table, which shows only the fields you chose to read. "The source doesn't carry X" is a factual claim, owed the same citation discipline as any other (`rules/self-review.md`). *(Host case study: `docs/rules/backend-postmortems.md`.)*

## Anti-Patterns

- **Never introduce an implicit global query scope** that silently applies to every read, association, and new-record default — because it silently leaks into every query and is painful to bypass; use explicit, named scopes instead. *(Extend per host.)*
- **Never load a whole table into memory at once** — because iterating every row at once exhausts memory; stream large result sets in batches instead. *(Extend per host.)*
- **Never issue a query per loop iteration (an N+1)** — because it fires a query every time around the loop; preload the data or keep a maintained count instead. *(Extend per host.)*
- **Never add a heavyweight service-object framework** where a plain object would do, without a documented justification — because a plain domain object covers almost every case. *(Extend per host.)*
- **Never infer that an external source lacks a field by reading the adapter's mapping table alone** — because the table shows only what you chose to map, not what the source sends; an unmapped-but-present field then reads as "missing" and any fail-closed / degraded / deferred path built on that assumption silently drops real data. Confirm against the actual fixture or a live sample before coding around the absence. *(Provenance: issue #54 / PR #62; extend per host.)*
