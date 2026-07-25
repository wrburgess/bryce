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

/**
 * stats.ncaa.org's Akamai edge can return an access-denied HTML document with
 * an HTTP 200. That is an upstream availability failure, never evidence that
 * the requested player does not exist.
 */
export class NcaaAccessDeniedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`stats.ncaa.org denied access to this request: ${url}`);
    this.name = "NcaaAccessDeniedError";
    this.url = url;
  }
}

function isAkamaiBlockedPage(body: string): boolean {
  return (
    /access\s+denied/i.test(body) ||
    /akamai_validation\.html/i.test(body) ||
    /(?:[?&])bm-verify=/i.test(body) ||
    /request_quota_reached\.html/i.test(body)
  );
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
 * constructed (ADR 0032). The current player page is keyed directly by the
 * player sequence; the season lookup remains necessary solely to select the
 * category id. The former `/player/game_by_game` route is no longer used by
 * the NCAA site.
 */
export function buildGameLogUrl(params: {
  baseUrl?: string;
  seq: number;
  season: NcaaSeason;
  category: NcaaStatCategory;
}): string {
  const { baseUrl = BASE_URL, seq, season, category } = params;
  const query = new URLSearchParams({
    year_stat_category_id: String(categoryId(season, category)),
  });
  return `${baseUrl}/players/${seq}?${query.toString()}`;
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
   * NcaaApiError on any non-200 response and NcaaAccessDeniedError when the
   * edge serves an access-denied HTML document with HTTP 200.
   */
  async getGameLogPage(
    seq: number,
    seasonYear: string,
    category: NcaaStatCategory,
  ): Promise<string> {
    const season = ncaaSeasonFor(seasonYear);
    if (season === null) {
      throw new UnsupportedNcaaSeasonError(seasonYear);
    }
    const url = buildGameLogUrl({ baseUrl: this.baseUrl, seq, season, category });
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
    const body = await res.text();
    // Akamai's denial page is often delivered with 200, so status alone cannot
    // distinguish it from a real game-log page. Keep this boundary explicit:
    // downstream identity resolution must never turn source blocking into
    // "no such player".
    if (isAkamaiBlockedPage(body)) {
      throw new NcaaAccessDeniedError(url);
    }
    return body;
  }
}
