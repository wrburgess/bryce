import { SPORT_IDS } from "./levels.js";
import type { GameLogResponse, Person, Season, Team } from "./schemas.js";
import {
  GameLogResponseSchema,
  PeopleResponseSchema,
  SeasonsResponseSchema,
  TeamsResponseSchema,
} from "./schemas.js";

const BASE_URL = "https://statsapi.mlb.com/api/v1";

/**
 * Most people `/people/search` will return for one query — measured, not
 * documented: `names=Garcia` yields exactly 50 both bare and with `limit=1000`,
 * so `limit` does NOT raise it. A caller rendering a result set of this size as
 * the complete candidate list is showing a truncated one (`src/cli/pick.ts`).
 */
export const SEARCH_RESULT_CAP = 50;

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface MlbClientOptions {
  fetchImpl?: FetchLike;
  /** Polite delay between consecutive API calls (ms). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export class MlbApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`MLB Stats API request failed with HTTP ${status}: ${url}`);
    this.name = "MlbApiError";
    this.status = status;
    this.url = url;
  }
}

export type StatGroup = "hitting" | "pitching" | "fielding";

/**
 * Thin client over the MLB Stats API. All responses are validated with Zod —
 * a shape mismatch throws loudly (ADR 0025). A polite delay is inserted
 * between consecutive calls so the full-season sweep (ADR 0030) stays a good
 * citizen. Fetch and sleep are injectable; tests never touch the network.
 */
export class MlbClient {
  private readonly fetchImpl: FetchLike;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private firstCall = true;

  constructor(options: MlbClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
    this.delayMs = options.delayMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  private async request(path: string): Promise<unknown> {
    if (this.firstCall) {
      this.firstCall = false;
    } else if (this.delayMs > 0) {
      await this.sleep(this.delayMs);
    }
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new MlbApiError(res.status, url);
    }
    return res.json();
  }

  /**
   * Name search, scoped to `SPORT_IDS` — search resolves exactly the population
   * the Refresh ingests, so the two can never disagree about who is watchable.
   *
   * `sportIds` is REQUIRED by design, for the same reason `getGameLog`'s is.
   * Omitting it does not mean "every sport"; it means "whatever scope the API
   * defaults to today", which is undocumented and MOVES — it silently stopped
   * covering Single-A and Rookie, and five rostered players became unfindable
   * by name while remaining resolvable by id (#204). An unset parameter here is
   * not a neutral default but an inherited one.
   */
  async searchPeople(name: string): Promise<Person[]> {
    const body = await this.request(
      `/people/search?names=${encodeURIComponent(name)}&sportIds=${SPORT_IDS.join(",")}`,
    );
    return PeopleResponseSchema.parse(body).people;
  }

  /**
   * Person with hydrate=currentTeam, or null when the API has no such person
   * (HTTP 404 or an empty people array — the API uses both for unknown ids).
   */
  async findPerson(personId: number): Promise<Person | null> {
    let body: unknown;
    try {
      body = await this.request(`/people/${personId}?hydrate=currentTeam`);
    } catch (err) {
      if (err instanceof MlbApiError && err.status === 404) return null;
      throw err;
    }
    return PeopleResponseSchema.parse(body).people[0] ?? null;
  }

  /** Person with hydrate=currentTeam (without the hydrate the API omits currentTeam entirely). */
  async getPerson(personId: number): Promise<Person> {
    const person = await this.findPerson(personId);
    if (person === null) {
      throw new Error(`MLB Stats API returned no person for personId ${personId}`);
    }
    return person;
  }

  async getTeam(teamId: number): Promise<Team> {
    const body = await this.request(`/teams/${teamId}`);
    const teams = TeamsResponseSchema.parse(body).teams;
    const team = teams[0];
    if (team === undefined) {
      throw new Error(`MLB Stats API returned no team for teamId ${teamId}`);
    }
    return team;
  }

  /** Season dates for one sportId; null when the season is not yet published. */
  async getSeason(sportId: number, season: string): Promise<Season | null> {
    const body = await this.request(`/seasons?sportId=${sportId}&season=${season}`);
    const seasons = SeasonsResponseSchema.parse(body).seasons;
    return seasons[0] ?? null;
  }

  /**
   * Game log for one person, one sport, one stat group, one season.
   *
   * `sportId` is REQUIRED by design: the API silently returns `{"stats": []}`
   * for a MiLB player when sportId is omitted (verified live) — an optional
   * parameter here would quietly lose entire seasons.
   */
  async getGameLog(params: {
    personId: number;
    sportId: number;
    group: StatGroup;
    season: string;
  }): Promise<GameLogResponse> {
    const { personId, sportId, group, season } = params;
    if (!Number.isInteger(sportId)) {
      throw new Error(`getGameLog requires an integer sportId; got ${String(sportId)}`);
    }
    const body = await this.request(
      `/people/${personId}/stats?stats=gameLog&group=${group}&sportId=${sportId}&season=${season}`,
    );
    return GameLogResponseSchema.parse(body);
  }
}
