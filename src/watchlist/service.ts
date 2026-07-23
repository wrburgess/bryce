import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { playerTags, players } from "../db/schema.js";
import type { PlayerBackupEntry } from "../backup/player-list.js";
import { canonicalizeName } from "../domain/names.js";
import { hostDate } from "../domain/season.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
import { NcaaApiError, UnsupportedNcaaSeasonError } from "../ncaa/client.js";
import { parseGameLogPage } from "../ncaa/parse.js";
import { parseTagSelector, playerIdsMatchingTags, syncDerivedTags } from "../tags/service.js";

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

/**
 * Add a Player by MLB Stats API personId. A duplicate add is a no-op update
 * (same Player, refreshed identity fields, re-activated). A brand-new add runs
 * his first Refresh — instant season backfill (ADR 0030) — unless the pipeline
 * is in Offseason Sleep (ADR 0031), exactly like the nightly job.
 */
export async function addPlayer(deps: WatchlistDeps, personId: number): Promise<AddPlayerResult> {
  const { db, client, now } = deps;
  const person = await client.findPerson(personId);
  if (person === null) {
    throw new UnknownPersonError(personId);
  }

  const existing = (await db.select().from(players).where(eq(players.externalId, personId)))[0];
  const nowIso = now().toISOString();

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
    return { action: "updated", player: updated, refresh: null };
  }

  const location = await resolveLocation(person, client);
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

  // Adding a Player IS his first Refresh (ADR 0030) — unless the pipeline sleeps.
  const refresh = await runRefreshForPlayer(
    { db, client, ncaaClient: deps.ncaaClient, now, tz: deps.tz },
    inserted.id,
  );
  // SC1: a completed Refresh already synced tags via refreshPlayer; only derive
  // here when the first Refresh was SKIPPED (Offseason Sleep), so tags still
  // land from the inserted identity columns and we avoid double-derivation.
  if (refresh === null || refresh.skipped) {
    syncDerivedTags(db, inserted.id, now());
  }
  return { action: "added", player: inserted, refresh };
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
  const { db, ncaaClient, now, tz } = deps;
  const season = hostDate(now(), tz).slice(0, 4);

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
  const nowIso = now().toISOString();

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
    return { action: "updated", player: updated, refresh: null };
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

  const refresh = await runRefreshForPlayer({ db, client: deps.client, ncaaClient, now, tz }, inserted.id);
  // SC1: mirror addPlayer — only derive here when the first Refresh was SKIPPED
  // (Offseason Sleep); a completed Refresh already synced via refreshNcaaPlayer.
  if (refresh === null || refresh.skipped) {
    syncDerivedTags(db, inserted.id, now());
  }
  return { action: "added", player: inserted, refresh };
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
      // Re-apply the entry's MANUAL tags by the restored id. A direct insert
      // preserves exact fidelity (the backup is authoritative for manual tags);
      // onConflictDoNothing keeps a re-import idempotent. A v1 backup with no
      // `tags` field leaves this a no-op (back-compat).
      for (const tag of row.tags ?? []) {
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
