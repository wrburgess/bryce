import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, OpenedDb } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import type { DigestDeliveryRow, PlayerRow, StatLineRow } from "../src/db/schema.js";
import { digestDeliveries, players, seasonCalendar, statLines } from "../src/db/schema.js";
import type { FetchLike } from "../src/mlb/client.js";
import type { MailMessage, Mailer } from "../src/mailer/types.js";

/**
 * Programmatic builders (rules/testing.md: never static schema-coupled test
 * data). API payload builders model the REAL captured payload shapes in
 * test/fixtures/mlb/. No factory ever touches the network or the wall clock.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mlb");

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

export function testDb(): OpenedDb {
  return openDb(":memory:");
}

export interface FakeClock {
  now: () => Date;
  set: (iso: string) => void;
}

export function fakeClock(startIso: string): FakeClock {
  let current = new Date(startIso);
  return {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}

export const TEST_TZ = "America/Chicago";
/** Mid-season instant: 2026-07-19 in America/Chicago. */
export const MID_SEASON = "2026-07-19T17:00:00Z";
/** Deep offseason instant: 2026-12-05 in America/Chicago. */
export const OFFSEASON = "2026-12-05T18:00:00Z";

const ISO_NOW = "2026-07-19T17:00:00.000Z";

let uniqueCounter = 1000;
export function nextInt(): number {
  uniqueCounter += 1;
  return uniqueCounter;
}

// --- DB row factories -------------------------------------------------------

export async function insertPlayer(
  db: Db,
  overrides: Partial<typeof players.$inferInsert> = {},
): Promise<PlayerRow> {
  const rows = await db
    .insert(players)
    .values({
      externalId: nextInt(),
      fullName: "Maximo Acosta",
      level: "milb",
      milbLevel: "Triple-A",
      teamName: "Jacksonville Jumbo Shrimp",
      position: "SS",
      active: true,
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("insertPlayer failed");
  return row;
}

export async function insertStatLine(
  db: Db,
  overrides: Partial<typeof statLines.$inferInsert> & { playerId: number },
): Promise<StatLineRow> {
  const stats = overrides.stats ?? {
    hits: 2,
    atBats: 4,
    homeRuns: 1,
    doubles: 0,
    triples: 0,
    runs: 1,
    rbi: 3,
    stolenBases: 0,
    baseOnBalls: 0,
    strikeOuts: 1,
  };
  const rows = await db
    .insert(statLines)
    .values({
      gameId: nextInt(),
      statType: "batting",
      gameDate: "2026-07-18",
      gameNumber: 1,
      gameType: "R",
      isHome: true,
      opponentName: "Charlotte Knights",
      teamName: "Jacksonville Jumbo Shrimp",
      sportId: 11,
      leagueName: "International League",
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
      ...overrides,
      stats,
      raw: overrides.raw ?? { stat: stats },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("insertStatLine failed");
  return row;
}

export async function insertDelivery(
  db: Db,
  overrides: Partial<typeof digestDeliveries.$inferInsert> = {},
): Promise<DigestDeliveryRow> {
  const rows = await db
    .insert(digestDeliveries)
    .values({
      kind: "digest",
      dateCovered: "2026-07-18",
      sentAt: "2026-07-18T17:00:00.000Z",
      playerCount: 1,
      statLineCount: 1,
      status: "sent",
      createdAt: "2026-07-18T17:00:00.000Z",
      ...overrides,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("insertDelivery failed");
  return row;
}

export async function insertCalendar(
  db: Db,
  overrides: Partial<typeof seasonCalendar.$inferInsert> = {},
): Promise<void> {
  await db.insert(seasonCalendar).values({
    sportId: 1,
    season: "2026",
    regularSeasonStart: "2026-03-25",
    regularSeasonEnd: "2026-09-27",
    postSeasonStart: "2026-09-28",
    postSeasonEnd: "2026-10-31",
    springStart: "2026-02-20",
    springEnd: "2026-03-24",
    fetchedAt: ISO_NOW,
    ...overrides,
  });
}

/** MLB + Triple-A 2026 calendars matching the real captured season fixtures. */
export async function insertCalendars2026(db: Db): Promise<void> {
  await insertCalendar(db); // sportId 1
  await insertCalendar(db, {
    sportId: 11,
    regularSeasonStart: "2026-03-27",
    regularSeasonEnd: "2026-09-20",
    postSeasonStart: "2026-09-22",
    postSeasonEnd: "2026-09-27",
    springStart: null,
    springEnd: null,
  });
}

// --- MLB Stats API payload builders (real captured shapes) ------------------

type JsonRecord = Record<string, unknown>;

export function makeSplit(overrides: JsonRecord = {}): JsonRecord {
  const stat = (overrides.stat as JsonRecord | undefined) ?? {
    summary: "1-3 | 2B, K",
    gamesPlayed: 1,
    hits: 1,
    atBats: 3,
    doubles: 1,
    triples: 0,
    homeRuns: 0,
    runs: 0,
    rbi: 0,
    stolenBases: 0,
    baseOnBalls: 0,
    strikeOuts: 1,
    avg: ".333",
  };
  return {
    season: "2026",
    team: { id: 564, name: "Jacksonville Jumbo Shrimp", link: "/api/v1/teams/564" },
    player: { id: 691185, fullName: "Maximo Acosta", link: "/api/v1/people/691185" },
    league: { id: 117, name: "International League", link: "/api/v1/league/117" },
    sport: { id: 11, link: "/api/v1/sports/11", abbreviation: "AAA" },
    opponent: { id: 494, name: "Charlotte Knights", link: "/api/v1/teams/494" },
    date: "2026-04-15",
    gameType: "R",
    isHome: true,
    isWin: true,
    positionsPlayed: [{ code: "6", name: "Shortstop", type: "Infielder", abbreviation: "SS" }],
    game: {
      gamePk: nextInt(),
      link: "/api/v1.1/game/816437/feed/live",
      content: { link: "/api/v1/game/816437/content" },
      gameNumber: 1,
      dayNight: "day",
    },
    ...overrides,
    stat,
  };
}

export function makeGameLogBody(group: "hitting" | "pitching", splits: JsonRecord[]): JsonRecord {
  return {
    copyright: "Copyright 2026 MLB Advanced Media, L.P.",
    stats: [
      {
        type: { displayName: "gameLog" },
        group: { displayName: group },
        exemptions: [],
        splits,
      },
    ],
  };
}

export const EMPTY_GAME_LOG: JsonRecord = {
  copyright: "Copyright 2026 MLB Advanced Media, L.P.",
  stats: [],
};

export function makePerson(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 691185,
    fullName: "Maximo Acosta",
    link: "/api/v1/people/691185",
    active: true,
    primaryPosition: { code: "6", name: "Shortstop", type: "Infielder", abbreviation: "SS" },
    isPlayer: true,
    currentTeam: { id: 564, name: "Jacksonville Jumbo Shrimp", link: "/api/v1/teams/564", parentOrgId: 146 },
    ...overrides,
  };
}

export function makeTeam(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 564,
    name: "Jacksonville Jumbo Shrimp",
    link: "/api/v1/teams/564",
    season: 2026,
    league: { id: 117, name: "International League", link: "/api/v1/league/117" },
    sport: { id: 11, link: "/api/v1/sports/11", name: "Triple-A" },
    parentOrgName: "Miami Marlins",
    parentOrgId: 146,
    active: true,
    ...overrides,
  };
}

export function makeMlbTeam(overrides: JsonRecord = {}): JsonRecord {
  return makeTeam({
    id: 146,
    name: "Miami Marlins",
    league: { id: 104, name: "National League", link: "/api/v1/league/104" },
    sport: { id: 1, link: "/api/v1/sports/1", name: "Major League Baseball" },
    parentOrgName: undefined,
    parentOrgId: undefined,
    ...overrides,
  });
}

export function makeSeasonBody(overrides: JsonRecord = {}): JsonRecord {
  return {
    seasonId: "2026",
    hasWildcard: true,
    springStartDate: "2026-02-20",
    springEndDate: "2026-03-24",
    regularSeasonStartDate: "2026-03-25",
    regularSeasonEndDate: "2026-09-27",
    postSeasonStartDate: "2026-09-28",
    postSeasonEndDate: "2026-10-31",
    seasonEndDate: "2026-10-31",
    ...overrides,
  };
}

// --- Fake Stats API (routes URLs like the real service; never the network) --

export interface FakeApiOptions {
  person?: JsonRecord;
  teams?: Record<number, JsonRecord>;
  /** key `${sportId}:${group}` → gameLog response body; unrouted → silent-empty. */
  gameLogs?: Record<string, JsonRecord>;
  /** sportId → season object; missing → unpublished (empty seasons array). */
  seasons?: Record<number, JsonRecord>;
  searchResults?: JsonRecord[];
}

export class FakeStatsApi {
  readonly calls: string[] = [];
  options: FakeApiOptions;

  constructor(options: FakeApiOptions = {}) {
    this.options = options;
  }

  get fetch(): FetchLike {
    return (url: string) => {
      this.calls.push(url);
      const body = this.route(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
  }

  callsMatching(pattern: RegExp): string[] {
    return this.calls.filter((u) => pattern.test(u));
  }

  private route(url: string): unknown {
    const u = new URL(url);
    const path = u.pathname;
    if (path.endsWith("/people/search")) {
      return { people: this.options.searchResults ?? [] };
    }
    if (/\/people\/\d+\/stats$/.test(path)) {
      const key = `${u.searchParams.get("sportId")}:${u.searchParams.get("group")}`;
      return this.options.gameLogs?.[key] ?? { copyright: "c", stats: [] };
    }
    if (/\/people\/\d+$/.test(path)) {
      return { people: this.options.person !== undefined ? [this.options.person] : [] };
    }
    const teamMatch = /\/teams\/(\d+)$/.exec(path);
    if (teamMatch !== null) {
      const team = this.options.teams?.[Number(teamMatch[1])];
      return { teams: team !== undefined ? [team] : [] };
    }
    if (path.endsWith("/seasons")) {
      const season = this.options.seasons?.[Number(u.searchParams.get("sportId"))];
      return { seasons: season !== undefined ? [season] : [] };
    }
    throw new Error(`FakeStatsApi: unrouted url ${url}`);
  }
}

// --- Mailer test double -----------------------------------------------------

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failWith: Error | null = null;

  send(message: MailMessage): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }
}
