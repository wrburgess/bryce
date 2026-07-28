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

/**
 * A lane-configuration value is out of range (#191). Thrown by the SERVICE, not
 * only rejected by the router: `configureList` is reachable from a test, a
 * future REST/MCP surface, and any caller that never sees a CLI option table, so
 * "the router validated it" is an assumption, not a guarantee. Carries the
 * offending field and the reason so every surface can render it the same way
 * (rules/backend.md — thread a new error type through every surface's seam).
 */
export class InvalidListConfigError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`invalid ${field}: expected ${reason}`);
    this.name = "InvalidListConfigError";
    this.field = field;
    this.reason = reason;
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
  /**
   * The lane's cadence, carried so a caller can READ BACK what `configure`
   * wrote (#191). Without these, `players lists configure` would be a
   * write-only surface: settable, and then unreadable except by writing again.
   * Null means "never auto-refreshes" / "never auto-digests" / "fall back to
   * the DIGEST_TO env value" — inert until #192/#193 act on them.
   */
  refreshIntervalMinutes: number | null;
  digestHour: number | null;
  digestTo: string | null;
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

/**
 * A partial update of a lane's cadence and recipients (#191). The three-state
 * contract is the whole point:
 *
 *   - key ABSENT (`undefined`) → leave that column exactly as it is;
 *   - key present as `null`    → clear it to SQL NULL;
 *   - key present as a value   → set it.
 *
 * Without the absent/null split, configuring ONE column would silently clear
 * the other two — a lane that had a digest hour would lose it the first time
 * someone set its refresh interval, and nothing about the command would say so.
 */
export interface ListConfigPatch {
  refreshIntervalMinutes?: number | null;
  digestHour?: number | null;
  digestTo?: string | null;
}

/** Reject a cadence value the DB CHECKs would reject, with the field named. */
function validatePatch(patch: ListConfigPatch): void {
  const { refreshIntervalMinutes: interval, digestHour: hour, digestTo: to } = patch;
  if (interval !== undefined && interval !== null && (!Number.isSafeInteger(interval) || interval <= 0)) {
    throw new InvalidListConfigError("refreshIntervalMinutes", "a positive whole number of minutes");
  }
  // 0 is VALID here — a midnight digest — which is why this is not the
  // positive-integer rule reused. `player_lists_digest_hour_range_ck` allows
  // 0..23, and a validator that rejected 0 would refuse a lane the database
  // accepts.
  if (hour !== undefined && hour !== null && (!Number.isSafeInteger(hour) || hour < 0 || hour > 23)) {
    throw new InvalidListConfigError("digestHour", "an hour from 0 to 23");
  }
  if (to !== undefined && to !== null && (to.trim().length === 0 || /\p{Cc}/u.test(to))) {
    throw new InvalidListConfigError("digestTo", "a non-blank value without control characters");
  }
}

/**
 * Set a live lane's cadence and recipients, writing ONLY the supplied keys.
 * Unknown or soft-deleted live name → UnknownListError; an out-of-range value →
 * InvalidListConfigError. An empty patch is refused rather than silently
 * bumping `updated_at`, so a no-op invocation is loud at BOTH layers (the CLI's
 * `oneOf` and here).
 *
 * One `BEGIN IMMEDIATE` transaction that re-reads the lane under the write lock,
 * for the same reason `deleteList` does: resolving the name and then updating on
 * that answer is a check-then-act split a concurrent delete lands in.
 */
export async function configureList(
  db: Db,
  name: string,
  patch: ListConfigPatch,
  now: Date,
): Promise<PlayerListRow> {
  const trimmed = requireName(name);
  validatePatch(patch);
  const changes: Partial<typeof playerLists.$inferInsert> = {};
  if (patch.refreshIntervalMinutes !== undefined) changes.refreshIntervalMinutes = patch.refreshIntervalMinutes;
  if (patch.digestHour !== undefined) changes.digestHour = patch.digestHour;
  if (patch.digestTo !== undefined) changes.digestTo = patch.digestTo === null ? null : patch.digestTo.trim();
  if (Object.keys(changes).length === 0) {
    throw new InvalidListConfigError("patch", "at least one of refreshIntervalMinutes, digestHour, digestTo");
  }
  const nowIso = now.toISOString();
  return db.transaction(
    (tx): PlayerListRow => {
      const target = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.name, trimmed), isNull(playerLists.deletedAt)))
        .all()[0];
      if (target === undefined) throw new UnknownListError(trimmed);
      const row = tx
        .update(playerLists)
        .set({ ...changes, updatedAt: nowIso })
        .where(eq(playerLists.id, target.id))
        .returning()
        .all()[0];
      if (row === undefined) throw new Error("configureList update failed");
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
      refreshIntervalMinutes: playerLists.refreshIntervalMinutes,
      digestHour: playerLists.digestHour,
      digestTo: playerLists.digestTo,
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
    refreshIntervalMinutes: r.refreshIntervalMinutes,
    digestHour: r.digestHour,
    digestTo: r.digestTo,
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
  const changed = insertMemberships(db, list.id, rows.map((player) => player.id), now.toISOString());
  return { list, players: rows, changed };
}

/** The top-level `Db`, or the transaction handle drizzle hands a callback. Both share the sync query API. */
type MembershipWriter = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * THE idempotent membership insert, authored once and shared by all three
 * writers (`addToList`, `addPlayerIdsToList`, `addPlayerIdsToLiveList`). One
 * bulk insert, never a write per member (rules/backend.md: no N+1); an existing
 * member conflicts on the unique key and is skipped, so the return counts only
 * rows actually newly written — an idempotent re-add is 0.
 *
 * Copying these four lines per call site is how the `onConflictDoNothing`
 * target quietly stops matching the unique index at one of them and a re-add
 * starts throwing (rules/scripting.md).
 */
function insertMemberships(writer: MembershipWriter, listId: number, playerIds: number[], nowIso: string): number {
  return writer
    .insert(listMembers)
    .values(playerIds.map((playerId) => ({ listId, playerId, createdAt: nowIso })))
    .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
    .returning()
    .all()
    .length;
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
  return insertMemberships(db, listId, playerIds, now.toISOString());
}

/**
 * `addPlayerIdsToList` plus a liveness RE-CHECK under the write lock (#191).
 *
 * `sk players add` resolves the lane, then makes a network call and creates the
 * player, and only then attaches — so an arbitrary amount of time passes between
 * "this lane exists" and "write membership onto it". A `lists delete` landing in
 * that gap would otherwise leave a membership row pointing at a soft-deleted
 * lane: invisible to every scope query, and impossible to notice from the
 * command's own success line. Re-reading the row inside the same
 * `BEGIN IMMEDIATE` transaction as the insert makes the DATABASE refuse, the way
 * `deleteList` makes it refuse the default (ADR 0059 decision 4).
 *
 * Takes the resolved row rather than an id so the refusal can NAME the lane the
 * operator asked for instead of quoting a bare integer at him.
 */
export async function addPlayerIdsToLiveList(
  db: Db,
  list: PlayerListRow,
  playerIds: number[],
  now: Date,
): Promise<number> {
  if (playerIds.length === 0) return 0;
  const nowIso = now.toISOString();
  return db.transaction(
    (tx): number => {
      const live = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.id, list.id), isNull(playerLists.deletedAt)))
        .all()[0];
      if (live === undefined) throw new UnknownListError(list.name);
      return insertMemberships(tx, list.id, playerIds, nowIso);
    },
    { behavior: "immediate" },
  );
}

/** A better-sqlite3 UNIQUE-constraint failure, however drizzle surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
