import { z } from "zod";

/** Small typed boundary around Highlightly/RapidAPI. It deliberately never logs credentials. */
export type HighlightlyFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type HighlightlyErrorCode =
  | "highlightly_not_configured"
  | "highlightly_auth_failed"
  | "highlightly_quota_exhausted"
  | "highlightly_upstream_error"
  | "highlightly_coverage_incomplete"
  | "highlightly_player_not_found"
  | "highlightly_identity_mismatch"
  | "highlightly_migration_required";

export class HighlightlyError extends Error {
  constructor(
    readonly code: HighlightlyErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HighlightlyError";
  }
}

export class HighlightlyNotConfiguredError extends HighlightlyError {
  constructor() {
    super("highlightly_not_configured", "HIGHLIGHTLY_API_KEY is required for NCAA refresh");
    this.name = "HighlightlyNotConfiguredError";
  }
}

export class HighlightlyAuthError extends HighlightlyError {
  constructor(status: number) {
    super("highlightly_auth_failed", "Highlightly rejected the configured API key", status);
    this.name = "HighlightlyAuthError";
  }
}

export class HighlightlyQuotaError extends HighlightlyError {
  constructor(readonly remaining: number | null) {
    super("highlightly_quota_exhausted", "Highlightly request quota is exhausted", 429);
    this.name = "HighlightlyQuotaError";
  }
}

export class HighlightlyUpstreamError extends HighlightlyError {
  constructor(status: number) {
    super("highlightly_upstream_error", `Highlightly request failed with HTTP ${status}`, status);
    this.name = "HighlightlyUpstreamError";
  }
}

export class HighlightlyCoverageError extends HighlightlyError {
  constructor(message: string) {
    super("highlightly_coverage_incomplete", message, 503);
    this.name = "HighlightlyCoverageError";
  }
}

export class HighlightlyPlayerNotFoundError extends HighlightlyError {
  constructor(playerId: number) {
    super("highlightly_player_not_found", `no Highlightly player with id=${playerId}`, 404);
    this.name = "HighlightlyPlayerNotFoundError";
  }
}

export class HighlightlyIdentityMismatchError extends HighlightlyError {
  constructor(message: string) {
    super("highlightly_identity_mismatch", message, 409);
    this.name = "HighlightlyIdentityMismatchError";
  }
}

export class HighlightlyMigrationRequiredError extends HighlightlyError {
  constructor() {
    super("highlightly_migration_required", "attach and backfill this legacy NCAA player first", 409);
    this.name = "HighlightlyMigrationRequiredError";
  }
}

const Team = z.looseObject({ id: z.number(), name: z.string(), displayName: z.string().optional(), league: z.string().optional() });
const Match = z.looseObject({
  id: z.number(),
  date: z.string(),
  league: z.string(),
  season: z.number(),
  awayTeam: Team,
  homeTeam: Team,
  state: z.looseObject({ description: z.string() }).optional(),
});
const Page = z.looseObject({
  data: z.array(Match),
  pagination: z.looseObject({ totalCount: z.number(), offset: z.number(), limit: z.number() }),
});
const Player = z.looseObject({
  id: z.number(),
  fullName: z.string(),
  team: Team.optional(),
  teamId: z.number().optional(),
  statistics: z.array(z.looseObject({ group: z.string(), name: z.string(), value: z.union([z.number(), z.string()]) })).default([]),
});
// The player-search endpoint returns flat records, while the detail endpoint
// currently returns a one-item array and nests the team under `profile`.
// Normalize both documented-in-practice shapes at this boundary.
const PlayerDetail = Player.extend({
  profile: z.looseObject({ team: Team.optional() }).optional(),
});
const PlayerResponse = z.union([
  Player,
  z.array(PlayerDetail).length(1).transform((players) => {
    const player = players[0]!;
    return Player.parse({ ...player, team: player.team ?? player.profile?.team });
  }),
]);
const PlayerSearchPage = z.looseObject({
  data: z.array(z.looseObject({ id: z.number(), fullName: z.string() })),
  pagination: z.looseObject({ totalCount: z.number(), offset: z.number(), limit: z.number() }),
});
const BoxTeam = z.looseObject({ team: Team.optional(), boxScores: z.array(Player) });

export type HighlightlyMatch = z.infer<typeof Match>;
export type HighlightlyPlayer = z.infer<typeof Player>;
export type HighlightlyNcaaPlayerSearchResult = { playerId: number; canonicalName: string; teamId: number };

export interface HighlightlyClientOptions {
  apiKey: string | null;
  fetchImpl?: HighlightlyFetch;
  baseUrl?: string;
}

export interface HighlightlyResponse<T> {
  value: T;
  /** Null means the provider did not send a usable header; it is never treated as zero. */
  remaining: number | null;
}

export class HighlightlyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: HighlightlyFetch;

  constructor(private readonly options: HighlightlyClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://baseball.highlightly.net";
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string): Promise<HighlightlyResponse<unknown>> {
    const key = this.options.apiKey?.trim();
    if (!key) throw new HighlightlyNotConfiguredError();
    let response: Awaited<ReturnType<HighlightlyFetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          "x-rapidapi-key": key,
          "x-rapidapi-host": "mlb-college-baseball-api.p.rapidapi.com",
        },
      });
    } catch {
      throw new HighlightlyUpstreamError(0);
    }
    const header = response.headers.get("x-ratelimit-requests-remaining");
    const parsed = header === null ? Number.NaN : Number(header);
    const remaining = Number.isFinite(parsed) ? parsed : null;
    if (response.status === 401 || response.status === 403) throw new HighlightlyAuthError(response.status);
    if (response.status === 429 || remaining === 0) throw new HighlightlyQuotaError(remaining);
    if (!response.ok) throw new HighlightlyUpstreamError(response.status);
    try {
      return { value: await response.json(), remaining };
    } catch {
      throw new HighlightlyCoverageError("Highlightly returned malformed JSON");
    }
  }

  private async getMatches(
    teamId: number,
    season: number,
    side: "homeTeamId" | "awayTeamId",
  ): Promise<HighlightlyResponse<HighlightlyMatch[]>> {
    const matches: HighlightlyMatch[] = [];
    let offset = 0;
    let previousOffset = -1;
    let remaining: number | null = null;
    for (;;) {
      const response = await this.request(
        `/matches?league=NCAA&season=${season}&${side}=${teamId}&limit=100&offset=${offset}`,
      );
      remaining = response.remaining;
      let page: z.infer<typeof Page>;
      try {
        page = Page.parse(response.value);
      } catch {
        throw new HighlightlyCoverageError("Highlightly returned an invalid matches page");
      }
      matches.push(...page.data.filter((match) => match.state?.description === "Finished"));
      if (offset + page.pagination.limit >= page.pagination.totalCount) break;
      previousOffset = offset;
      offset += page.pagination.limit;
      if (page.pagination.limit <= 0 || offset <= previousOffset) {
        throw new HighlightlyCoverageError("Highlightly matches pagination did not advance");
      }
    }
    return { value: matches, remaining };
  }

  /** A team plays on both sides; querying both is required for a complete season. */
  async getFinalTeamMatches(teamId: number, season: number): Promise<HighlightlyResponse<HighlightlyMatch[]>> {
    const [home, away] = await Promise.all([
      this.getMatches(teamId, season, "homeTeamId"),
      this.getMatches(teamId, season, "awayTeamId"),
    ]);
    const unique = new Map<number, HighlightlyMatch>();
    for (const match of [...home.value, ...away.value]) unique.set(match.id, match);
    return {
      value: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id),
      remaining: away.remaining ?? home.remaining,
    };
  }

  /** Resolve an explicitly supplied provider identity before it can be attached to a Bryce row. */
  async getPlayer(playerId: number): Promise<HighlightlyResponse<HighlightlyPlayer>> {
    const response = await this.request(`/players/${playerId}`);
    try {
      return { value: PlayerResponse.parse(response.value), remaining: response.remaining };
    } catch {
      throw new HighlightlyPlayerNotFoundError(playerId);
    }
  }

  /** Search provider players by name and retain only NCAA identities with a team. */
  async searchNcaaPlayers(name: string): Promise<HighlightlyResponse<HighlightlyNcaaPlayerSearchResult[]>> {
    const query = new URLSearchParams({ name, limit: "10", offset: "0" });
    const response = await this.request(`/players?${query.toString()}`);
    let page: z.infer<typeof PlayerSearchPage>;
    try {
      page = PlayerSearchPage.parse(response.value);
    } catch {
      throw new HighlightlyCoverageError("Highlightly returned an invalid player search page");
    }
    // Highlightly's name query is fuzzy. If its lightweight search records
    // include an exact name, resolve only those candidates rather than using
    // detail requests on every fuzzy hit.
    const normalizedName = name.normalize("NFC").trim().toLocaleLowerCase("en-US");
    const exactCandidates = page.data.filter(
      (candidate) => candidate.fullName.normalize("NFC").trim().toLocaleLowerCase("en-US") === normalizedName,
    );
    const candidates = exactCandidates.length > 0 ? exactCandidates : page.data;
    const results: HighlightlyNcaaPlayerSearchResult[] = [];
    for (const candidate of candidates) {
      const player = await this.getPlayer(candidate.id);
      const teamId = highlightlyTeamId(player.value);
      if (player.value.team?.league === "NCAA" && teamId !== null) {
        results.push({ playerId: candidate.id, canonicalName: candidate.fullName.normalize("NFC"), teamId });
      }
    }
    return { value: results, remaining: response.remaining };
  }

  async getBoxScore(matchId: number): Promise<HighlightlyResponse<Array<{ teamId: number | null; players: HighlightlyPlayer[] }>>> {
    const response = await this.request(`/box-scores/${matchId}`);
    try {
      const teams = z.array(BoxTeam).parse(response.value);
      return {
        value: teams.map((team) => ({ teamId: team.team?.id ?? null, players: team.boxScores })),
        remaining: response.remaining,
      };
    } catch {
      throw new HighlightlyCoverageError("Highlightly returned an invalid box score");
    }
  }
}

/** Highlightly has used both nested `team.id` and a top-level teamId. */
export function highlightlyTeamId(player: HighlightlyPlayer): number | null {
  return player.team?.id ?? player.teamId ?? null;
}

const STAT_KEYS: Record<string, string> = {
  AB: "atBats", PA: "plateAppearances", R: "runs", H: "hits", "2B": "doubles", "3B": "triples",
  RBI: "rbi", HR: "homeRuns", BB: "baseOnBalls", SO: "strikeOuts", K: "strikeOuts",
  HBP: "hitByPitch", SF: "sacFlies", SH: "sacBunts", SB: "stolenBases", CS: "caughtStealing",
  IP: "inningsPitched", ER: "earnedRuns", W: "wins", L: "losses", SV: "saves", HLD: "holds",
  BF: "battersFaced", QS: "qualityStarts", GS: "gamesStarted", HA: "hits", R_ALLOWED: "runs",
};

/** Convert only supplied provider fields. The key list is persisted to distinguish absent from zero. */
export function normalizeHighlightlyStats(
  player: HighlightlyPlayer,
  group: "Batting" | "Pitching",
): { stats: Record<string, number | string>; availableStats: string[] } {
  const stats: Record<string, number | string> = {};
  for (const statistic of player.statistics) {
    const key = STAT_KEYS[statistic.name.toUpperCase()];
    if (statistic.group === group && key !== undefined) stats[key] = statistic.value;
  }
  return { stats, availableStats: Object.keys(stats).sort() };
}
