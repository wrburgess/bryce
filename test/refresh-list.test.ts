import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { refreshRuns } from "../src/db/schema.js";
import type { RefreshDeps, RefreshScope } from "../src/jobs/refresh.js";
import { runRefresh, runRefreshForPlayer } from "../src/jobs/refresh.js";
import { claimRefreshRun } from "../src/jobs/refresh-run.js";
import { deleteList } from "../src/lists/service.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendar,
  insertLane,
  insertListMember,
  insertPlayer,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * The lane-scoped Refresh (#192 / ADR 0061). Mirrors `test/digest-list.test.ts`:
 * the hazard is the TWO-SELECTION-SITE leak, so the headline guards assert on an
 * observable that ONLY the second site can move.
 *
 * `runRefresh` selects active Players twice — once for the sweep itself
 * (src/jobs/refresh.ts, before the claim) and once at SETTLE time to recompute
 * `calendarBlocksFresh` against the post-refresh world. Every pre-#192 refresh
 * test inserts unlisted players and expects all of them swept, so a HALF-scoped
 * implementation — site 1 narrowed, site 2 left whole — ships with the entire
 * suite green while an off-lane player quietly downgrades a clean lane run to
 * `partial`. Guard 2a is the one that fails in that world; guard 9 is the one
 * that fails if site 2 stops re-querying and reuses site 1's frozen array.
 * Together they pin BOTH properties: scoped AND re-read.
 *
 * Fetch assertions are on the FAKE CLIENT'S CALLS, never on row counts: the
 * ADR 0029 upsert is idempotent, so a doubled fetch leaves the tables identical.
 */

/** The on-lane MLB (sportId 1) identity, and the Triple-A (sportId 11) one. */
const MLB_PERSON_ID = 691185;
const AAA_PERSON_ID = 660271;

describe("lane-scoped refresh (#192)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;

  /**
   * ONLY the MLB (sportId 1) calendar is cached. Triple-A (sportId 11) has no
   * row, which is what lets a failed sportId-11 `getSeason` block `fresh` for a
   * watched Triple-A player — the observable guards 2a/2b/9 turn on.
   */
  const cacheMlbCalendarOnly = () => insertCalendar(opened.db); // sportId 1

  /** The whole 2026 season published for every sportId the sweep asks about. */
  const seasons = () => ({
    1: makeSeasonBody(),
    11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }),
  });

  const deps = (overrides: Partial<RefreshDeps> = {}): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
    ...overrides,
  });

  /**
   * `FakeStatsApi` serves ONE person for EVERY id, and `refreshPlayer` writes the
   * identity it gets back — so a sweep would rewrite both players to the same
   * level and the settle-time read would see one sport where the guard needs
   * two. This points the fake's single person slot at the right identity just
   * before it answers, which keeps call recording (and every other route) in the
   * fake rather than forking a second one.
   */
  const routeIdentityById = (url: string): void => {
    // The identity fetch is `/people/<id>?…`; the game log is `/people/<id>/stats?…`.
    const identity = /\/people\/(\d+)\?/.exec(url);
    if (identity === null) return;
    api.options.person =
      Number(identity[1]) === MLB_PERSON_ID
        ? makePerson({ id: MLB_PERSON_ID, currentTeam: { id: 146, name: "Miami Marlins" } })
        : makePerson({ id: AAA_PERSON_ID, currentTeam: { id: 564, name: "Jacksonville Jumbo Shrimp" } });
  };

  /**
   * A client that keeps the two players at DIFFERENT levels and whose Triple-A
   * (sportId 11) season fetch throws. sportId 11 has no cached calendar row, so
   * it BLOCKS `fresh` for anyone watched at that level and for nobody else —
   * that asymmetry is the observable the two-site guards read.
   */
  const twoLevelTripleASeasonDown = (): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) => {
        if (/\/seasons\?.*sportId=11/.test(url)) return Promise.reject(new Error("aaa calendar down"));
        routeIdentityById(url);
        return api.fetch(url);
      },
      delayMs: 0,
    });

  const scopeOf = (...lists: { id: number; isDefault: boolean }[]): RefreshScope => ({
    lists: lists as RefreshScope["lists"],
    listIds: lists.map((l) => l.id),
    includesDefaultLane: lists.some((l) => l.isDefault),
  });

  /** Every `getPlayerGameLog`-equivalent fetch issued for one MLB person id. */
  const gameLogCallsFor = (personId: number): string[] =>
    api.callsMatching(new RegExp(`/people/${personId}/stats\\?`));

  /** Every identity fetch issued, as the person ids the sweep actually touched. */
  const peopleFetched = (): number[] =>
    [
      ...new Set(
        api.calls
          .map((url) => /\/people\/(\d+)\?/.exec(url)?.[1])
          .filter((id): id is string => id !== undefined),
      ),
    ]
      .map(Number)
      .sort((a, b) => a - b);

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: seasons(),
      gameLogs: {
        "11:hitting": makeGameLogBody("hitting", [
          makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
        ]),
      },
    });
  });

  afterEach(() => {
    opened.close();
  });

  it("sweeps only the scoped lane's active members", async () => {
    const onLane = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 }); // off-lane, active
    const lane = await insertLane(opened.db, "Prospects", [onLane]);

    const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

    expect(summary.playersRefreshed).toBe(1);
    // The off-lane player's identity was never fetched at all — the assertion is
    // on the CLIENT, because an idempotent upsert would hide a second fetch.
    expect(peopleFetched()).toEqual([691185]);
  });

  // --- The two-selection-site guards -----------------------------------------

  it("2a: an ACTIVE off-lane player at a calendar-failed sport cannot downgrade a lane run", async () => {
    await cacheMlbCalendarOnly();
    // On-lane, MLB (sportId 1) — the sport whose calendar IS cached and fetches fine.
    const onLane = await insertPlayer(opened.db, {
      externalId: MLB_PERSON_ID,
      level: "mlb",
      milbLevel: null,
    });
    // Off-lane, Triple-A (sportId 11), and ACTIVE on purpose. If he were
    // deactivated, `players.active` would exclude him before membership ever ran
    // and this guard would pass for the wrong reason (rules/testing.md).
    await insertPlayer(opened.db, {
      externalId: AAA_PERSON_ID,
      level: "milb",
      milbLevel: "Triple-A",
    });
    const lane = await insertLane(opened.db, "Prospects", [onLane]);

    const summary = await runRefresh(
      deps({ scope: scopeOf(lane), client: twoLevelTripleASeasonDown() }),
    );

    // sportId 11's getSeason threw and has no cached row, but no player IN SCOPE
    // is at sportId 11, so nothing the digest would report is missing.
    expect(summary.calendarFailures.map((f) => f.sportId)).toEqual([11]);
    expect(summary.status).toBe("ok");
  });

  it("2b: the SAME fixture settles `partial` unscoped, so the observable demonstrably moves", async () => {
    await cacheMlbCalendarOnly();
    const onLane = await insertPlayer(opened.db, {
      externalId: MLB_PERSON_ID,
      level: "mlb",
      milbLevel: null,
    });
    await insertPlayer(opened.db, {
      externalId: AAA_PERSON_ID,
      level: "milb",
      milbLevel: "Triple-A",
    });
    await insertLane(opened.db, "Prospects", [onLane]);

    // Identical fixture, NO scope: the Triple-A player is watched, his calendar
    // fetch failed, and no cached row can stand in — so the run must warn.
    const summary = await runRefresh(deps({ client: twoLevelTripleASeasonDown() }));

    expect(summary.playersRefreshed).toBe(2);
    expect(summary.status).toBe("partial");
  });

  it("9: the settle-time read RE-QUERIES, so a mid-sweep addition to an in-scope lane counts", async () => {
    await cacheMlbCalendarOnly();
    const onLane = await insertPlayer(opened.db, {
      externalId: MLB_PERSON_ID,
      level: "mlb",
      milbLevel: null,
    });
    const lane = await insertLane(opened.db, "Prospects", [onLane]);

    // A Triple-A player joins THE SCOPED LANE while the sweep is mid-flight —
    // the call-up/addition case the settle-time re-read exists for. He is added
    // after the player loop has begun, so site 1 never saw him. ONCE: the
    // player's fan-out issues many game-log calls, and re-running the enrollment
    // would trip `list_members_list_player_uq` and be miscounted as a failure.
    let added = false;
    const addingClient = new MlbClient({
      fetchImpl: async (url: string) => {
        if (!added && new RegExp(`/people/${MLB_PERSON_ID}/stats\\?`).test(url)) {
          added = true;
          const late = await insertPlayer(opened.db, {
            externalId: AAA_PERSON_ID,
            level: "milb",
            milbLevel: "Triple-A",
          });
          await insertListMember(opened.db, { listId: lane.id, playerId: late.id });
        }
        if (/\/seasons\?.*sportId=11/.test(url)) throw new Error("aaa calendar down");
        routeIdentityById(url);
        return api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh(deps({ scope: scopeOf(lane), client: addingClient }));

    // He was NOT swept (he joined after selection site 1), but the settle-time
    // re-read sees him, so sportId 11's failed calendar now blocks `fresh`.
    // Impossible if site 2 reused site 1's frozen array.
    expect(summary.playersRefreshed).toBe(1);
    expect(summary.status).toBe("partial");
  });

  // --- The gate ordering and the union ---------------------------------------

  it("never fetches a DEACTIVATED member: players.active stays the master gate above membership", async () => {
    const active = await insertPlayer(opened.db, { externalId: 691185 });
    const gone = await insertPlayer(opened.db, { externalId: 660271, active: false });
    const lane = await insertLane(opened.db, "Prospects", [active, gone]);

    const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

    expect(summary.playersRefreshed).toBe(1);
    expect(peopleFetched()).toEqual([691185]);
  });

  it("fetches a player on TWO in-scope lanes exactly once (the EXISTS dedupes)", async () => {
    const shared = await insertPlayer(opened.db, { externalId: 691185 });
    const a = await insertLane(opened.db, "Prospects", [shared]);
    const b = await insertLane(opened.db, "Top 30", [shared]);

    const summary = await runRefresh(deps({ scope: scopeOf(a, b) }));

    expect(summary.playersRefreshed).toBe(1);
    // ONE identity fetch and ONE game-log fan-out, not two of each.
    expect(peopleFetched()).toEqual([691185]);
    expect(gameLogCallsFor(691185).length).toBe(new Set(gameLogCallsFor(691185)).size);
  });

  // --- Degenerate scopes ------------------------------------------------------

  it("an EMPTY lane sweeps rather than sleeps, settling `ok` with playersTotal 0", async () => {
    await cacheMlbCalendarOnly();
    // An active player exists; he is simply not in the lane.
    await insertPlayer(opened.db, { externalId: 691185 });
    const lane = await insertLane(opened.db, "Empty", []);

    const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

    // `sleepWindow` returns awake for zero watched players, so this is a REAL
    // run: nothing failed, nothing was passed over, nothing blocks — `ok`.
    expect(summary.skipped).toBe(false);
    expect(summary.status).toBe("ok");
    const run = (await opened.db.select().from(refreshRuns))[0];
    expect(run?.playersTotal).toBe(0);
    expect(peopleFetched()).toEqual([]);
  });

  it("an empty listIds set selects nobody (zero due lanes, reachable in #193)", async () => {
    await cacheMlbCalendarOnly();
    await insertPlayer(opened.db, { externalId: 691185 });

    const summary = await runRefresh(
      deps({ scope: { lists: [], listIds: [], includesDefaultLane: false } }),
    );

    expect(summary.playersRefreshed).toBe(0);
    expect(peopleFetched()).toEqual([]);
  });

  it("UNSCOPED runRefresh is unchanged: every active player is swept, membership ignored", async () => {
    const listed = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 }); // in no list at all
    await insertLane(opened.db, "Prospects", [listed]);

    const summary = await runRefresh(deps());

    // The contract MCP, REST, and ~60 existing refresh tests rely on.
    expect(summary.playersRefreshed).toBe(2);
    expect(peopleFetched()).toEqual([660271, 691185]);
    const run = (await opened.db.select().from(refreshRuns))[0];
    expect(run?.scopeListIds).toBeNull();
  });

  it("runRefreshForPlayer ignores a scope entirely — its whole-list read is on purpose", async () => {
    // The seed-time backfill targets ONE Player by id and records no freshness
    // run; its list read exists only to answer "is the pipeline asleep?", which
    // is a host-wide question. A Player in NO lane must still get his first
    // Refresh even when the caller happens to carry a scope, so this pins the
    // comment in src/jobs/refresh.ts rather than leaving it untested prose.
    const unlisted = await insertPlayer(opened.db, { externalId: 691185 });
    const otherLane = await insertLane(opened.db, "Prospects", []);

    const result = await runRefreshForPlayer(
      deps({ scope: scopeOf(otherLane) }),
      unlisted.id,
    );

    expect(result).toMatchObject({ skipped: false, reason: null });
    expect(peopleFetched()).toEqual([691185]);
  });

  // --- Concurrency and lane lifetime -----------------------------------------

  it("a lane sweep behind a LIVE lease skips `already-running` and records no run of its own", async () => {
    const onLane = await insertPlayer(opened.db, { externalId: 691185 });
    const lane = await insertLane(opened.db, "Prospects", [onLane]);
    const held = claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 });
    expect(held.claimed).toBe(true);

    const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

    // A whole-sweep claim refusal is `already-running` — the SAME vocabulary a
    // whole-list sweep gets, because it is the same claim. `whole-refresh-running`
    // belongs to the targeted single-player fence and is not widened here.
    expect(summary).toMatchObject({ skipped: true, reason: "already-running", status: null });
    expect((await opened.db.select().from(refreshRuns)).length).toBe(1);
    expect(peopleFetched()).toEqual([]);
  });

  it("a lane SOFT-DELETED mid-sweep still completes over the captured membership", async () => {
    await cacheMlbCalendarOnly();
    const onLane = await insertPlayer(opened.db, { externalId: 691185 });
    const lane = await insertLane(opened.db, "Doomed", [onLane]);

    // Deleted after the claim, before the settle-time re-read. `deleted_at` lives
    // on player_lists and leaves list_members untouched, so BOTH scoped reads keep
    // matching and agree — the sweep proceeds against the captured id rather than
    // aborting or, worse, having its two reads disagree (ADR 0061 decision 10).
    // ONCE: the fan-out issues many game-log calls, and a second `deleteList`
    // would raise UnknownListError and be collected as a player failure —
    // turning a soft-delete guard into an accidental error-path test.
    let deleted = false;
    const deletingClient = new MlbClient({
      fetchImpl: async (url: string) => {
        if (!deleted && /\/people\/691185\/stats\?/.test(url)) {
          deleted = true;
          await deleteList(opened.db, "Doomed", clock.now());
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh(deps({ scope: scopeOf(lane), client: deletingClient }));

    expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 1 });
  });
});
