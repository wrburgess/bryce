import { and, eq, exists, sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "../db/client.js";
import type { PlayerTagRow } from "../db/schema.js";
import { playerTags, players, statLines } from "../db/schema.js";
import { latestStatLineOrder } from "../queries/statLines.js";
import { deriveTags } from "./derive.js";

/**
 * The tag service (Phase A of #29): the one home for tag semantics, mirroring
 * `src/watchlist/service.ts` — typed results, typed errors, no output sink.
 *
 * Every function is written on the SYNCHRONOUS better-sqlite3 drizzle API
 * (`.all()/.get()/.run()`) so it composes BOTH at top level (callers may
 * `await` the void return) AND inside the synchronous `db.transaction((tx) =>
 * …)` callback the restore path uses — the handle is a `Db` or a transaction
 * handle interchangeably.
 *
 * The load-bearing invariant (the sync invariant): derivation rewrites ONLY
 * `source='derived'` rows; manual `status:` tags are never read or written by
 * it, and a manual write to a derived namespace is rejected. The two sets are
 * disjoint by construction.
 */

/** The transaction handle drizzle hands a `db.transaction` callback. */
type TxHandle = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A db-or-tx handle: the top-level Db, or a transaction handle from restore. */
type TagDb = Db | TxHandle;

/** Namespaces owned by derivation — never writable by hand. */
export const DERIVED_NAMESPACES: ReadonlySet<string> = new Set(["level", "pos", "prospect"]);
/** The one manual namespace and its closed value set. */
export const MANUAL_NAMESPACE = "status";
export const MANUAL_STATUS_VALUES = ["rostered", "scouted"] as const;

/** The most tokens a selector may carry (a cheap denial-of-service bound). */
export const MAX_SELECTOR_TOKENS = 16;

/**
 * A non-throwing check: is `(namespace, value)` a valid MANUAL tag (the `status`
 * namespace with an allowed value)? The trusted-but-possibly-stale Player List
 * Backup uses this to skip a hand-edited derived/unknown tag on restore instead
 * of writing a bogus manual row a derived namespace could never reconcile away.
 */
export function isManualTag(namespace: string, value: string): boolean {
  return (
    namespace === MANUAL_NAMESPACE && (MANUAL_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/** A manual add/remove that targeted a derived namespace (`level`/`pos`/`prospect`). */
export class ManualWriteToDerivedNamespaceError extends Error {
  readonly namespace: string;

  constructor(namespace: string) {
    super(`namespace '${namespace}' is derived and cannot be tagged manually`);
    this.name = "ManualWriteToDerivedNamespaceError";
    this.namespace = namespace;
  }
}

/** An unknown namespace, or a `status` value outside the allowed set. */
export class UnknownTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTagError";
  }
}

/**
 * Reconcile ONLY `source='derived'` rows for one player against `deriveTags`.
 * Deletes derived rows that are no longer desired FIRST (freeing the single-
 * `level:` partial unique index before an upgraded level value is inserted),
 * then inserts the missing ones. Idempotent; never reads or writes manual rows.
 * Assumes it runs inside a transaction (its caller opens one).
 */
function reconcileDerived(tx: TagDb, playerId: number, now: Date): void {
  const player = tx.select().from(players).where(eq(players.id, playerId)).get();
  if (player === undefined) return; // a missing player has nothing to derive
  const latestStatLine =
    tx
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, playerId))
      .orderBy(...latestStatLineOrder)
      .limit(1)
      .get() ?? null;

  const desired = deriveTags({ player, latestStatLine });
  const existing = tx
    .select()
    .from(playerTags)
    .where(and(eq(playerTags.playerId, playerId), eq(playerTags.source, "derived")))
    .all();

  const keyOf = (t: { namespace: string; value: string }): string => `${t.namespace}\u0000${t.value}`;
  const desiredKeys = new Set(desired.map(keyOf));
  const existingKeys = new Set(existing.map(keyOf));

  for (const row of existing) {
    if (!desiredKeys.has(keyOf(row))) {
      tx.delete(playerTags).where(eq(playerTags.id, row.id)).run();
    }
  }
  const createdAt = now.toISOString();
  for (const tag of desired) {
    if (existingKeys.has(keyOf(tag))) continue;
    tx
      .insert(playerTags)
      .values({ playerId, namespace: tag.namespace, value: tag.value, source: "derived", createdAt })
      .run();
  }
}

/**
 * Recompute and reconcile a player's derived tags, atomically. Wraps the
 * reconcile in a transaction: called at top level this is a fresh transaction;
 * called inside restore's `db.transaction` (with the tx handle) it is a nested
 * savepoint — atomic either way. `prospect` is dropped as well as added.
 */
export function syncDerivedTags(db: TagDb, playerId: number, now: Date): void {
  db.transaction((tx) => {
    reconcileDerived(tx, playerId, now);
  });
}

/**
 * The one-shot backfill for existing rows: iterate EVERY player (active AND
 * inactive, every level) and re-derive. Returns the number of players swept.
 */
export function syncAllDerivedTags(db: TagDb, now: Date): number {
  const ids = db
    .select({ id: players.id })
    .from(players)
    .all()
    .map((r) => r.id);
  for (const id of ids) {
    syncDerivedTags(db, id, now);
  }
  return ids.length;
}

/**
 * The self-healing startup sweep: derive tags for every player that currently
 * has NO `source='derived'` tag row, and only those. Unlike the whole-table
 * one-shot ({@link syncAllDerivedTags}), this RESUMES a backfill that crashed
 * after committing some players and repairs any player a failed Refresh (or a
 * first-add whose Refresh threw) left untagged. Every valid player derives at
 * least one derived tag (level and/or prospect), so "no derived row" reliably
 * means "not yet derived", and the sweep is a genuine NO-OP once all players are
 * tagged. Returns the number of players swept.
 */
export function syncUntaggedDerivedTags(db: TagDb, now: Date): number {
  const tagged = new Set(
    db
      .select({ playerId: playerTags.playerId })
      .from(playerTags)
      .where(eq(playerTags.source, "derived"))
      .all()
      .map((r) => r.playerId),
  );
  const ids = db
    .select({ id: players.id })
    .from(players)
    .all()
    .map((r) => r.id)
    .filter((id) => !tagged.has(id));
  for (const id of ids) {
    syncDerivedTags(db, id, now);
  }
  return ids.length;
}

/**
 * Add a manual tag (semantics enforced HERE — boundary schemas check syntax
 * only). Rejects a derived namespace, an unknown namespace, or a `status` value
 * outside the allowed set. Idempotent: a repeat add makes no duplicate row.
 */
export function addManualTag(
  db: TagDb,
  playerId: number,
  namespace: string,
  value: string,
  now: Date,
): PlayerTagRow {
  if (DERIVED_NAMESPACES.has(namespace)) throw new ManualWriteToDerivedNamespaceError(namespace);
  if (namespace !== MANUAL_NAMESPACE) throw new UnknownTagError(`unknown namespace '${namespace}'`);
  if (!(MANUAL_STATUS_VALUES as readonly string[]).includes(value)) {
    throw new UnknownTagError(
      `unknown ${namespace} value '${value}' (allowed: ${MANUAL_STATUS_VALUES.join(", ")})`,
    );
  }
  db
    .insert(playerTags)
    .values({ playerId, namespace, value, source: "manual", createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  const row = db
    .select()
    .from(playerTags)
    .where(
      and(
        eq(playerTags.playerId, playerId),
        eq(playerTags.namespace, namespace),
        eq(playerTags.value, value),
        eq(playerTags.source, "manual"),
      ),
    )
    .get();
  if (row === undefined) throw new Error(`addManualTag failed for player id ${playerId}`);
  return row;
}

/**
 * Remove a manual tag. Rejects a derived namespace; deleting an absent manual
 * tag is a no-op.
 */
export function removeManualTag(db: TagDb, playerId: number, namespace: string, value: string): void {
  if (DERIVED_NAMESPACES.has(namespace)) throw new ManualWriteToDerivedNamespaceError(namespace);
  db
    .delete(playerTags)
    .where(
      and(
        eq(playerTags.playerId, playerId),
        eq(playerTags.namespace, namespace),
        eq(playerTags.value, value),
        eq(playerTags.source, "manual"),
      ),
    )
    .run();
}

/** Every tag for a player, both sources, `ORDER BY namespace, value, source`. */
export function listTags(db: TagDb, playerId: number): PlayerTagRow[] {
  return db
    .select()
    .from(playerTags)
    .where(eq(playerTags.playerId, playerId))
    .orderBy(playerTags.namespace, playerTags.value, playerTags.source)
    .all();
}

/** A parsed selector token: `ns:value`, or a bare `ns` (value=null → any value). */
export interface TagToken {
  namespace: string;
  value: string | null;
}

function selectorError(message: string, input: unknown): ZodError {
  return new ZodError([{ code: "custom", path: ["tags"], message, input }]);
}

/**
 * Parse a comma-separated selector into distinct tokens. Each token is
 * `ns:value` or a bare `ns` (matching the namespace alone, e.g. `prospect`).
 * Whitespace is trimmed, empty segments dropped, duplicates deduped, and the
 * distinct count bounded to {@link MAX_SELECTOR_TOKENS}. A malformed token
 * (`:foo`, `foo:`) or an over-long list throws a ZodError — a boundary
 * validation error that every surface maps to 400 / exit 1.
 */
export function parseTagSelector(expr: string): TagToken[] {
  const segments = expr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const tokens: TagToken[] = [];
  for (const segment of segments) {
    const colon = segment.indexOf(":");
    const namespace = colon === -1 ? segment : segment.slice(0, colon);
    const value = colon === -1 ? null : segment.slice(colon + 1);
    if (namespace.length === 0 || (value !== null && value.length === 0)) {
      throw selectorError(`malformed tag token '${segment}'`, expr);
    }
    const key = `${namespace}\u0000${value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ namespace, value });
  }
  // A PROVIDED expression that normalizes to zero tokens (only separators or
  // whitespace, e.g. `,,,` or `  `) is malformed — NOT an absent filter. Left to
  // fall through, an empty token list would read as "no filter" in
  // `playerIdsMatchingTags` and return the whole roster, silently bypassing the
  // validation error. An ABSENT `tags` param never reaches here (callers guard on
  // undefined), so this only rejects a present-but-empty selector.
  if (tokens.length === 0) {
    throw selectorError(`tag selector '${expr}' has no tokens`, expr);
  }
  if (tokens.length > MAX_SELECTOR_TOKENS) {
    throw selectorError(`too many tag tokens (max ${MAX_SELECTOR_TOKENS})`, expr);
  }
  return tokens;
}

/**
 * Player ids matching ALL tokens (AND semantics), via N correlated EXISTS
 * subqueries — one per distinct token — so a bare `pos` and a specific `pos:ss`
 * can each be satisfied by a DIFFERENT tag row (correct overlap handling). One
 * aggregate query, never a query per player. An empty token list returns every
 * player id.
 */
export function playerIdsMatchingTags(db: TagDb, tokens: TagToken[]): number[] {
  if (tokens.length === 0) {
    return db
      .select({ id: players.id })
      .from(players)
      .all()
      .map((r) => r.id);
  }
  const conditions = tokens.map((tok) => {
    const filters = [eq(playerTags.playerId, players.id), eq(playerTags.namespace, tok.namespace)];
    if (tok.value !== null) filters.push(eq(playerTags.value, tok.value));
    return exists(
      db
        .select({ one: sql`1` })
        .from(playerTags)
        .where(and(...filters)),
    );
  });
  return db
    .select({ id: players.id })
    .from(players)
    .where(and(...conditions))
    .all()
    .map((r) => r.id);
}
