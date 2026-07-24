# Named player lists scope digests and queries

Bryce supports **named player lists** (issue #70): the HC can define lists over the Watch List and
scope a **digest**, a **preview**, or a **stat-line query** to one list's members. A list is a single
service (`src/lists/service.ts`) exposed on all three surfaces (CLI, REST, MCP — ADR 0027), backed by
two new tables (`player_lists`, `list_members`). A list is **curated membership**, deliberately kept
**distinct from** a **tag** (a queryable attribute, #30) and a **fantasy roster** (a future
specialization of a list, #69), and composable with them; there is no coupling to the unbuilt #30.

## Considered Options

- **Dedicated list tables with an implicit default (chosen).** `player_lists(id, name, created_at,
  updated_at, deleted_at)` and `list_members(id, list_id→player_lists.id, player_id→players.id,
  created_at)`. Every constraint is declared in the ORM schema so the drizzle snapshot re-emits it on
  a future table rebuild (`rules/backend.md`): a **partial unique index** on `name WHERE deleted_at IS
  NULL`, a non-blank-name `CHECK`, a `unique(list_id, player_id)`, and both foreign keys. When **no
  list is named**, every read keeps today's exact path (`players.active = true`, no membership join) —
  no seeded default row, no backfill, today's behavior byte-for-byte unchanged.
- **A `list` column on `players` (single-list membership).** Rejected: a player belongs to at most one
  list, and adding a second list means a migration. A join table is the natural many-to-many and lets
  a player sit in several lists at once.
- **Reuse the (unbuilt) tag model (#30) as the list mechanism.** Rejected: a tag is a *queryable
  attribute*, a list is *curated membership* — different concepts with different lifecycles. Folding
  one into the other couples this change to unbuilt work and muddies both. They stay distinct and
  composable.

## Consequences

The five decisions this ADR fixes:

1. **Implicit default.** No list named ⇒ the untouched current path. There is no "all players" list
   row to maintain and no backfill; the only code that changes is the *scoped* read, which adds a
   membership filter.
2. **Membership sits UNDER `players.active`.** A named-list scope selects the *active* members of the
   list. `players.active` stays the master gate: a deactivated player never appears, even while still
   listed. The refresh sweep (`loadActivePlayers`) is **left whole** — only the digest *read* is
   scoped, so ingestion still covers the entire Watch List.
3. **Soft-delete a list, hard-delete a membership.** A list definition carries the HC's curation
   intent, so `deleteList` stamps `deleted_at` (recoverable, and the partial unique index frees the
   name for reuse). A single membership join row carries no irreplaceable state — the player and his
   stats are untouched — so `removeFromList` is a plain delete, sparing every scoped read a
   `deleted_at IS NULL` filter (an implicit-scope smell, `rules/backend.md`).
4. **Named-list digests are on-demand/preview only this PR.** The delivery-slot unique index
   `(kind, date_covered)` has no list dimension, so a *scheduled* per-list delivery would collide on
   the slot. `send_digest`/`POST /digest/send`/`digest --list` may take a `list` for an **on-demand**
   send (routed to the no-claim, no-delivery-row path whatever the window); the daily scheduled 1d
   slot is unaffected because the scheduler passes no list. Per-list *scheduled* deliveries are a
   documented follow-up.
5. **Distinct concepts.** A *list* is curated membership; a *tag* (#30) is a queryable attribute; a
   *fantasy roster* (#69) is a future specialization of a list. No coupling to unbuilt #30.

Further consequences:

- **The two-selection-site hazard is closed.** `assembleDigest` selects players in the main
  `stat_lines ⨝ players` join **and** via the active-player set (which feeds the idle/zero-row tail and
  `seasonStartFor`). A list scope filters **both** or an off-list player leaks — as a real row, a zero
  row, or a distorted `ytd` window. A dedicated leak guard pins this (`test/digest-list.test.ts`).
- **Typed errors reach every surface.** `UnknownListError` (REST 404 / MCP `isError` / CLI `error=`,
  exit 1) and `DuplicateListNameError` (REST 409) join the existing error seams, with a sad-path test
  per surface (`rules/backend.md`). Unknown player references reuse `PlayerNotFoundError`.
- **The reserved `list` seam is now live.** ADR 0045 left `BatchAddInputBase.list` shape-validated but
  ignored; it now targets an **existing** list (batch-add never *creates* a list — an unknown list
  fails the whole call closed, before any write) and adds every staged player to it.
- **Backup format bump 1 → 2, backward compatible.** A v2 Player List Backup adds optional `lists`
  (live lists) and `members` (each referencing a player by natural id and a list by name).
  `createPlayerListBackup` emits v2 with the live lists and their memberships; `restorePlayerListBackup`
  recreates them **inside its existing all-or-nothing transaction** — a membership whose player natural
  id does not resolve aborts the import, consistent with the restore's strictness. A v1 payload (no
  lists/members) still restores. Soft-deleted lists are excluded from the backup (a deleted list is not
  a roster choice to preserve).
- **Additive, reversible migration.** Two new tables, no change to existing rows, so no backfill and no
  risk to current data; it auto-applies on next startup after the pre-migration Snapshot (ADR 0042).
  Reversible in practice by dropping the two tables.
