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

/** A blank or whitespace-only list name reached the service (boundary schemas also reject it). */
export class BlankListNameError extends Error {
  constructor() {
    super("list name must not be blank");
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
  const lists = await db
    .select()
    .from(playerLists)
    .where(isNull(playerLists.deletedAt))
    .orderBy(playerLists.name);
  if (lists.length === 0) return [];

  // One grouped count over the active members of every live list — never a
  // query per list (rules/backend.md: no N+1).
  const counts = await db
    .select({ listId: listMembers.listId, count: sql<number>`count(*)` })
    .from(listMembers)
    .innerJoin(players, eq(listMembers.playerId, players.id))
    .where(
      and(
        eq(players.active, true),
        inArray(
          listMembers.listId,
          lists.map((l) => l.id),
        ),
      ),
    )
    .groupBy(listMembers.listId);
  const byList = new Map(counts.map((c) => [c.listId, Number(c.count)]));

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    memberCount: byList.get(l.id) ?? 0,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
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

/** Active member rows of a named list, ordered by players.id. Unknown → UnknownListError. */
export async function listMembersOf(db: Db, name: string): Promise<PlayerRow[]> {
  const list = await resolveListByName(db, name);
  return db
    .select({ player: players })
    .from(listMembers)
    .innerJoin(players, eq(listMembers.playerId, players.id))
    .where(and(eq(listMembers.listId, list.id), eq(players.active, true)))
    .orderBy(players.id)
    .then((rows) => rows.map((r) => r.player));
}

/** How many membership rows a mutation added or removed, plus the resolved list. */
export interface ListMembershipResult {
  list: PlayerListRow;
  /** Player rows the refs resolved to, in input order. */
  players: PlayerRow[];
  /** Rows actually written (idempotent add) or deleted (non-members are no-ops). */
  changed: number;
}

/** Resolve a PlayerRef to its Watch List row, or throw PlayerNotFoundError (as deactivatePlayer does). */
async function resolvePlayer(db: Db, ref: PlayerRef): Promise<PlayerRow> {
  const where =
    typeof ref === "number"
      ? eq(players.externalId, ref)
      : eq(players.ncaaPlayerSeq, ref.ncaaPlayerSeq);
  const row = (await db.select().from(players).where(where))[0];
  if (row === undefined) throw new PlayerNotFoundError(ref);
  return row;
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
  const rows: PlayerRow[] = [];
  for (const ref of refs) rows.push(await resolvePlayer(db, ref));

  const nowIso = now.toISOString();
  let changed = 0;
  for (const player of rows) {
    const inserted = await db
      .insert(listMembers)
      .values({ listId: list.id, playerId: player.id, createdAt: nowIso })
      .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
      .returning();
    changed += inserted.length;
  }
  return { list, players: rows, changed };
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
  const rows: PlayerRow[] = [];
  for (const ref of refs) rows.push(await resolvePlayer(db, ref));

  let changed = 0;
  for (const player of rows) {
    const deleted = await db
      .delete(listMembers)
      .where(and(eq(listMembers.listId, list.id), eq(listMembers.playerId, player.id)))
      .returning();
    changed += deleted.length;
  }
  return { list, players: rows, changed };
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
  const nowIso = now.toISOString();
  let changed = 0;
  for (const playerId of playerIds) {
    const inserted = await db
      .insert(listMembers)
      .values({ listId, playerId, createdAt: nowIso })
      .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
      .returning();
    changed += inserted.length;
  }
  return changed;
}

/** A better-sqlite3 UNIQUE-constraint failure, however drizzle surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
