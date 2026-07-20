import type { NcaaSeason, NcaaStatCategory } from "./seasons.js";
import { categoryId, ncaaSeasonFor } from "./seasons.js";

/**
 * Thin, isolated scrape adapter over stats.ncaa.org (ADR 0032). Everything
 * NCAA-source-specific lives behind this boundary: the browser header set, the
 * URL form, and the polite delay. Mirrors MlbClient's shape — an injectable
 * fetch, a configurable delay, a typed error — so tests never touch the
 * network and the nightly sweep stays a good citizen.
 *
 * stats.ncaa.org sits behind Akamai bot protection that rate-limits and
 * IP-bans aggressive clients, so this is a deliberately unofficial, polite
 * adapter: a full modern-browser header set, a generous delay between calls,
 * and loud failures (never silent empties).
 */

export type NcaaFetchLike = (
  url: string,
  headers: Record<string, string>,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

const BASE_URL = "https://stats.ncaa.org";

/**
 * Modern-browser header set, copied from the baseballr `.ncaa_headers()`
 * precedent (billpetti/baseballr) — the set documented to pass the
 * stats.ncaa.org Akamai edge. Sent on every request.
 */
export const NCAA_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp," +
    "image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

export interface NcaaClientOptions {
  fetchImpl?: NcaaFetchLike;
  /** Polite delay between consecutive requests (ms). Default is generous. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export class NcaaApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`stats.ncaa.org request failed with HTTP ${status}: ${url}`);
    this.name = "NcaaApiError";
    this.status = status;
    this.url = url;
  }
}

/** The bundled season table has no entry for the requested year. */
export class UnsupportedNcaaSeasonError extends Error {
  readonly year: string;

  constructor(year: string) {
    super(`no bundled stats.ncaa.org season lookup for year ${year}`);
    this.name = "UnsupportedNcaaSeasonError";
    this.year = year;
  }
}

/**
 * Build the game-log page URL. This is the ONE place the source URL form is
 * constructed (ADR 0032). The legacy `game_by_game` form is used — the form
 * both reference implementations (baseballr, collegebaseball) drive. `org_id`
 * (the school id) is omitted when unknown: the page is keyed by
 * `stats_player_seq`, so the player's log resolves without it, and we never
 * store an NCAA school id.
 */
export function buildGameLogUrl(params: {
  baseUrl?: string;
  seq: number;
  season: NcaaSeason;
  category: NcaaStatCategory;
  orgId?: number;
}): string {
  const { baseUrl = BASE_URL, seq, season, category, orgId } = params;
  const query = new URLSearchParams({
    game_sport_year_ctl_id: String(season.seasonId),
    stats_player_seq: String(seq),
    year_stat_category_id: String(categoryId(season, category)),
  });
  if (orgId !== undefined) query.set("org_id", String(orgId));
  return `${baseUrl}/player/game_by_game?${query.toString()}`;
}

export class NcaaClient {
  private readonly fetchImpl: NcaaFetchLike;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private firstCall = true;

  constructor(options: NcaaClientOptions = {}) {
    this.fetchImpl =
      options.fetchImpl ??
      ((url, headers) => fetch(url, { headers }).then((r) => ({
        ok: r.ok,
        status: r.status,
        text: () => r.text(),
      })));
    // A generous default: stats.ncaa.org rate-limits aggressively.
    this.delayMs = options.delayMs ?? 3000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  /**
   * Fetch one player's raw game-log HTML for one season and one stat category.
   * Throws UnsupportedNcaaSeasonError when the year is not bundled and
   * NcaaApiError on any non-200 response.
   */
  async getGameLogPage(
    seq: number,
    seasonYear: string,
    category: NcaaStatCategory,
    orgId?: number,
  ): Promise<string> {
    const season = ncaaSeasonFor(seasonYear);
    if (season === null) {
      throw new UnsupportedNcaaSeasonError(seasonYear);
    }
    const url = buildGameLogUrl({ baseUrl: this.baseUrl, seq, season, category, orgId });
    return this.request(url);
  }

  private async request(url: string): Promise<string> {
    if (this.firstCall) {
      this.firstCall = false;
    } else if (this.delayMs > 0) {
      await this.sleep(this.delayMs);
    }
    const res = await this.fetchImpl(url, { ...NCAA_HEADERS });
    if (!res.ok) {
      throw new NcaaApiError(res.status, url);
    }
    return res.text();
  }
}
