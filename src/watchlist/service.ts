import { eq } from "drizzle-orm";
import type { BatchAddEntry } from "../api/schemas.js";
import { BatchAddInputSchema } from "../api/schemas.js";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players } from "../db/schema.js";
import type { PlayerBackupEntry } from "../backup/player-list.js";
import { canonicalizeName } from "../domain/names.js";
import { hostDate } from "../domain/season.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbApiError } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../ncaa/client.js";
import { parseGameLogPage } from "../ncaa/parse.js";

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
    return { action, player, refresh: null };
  }

  // Adding a Player IS his first Refresh (ADR 0030) — unless the pipeline sleeps.
  const refresh = await runRefreshForPlayer(
    { db, client, ncaaClient: deps.ncaaClient, now, tz: deps.tz },
    player.id,
  );
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
    return { action, player, refresh: null };
  }

  const refresh = await runRefreshForPlayer({ db, client, ncaaClient, now, tz }, player.id);
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

/** Watch-list rows ordered by id; active-only by default. */
export async function listPlayers(db: Db, filter: PlayerListFilter = "active"): Promise<PlayerRow[]> {
  if (filter === "all") {
    return db.select().from(players).orderBy(players.id);
  }
  return db
    .select()
    .from(players)
    .where(eq(players.active, filter === "active"))
    .orderBy(players.id);
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
        updated += 1;
      } else {
        tx
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
          .run();
        inserted += 1;
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
