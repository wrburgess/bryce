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
  const list = await resolveListByName(db, name);
  const nowIso = now.toISOString();
  const rows = await db
    .update(playerLists)
    .set({ deletedAt: nowIso, updatedAt: nowIso })
    .where(eq(playerLists.id, list.id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("deleteList update failed");
  return row;
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
 * query for the MLB `personId` (externalId) refs and one for the NCAA
 * `{ncaaPlayerSeq}` refs, never a query per ref (rules/backend.md: no N+1). The
 * ref set is capped at the boundary, so the two `inArray` lists are bounded.
 * The first ref that resolves to no player throws PlayerNotFoundError for that
 * ref (as the prior per-ref loop did), so a bad ref aborts the whole mutation.
 */
async function resolvePlayers(db: Db, refs: PlayerRef[]): Promise<PlayerRow[]> {
  const externalIds = refs.filter((r): r is number => typeof r === "number");
  const ncaaSeqs = refs
    .filter((r): r is { ncaaPlayerSeq: number } => typeof r !== "number")
    .map((r) => r.ncaaPlayerSeq);

  const byExternal = new Map<number, PlayerRow>();
  if (externalIds.length > 0) {
    const rows = await db.select().from(players).where(inArray(players.externalId, externalIds));
    for (const row of rows) if (row.externalId !== null) byExternal.set(row.externalId, row);
  }
  const byNcaa = new Map<number, PlayerRow>();
  if (ncaaSeqs.length > 0) {
    const rows = await db.select().from(players).where(inArray(players.ncaaPlayerSeq, ncaaSeqs));
    for (const row of rows) if (row.ncaaPlayerSeq !== null) byNcaa.set(row.ncaaPlayerSeq, row);
  }

  return refs.map((ref) => {
    const row = typeof ref === "number" ? byExternal.get(ref) : byNcaa.get(ref.ncaaPlayerSeq);
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
