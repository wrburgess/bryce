import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { MlbApiError, MlbClient } from "../src/mlb/client.js";
import { isIngestedGameType } from "../src/mlb/gameTypes.js";
import { levelForSportId, sportIdForLevel } from "../src/mlb/levels.js";
import type { Team } from "../src/mlb/schemas.js";
import { FakeStatsApi, loadFixture, makePerson } from "./factories.js";

function clientFor(api: FakeStatsApi): MlbClient {
  return new MlbClient({ fetchImpl: api.fetch, delayMs: 0 });
}

function clientWithBody(body: unknown): { client: MlbClient; calls: string[] } {
  const calls: string[] = [];
  const client = new MlbClient({
    fetchImpl: (url) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
    delayMs: 0,
  });
  return { client, calls };
}

describe("MlbClient game logs (real captured fixtures)", () => {
  it("parses a real Triple-A hitting game log", async () => {
    const { client } = clientWithBody(loadFixture("gamelog_hitting_aaa.json"));
    const log = await client.getGameLog({
      personId: 691185,
      sportId: 11,
      group: "hitting",
      season: "2026",
    });
    expect(log.stats).toHaveLength(1);
    const stats = log.stats[0];
    expect(stats?.group.displayName).toBe("hitting");
    expect(stats?.splits).toHaveLength(18);
    const split = stats?.splits[0];
    expect(split?.game.gamePk).toBe(816437);
    expect(split?.game.gameNumber).toBe(1);
    expect(split?.date).toBe("2026-04-15");
    expect(split?.gameType).toBe("R");
    expect(split?.sport.id).toBe(11);
    expect(split?.player.fullName).toBe("Maximo Acosta");
    expect(split?.stat.hits).toBe(1);
    expect(split?.stat.atBats).toBe(3);
  });

  it("parses a real MLB pitching game log", async () => {
    const { client } = clientWithBody(loadFixture("gamelog_pitching_mlb.json"));
    const log = await client.getGameLog({
      personId: 694973,
      sportId: 1,
      group: "pitching",
      season: "2026",
    });
    const stats = log.stats[0];
    expect(stats?.group.displayName).toBe("pitching");
    expect(stats?.splits).toHaveLength(21);
    const split = stats?.splits[0];
    expect(split?.stat.inningsPitched).toBe("0.2");
    expect(split?.stat.earnedRuns).toBe(5);
    expect(split?.sport.id).toBe(1);
  });

  it("parses the silent-empty shape the API returns without sportId", async () => {
    const { client } = clientWithBody(loadFixture("gamelog_empty.json"));
    const log = await client.getGameLog({
      personId: 691185,
      sportId: 11,
      group: "hitting",
      season: "2026",
    });
    expect(log.stats).toEqual([]);
  });

  it("throws a ZodError loudly on a malformed payload", async () => {
    const { client } = clientWithBody({
      stats: [{ type: {}, group: {}, splits: [{ date: "2026-04-15" }] }],
    });
    await expect(
      client.getGameLog({ personId: 691185, sportId: 11, group: "hitting", season: "2026" }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("surfaces HTTP failures as MlbApiError with the status", async () => {
    const client = new MlbClient({
      fetchImpl: () =>
        Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
      delayMs: 0,
    });
    const promise = client.getGameLog({
      personId: 691185,
      sportId: 11,
      group: "hitting",
      season: "2026",
    });
    await expect(promise).rejects.toBeInstanceOf(MlbApiError);
    await promise.catch((err: unknown) => {
      expect((err as MlbApiError).status).toBe(500);
    });
  });

  it("sends sportId, group and season on the game log URL", async () => {
    const api = new FakeStatsApi({});
    await clientFor(api).getGameLog({
      personId: 691185,
      sportId: 11,
      group: "hitting",
      season: "2026",
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toBe(
      "https://statsapi.mlb.com/api/v1/people/691185/stats?stats=gameLog&group=hitting&sportId=11&season=2026",
    );
  });
});

describe("MlbClient people and teams (real captured fixtures)", () => {
  it("parses a person WITHOUT currentTeam (no hydrate)", async () => {
    const { client } = clientWithBody(loadFixture("person_no_hydrate.json"));
    const person = await client.getPerson(691185);
    expect(person.id).toBe(691185);
    expect(person.fullName).toBe("Maximo Acosta");
    expect(person.currentTeam).toBeUndefined();
  });

  it("parses a hydrated person WITH currentTeam and requests the hydrate", async () => {
    const api = new FakeStatsApi({ person: loadFixtureFirstPerson() });
    const client = clientFor(api);
    const person = await client.getPerson(691185);
    expect(api.calls[0]).toContain("hydrate=currentTeam");
    expect(person.currentTeam?.id).toBe(564);
    expect(person.currentTeam?.parentOrgId).toBe(146);
  });

  it("maps a real Triple-A team to milb / Triple-A via its sport id", async () => {
    const { client } = clientWithBody(loadFixture("team_aaa.json"));
    const team = await client.getTeam(564);
    expect(team.sport.id).toBe(11);
    expect(levelForSportId(team.sport.id)).toEqual({ level: "milb", milbLevel: "Triple-A" });
    expect(team.parentOrgName).toBe("Miami Marlins");
  });

  it("maps a real MLB team to level mlb", async () => {
    const { client } = clientWithBody(loadFixture("team_mlb.json"));
    const team: Team = await client.getTeam(146);
    expect(team.sport.id).toBe(1);
    expect(levelForSportId(team.sport.id)).toEqual({ level: "mlb", milbLevel: null });
  });

  it("parses real search results", async () => {
    const { client } = clientWithBody(loadFixture("search_skenes.json"));
    const people = await client.searchPeople("skenes");
    expect(people).toHaveLength(1);
    expect(people[0]?.id).toBe(694973);
    expect(people[0]?.fullName).toBe("Paul Skenes");
  });
});

describe("MlbClient seasons (real captured fixtures)", () => {
  it("parses the MLB season with spring and postseason dates", async () => {
    const { client } = clientWithBody(loadFixture("season_mlb.json"));
    const season = await client.getSeason(1, "2026");
    expect(season?.regularSeasonStartDate).toBe("2026-03-25");
    expect(season?.regularSeasonEndDate).toBe("2026-09-27");
    expect(season?.postSeasonEndDate).toBe("2026-10-31");
    expect(season?.springStartDate).toBe("2026-02-20");
  });

  it("parses the Triple-A season, which has no spring dates", async () => {
    const { client } = clientWithBody(loadFixture("season_aaa.json"));
    const season = await client.getSeason(11, "2026");
    expect(season?.regularSeasonStartDate).toBe("2026-03-27");
    expect(season?.postSeasonEndDate).toBe("2026-09-27");
    expect(season?.springStartDate).toBeUndefined();
  });

  it("returns null for an unpublished season", async () => {
    const { client } = clientWithBody({ seasons: [] });
    expect(await client.getSeason(1, "2027")).toBeNull();
  });
});

describe("gameType ingestion allowlist", () => {
  it("keeps regular season and every postseason series type", () => {
    for (const t of ["R", "F", "D", "L", "W", "C"]) {
      expect(isIngestedGameType(t)).toBe(true);
    }
  });

  it("drops spring training, exhibitions, the All-Star game and unknown types", () => {
    for (const t of ["S", "E", "A", "I", "X", ""]) {
      expect(isIngestedGameType(t)).toBe(false);
    }
  });
});

describe("level mapping", () => {
  it("maps every swept sportId", () => {
    expect(levelForSportId(1)).toEqual({ level: "mlb", milbLevel: null });
    expect(levelForSportId(11)).toEqual({ level: "milb", milbLevel: "Triple-A" });
    expect(levelForSportId(12)).toEqual({ level: "milb", milbLevel: "Double-A" });
    expect(levelForSportId(13)).toEqual({ level: "milb", milbLevel: "High-A" });
    expect(levelForSportId(14)).toEqual({ level: "milb", milbLevel: "Single-A" });
    expect(levelForSportId(16)).toEqual({ level: "milb", milbLevel: "Rookie" });
    expect(levelForSportId(999)).toBeNull();
  });

  it("round-trips level back to sportId", () => {
    expect(sportIdForLevel("mlb", null)).toBe(1);
    expect(sportIdForLevel("milb", "Double-A")).toBe(12);
    expect(sportIdForLevel("milb", null)).toBeNull();
    expect(sportIdForLevel("milb", "Nonsense")).toBeNull();
  });
});

describe("polite delay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits delayMs between consecutive calls (fake timers, no wall clock)", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const client = new MlbClient({
      fetchImpl: (url) => {
        calls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ people: [makePerson()] }),
        });
      },
      delayMs: 500,
    });

    // First call goes straight through.
    await client.getPerson(691185);
    expect(calls).toHaveLength(1);

    // Second call must wait the polite delay.
    let resolved = false;
    const second = client.getPerson(691185).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(resolved).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

function loadFixtureFirstPerson(): Record<string, unknown> {
  const body = loadFixture("person_hydrated.json") as { people: Record<string, unknown>[] };
  const person = body.people[0];
  if (person === undefined) throw new Error("fixture person missing");
  return person;
}
