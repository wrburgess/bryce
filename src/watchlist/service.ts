import { and, eq, isNull } from "drizzle-orm";
import type { BatchAddEntry } from "../api/schemas.js";
import { BatchAddInputSchema } from "../api/schemas.js";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { highlightlyPlayerCursors, listMembers, playerLists, playerTags, players } from "../db/schema.js";
import type {
  PlayerBackupEntry,
  PlayerBackupList,
  PlayerBackupMember,
} from "../backup/player-list.js";
import { canonicalizeName } from "../domain/names.js";
import {
  HighlightlyIdentityMismatchError,
  HighlightlyMigrationRequiredError,
  HighlightlyError,
  highlightlyTeamId,
} from "../highlightly/client.js";
import type { HighlightlyClient } from "../highlightly/client.js";
import { addPlayerIdsToList, resolveListByName } from "../lists/service.js";
import type { CalendarFailure } from "../jobs/refresh.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbApiError } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import {
  isManualTag,
  parseTagSelector,
  playerIdsMatchingTags,
  syncDerivedTags,
} from "../tags/service.js";

/**
 * Watch-list service: the one home for add/deactivate/list/search semantics,
 * shared by the seed CLI, the REST API, and the MCP tools. Typed results and
 * typed errors — no output sink; presentation stays with each caller.
 */

export interface WatchlistDeps {
  db: Db;
  client: MlbClient;
  highlightlyClient?: HighlightlyClient;
  now: () => Date;
  tz: string;
}

/**
 * How a caller addresses an existing watch-list Player: an MLB Stats API
 * personId (the default numeric form) or an NCAA stats_player_seq (ADR 0032).
 */
export type PlayerRef = number | { kind: "highlightly"; playerId: number };

/** Explicit provider identity; a raw number is never treated as an NCAA ID. */
export type HighlightlyPlayerRef = { kind: "highlightly"; playerId: number };

/** The MLB Stats API has no person for the requested personId. */
export class UnknownPersonError extends Error {
  readonly personId: number;

  constructor(personId: number) {
    super(`no MLB person with personId=${personId}`);
    this.name = "UnknownPersonError";
    this.personId = personId;
  }
}

/** No watch-list row exists for the requested Player reference. */
export class PlayerNotFoundError extends Error {
  readonly ref: PlayerRef;

  constructor(ref: PlayerRef) {
    super(
      typeof ref === "number"
        ? `no player with personId=${ref}`
        : `no player with highlightlyPlayerId=${ref.playerId}`,
    );
    this.name = "PlayerNotFoundError";
    this.ref = ref;
  }
}

/** A requested NCAA-to-professional transition is no longer safe to perform. */
export class PlayerPromotionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerPromotionConflictError";
  }
}

export interface FirstRefreshSummary {
  skipped: boolean;
  /** Why priming did not write: offseason or a live whole-watch-list Refresh. */
  reason: "offseason-sleep" | "whole-refresh-running" | null;
  inserted: number;
  updated: number;
  /** Calendar fetch failures encountered priming this player's refresh (#23, MF3). */
  calendarFailures: CalendarFailure[];
}

export interface AddPlayerResult {
  action: "added" | "updated";
  player: PlayerRow;
  /** Null on a duplicate add — only a brand-new Player gets his first Refresh. */
  refresh: FirstRefreshSummary | null;
}

/**
 * Add a new NCAA player from an operator-selected Highlightly ID. The canonical
 * name and team ID are assertions, not a fuzzy search: a mismatch prevents an
 * accidental same-name attachment.
 */
export async function addHighlightlyNcaaPlayer(
  deps: WatchlistDeps,
  input: { playerId: number; canonicalName: string; teamId: number },
): Promise<AddPlayerResult> {
  const staged = await stageHighlightlyNcaaPlayer(deps, input);
  if (staged.action === "updated") return { ...staged, refresh: null };
  const refresh = await runRefreshForPlayer(deps, staged.player.id);
  return { ...staged, refresh };
}

/** Resolve and stage a Highlightly identity without running a first refresh (batch seam). */
export async function stageHighlightlyNcaaPlayer(
  deps: WatchlistDeps,
  input: { playerId: number; canonicalName: string; teamId: number },
): Promise<{ action: "added" | "updated"; player: PlayerRow }> {
  if (deps.highlightlyClient === undefined) throw new HighlightlyMigrationRequiredError();
  const resolved = await deps.highlightlyClient.getPlayer(input.playerId);
  const providerTeamId = highlightlyTeamId(resolved.value);
  if (
    canonicalizeName(resolved.value.fullName) !== canonicalizeName(input.canonicalName) ||
    providerTeamId !== input.teamId
  ) {
    throw new HighlightlyIdentityMismatchError("Highlightly player ID does not match the supplied canonical name and team ID");
  }
  const nowIso = deps.now().toISOString();
  const existing = (await deps.db.select().from(players)
    .where(eq(players.highlightlyPlayerId, input.playerId)))[0];
  if (existing !== undefined) {
    const player = (await deps.db.update(players).set({ active: true, updatedAt: nowIso })
      .where(eq(players.id, existing.id)).returning())[0];
    if (player === undefined) throw new Error(`update failed for player id ${existing.id}`);
    return { action: "updated", player };
  }
  const player = (await deps.db.insert(players).values({
    externalId: null,
    ncaaPlayerSeq: null,
    highlightlyPlayerId: input.playerId,
    highlightlyTeamId: input.teamId,
    ncaaSourceState: "highlightly_active",
    fullName: canonicalizeName(resolved.value.fullName),
    level: "ncaa",
    milbLevel: null,
    teamName: resolved.value.team?.name ?? null,
    schoolName: resolved.value.team?.name ?? null,
    position: null,
    active: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).returning())[0];
  if (player === undefined) throw new Error("insert failed");
  return { action: "added", player };
}

/**
 * Attach an existing legacy identity without guessing from its historical name.
 * This only enters `highlightly_pending`; `refreshHighlightlyNcaaPlayer` owns
 * the transaction that replaces presentation after a complete backfill.
 */
export async function attachHighlightlyNcaaPlayer(
  deps: WatchlistDeps,
  legacySeq: number,
  input: { playerId: number; canonicalName: string; teamId: number },
): Promise<PlayerRow> {
  if (deps.highlightlyClient === undefined) throw new HighlightlyMigrationRequiredError();
  const legacy = (await deps.db.select().from(players).where(eq(players.ncaaPlayerSeq, legacySeq)))[0];
  if (legacy === undefined) throw new Error(`no legacy NCAA player with ncaaPlayerSeq=${legacySeq}`);
  const resolved = await deps.highlightlyClient.getPlayer(input.playerId);
  if (
    canonicalizeName(resolved.value.fullName) !== canonicalizeName(input.canonicalName) ||
    highlightlyTeamId(resolved.value) !== input.teamId
  ) throw new HighlightlyIdentityMismatchError("Highlightly player ID does not match the supplied canonical name and team ID");
  const updated = (await deps.db.update(players).set({
    highlightlyPlayerId: input.playerId,
    highlightlyTeamId: input.teamId,
    ncaaSourceState: "highlightly_pending",
    updatedAt: deps.now().toISOString(),
  }).where(eq(players.id, legacy.id)).returning())[0];
  if (updated === undefined) throw new Error(`update failed for player id ${legacy.id}`);
  return updated;
}

export type PlayerListFilter = "active" | "inactive" | "all";

export interface PlayerSearchResult {
  personId: number;
  fullName: string;
  position: string | null;
  level: "mlb" | "milb";
  milbLevel: string | null;
  teamName: string | null;
}

/** Team lookups memoized within one call so shared teams cost one API request. */
type TeamCache = Map<number, Awaited<ReturnType<MlbClient["getTeam"]>>>;

/**
 * Resolve an MLB personId to identity and insert/re-activate his row — the
 * network-free-of-Refresh CORE shared by single-add (`addPlayer`) and batch-add
 * (`batchAddPlayers`). No first Refresh is run here; the caller decides whether
 * to run one. A null person is an UnknownPersonError; an existing row is a no-op
 * identity refresh + re-activation. `teamCache` is threaded so a batch of
 * teammates resolves the shared team once.
 */
export async function upsertMlbPlayer(
  deps: Pick<WatchlistDeps, "db" | "client">,
  personId: number,
  nowIso: string,
  teamCache: TeamCache,
): Promise<{ action: "added" | "updated"; player: PlayerRow }> {
  const { db, client } = deps;
  const person = await client.findPerson(personId);
  if (person === null) {
    throw new UnknownPersonError(personId);
  }

  const existing = (await db.select().from(players).where(eq(players.externalId, personId)))[0];

  if (existing !== undefined) {
    const updatedRows = await db
      .update(players)
      .set({ fullName: person.fullName, active: true, updatedAt: nowIso })
      .where(eq(players.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (updated === undefined) {
      throw new Error(`update failed for player id ${existing.id}`);
    }
    return { action: "updated", player: updated };
  }

  const location = await resolveLocation(person, client, teamCache);
  const insertedRows = await db
    .insert(players)
    .values({
      externalId: personId,
      fullName: person.fullName,
      level: location.level,
      milbLevel: location.milbLevel,
      teamName: location.teamName,
      position: person.primaryPosition?.abbreviation ?? null,
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();
  const inserted = insertedRows[0];
  if (inserted === undefined) {
    throw new Error("insert failed");
  }
  return { action: "added", player: inserted };
}

/**
 * Convert an explicitly-addressed Highlightly NCAA row to its MLB/MiLB identity.
 * The local Player id is deliberately the only identity that survives; every
 * record attached to it (lines, lists, tags, notes) therefore remains attached.
 */
export async function promoteHighlightlyNcaaPlayer(
  deps: WatchlistDeps,
  input: { highlightlyPlayerId: number; personId: number },
): Promise<PlayerRow> {
  const person = await deps.client.findPerson(input.personId);
  if (person === null) throw new UnknownPersonError(input.personId);
  const location = await resolveLocation(person, deps.client, new Map());
  const now = deps.now();
  const nowIso = now.toISOString();

  try {
    return deps.db.transaction((tx) => {
      // The source must still be an active, fully attached Highlightly NCAA
      // row.  Include every precondition in both the read and guarded write:
      // a deactivate or source-state change cannot be accidentally promoted.
      const source = tx.select().from(players)
        .where(and(
          eq(players.highlightlyPlayerId, input.highlightlyPlayerId),
          eq(players.level, "ncaa"),
          eq(players.ncaaSourceState, "highlightly_active"),
          eq(players.active, true),
        )).get();
      if (source === undefined) {
        throw new PlayerNotFoundError({ kind: "highlightly", playerId: input.highlightlyPlayerId });
      }
      const owner = tx.select().from(players).where(eq(players.externalId, input.personId)).get();
      if (owner !== undefined && owner.id !== source.id) {
        throw new PlayerPromotionConflictError(`personId=${input.personId} is already owned by player id ${owner.id}`);
      }
      const changed = tx.update(players).set({
        externalId: input.personId,
        ncaaPlayerSeq: null,
        highlightlyPlayerId: null,
        highlightlyTeamId: null,
        ncaaSourceState: null,
        fullName: person.fullName,
        level: location.level,
        milbLevel: location.milbLevel,
        teamName: location.teamName,
        position: person.primaryPosition?.abbreviation ?? null,
        schoolName: null,
        active: true,
        updatedAt: nowIso,
      }).where(and(
        eq(players.id, source.id),
        eq(players.level, "ncaa"),
        eq(players.ncaaSourceState, "highlightly_active"),
        eq(players.active, true),
        eq(players.highlightlyPlayerId, input.highlightlyPlayerId),
      )).run();
      if (changed.changes !== 1) {
        throw new PlayerPromotionConflictError(`NCAA player ${input.highlightlyPlayerId} changed during promotion`);
      }
      // Nested savepoint; only derived tags are replaced, never manual tags.
      syncDerivedTags(tx, source.id, now);
      tx.delete(highlightlyPlayerCursors).where(eq(highlightlyPlayerCursors.playerId, source.id)).run();
      const promoted = tx.select().from(players).where(eq(players.id, source.id)).get();
      if (promoted === undefined) throw new Error(`promoted player ${source.id} disappeared`);
      return promoted;
    }, { behavior: "immediate" });
  } catch (err) {
    // SQLite reports unique-index races as a generic constraint error. Present
    // the stable domain conflict without exposing driver-specific details.
    if (err instanceof Error && /UNIQUE constraint failed: players\.external_id/.test(err.message)) {
      throw new PlayerPromotionConflictError(`personId=${input.personId} is already owned by another player`);
    }
    throw err;
  }
}

/**
 * Add a Player by MLB Stats API personId. A duplicate add is a no-op update
 * (same Player, refreshed identity fields, re-activated). A brand-new add runs
 * his first Refresh — instant season backfill (ADR 0030) — unless the pipeline
 * is in Offseason Sleep (ADR 0031), exactly like the nightly job.
 */
export async function addPlayer(deps: WatchlistDeps, personId: number): Promise<AddPlayerResult> {
  const { db, client, now } = deps;
  const nowIso = now().toISOString();
  const { action, player } = await upsertMlbPlayer(deps, personId, nowIso, new Map());

  if (action === "updated") {
    // Heal on re-add: a player left untagged by an earlier failed first-add (its
    // Refresh threw before deriving) gets his derived tags now, from the
    // committed identity columns. Idempotent for an already-tagged player; the
    // update path never touched a tag-relevant column, so this only ADDS.
    syncDerivedTags(db, player.id, now());
    return { action, player, refresh: null };
  }

  // Adding a Player IS his first Refresh (ADR 0030) — unless the pipeline sleeps.
  let refresh: FirstRefreshSummary;
  try {
    refresh = await runRefreshForPlayer(
      { db, client, highlightlyClient: deps.highlightlyClient, now, tz: deps.tz },
      player.id,
    );
  } catch (err) {
    // The player row is already committed, but a mid-Refresh throw means
    // refreshPlayer's own syncDerivedTags never ran — derive from the committed
    // identity columns (best-effort) so a failed first-add is never left
    // untagged, then rethrow so the caller still sees the failure.
    syncDerivedTags(db, player.id, now());
    throw err;
  }
  // SC1: a completed Refresh already synced tags via refreshPlayer; only derive
  // here when the first Refresh was SKIPPED (Offseason Sleep), so tags still
  // land from the inserted identity columns and we avoid double-derivation.
  if (refresh.skipped) {
    syncDerivedTags(db, player.id, now());
  }
  return { action: "added", player, refresh };
}

/**
 * Why a batch entry did not become an active Player. `person_not_found` /
 * `name_no_match` / `name_ambiguous` / `highlightly_player_not_found` are SOFT outcomes
 * (`unresolved` — the identity did not resolve); `unsupported_season` /
 * `upstream_error` are HARD failures (`failed` — something upstream broke).
 */
export type BatchAddReasonCode =
  | "person_not_found"
  | "name_no_match"
  | "name_ambiguous"
  | "highlightly_player_not_found"
  | "upstream_error";

/** A disambiguation candidate offered when a name matches more than one player. */
export interface BatchAddCandidate {
  personId: number;
  fullName: string;
  teamName: string | null;
  position: string | null;
}

/**
 * One entry's outcome, discriminated on `status`. `entry` echoes the NORMALIZED
 * parsed entry (trimmed name). `candidates` is present ONLY for name_ambiguous;
 * `message` is display-only diagnostic text on a hard failure.
 */
export type BatchAddEntryResult =
  | { status: "added"; entry: BatchAddEntry; player: PlayerRow }
  | { status: "updated"; entry: BatchAddEntry; player: PlayerRow }
  | { status: "unresolved"; entry: BatchAddEntry; reason: BatchAddReasonCode; candidates?: BatchAddCandidate[] }
  | { status: "failed"; entry: BatchAddEntry; reason: BatchAddReasonCode; message?: string };

export interface BatchAddSummary {
  added: number;
  updated: number;
  unresolved: number;
  failed: number;
  total: number;
}

export interface BatchAddPlayersResult {
  summary: BatchAddSummary;
  entries: BatchAddEntryResult[];
}

/** Project an MLB people-search hit into a disambiguation candidate. */
function toBatchCandidate(person: Person): BatchAddCandidate {
  return {
    personId: person.id,
    fullName: person.fullName,
    teamName: person.currentTeam?.name ?? null,
    position: person.primaryPosition?.abbreviation ?? null,
  };
}

/**
 * Classify a per-entry throw into its outcome (ADR 0045 error taxonomy). A clean
 * not-found is SOFT (`unresolved`); an upstream/season failure is HARD
 * (`failed`). A ZodError from parsing an UPSTREAM response, or any other
 * unexpected error, is an upstream_error — the top-level INPUT ZodError never
 * reaches here (it aborts the whole call in `batchAddPlayers`).
 */
function classifyBatchFailure(entry: BatchAddEntry, err: unknown): BatchAddEntryResult {
  if (err instanceof UnknownPersonError) {
    return { status: "unresolved", entry, reason: "person_not_found" };
  }
  if (err instanceof HighlightlyError && err.code === "highlightly_player_not_found") {
    return { status: "unresolved", entry, reason: "highlightly_player_not_found" };
  }
  if (err instanceof MlbApiError || err instanceof HighlightlyError) {
    return { status: "failed", entry, reason: "upstream_error", message: err.message };
  }
  return {
    status: "failed",
    entry,
    reason: "upstream_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Batch-add typed identity entries to the Watch List (issue #68 / ADR 0045).
 *
 * The batch's SHAPE is validated strictly up front — over-cap, blank, untyped,
 * multi-key, unknown-key, or in-batch duplicate throws a ZodError that aborts
 * the whole call BEFORE any network or write (the only abort path). Each entry
 * is then resolved best-effort, in input order, under its OWN try/catch:
 * capture-and-continue, so one entry's failure never aborts the batch and never
 * rolls back an earlier insert (batch-add is deliberately NON-transactional,
 * unlike restorePlayerListBackup).
 *
 * Crucially, NO first Refresh runs (no runRefreshForPlayer / refresh_runs row /
 * stat_lines write): batch-add STAGES identity and defers the season backfill to
 * the next Refresh, which sweeps loadActivePlayers (ADR 0030/0045). One clock and
 * one team cache are captured for the whole call — uniform timestamps, shared
 * teams fetched once.
 */
export async function batchAddPlayers(
  deps: WatchlistDeps,
  input: unknown,
): Promise<BatchAddPlayersResult> {
  // A bad shape aborts the whole call before any network or write (ADR 0045).
  const parsed = BatchAddInputSchema.parse(input);

  // The `list` seam (issue #70 / ADR 0046): a value must name an EXISTING list —
  // batch-add never creates one — so resolve it up front and fail closed on an
  // unknown list (UnknownListError) BEFORE any network or write, exactly like the
  // shape check. Staged players are added to it after resolution below.
  const list =
    parsed.list !== undefined ? await resolveListByName(deps.db, parsed.list) : null;

  const nowIso = deps.now().toISOString();
  const teamCache: TeamCache = new Map();
  const entries: BatchAddEntryResult[] = [];

  for (const entry of parsed.entries) {
    try {
      if (entry.personId !== undefined) {
        const { action, player } = await upsertMlbPlayer(deps, entry.personId, nowIso, teamCache);
        entries.push({ status: action, entry, player });
      } else if (entry.highlightlyPlayerId !== undefined) {
        const { action, player } = await stageHighlightlyNcaaPlayer(deps, {
          playerId: entry.highlightlyPlayerId,
          canonicalName: entry.canonicalName!,
          teamId: entry.teamId!,
        });
        entries.push({ status: action, entry, player });
      } else {
        // A name is an MLB-only people-search convenience; it must resolve to
        // EXACTLY one hit — 0 or >1 is unresolved, never a guessed pick.
        const people = await deps.client.searchPeople(entry.name ?? "");
        if (people.length === 0) {
          entries.push({ status: "unresolved", entry, reason: "name_no_match" });
        } else if (people.length > 1) {
          entries.push({
            status: "unresolved",
            entry,
            reason: "name_ambiguous",
            candidates: people.map(toBatchCandidate),
          });
        } else {
          const hit = people[0];
          if (hit === undefined) {
            entries.push({ status: "unresolved", entry, reason: "name_no_match" });
          } else {
            const { action, player } = await upsertMlbPlayer(deps, hit.id, nowIso, teamCache);
            entries.push({ status: action, entry, player });
          }
        }
      }
    } catch (err) {
      entries.push(classifyBatchFailure(entry, err));
    }
  }

  // Batch-add STAGES identity with NO inline Refresh, so — unlike addPlayer,
  // whose completed first Refresh derives tags — a newly staged player has no
  // derived tags yet. Derive them now from the identity columns just written
  // (reusing the single captured clock; idempotent, manual tags untouched), so a
  // batch-added player is not left untagged until the next Refresh. Both `added`
  // AND `updated` are synced: an `added` needs its first derivation, and an
  // `updated` re-add heals a player an earlier failed add left untagged
  // (idempotent when he is already tagged).
  const derivedAt = new Date(nowIso);
  for (const result of entries) {
    if (result.status === "added" || result.status === "updated") {
      syncDerivedTags(deps.db, result.player.id, derivedAt);
    }
  }

  // Add every successfully staged player to the target list, idempotently. A
  // membership write is DB-local (no network) and never fails an already-staged
  // entry, so it happens after the best-effort loop.
  if (list !== null) {
    const stagedIds = entries
      .filter((e): e is Extract<BatchAddEntryResult, { status: "added" | "updated" }> =>
        e.status === "added" || e.status === "updated",
      )
      .map((e) => e.player.id);
    await addPlayerIdsToList(deps.db, list.id, stagedIds, new Date(nowIso));
  }

  const summary: BatchAddSummary = {
    added: entries.filter((e) => e.status === "added").length,
    updated: entries.filter((e) => e.status === "updated").length,
    unresolved: entries.filter((e) => e.status === "unresolved").length,
    failed: entries.filter((e) => e.status === "failed").length,
    total: entries.length,
  };
  return { summary, entries };
}

/**
 * Deactivate a Player by MLB personId or explicit Highlightly player ID. The
 * row and its history are retained.
 */
export async function deactivatePlayer(
  deps: Pick<WatchlistDeps, "db" | "now">,
  ref: PlayerRef,
): Promise<PlayerRow> {
  const { db, now } = deps;
  const where = typeof ref === "number"
    ? eq(players.externalId, ref)
    : eq(players.highlightlyPlayerId, ref.playerId);
  const existing = (await db.select().from(players).where(where))[0];
  if (existing === undefined) {
    throw new PlayerNotFoundError(ref);
  }
  const updatedRows = await db
    .update(players)
    .set({ active: false, updatedAt: now().toISOString() })
    .where(eq(players.id, existing.id))
    .returning();
  const updated = updatedRows[0];
  if (updated === undefined) {
    throw new Error(`update failed for player id ${existing.id}`);
  }
  return updated;
}

/**
 * Watch-list rows ordered by id; active-only by default. An optional
 * `tagSelector` (comma = AND) intersects the result with the players matching
 * every token — one aggregate tag query, never a query per player. A malformed
 * selector throws a ZodError (400 / exit 1 on every surface).
 */
export async function listPlayers(
  db: Db,
  filter: PlayerListFilter = "active",
  tagSelector?: string,
): Promise<PlayerRow[]> {
  const rows =
    filter === "all"
      ? await db.select().from(players).orderBy(players.id)
      : await db
          .select()
          .from(players)
          .where(eq(players.active, filter === "active"))
          .orderBy(players.id);
  if (tagSelector === undefined) return rows;
  const matching = new Set(playerIdsMatchingTags(db, parseTagSelector(tagSelector)));
  return rows.filter((r) => matching.has(r.id));
}

/**
 * A backup row's two natural identities resolve to two DIFFERENT existing rows —
 * an ambiguity no upsert can safely reconcile, so the whole import is aborted.
 */
export class SplitIdentityConflictError extends Error {
  constructor(left: string, right: string, leftRowId: number, rightRowId: number) {
    super(
      `split identity: ${left} resolves to player id ${leftRowId} ` +
        `but ${right} resolves to player id ${rightRowId}`,
    );
    this.name = "SplitIdentityConflictError";
  }
}

/**
 * Two DISTINCT backup rows resolve to the SAME existing player (e.g. an existing
 * row carrying external_id A + ncaa X, with the payload holding a separate A-only
 * row and a B+X row). Applying both would silently overwrite one with the other
 * and drop a backed-up player, so the whole import is aborted.
 */
export class AmbiguousImportTargetError extends Error {
  constructor(existingRowId: number) {
    super(
      `ambiguous import: two backup rows both resolve to existing player id ${existingRowId}`,
    );
    this.name = "AmbiguousImportTargetError";
  }
}

export interface RestorePlayerListSummary {
  inserted: number;
  updated: number;
  total: number;
  /**
   * True when the restore left the database with NO live default list (#190) —
   * a v1-v4 payload carrying lists, or a v5 payload whose lists are all
   * non-default. Surfaced rather than silently tolerated because a lane-less
   * database fails every unscoped command, and a restore that quietly created
   * that state would be discovered by the next digest not arriving.
   */
  noDefaultList: boolean;
  /**
   * Set when the restore moved the default flag to a DIFFERENT list than the one
   * the database held (#190) — `from` is the lane that lost it, `to` the lane
   * that took it, or `null` when the payload left none. `null` overall means the
   * default did not move: either the payload's default is the incumbent, or
   * there was no incumbent to overwrite.
   *
   * The payload wins (see the precedence comment in the restore), and that is
   * the whole reason this field exists: a restore run months later to recover
   * one deleted player also re-points the schedule at whichever lane was default
   * when the backup was written. Reported by ENDPOINT, not by whether the flag
   * was rewritten — the clear-then-apply sequence touches the incumbent row even
   * when nothing moves, and a line that fired on every restore would be ignored
   * by the time it mattered.
   */
  defaultListChange: { from: string; to: string | null } | null;
}

/**
 * A v2 backup membership whose player natural id (or list name) does not resolve
 * against the just-restored state. Aborts the whole import, consistent with the
 * restore's all-or-nothing strictness (ADR 0046).
 */
export class UnresolvedBackupMemberError extends Error {
  constructor(detail: string) {
    super(`unresolvable backup membership: ${detail}`);
    this.name = "UnresolvedBackupMemberError";
  }
}

/** The named-list half of a v2 Player List Backup, recreated inside the restore transaction. */
export interface RestoreListExtras {
  lists?: PlayerBackupList[];
  members?: PlayerBackupMember[];
}

/** The drizzle better-sqlite3 transaction handle (a synchronous transaction). */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Re-import a Player List Backup, network-free and all-or-nothing (ADR 0042).
 *
 * Identity (ADR 0032 / ADR 0041): each row is matched on its one current
 * natural id (MLB, legacy NCAA, or Highlightly NCAA). A cross-identity match is
 * treated as corruption and aborts the transaction. The sole compatibility
 * exception is a parser-vetted v1-v3 pro row with externalId + ncaaPlayerSeq:
 * both identities are used to find its old local row, then the retired NCAA
 * identity is cleared as the row becomes professional. Names are canonicalized
 * on this direct write path.
 *
 * Authority (ADR 0042 matrix): natural ids + level + milbLevel + teamName +
 * position + schoolName + notes + active come from the backup; the source-local
 * `id` is never authoritative (existing rows keep their id so Stat Line FKs stay
 * intact); `createdAt` is the existing row's on update / the backup value (or
 * `now` if absent) on insert; `updatedAt` is always `now`.
 */
export function restorePlayerListBackup(
  db: Db,
  rows: PlayerBackupEntry[],
  now: Date,
  extras: RestoreListExtras = {},
): RestorePlayerListSummary {
  const nowIso = now.toISOString();

  return db.transaction((tx: Tx): RestorePlayerListSummary => {
    // Phase 1 — pre-resolve every payload row to its existing-row target (against
    // the pre-import state, before any write), so a split identity or two rows
    // mapping to ONE existing player is caught before anything is mutated.
    const resolved = rows.map((row) => {
      const byExternal =
        row.externalId != null
          ? tx.select().from(players).where(eq(players.externalId, row.externalId)).all()[0]
          : undefined;
      const byNcaa =
        row.ncaaPlayerSeq != null
          ? tx.select().from(players).where(eq(players.ncaaPlayerSeq, row.ncaaPlayerSeq)).all()[0]
          : undefined;
      const byHighlightly =
        row.highlightlyPlayerId != null
          ? tx.select().from(players).where(eq(players.highlightlyPlayerId, row.highlightlyPlayerId)).all()[0]
          : undefined;

      const resolvedRows = [byExternal, byNcaa, byHighlightly].filter((r): r is PlayerRow => r !== undefined);
      if (resolvedRows.some((r) => r.id !== resolvedRows[0]!.id)) {
        const first = resolvedRows[0]!;
        const other = resolvedRows.find((r) => r.id !== first.id)!;
        const firstRef = byExternal?.id === first.id ? `externalId=${row.externalId}` : byNcaa?.id === first.id ? `ncaaPlayerSeq=${row.ncaaPlayerSeq}` : `highlightlyPlayerId=${row.highlightlyPlayerId}`;
        const otherRef = byExternal?.id === other.id ? `externalId=${row.externalId}` : byNcaa?.id === other.id ? `ncaaPlayerSeq=${row.ncaaPlayerSeq}` : `highlightlyPlayerId=${row.highlightlyPlayerId}`;
        throw new SplitIdentityConflictError(
          firstRef, otherRef, first.id, other.id,
        );
      }
      return { row, existing: byExternal ?? byNcaa ?? byHighlightly };
    });

    // Two distinct payload rows resolving to the same existing player would have
    // the second silently overwrite the first — reject the whole import.
    const claimed = new Set<number>();
    for (const { existing } of resolved) {
      if (existing !== undefined) {
        if (claimed.has(existing.id)) throw new AmbiguousImportTargetError(existing.id);
        claimed.add(existing.id);
      }
    }

    // Phase 2 — apply.
    let inserted = 0;
    let updated = 0;
    for (const { row, existing } of resolved) {
      const fullName = canonicalizeName(row.fullName);
      const schoolName =
        row.schoolName === null || row.schoolName === undefined
          ? null
          : canonicalizeName(row.schoolName);

      let playerId: number;
      const ncaaSourceState = row.level === "ncaa" ? row.ncaaSourceState : null;
      const highlightlyPlayerId = row.level === "ncaa" ? row.highlightlyPlayerId ?? null : null;
      const highlightlyTeamId = row.level === "ncaa" ? row.highlightlyTeamId ?? null : null;
      if (existing !== undefined) {
        tx
          .update(players)
          .set({
            externalId: row.level === "ncaa" ? null : row.externalId,
            ncaaPlayerSeq: row.level === "ncaa" ? row.ncaaPlayerSeq ?? null : null,
            highlightlyPlayerId: row.level === "ncaa" ? highlightlyPlayerId : null,
            highlightlyTeamId: row.level === "ncaa" ? highlightlyTeamId : null,
            ncaaSourceState,
            fullName,
            level: row.level,
            milbLevel: row.milbLevel ?? null,
            teamName: row.teamName ?? null,
            position: row.position ?? null,
            schoolName,
            active: row.active,
            notes: row.notes ?? null,
            updatedAt: nowIso,
          })
          .where(eq(players.id, existing.id))
          .run();
        playerId = existing.id;
        updated += 1;
      } else {
        const insertedRow = tx
          .insert(players)
          .values({
            externalId: row.externalId ?? null,
            // A parser-vetted legacy promotion can carry both identities solely
            // so Phase 1 can retain the existing NCAA row and its history. It
            // must never create a new mixed-identity row.
            ncaaPlayerSeq: row.level === "ncaa" ? row.ncaaPlayerSeq ?? null : null,
            highlightlyPlayerId,
            highlightlyTeamId,
            ncaaSourceState,
            fullName,
            level: row.level,
            milbLevel: row.milbLevel ?? null,
            teamName: row.teamName ?? null,
            position: row.position ?? null,
            schoolName,
            active: row.active,
            notes: row.notes ?? null,
            createdAt: row.createdAt ?? nowIso,
            updatedAt: nowIso,
          })
          .returning()
          .get();
        playerId = insertedRow.id;
        inserted += 1;
      }

      // Derive INSIDE the transaction (MF4): derived tags are rebuildable state,
      // recomputed per upserted row from the identity columns just written — so
      // the import stays all-or-nothing with no post-commit failure gap.
      syncDerivedTags(tx, playerId, now);

      // Reconcile the player's MANUAL tags to the backup's authoritative set.
      // The undefined-vs-present distinction is load-bearing: an ABSENT `tags`
      // field (only a legacy v1 backup omits it) means "leave manual tags
      // untouched" (back-compat); a PRESENT field (including `[]`) is
      // authoritative, so we reconcile to exactly it. Any non-manual entry (a
      // hand-edited derived-namespace or unknown tag) is skipped, never written.
      if (row.tags !== undefined) {
        const desired = row.tags.filter((t) => isManualTag(t.namespace, t.value));
        // Delimiter is a colon: isManualTag pins the namespace to `status` (no
        // colon) and the value to a fixed word, so the key is unambiguous. Never
        // a raw NUL byte.
        const desiredKeys = new Set(desired.map((t) => `${t.namespace}:${t.value}`));
        const existingManual = tx
          .select()
          .from(playerTags)
          .where(and(eq(playerTags.playerId, playerId), eq(playerTags.source, "manual")))
          .all();
        for (const ex of existingManual) {
          if (!desiredKeys.has(`${ex.namespace}:${ex.value}`)) {
            tx.delete(playerTags).where(eq(playerTags.id, ex.id)).run();
          }
        }
        for (const tag of desired) {
          tx
            .insert(playerTags)
            .values({
              playerId,
              namespace: tag.namespace,
              value: tag.value,
              source: "manual",
              createdAt: nowIso,
            })
            .onConflictDoNothing()
            .run();
        }
      }
    }

    // Phase 3 — recreate named lists and memberships (v2 backup, ADR 0046),
    // INSIDE this same all-or-nothing transaction. List recreation is
    // find-or-create by name (idempotent, mirroring the player upsert): a name
    // that already names a LIVE list REUSES that list rather than colliding on
    // the partial unique index and rolling the whole restore back; memberships
    // are then merged idempotently (a duplicate list_id/player_id is a no-op).
    // A member whose player natural id (or list name) does not resolve throws and
    // aborts — consistent with the restore's existing strictness.
    // Shared list-name resolution memo across BOTH loops below. A `number` is a
    // resolved live list id; `null` is the memoized "no live list of this name"
    // sentinel — so a repeated member list name is looked up at most once.
    const listIdByName = new Map<string, number | null>();

    // THE PAYLOAD'S DEFAULT WINS (#190). Restore is merge-by-live-name, so a
    // restored default can collide with one the database already has — and
    // `player_lists_default_uq` would reject the second, rolling back an
    // otherwise good restore. Clearing every live default FIRST, under this same
    // all-or-nothing transaction, resolves it in the only direction that makes
    // the result reproducible: a restore is a deliberate act of replacement, so
    // the restored state must not depend on which list happened to be default
    // beforehand.
    //
    // The one cost of that choice is that a restore run for an unrelated reason
    // — recovering a player deleted by mistake, say — silently re-points the
    // schedule at whatever lane was default when the backup was written. So the
    // incumbent is captured HERE, before the clear, and the endpoints are
    // compared at the end: the payload still wins, but the win is announced by
    // the caller rather than discovered by reading the wrong digest.
    const priorDefault = tx
      .select()
      .from(playerLists)
      .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)))
      .all()[0];

    // The clear is conditioned on the payload carrying a `lists` ARRAY at all. A
    // v1 backup predates named lists and says nothing about them; treating its
    // silence as "no lists, therefore no default" would destroy a default the
    // payload never described. Same undefined-vs-present distinction the manual
    // tag reconciliation above turns on.
    if (extras.lists !== undefined) {
      tx
        .update(playerLists)
        .set({ isDefault: false, updatedAt: nowIso })
        .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)))
        .run();
    }

    for (const list of extras.lists ?? []) {
      const name = list.name.trim();
      const live = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.name, name), isNull(playerLists.deletedAt)))
        .all()[0];
      if (live !== undefined) {
        // Reuse an existing live list of the same name (do not insert, do not
        // error) — but its LANE configuration is authoritative in the payload,
        // so overwrite it rather than merging. A restored lane that kept the
        // database's cadence would be neither the backup's state nor the
        // database's.
        tx
          .update(playerLists)
          .set({
            isDefault: list.isDefault,
            refreshIntervalMinutes: list.refreshIntervalMinutes,
            digestHour: list.digestHour,
            digestTo: list.digestTo,
            updatedAt: list.updatedAt ?? nowIso,
          })
          .where(eq(playerLists.id, live.id))
          .run();
        listIdByName.set(name, live.id);
        continue;
      }
      // Insert and read the new row's id straight back via .returning() — no
      // separate re-SELECT (this is the sync better-sqlite3 tx, so .all() is
      // synchronous, mirroring the selects above).
      const created = tx
        .insert(playerLists)
        .values({
          name,
          createdAt: list.createdAt ?? nowIso,
          updatedAt: list.updatedAt ?? nowIso,
          isDefault: list.isDefault,
          refreshIntervalMinutes: list.refreshIntervalMinutes,
          digestHour: list.digestHour,
          digestTo: list.digestTo,
        })
        .returning()
        .all()[0];
      if (created === undefined) throw new Error(`list insert failed for ${name}`);
      listIdByName.set(name, created.id);
    }

    if ((extras.members ?? []).length > 0) {
      // Build player natural-id -> id maps from the just-restored state.
      const allPlayers = tx.select().from(players).all();
      const byExternal = new Map<number, number>();
      const byNcaa = new Map<number, number>();
      const byHighlightly = new Map<number, number>();
      for (const p of allPlayers) {
        if (p.externalId != null) byExternal.set(p.externalId, p.id);
        if (p.ncaaPlayerSeq != null) byNcaa.set(p.ncaaPlayerSeq, p.id);
        if (p.highlightlyPlayerId != null) byHighlightly.set(p.highlightlyPlayerId, p.id);
      }

      // Resolve every membership FIRST (a bad list name or player id aborts the
      // whole restore), then write in one bulk insert — never a write per member
      // (rules/backend.md: no N+1). List names resolve through the shared
      // listIdByName memo, so each distinct name is queried at most once across
      // both the lists loop above and this loop; duplicates are skipped idempotently.
      const memberValues: { listId: number; playerId: number; createdAt: string }[] = [];
      for (const member of extras.members ?? []) {
        const listName = member.list.trim();
        if (!listIdByName.has(listName)) {
          // First sighting of this name in the member loop: resolve once and
          // memoize (null = no live list) so a repeated name never re-queries.
          const live = tx
            .select()
            .from(playerLists)
            .where(and(eq(playerLists.name, listName), isNull(playerLists.deletedAt)))
            .all()[0];
          listIdByName.set(listName, live?.id ?? null);
        }
        const listId = listIdByName.get(listName);
        if (listId == null) {
          throw new UnresolvedBackupMemberError(`no list named "${listName}"`);
        }
        const playerId =
          member.externalId != null
            ? byExternal.get(member.externalId)
            : member.ncaaPlayerSeq != null
              ? byNcaa.get(member.ncaaPlayerSeq)
              : member.highlightlyPlayerId != null ? byHighlightly.get(member.highlightlyPlayerId) : undefined;
        if (playerId === undefined) {
          const ref =
            member.externalId != null
              ? `externalId=${member.externalId}`
              : member.ncaaPlayerSeq != null ? `ncaaPlayerSeq=${member.ncaaPlayerSeq}` : `highlightlyPlayerId=${member.highlightlyPlayerId}`;
          throw new UnresolvedBackupMemberError(`no player with ${ref} for list "${listName}"`);
        }
        memberValues.push({ listId, playerId, createdAt: nowIso });
      }
      if (memberValues.length > 0) {
        tx.insert(listMembers)
          .values(memberValues)
          .onConflictDoNothing({ target: [listMembers.listId, listMembers.playerId] })
          .run();
      }
    }

    // Read the FINAL state rather than inferring it from the payload (#190): the
    // question a caller needs answered is "does this database have a default
    // now?", and after a merge-by-name restore only the database knows.
    const liveDefault = tx
      .select()
      .from(playerLists)
      .where(and(eq(playerLists.isDefault, true), isNull(playerLists.deletedAt)))
      .all()[0];

    // Compared by id, not by name: a merge-by-name restore REUSES the incumbent
    // row when the payload names it, so an id match is "the default did not
    // move" even though the flag was cleared and re-set on the way through.
    const defaultListChange =
      priorDefault !== undefined && priorDefault.id !== liveDefault?.id
        ? { from: priorDefault.name, to: liveDefault?.name ?? null }
        : null;

    return {
      inserted,
      updated,
      total: rows.length,
      noDefaultList: liveDefault === undefined,
      defaultListChange,
    };
  });
}

/**
 * Name search over MLB /people/search, each hit resolved to a current
 * team/level via the same location logic the add path uses. Team lookups are
 * cached per call so shared teams cost one API request.
 */
export async function searchPlayers(
  deps: Pick<WatchlistDeps, "client">,
  name: string,
): Promise<PlayerSearchResult[]> {
  const { client } = deps;
  const people = await client.searchPeople(name);
  const teamCache = new Map<number, Awaited<ReturnType<MlbClient["getTeam"]>>>();
  const results: PlayerSearchResult[] = [];
  for (const person of people) {
    const location = await resolveLocation(person, client, teamCache);
    results.push({
      personId: person.id,
      fullName: person.fullName,
      position: person.primaryPosition?.abbreviation ?? null,
      level: location.level,
      milbLevel: location.milbLevel,
      teamName: location.teamName,
    });
  }
  return results;
}

/**
 * Resolve a person's current team into our Level vocabulary. No resolvable
 * team (e.g. free agent): default to mlb; the next Refresh corrects it.
 */
export async function resolveLocation(
  person: Person,
  client: MlbClient,
  teamCache?: Map<number, Awaited<ReturnType<MlbClient["getTeam"]>>>,
): Promise<{ level: "mlb" | "milb"; milbLevel: string | null; teamName: string | null }> {
  if (person.currentTeam !== undefined) {
    const cached = teamCache?.get(person.currentTeam.id);
    const team = cached ?? (await client.getTeam(person.currentTeam.id));
    teamCache?.set(person.currentTeam.id, team);
    const info = levelForSportId(team.sport.id);
    if (info !== null && info.level !== "ncaa") {
      return { level: info.level, milbLevel: info.milbLevel, teamName: team.name };
    }
  }
  return { level: "mlb", milbLevel: null, teamName: null };
}
