import { describe, expect, it } from "vitest";
import {
  HighlightlyAuthError,
  HighlightlyClient,
  HighlightlyCoverageError,
  HighlightlyNotConfiguredError,
  HighlightlyQuotaError,
  normalizeHighlightlyStats,
} from "../src/highlightly/client.js";

const response = (body: unknown, status = 200, remaining: string | null = "99") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => (name === "x-ratelimit-requests-remaining" ? remaining : null) },
  json: async () => body,
});

const match = (id: number, date: string, state = "Finished") => ({
  id,
  date,
  league: "NCAA",
  season: 2026,
  awayTeam: { id: 7, name: "Away" },
  homeTeam: { id: 8, name: "Home" },
  state: { description: state },
});

describe("Highlightly client", () => {
  it("uses required auth headers without exposing the key", async () => {
    let headers: Record<string, string> | undefined;
    const client = new HighlightlyClient({
      apiKey: "secret-key",
      fetchImpl: async (_url, init) => {
        headers = init.headers;
        return response({ data: [], pagination: { totalCount: 0, offset: 0, limit: 100 } });
      },
    });

    await client.getFinalTeamMatches(7, 2026);
    expect(headers).toEqual({
      "x-rapidapi-key": "secret-key",
      "x-rapidapi-host": "mlb-college-baseball-api.p.rapidapi.com",
    });
  });

  it("collects both home and away final schedules, deduplicates, and sorts", async () => {
    const urls: string[] = [];
    const client = new HighlightlyClient({
      apiKey: "key",
      fetchImpl: async (url) => {
        urls.push(url);
        const query = new URL(url).searchParams;
        return response({
          data: query.has("homeTeamId")
            ? [match(2, "2026-03-02T00:00:00Z"), match(3, "2026-03-03T00:00:00Z", "Scheduled")]
            : [match(1, "2026-03-01T00:00:00Z"), match(2, "2026-03-02T00:00:00Z")],
          pagination: { totalCount: 2, offset: 0, limit: 100 },
        });
      },
    });

    const result = await client.getFinalTeamMatches(7, 2026);
    expect(result.value.map((item) => item.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("homeTeamId=7"))).toBe(true);
    expect(urls.some((url) => url.includes("awayTeamId=7"))).toBe(true);
  });

  it("does not treat a missing rate header as quota zero", async () => {
    const client = new HighlightlyClient({
      apiKey: "key",
      fetchImpl: async () => response({ data: [], pagination: { totalCount: 0, offset: 0, limit: 100 } }, 200, null),
    });
    await expect(client.getFinalTeamMatches(7, 2026)).resolves.toMatchObject({ remaining: null });
  });

  it("rejects pagination that cannot make durable progress", async () => {
    const client = new HighlightlyClient({
      apiKey: "key",
      fetchImpl: async () => response({ data: [], pagination: { totalCount: 2, offset: 0, limit: 0 } }),
    });
    await expect(client.getFinalTeamMatches(7, 2026)).rejects.toBeInstanceOf(HighlightlyCoverageError);
  });

  it("classifies configuration, auth, and quota without parsing provider errors", async () => {
    await expect(new HighlightlyClient({ apiKey: null }).getFinalTeamMatches(1, 2026)).rejects.toBeInstanceOf(HighlightlyNotConfiguredError);
    await expect(new HighlightlyClient({ apiKey: "k", fetchImpl: async () => response({}, 401) }).getFinalTeamMatches(1, 2026)).rejects.toBeInstanceOf(HighlightlyAuthError);
    await expect(new HighlightlyClient({ apiKey: "k", fetchImpl: async () => response({}, 429, "0") }).getFinalTeamMatches(1, 2026)).rejects.toBeInstanceOf(HighlightlyQuotaError);
  });

  it("preserves provider zero and records only supplied canonical input keys", () => {
    const player = {
      id: 1,
      fullName: "Gavin Kelly",
      statistics: [
        { group: "Batting", name: "AB", value: 4 },
        { group: "Batting", name: "H", value: 0 },
        { group: "Fielding", name: "Errors", value: 0 },
      ],
    };
    expect(normalizeHighlightlyStats(player, "Batting")).toEqual({
      stats: { atBats: 4, hits: 0 },
      availableStats: ["atBats", "hits"],
    });
    expect(normalizeHighlightlyStats(player, "Pitching")).toEqual({ stats: {}, availableStats: [] });
  });
});
