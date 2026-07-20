import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players } from "../db/schema.js";
import { hostDate } from "../domain/season.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import type { NcaaClient } from "../ncaa/client.js";
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
  return { action: "added", player: inserted, refresh };
}

/**
 * Add an NCAA Player by stats.ncaa.org stats_player_seq (ADR 0032). Mirrors
 * addPlayer: fetch his current-season game-log page to resolve name/school, a
 * duplicate is a no-op identity/school refresh, and a brand-new add runs his
 * first Refresh (Sleep-aware). Unknown seq / unparseable page → typed error.
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
  } catch {
    // Unknown seq or a page we cannot parse — either way there is no Player to add.
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
