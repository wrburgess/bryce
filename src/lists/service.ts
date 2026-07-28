import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerListRow, PlayerRow } from "../db/schema.js";
import { listMembers, playerLists, players } from "../db/schema.js";
import type { PlayerRef } from "../watchlist/service.js";
import { PlayerNotFoundError } from "../watchlist/service.js";

/**
 * Named-list service (issue #70 / ADR 0046): the one home for create/rename/
 * delete/membership/scope semantics, shared by the CLI, REST, and MCP surfaces
 * (ADR 0027). Typed results and typed errors — no output sink; presentation
 * stays with each caller.
 *
 * A list is CURATED membership over the Watch List, distinct from a tag (#30)
 * and a fantasy roster (#69). A named-list scope selects the ACTIVE players who
 * are members — `players.active` stays the master gate (ADR 0046 decision 2).
 * Names are trimmed, non-blank, and case-sensitively unique among LIVE lists.
 */

/** No LIVE list exists with the requested name (used for scoping and mutation). */
export class UnknownListError extends Error {
  readonly listName: string;

  constructor(listName: string) {
    super(`no list named "${listName}"`);
    this.name = "UnknownListError";
    this.listName = listName;
  }
}

/** A LIVE list already carries the requested name (create/rename collision). */
export class DuplicateListNameError extends Error {
  readonly listName: string;

  constructor(listName: string) {
    super(`a list named "${listName}" already exists`);
    this.name = "DuplicateListNameError";
    this.listName = listName;
  }
}

/**
 * No LIVE list carries `is_default` (#190). Unscoped commands resolve THE
 * default lane, so this is a refusal, never a silent widening to the whole Watch
 * List: an unscoped digest that quietly mailed everyone would be indistinguishable
 * from a correctly configured one. The migration seeds a default, so reaching
 * this means the HC deleted or unset it — recoverable with `lists set-default`,
 * which the message names.
 */
export class NoDefaultListError extends Error {
  constructor() {
    super("no default list is set — run: sk players lists set-default --name NAME");
    this.name = "NoDefaultListError";
  }
}

/**
 * The target of a delete is the live default (#190). Refused rather than
 * cascaded: deleting it would leave every unscoped command raising
 * NoDefaultListError, so the HC must point the default elsewhere FIRST and then
 * delete — an ordering the error message states.
 */
export class CannotDeleteDefaultListError extends Error {
  readonly listName: string;

  constructor(listName: string) {
    super(
      `"${listName}" is the default list — set another default first: sk players lists set-default --name NAME`,
    );
    this.name = "CannotDeleteDefaultListError";
    this.listName = listName;
  }
}

/** A blank/whitespace-only or control-char-bearing list name reached the service (boundary schemas also reject it). */
export class BlankListNameError extends Error {
  constructor() {
    super("list name must not be blank or contain a control character");
    this.name = "BlankListNameError";
  }
}

/** A live list with its active-member count, for `listLists`. */
export interface ListSummary {
  id: number;
  name: string;
  memberCount: number;
  /** Whether this is THE default lane — what an unscoped command means (#190). */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Trim and reject a blank/whitespace-only name (rules/backend.md: guard in the service too). */
function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new BlankListNameError();
  // Reject any control character (defense-in-depth, rules/backend.md): a
  // newline/tab in a name could forge extra greppable output lines. This is the
  // CLI's validation path, which does not funnel through the Zod boundary.
  if (/\p{Cc}/u.test(trimmed)) throw new BlankListNameError();
  return trimmed;
}

/** The one live list with this exact (trimmed) name, or undefined. */
async function findLiveList(db: Db, name: string): Promise<PlayerListRow | undefined> {
  return (
    await db
      .select()
      .from(playerLists)
      .where(and(eq(playerLists.name, name), isNull(playerLists.deletedAt)))
  )[0];
}

/**
 * Resolve a live list by name to its row, or throw UnknownListError. The single
 * scoping entry point every surface funnels `:name` / `?list=` through so a typo
 * fails closed rather than silently widening a scope (ADR 0046).
 */
export async function resolveListByName(db: Db, name: string): Promise<PlayerListRow> {
  const list = await findLiveList(db, requireName(name));
  if (list === undefined) throw new UnknownListError(name.trim());
  return list;
}

/**
 * THE default lane, or NoDefaultListError (#190). The single place "no `--list`"
 * is answered, so an unscoped command can never resolve to something other than
 * a real, nameable list — the reversal of ADR 0046 decision 1's implicit default.
 */
export async function resolveDefaultList(db: Db): Promise<PlayerListRow> {
  const row = (
    await db
      .select()
      .from(playerLists)
      .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)))
  )[0];
  if (row === undefined) throw new NoDefaultListError();
  return row;
}

/**
 * The one funnel every surface and later phase routes list scoping through: an
 * explicit name wins, an absent one resolves the default. Both failure modes are
 * CLOSED — an unknown or soft-deleted name throws UnknownListError rather than
 * quietly falling back to the default, so a typo can never widen a scope into
 * someone else's lane, and a missing default is NoDefaultListError rather than
 * "everyone".
 */
export async function resolveListOrDefault(db: Db, name?: string): Promise<PlayerListRow> {
  if (name === undefined) return resolveDefaultList(db);
  return resolveListByName(db, name);
}

/**
 * Point the default lane at `name` (#190). Unknown live name → UnknownListError;
 * already the default → an idempotent no-op that writes nothing.
 *
 * ONE transaction, and the clear STRICTLY precedes the set: `player_lists_default_uq`
 * is a live-partial unique index, so setting the new default while the old one
 * still holds the flag violates it mid-statement. Doing both under one write lock
 * is also what keeps a crash from leaving the database with no default at all —
 * the state in which every unscoped command fails.
 */
export async function setDefaultList(db: Db, name: string, now: Date): Promise<PlayerListRow> {
  const trimmed = requireName(name);
  const nowIso = now.toISOString();
  return db.transaction(
    (tx): PlayerListRow => {
      const target = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.name, trimmed), isNull(playerLists.deletedAt)))
        .all()[0];
      if (target === undefined) throw new UnknownListError(trimmed);
      // Already the default: write NOTHING. A no-op that still bumped
      // `updated_at` would make a re-run look like a change in every audit.
      if (target.isDefault) return target;

      tx
        .update(playerLists)
        .set({ isDefault: false, updatedAt: nowIso })
        .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)))
        .run();
      const row = tx
        .update(playerLists)
        .set({ isDefault: true, updatedAt: nowIso })
        .where(eq(playerLists.id, target.id))
        .returning()
        .all()[0];
      if (row === undefined) throw new Error("setDefaultList update failed");
      return row;
    },
    { behavior: "immediate" },
  );
}

/** Create a new live list; a duplicate LIVE name is a DuplicateListNameError. */
export async function createList(db: Db, name: string, now: Date): Promise<PlayerListRow> {
  const trimmed = requireName(name);
  if ((await findLiveList(db, trimmed)) !== undefined) {
    throw new DuplicateListNameError(trimmed);
  }
  const nowIso = now.toISOString();
  try {
    const rows = await db
      .insert(playerLists)
      .values({ name: trimmed, createdAt: nowIso, updatedAt: nowIso })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("createList insert failed");
    return row;
  } catch (err) {
    // The partial unique index is the real guarantee under concurrency; surface
    // its violation as the typed error too (rules/backend.md).
    if (isUniqueViolation(err)) throw new DuplicateListNameError(trimmed);
    throw err;
  }
}

/** Rename a live list; unknown → UnknownListError, live collision → DuplicateListNameError. */
export async function renameList(
  db: Db,
  name: string,
  newName: string,
  now: Date,
): Promise<PlayerListRow> {
  const list = await resolveListByName(db, name);
  const trimmed = requireName(newName);
  if (trimmed !== list.name) {
    const clash = await findLiveList(db, trimmed);
    if (clash !== undefined) throw new DuplicateListNameError(trimmed);
  }
  try {
    const rows = await db
      .update(playerLists)
      .set({ name: trimmed, updatedAt: now.toISOString() })
      .where(eq(playerLists.id, list.id))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("renameList update failed");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateListNameError(trimmed);
    throw err;
  }
}

/**
 * Soft-delete a live list: stamp `deleted_at` so its curation intent is
 * recoverable and its name frees for reuse (ADR 0046 decision 3). Membership
 * rows are left in place — a deleted list is simply unresolvable for scoping.
 */
export async function deleteList(db: Db, name: string, now: Date): Promise<PlayerListRow> {
  const trimmed = requireName(name);
  const nowIso = now.toISOString();
  return db.transaction(
    (tx): PlayerListRow => {
      // ONE conditional UPDATE decides and acts (#190). Reading "is this the
      // default?" and then deleting on the answer is a check-then-act split: a
      // set-default landing in the gap would delete the list that had just BECOME
      // the default, leaving the database with none. The predicate carries all
      // three conditions — right name, still live, not the default — so the
      // database, not a prior read, is what refuses.
      const row = tx
        .update(playerLists)
        .set({ deletedAt: nowIso, updatedAt: nowIso })
        .where(
          and(
            eq(playerLists.name, trimmed),
            isNull(playerLists.deletedAt),
            eq(playerLists.isDefault, false),
          ),
        )
        .returning()
        .all()[0];
      if (row !== undefined) return row;

      // Zero rows affected is ambiguous — no such live list, or it is the
      // default. Re-read INSIDE the same transaction to tell them apart, so the
      // classification describes the state the UPDATE actually saw.
      const live = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.name, trimmed), isNull(playerLists.deletedAt)))
        .all()[0];
      if (live === undefined) throw new UnknownListError(trimmed);
      throw new CannotDeleteDefaultListError(live.name);
    },
    { behavior: "immediate" },
  );
}

/** Every live list with its active-member count, ordered by name. */
export async function listLists(db: Db): Promise<ListSummary[]> {
  // One constant-size query, never a per-list count (rules/backend.md: no N+1)
  // and never a materialized `IN (<all list ids>)` (unbounded param cap). LEFT
  // JOIN so a list with zero members still appears with count 0, and carry the
  // `players.active = true` gate in the players JOIN's ON clause (not a WHERE)
  // so a deactivated member is uncounted without dropping its list — active
  // membership is the master gate (ADR 0046 decision 2). `count(players.id)`
  // ignores the NULL-padded rows a member-less or deactivated-only list yields.
  const rows = await db
    .select({
      id: playerLists.id,
      name: playerLists.name,
      isDefault: playerLists.isDefault,
      createdAt: playerLists.createdAt,
      updatedAt: playerLists.updatedAt,
      memberCount: sql<number>`count(${players.id})`,
    })
    .from(playerLists)
    .leftJoin(listMembers, eq(listMembers.listId, playerLists.id))
    .leftJoin(players, and(eq(players.id, listMembers.playerId), eq(players.active, true)))
    .where(isNull(playerLists.deletedAt))
    .groupBy(playerLists.id)
    .orderBy(playerLists.name);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: Number(r.memberCount),
    isDefault: r.isDefault,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Active member player ids for a list id, ordered by players.id (scope helper). */
export async function listMemberIds(db: Db, listId: number): Promise<number[]> {
  const rows = await db
    .select({ id: players.id })
    .from(listMembers)
    .innerJoin(players, eq(listMembers.playerId, players.id))
    .where(and(eq(listMembers.listId, listId), eq(players.active, true)))
    .orderBy(players.id);
  return rows.map((r) => r.id);
}

/** Active member rows for a resolved list id, ordered by players.id (no re-resolution). */
export async function listMembersById(db: Db, listId: number): Promise<PlayerRow[]> {
  return db
    .select({ player: players })
    .from(listMembers)
    .innerJoin(players, eq(listMembers.playerId, players.id))
    .where(and(eq(listMembers.listId, listId), eq(players.active, true)))
    .orderBy(players.id)
    .then((rows) => rows.map((r) => r.player));
}

/** Active member rows of a named list, ordered by players.id. Unknown → UnknownListError. */
export async function listMembersOf(db: Db, name: string): Promise<PlayerRow[]> {
  const list = await resolveListByName(db, name);
  return listMembersById(db, list.id);
}

/** How many membership rows a mutation added or removed, plus the resolved list. */
export interface ListMembershipResult {
  list: PlayerListRow;
  /** Player rows the refs resolved to, in input order. */
  players: PlayerRow[];
  /** Rows actually written (idempotent add) or deleted (non-members are no-ops). */
  changed: number;
}

/**
 * Resolve every PlayerRef to its Watch List row IN INPUT ORDER, in bulk — one
 * query for MLB `personId` (externalId) refs and one for explicit Highlightly
 * player IDs, never a query per ref (rules/backend.md: no N+1). The
 * ref set is capped at the boundary, so the two `inArray` lists are bounded.
 * The first ref that resolves to no player throws PlayerNotFoundError for that
 * ref (as the prior per-ref loop did), so a bad ref aborts the whole mutation.
 */
async function resolvePlayers(db: Db, refs: PlayerRef[]): Promise<PlayerRow[]> {
  const externalIds = refs.filter((r): r is number => typeof r === "number");
  const highlightlyIds = refs
    .filter((r): r is { kind: "highlightly"; playerId: number } => typeof r !== "number")
    .map((r) => r.playerId);

  const byExternal = new Map<number, PlayerRow>();
  if (externalIds.length > 0) {
    const rows = await db.select().from(players).where(inArray(players.externalId, externalIds));
    for (const row of rows) if (row.externalId !== null) byExternal.set(row.externalId, row);
  }
  const byHighlightly = new Map<number, PlayerRow>();
  if (highlightlyIds.length > 0) {
    const rows = await db.select().from(players).where(inArray(players.highlightlyPlayerId, highlightlyIds));
    for (const row of rows) if (row.highlightlyPlayerId !== null) byHighlightly.set(row.highlightlyPlayerId, row);
  }
  return refs.map((ref) => {
    const row = typeof ref === "number"
      ? byExternal.get(ref)
      : byHighlightly.get(ref.playerId);
    if (row === undefined) throw new PlayerNotFoundError(ref);
    return row;
  });
}

/**
 * Add players to a list, idempotently. Unknown list → UnknownListError; an
 * unresolvable player ref → PlayerNotFoundError (nothing is written on either).
 * A re-add of an existing member is a no-op under the unique index.
 */
export async function addToList(
  db: Db,
  name: string,
  refs: PlayerRef[],
  now: Date,
): Promise<ListMembershipResult> {
  const list = await resolveListByName(db, name);
  // Resolve EVERY ref before writing anything, so a bad ref aborts the whole add.
  const rows = await resolvePlayers(db, refs);
  if (rows.length === 0) return { list, players: rows, changed: 0 };

  // One bulk insert, never a write per member (rules/backend.md: no N+1). A
  // re-add of an existing member conflicts on the unique key and is skipped, so
  // `changed` counts only rows actually newly inserted (idempotent re-add = 0).
  const nowIso = now.toISOString();
  const inserted = await db
    .insert(listMembers)
    .values(rows.map((player) => ({ listId: list.id, playerId: player.id, createdAt: nowIso })))
    .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
    .returning();
  return { list, players: rows, changed: inserted.length };
}

/**
 * Remove players from a list (hard-delete the join rows). Unknown list →
 * UnknownListError; an unresolvable player ref → PlayerNotFoundError. Removing a
 * non-member is a no-op.
 */
export async function removeFromList(
  db: Db,
  name: string,
  refs: PlayerRef[],
  _now: Date,
): Promise<ListMembershipResult> {
  const list = await resolveListByName(db, name);
  const rows = await resolvePlayers(db, refs);
  if (rows.length === 0) return { list, players: rows, changed: 0 };

  // One bulk delete, never a write per member (rules/backend.md: no N+1).
  // Removing a non-member deletes nothing, so `changed` counts only rows
  // actually deleted.
  const deleted = await db
    .delete(listMembers)
    .where(
      and(
        eq(listMembers.listId, list.id),
        inArray(
          listMembers.playerId,
          rows.map((p) => p.id),
        ),
      ),
    )
    .returning();
  return { list, players: rows, changed: deleted.length };
}

/**
 * Idempotently add resolved player ids to a list by id (used by batch-add's
 * `list` seam, where the caller has already resolved the rows). Returns how many
 * membership rows were newly written.
 */
export async function addPlayerIdsToList(
  db: Db,
  listId: number,
  playerIds: number[],
  now: Date,
): Promise<number> {
  if (playerIds.length === 0) return 0;
  const nowIso = now.toISOString();
  // One bulk insert, never a write per id (rules/backend.md: no N+1). Existing
  // members conflict on the unique key and are skipped, so `changed` counts only
  // rows actually newly inserted (a re-add is idempotent).
  const inserted = await db
    .insert(listMembers)
    .values(playerIds.map((playerId) => ({ listId, playerId, createdAt: nowIso })))
    .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
    .returning();
  return inserted.length;
}

/** A better-sqlite3 UNIQUE-constraint failure, however drizzle surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
