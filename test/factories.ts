import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, OpenedDb } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import type { DigestDeliveryRow, PlayerRow, StatLineRow } from "../src/db/schema.js";
import { digestDeliveries, players, seasonCalendar, statLines } from "../src/db/schema.js";
import type { FetchLike } from "../src/mlb/client.js";
import { MlbClient } from "../src/mlb/client.js";
import type { MailContext, MailMessage, MailReceipt, Mailer } from "../src/mailer/types.js";
import type { NcaaFetchLike } from "../src/ncaa/client.js";
import { NcaaClient } from "../src/ncaa/client.js";
import { NCAA_SEASONS } from "../src/ncaa/seasons.js";
import type { NcaaStatCategory } from "../src/ncaa/seasons.js";
import type { AppDeps } from "../src/server.js";

/**
 * Programmatic builders (rules/testing.md: never static schema-coupled test
 * data). API payload builders model the REAL captured payload shapes in
 * test/fixtures/mlb/. No factory ever touches the network or the wall clock.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mlb");
const NCAA_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ncaa");

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

/** Raw HTML fixture from test/fixtures/ncaa/ (constructed, faithful to the real table). */
export function loadNcaaFixture(name: string): string {
  return readFileSync(join(NCAA_FIXTURES_DIR, name), "utf8");
}

export function testDb(): OpenedDb {
  return openDb(":memory:");
}

export interface TempFileDb {
  opened: OpenedDb;
  path: string;
  cleanup: () => void;
}

/**
 * A migrated database in a temp FILE (not :memory:) for tests that need a
 * second connection to the same database — e.g. the read-only handle in
 * test/readonly.test.ts; an in-memory db cannot be shared across connections.
 */
export function testFileDb(): TempFileDb {
  const dir = mkdtempSync(join(tmpdir(), "bryce-test-"));
  const path = join(dir, "bryce.db");
  const opened = openDb(path);
  return {
    opened,
    path,
    cleanup: () => {
      try {
        opened.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

/**
 * A delivery row. Defaults describe a completed `sent` digest; pass
 * `status: "sending"` with a `claimedAt` to construct the durable aftermath of
 * a crashed run directly (ADR 0034) — a non-`sent` status drops the default
 * sentAt so the row is never a contradiction.
 */
export async function insertDelivery(
  db: Db,
  overrides: Partial<typeof digestDeliveries.$inferInsert> = {},
): Promise<DigestDeliveryRow> {
  const status = overrides.status ?? "sent";
  const rows = await db
    .insert(digestDeliveries)
    .values({
      kind: "digest",
      dateCovered: "2026-07-18",
      sentAt: status === "sent" ? "2026-07-18T17:00:00.000Z" : null,
      playerCount: 1,
      statLineCount: 1,
      // Any row that exists is the residue of at least one attempt.
      attemptCount: 1,
      createdAt: "2026-07-18T17:00:00.000Z",
      ...overrides,
      status,
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

export function makeGameLogBody(
  group: "hitting" | "pitching" | "fielding",
  splits: JsonRecord[],
): JsonRecord {
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

// --- NCAA game-log HTML builder (faithful to the reference table shape) -----

export interface NcaaLogRow {
  /** ISO date; the builder emits it as MM/DD/YYYY like the real page. */
  date: string;
  opponentName: string;
  /** true = "vs" home, false = "@" away, null = neutral (no prefix). */
  isHome?: boolean | null;
  /** When set, the Result cell links to a box score carrying this contest id. */
  contestId?: number | null;
  result?: string;
  stats: Record<string, string | number>;
}

/**
 * Build a stats.ncaa.org game-log page (constructed, faithful to the
 * billpetti/baseballr + collegebaseball reference table shape): a Date /
 * Opponent / Result header, per-game stat columns, and a trailing
 * season-totals row the parser excludes.
 */
export function makeNcaaGameLogHtml(args: {
  fullName: string;
  schoolName: string;
  schoolTeamId?: number;
  rows: NcaaLogRow[];
}): string {
  const { fullName, schoolName, schoolTeamId = 999, rows } = args;
  const statColumns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.stats)) {
      if (!statColumns.includes(key)) statColumns.push(key);
    }
  }

  const headerCells = ["Date", "Opponent", "Result", ...statColumns]
    .map((h) => `<th>${h}</th>`)
    .join("");

  const bodyRows = rows
    .map((row) => {
      const [, mm, dd] = row.date.split("-");
      const yyyy = row.date.slice(0, 4);
      const dateCell = `<td>${mm}/${dd}/${yyyy}</td>`;
      const prefix = row.isHome === true ? "vs " : row.isHome === false ? "@ " : "";
      const oppCell = `<td>${prefix}<a href="/teams/1">${row.opponentName}</a></td>`;
      const result = row.result ?? "W 5-3";
      const resultCell =
        row.contestId != null
          ? `<td><a href="/contests/${row.contestId}/box_score">${result}</a></td>`
          : `<td>${result}</td>`;
      const statCells = statColumns
        .map((col) => `<td>${row.stats[col] ?? ""}</td>`)
        .join("");
      return `<tr>${dateCell}${oppCell}${resultCell}${statCells}</tr>`;
    })
    .join("");

  const totalsStats = statColumns.map(() => "<td>0</td>").join("");
  const totalsRow = `<tr class="grey_heading"><td>Totals</td><td></td><td></td>${totalsStats}</tr>`;

  return [
    "<!DOCTYPE html><html><head>",
    `<title>${fullName}</title>`,
    "</head><body>",
    `<div class="card"><div class="card-header">`,
    `<a href="/teams/${schoolTeamId}">${schoolName}</a>`,
    "</div></div>",
    `<table class="nav"><thead><tr><th>Year</th></tr></thead><tbody><tr><td>2025</td></tr></tbody></table>`,
    `<table id="game_by_game"><thead><tr>${headerCells}</tr></thead>`,
    `<tbody>${bodyRows}${totalsRow}</tbody></table>`,
    "</body></html>",
  ].join("");
}

/**
 * Fake stats.ncaa.org over NcaaClient's fetch. Routes game-log URLs by
 * stats_player_seq + stat category (derived from year_stat_category_id via the
 * bundled season table); serves builder HTML; records calls and headers; an
 * unrouted url throws — the FakeStatsApi pattern for the NCAA adapter.
 */
export interface FakeNcaaOptions {
  /** key `${seq}:${category}` → game-log HTML. */
  pages?: Record<string, string>;
  /** Force a non-200 status (with empty body) on every request. */
  status?: number;
}

export class FakeNcaaApi {
  readonly calls: string[] = [];
  readonly headers: Array<Record<string, string>> = [];
  options: FakeNcaaOptions;

  constructor(options: FakeNcaaOptions = {}) {
    this.options = options;
  }

  get fetch(): NcaaFetchLike {
    return (url: string, headers: Record<string, string>) => {
      this.calls.push(url);
      this.headers.push(headers);
      if (this.options.status !== undefined && this.options.status !== 200) {
        return Promise.resolve({
          ok: false,
          status: this.options.status,
          text: () => Promise.resolve(""),
        });
      }
      const body = this.route(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    };
  }

  callsMatching(pattern: RegExp): string[] {
    return this.calls.filter((u) => pattern.test(u));
  }

  private route(url: string): string {
    const u = new URL(url);
    const seq = u.searchParams.get("stats_player_seq");
    const catId = Number(u.searchParams.get("year_stat_category_id"));
    const category = categoryForId(catId);
    const key = `${seq}:${category}`;
    const page = this.options.pages?.[key];
    if (page === undefined) {
      throw new Error(`FakeNcaaApi: unrouted url ${url}`);
    }
    return page;
  }
}

function categoryForId(catId: number): NcaaStatCategory | "unknown" {
  for (const season of NCAA_SEASONS) {
    if (season.battingCategoryId === catId) return "batting";
    if (season.pitchingCategoryId === catId) return "pitching";
    if (season.fieldingCategoryId === catId) return "fielding";
  }
  return "unknown";
}

/** A NcaaClient wired to a FakeNcaaApi with zero politeness delay. */
export function fakeNcaaClient(api: FakeNcaaApi): NcaaClient {
  return new NcaaClient({ fetchImpl: api.fetch, delayMs: 0 });
}

// --- App deps builder (createApp / REST / MCP tests) ------------------------

export const TEST_API_TOKEN = "test-api-token-1234567890";

/**
 * Full createApp dependency bundle over an opened test db. The readonlySqlite
 * handle reuses the writable test connection — the statement guard is what the
 * app-level tests exercise; the genuinely read-only connection is covered by
 * test/readonly.test.ts with a temp-file db.
 */
export function testAppDeps(opened: OpenedDb, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: opened.db,
    readonlySqlite: opened.sqlite,
    client: new MlbClient({ fetchImpl: new FakeStatsApi().fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(new FakeNcaaApi()),
    mailer: new CapturingMailer(),
    now: fakeClock(MID_SEASON).now,
    tz: TEST_TZ,
    apiToken: TEST_API_TOKEN,
    digestTo: "hc@example.com",
    digestFrom: "bryce@example.com",
    ...overrides,
  };
}

// --- Mailer test double -----------------------------------------------------

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** The MailContext handed alongside each captured message (ADR 0034). */
  readonly contexts: Array<MailContext | undefined> = [];
  failWith: Error | null = null;
  providerMessageId: string | null = null;

  send(message: MailMessage, context?: MailContext): Promise<MailReceipt> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.sent.push(message);
    this.contexts.push(context);
    return Promise.resolve({ providerMessageId: this.providerMessageId });
  }
}

/**
 * A Mailer that PARKS every send on a promise released on demand — the explicit
 * barrier the concurrency tests synchronize on. Never a timer: rules/testing.md
 * forbids wall-clock waits, and a sleep would only make the race probable, not
 * deterministic.
 *
 * `attempts` records a message the instant it reaches the "provider";
 * `sent` records it only once the provider acknowledges (release). The gap
 * between them is exactly the crash-after-acceptance window (ADR 0034).
 */
export class GatedMailer implements Mailer {
  readonly attempts: MailMessage[] = [];
  readonly sent: MailMessage[] = [];
  readonly contexts: Array<MailContext | undefined> = [];
  failWith: Error | null = null;
  providerMessageId: string | null = "pm-message-1";

  private parked: Array<() => void> = [];
  private waiters: Array<{ n: number; resolve: () => void }> = [];

  send(message: MailMessage, context?: MailContext): Promise<MailReceipt> {
    this.attempts.push(message);
    return new Promise<MailReceipt>((resolve, reject) => {
      this.parked.push(() => {
        if (this.failWith !== null) {
          reject(this.failWith);
          return;
        }
        this.sent.push(message);
        this.contexts.push(context);
        resolve({ providerMessageId: this.providerMessageId });
      });
      this.settleWaiters();
    });
  }

  /** How many sends are currently parked at the barrier. */
  get inFlight(): number {
    return this.parked.length;
  }

  /** Resolves once at least `n` sends are parked — the barrier, not a sleep. */
  waitForInFlight(n: number): Promise<void> {
    if (this.parked.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ n, resolve });
    });
  }

  /** Release every parked send (rejecting them all when failWith is set). */
  release(): void {
    const toRun = this.parked;
    this.parked = [];
    for (const run of toRun) run();
  }

  private settleWaiters(): void {
    this.waiters = this.waiters.filter((w) => {
      if (this.parked.length >= w.n) {
        w.resolve();
        return false;
      }
      return true;
    });
  }
}

// --- Fault injection over the database (crash-window tests) -----------------

/** Marks a deliberately injected fault so a test never mistakes it for a real bug. */
export class InjectedFault extends Error {
  constructor(where: string) {
    super(`injected fault: ${where}`);
    this.name = "InjectedFault";
  }
}

export interface FaultOptions {
  /**
   * Where the process "dies":
   * - `before-settle` — the settle transaction never starts (death right after
   *   provider acceptance);
   * - `after-delivery-update` — inside the transaction, after the delivery row
   *   was updated and before the Stat Lines are marked;
   * - `after-line-update` — inside the transaction, after both statements ran
   *   but before COMMIT.
   */
  failAt: "before-settle" | "after-delivery-update" | "after-line-update";
  /**
   * Transactions to let through untouched first. Every runDigest invocation
   * opens exactly two: the claim, then the settle — so the default of 1 targets
   * the settle.
   */
  passThrough?: number;
}

type TransactionFn = (fn: (tx: unknown) => unknown, config?: unknown) => unknown;

/**
 * A Proxy over the drizzle Db that injects a crash into the settle transaction,
 * so the tests can assert what SQLite durably left behind — the only honest way
 * to prove "a crash mid-persist rolls the whole settle back".
 */
export function faultingDb(db: Db, options: FaultOptions): Db {
  const passThrough = options.passThrough ?? 1;
  let transactions = 0;

  return new Proxy(db, {
    get(target, prop) {
      // No receiver: a getter must never run with the proxy as `this`.
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "transaction") {
        // Bind to the real target: drizzle's methods must never see the proxy
        // as `this`, or internal state lookups go through this trap.
        return typeof value === "function" ? value.bind(target) : value;
      }
      const realTransaction = (value as TransactionFn).bind(target);
      return (fn: (tx: unknown) => unknown, config?: unknown): unknown => {
        transactions += 1;
        if (transactions <= passThrough) return realTransaction(fn, config);
        if (options.failAt === "before-settle") {
          throw new InjectedFault("process died before the settle transaction");
        }
        return realTransaction((tx: unknown) => {
          const result = fn(faultingTx(tx, options.failAt));
          if (options.failAt === "after-line-update") {
            throw new InjectedFault("process died after marking stat lines, before COMMIT");
          }
          return result;
        }, config);
      };
    },
  }) as Db;
}

/** Counts `update` calls inside the settle txn so a fault can land between them. */
function faultingTx(tx: unknown, failAt: FaultOptions["failAt"]): unknown {
  let updates = 0;
  return new Proxy(tx as object, {
    get(target, prop) {
      // No receiver: a getter must never run with the proxy as `this`.
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "update") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const realUpdate = (value as (...args: unknown[]) => unknown).bind(target);
      return (...args: unknown[]): unknown => {
        updates += 1;
        // Statement 1 updates digest_deliveries, statement 2 marks stat_lines.
        if (failAt === "after-delivery-update" && updates === 2) {
          throw new InjectedFault("process died after the delivery update");
        }
        return realUpdate(...args);
      };
    },
  });
}
