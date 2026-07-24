import { and, eq, isNull } from "drizzle-orm";
import type { BatchAddEntry } from "../api/schemas.js";
import { BatchAddInputSchema } from "../api/schemas.js";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { listMembers, playerLists, playerTags, players } from "../db/schema.js";
import type {
  PlayerBackupEntry,
  PlayerBackupList,
  PlayerBackupMember,
} from "../backup/player-list.js";
import { canonicalizeName } from "../domain/names.js";
import { addPlayerIdsToList, resolveListByName } from "../lists/service.js";
import { hostDate } from "../domain/season.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbApiError } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../ncaa/client.js";
import { parseGameLogPage } from "../ncaa/parse.js";
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
  ncaaClient: NcaaClient;
  now: () => Date;
  tz: string;
}

/**
 * How a caller addresses an existing watch-list Player: an MLB Stats API
 * personId (the default numeric form) or an NCAA stats_player_seq (ADR 0032).
 */
export type PlayerRef = number | { ncaaPlayerSeq: number };

/** The MLB Stats API has no person for the requested personId. */
export class UnknownPersonError extends Error {
  readonly personId: number;

  constructor(personId: number) {
    super(`no MLB person with personId=${personId}`);
    this.name = "UnknownPersonError";
    this.personId = personId;
  }
}

/** stats.ncaa.org has no resolvable player for the requested stats_player_seq. */
export class UnknownNcaaPlayerError extends Error {
  readonly playerSeq: number;

  constructor(playerSeq: number) {
    super(`no NCAA player with ncaaPlayerSeq=${playerSeq}`);
    this.name = "UnknownNcaaPlayerError";
    this.playerSeq = playerSeq;
  }
}

/** No watch-list row exists for the requested Player reference. */
export class PlayerNotFoundError extends Error {
  readonly ref: PlayerRef;

  constructor(ref: PlayerRef) {
    super(
      typeof ref === "number"
        ? `no player with personId=${ref}`
        : `no player with ncaaPlayerSeq=${ref.ncaaPlayerSeq}`,
    );
    this.name = "PlayerNotFoundError";
    this.ref = ref;
  }
}

export interface FirstRefreshSummary {
  skipped: boolean;
  inserted: number;
  updated: number;
}

export interface AddPlayerResult {
  action: "added" | "updated";
  player: PlayerRow;
  /** Null on a duplicate add — only a brand-new Player gets his first Refresh. */
  refresh: FirstRefreshSummary | null;
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
      { db, client, ncaaClient: deps.ncaaClient, now, tz: deps.tz },
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
 * Add an NCAA Player by stats.ncaa.org stats_player_seq (ADR 0032). Mirrors
 * addPlayer: fetch his current-season game-log page to resolve name/school, a
 * duplicate is a no-op identity/school refresh, and a brand-new add runs his
 * first Refresh (Sleep-aware). Only a genuine not-found (HTTP 404 or a page
 * with no resolvable player) becomes UnknownNcaaPlayerError; upstream failures
 * (NcaaApiError) and an unbundled season (UnsupportedNcaaSeasonError)
 * propagate untouched, exactly like addPlayer surfaces MlbApiError.
 */
export async function addNcaaPlayer(
  deps: WatchlistDeps,
  playerSeq: number,
): Promise<AddPlayerResult> {
  const { db, client, ncaaClient, now, tz } = deps;
  const nowIso = now().toISOString();
  const { action, player } = await upsertNcaaPlayer(deps, playerSeq, nowIso);

  if (action === "updated") {
    // Heal on re-add (mirrors addPlayer): a previously-untagged NCAA player gets
    // his derived tags now from the committed identity columns. Idempotent.
    syncDerivedTags(db, player.id, now());
    return { action, player, refresh: null };
  }

  let refresh: FirstRefreshSummary;
  try {
    refresh = await runRefreshForPlayer({ db, client, ncaaClient, now, tz }, player.id);
  } catch (err) {
    // Best-effort derive from the committed columns before rethrowing, so a
    // first-add whose Refresh threw is never left untagged (mirrors addPlayer).
    syncDerivedTags(db, player.id, now());
    throw err;
  }
  // SC1: mirror addPlayer — only derive here when the first Refresh was SKIPPED
  // (Offseason Sleep); a completed Refresh already synced via refreshNcaaPlayer.
  if (refresh.skipped) {
    syncDerivedTags(db, player.id, now());
  }
  return { action: "added", player, refresh };
}

/**
 * Resolve an NCAA stats_player_seq to identity (name/school, from his game-log
 * page) and insert/re-activate his row — the Refresh-free CORE shared by
 * single-add (`addNcaaPlayer`) and batch-add (`batchAddPlayers`). Error handling
 * mirrors the single-add path: only a genuine not-found (HTTP 404 or a page with
 * no resolvable player) becomes UnknownNcaaPlayerError; a non-404 NcaaApiError
 * and an unbundled season (UnsupportedNcaaSeasonError) propagate untouched. The
 * season is derived from the single captured clock (nowIso) — no second read.
 */
export async function upsertNcaaPlayer(
  deps: Pick<WatchlistDeps, "db" | "ncaaClient" | "tz">,
  playerSeq: number,
  nowIso: string,
): Promise<{ action: "added" | "updated"; player: PlayerRow }> {
  const { db, ncaaClient, tz } = deps;
  const season = hostDate(new Date(nowIso), tz).slice(0, 4);

  let identity: { fullName: string; schoolName: string };
  try {
    const html = await ncaaClient.getGameLogPage(playerSeq, season, "batting");
    const page = parseGameLogPage(html);
    identity = { fullName: page.fullName, schoolName: page.schoolName };
  } catch (err) {
    // Upstream trouble is NOT a missing player: a non-404 HTTP failure and an
    // unbundled season propagate untouched for the callers' error seams.
    if (err instanceof NcaaApiError && err.status !== 404) throw err;
    if (err instanceof UnsupportedNcaaSeasonError) throw err;
    // A genuine not-found — HTTP 404 or a page with no resolvable player —
    // means there is no Player to add.
    throw new UnknownNcaaPlayerError(playerSeq);
  }

  const existing = (
    await db.select().from(players).where(eq(players.ncaaPlayerSeq, playerSeq))
  )[0];

  if (existing !== undefined) {
    const updatedRows = await db
      .update(players)
      .set({
        fullName: identity.fullName,
        schoolName: identity.schoolName,
        active: true,
        updatedAt: nowIso,
      })
      .where(eq(players.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (updated === undefined) {
      throw new Error(`update failed for player id ${existing.id}`);
    }
    return { action: "updated", player: updated };
  }

  const insertedRows = await db
    .insert(players)
    .values({
      externalId: null,
      ncaaPlayerSeq: playerSeq,
      fullName: identity.fullName,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      schoolName: identity.schoolName,
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
 * Why a batch entry did not become an active Player. `person_not_found` /
 * `name_no_match` / `name_ambiguous` / `ncaa_not_found` are SOFT outcomes
 * (`unresolved` — the identity did not resolve); `unsupported_season` /
 * `upstream_error` are HARD failures (`failed` — something upstream broke).
 */
export type BatchAddReasonCode =
  | "person_not_found"
  | "name_no_match"
  | "name_ambiguous"
  | "ncaa_not_found"
  | "unsupported_season"
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
  if (err instanceof UnknownNcaaPlayerError) {
    return { status: "unresolved", entry, reason: "ncaa_not_found" };
  }
  if (err instanceof UnsupportedNcaaSeasonError) {
    return { status: "failed", entry, reason: "unsupported_season", message: err.message };
  }
  if (err instanceof MlbApiError || err instanceof NcaaApiError) {
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
      } else if (entry.ncaaPlayerSeq !== undefined) {
        const { action, player } = await upsertNcaaPlayer(deps, entry.ncaaPlayerSeq, nowIso);
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
 * Deactivate a Player by reference — an MLB personId or an NCAA
 * stats_player_seq (ADR 0032) — the row and his whole history are kept.
 */
export async function deactivatePlayer(
  deps: Pick<WatchlistDeps, "db" | "now">,
  ref: PlayerRef,
): Promise<PlayerRow> {
  const { db, now } = deps;
  const where =
    typeof ref === "number"
      ? eq(players.externalId, ref)
      : eq(players.ncaaPlayerSeq, ref.ncaaPlayerSeq);
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
  constructor(externalId: number, ncaaPlayerSeq: number, externalRowId: number, ncaaRowId: number) {
    super(
      `split identity: externalId=${externalId} resolves to player id ${externalRowId} ` +
        `but ncaaPlayerSeq=${ncaaPlayerSeq} resolves to player id ${ncaaRowId}`,
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
 * Identity (ADR 0032 / ADR 0041): each row is matched on EITHER natural id; when
 * both are present they must resolve to the SAME existing row (a promotion
 * NCAA -> pro keeps one row and gains external_id WITHOUT losing ncaa_player_seq)
 * — a split-row conflict fails the whole transaction. Names are canonicalized on
 * this new direct write path.
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

      if (byExternal !== undefined && byNcaa !== undefined && byExternal.id !== byNcaa.id) {
        throw new SplitIdentityConflictError(
          row.externalId as number,
          row.ncaaPlayerSeq as number,
          byExternal.id,
          byNcaa.id,
        );
      }
      return { row, existing: byExternal ?? byNcaa };
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
      if (existing !== undefined) {
        // Coalesce natural ids so a backup can ADD an id without erasing one the
        // existing row already holds (the promotion case keeps ncaa_player_seq).
        tx
          .update(players)
          .set({
            externalId: row.externalId ?? existing.externalId,
            ncaaPlayerSeq: row.ncaaPlayerSeq ?? existing.ncaaPlayerSeq,
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
            ncaaPlayerSeq: row.ncaaPlayerSeq ?? null,
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
    for (const list of extras.lists ?? []) {
      const name = list.name.trim();
      const live = tx
        .select()
        .from(playerLists)
        .where(and(eq(playerLists.name, name), isNull(playerLists.deletedAt)))
        .all()[0];
      if (live !== undefined) {
        // Reuse an existing live list of the same name (do not insert, do not error).
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
      for (const p of allPlayers) {
        if (p.externalId != null) byExternal.set(p.externalId, p.id);
        if (p.ncaaPlayerSeq != null) byNcaa.set(p.ncaaPlayerSeq, p.id);
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
              : undefined;
        if (playerId === undefined) {
          const ref =
            member.externalId != null
              ? `externalId=${member.externalId}`
              : `ncaaPlayerSeq=${member.ncaaPlayerSeq}`;
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

    return { inserted, updated, total: rows.length };
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
