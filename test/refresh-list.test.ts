import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import { players, refreshRuns } from "../src/db/schema.js";
import type { RefreshDeps, RefreshScope } from "../src/jobs/refresh.js";
import { runRefresh, runRefreshForPlayer } from "../src/jobs/refresh.js";
import { claimRefreshRun, digestFreshnessFor } from "../src/jobs/refresh-run.js";
import { deleteList } from "../src/lists/service.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  enrollInDefaultLane,
  fakeClock,
  insertCalendar,
  insertCalendars2026,
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

/**
 * A db that runs `enroll()` the moment the FIRST read against `players`
 * COMPLETES — after its rows are in hand and before the caller resumes to issue
 * anything else. That instant IS the race window ADR 0061 decision 8 has to be
 * atomic across: everything `runRefresh` learns about who is active and who is
 * covered must come from the snapshot taken before it.
 *
 * The hook is on completion, not on issue, and that distinction is the whole
 * fixture: firing BEFORE the read would simply let selection see the new member
 * and sweep him, which is not a defect at all.
 *
 * `then` is what `await` calls, so intercepting it is how a completion is
 * observed without re-implementing drizzle's execution. The chainable methods
 * are re-wrapped because `.where()` returns `this` — handing back the unwrapped
 * builder would drop the hook before anything was ever awaited.
 */
function enrollWhenPlayersFirstRead(db: Db, enroll: () => void): Db {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    enroll();
  };
  const hooked = (builder: object): object =>
    new Proxy(builder, {
      get(b, p) {
        const bv: unknown = Reflect.get(b, p);
        if (p === "then") {
          return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown): unknown =>
            (async () => {
              // `b` is the RAW builder, so this awaits drizzle's own `then`
              // rather than recursing back through this proxy.
              const rows: unknown = await (b as PromiseLike<unknown>);
              fire();
              return rows;
            })().then(onOk, onErr);
        }
        if (typeof bv !== "function") return bv;
        return (...args: unknown[]): unknown => {
          const result: unknown = (bv as (...a: unknown[]) => unknown).apply(b, args);
          return result === b ? hooked(b) : result;
        };
      },
    });

  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
      return (...selectArgs: unknown[]): unknown => {
        const builder = (value as (...a: unknown[]) => unknown).apply(target, selectArgs);
        return new Proxy(builder as object, {
          get(b, p) {
            const bv: unknown = Reflect.get(b, p);
            if (p === "from") {
              return (table: unknown): unknown => {
                const next: unknown = (bv as (t: unknown) => unknown).call(b, table);
                // Only reads OF `players` matter. The correlated `EXISTS`
                // subquery reads `list_members` and is never awaited on its own.
                return table === players ? hooked(next as object) : next;
              };
            }
            return typeof bv === "function" ? bv.bind(b) : bv;
          },
        });
      };
    },
  }) as Db;
}

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

  const scopeOf = (...lists: { id: number }[]): RefreshScope => ({
    lists: lists as RefreshScope["lists"],
    listIds: lists.map((l) => l.id),
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
      deps({ scope: { lists: [], listIds: [] } }),
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
    // is a host-wide question (ADR 0031, ADR 0061 decision 3). A Player in NO
    // lane must still get his first Refresh even when the caller happens to
    // carry a scope.
    //
    // THE FIXTURE IS THE GUARD, and the first version of this test had none. It
    // scoped an EMPTY lane, and `sleepWindow` short-circuits to `{sleeping:
    // false}` on zero watched sportIds (src/domain/season.ts) — so the scoped
    // and unscoped reads returned the SAME verdict and scoping the read under
    // test left every assertion passing. A guard whose two worlds agree pins
    // nothing (`rules/testing.md` #36). This fixture makes them DISAGREE:
    //
    //   - the lane holds a Triple-A player whose sportId-11 season opens
    //     2026-09-01, AFTER the clock's 2026-07-19 — a scoped read sees only
    //     sportId 11, `today < awakeStart`, and SLEEPS;
    //   - the target is an MLB player on NO lane, in season — the correct
    //     unscoped read sees sportIds {1, 11}, `awakeStart` is MLB's March
    //     opening, and it is AWAKE.
    //
    // So a wrongly-scoped read returns `skipped: "offseason-sleep"` and fetches
    // nothing. Verified by mutating the read to `loadActivePlayers(db,
    // deps.scope?.listIds)` and watching this test go red.
    await insertCalendar(opened.db); // sportId 1: opens 2026-03-25, in season
    await insertCalendar(opened.db, {
      sportId: 11,
      regularSeasonStart: "2026-09-01",
      regularSeasonEnd: "2026-09-20",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    const onLane = await insertPlayer(opened.db, {
      externalId: AAA_PERSON_ID,
      level: "milb",
      milbLevel: "Triple-A",
    });
    const offSeasonLane = await insertLane(opened.db, "Prospects", [onLane]);
    const unlisted = await insertPlayer(opened.db, {
      externalId: MLB_PERSON_ID,
      level: "mlb",
      milbLevel: null,
    });

    const result = await runRefreshForPlayer(deps({ scope: scopeOf(offSeasonLane) }), unlisted.id);

    expect(result).toMatchObject({ skipped: false, reason: null });
    expect(peopleFetched()).toEqual([MLB_PERSON_ID]);
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

  // --- The COVERAGE-keyed freshness watermark (ADR 0061 decision 8) -----------
  //
  // These live here, not in test/refresh-run.test.ts beside the rest of the
  // freshness cases, because the decision under test is `runRefresh`'s — its
  // claim-time selection read tags each active Player with his own coverage and
  // writes `NULL` when none came back uncovered (PR #201 Reviewer P1: ONE read,
  // so selection and coverage cannot disagree). A `claimRefreshRun` fixture
  // would hand-write the very value
  // the code is supposed to derive, which is the one thing these cases must not
  // do. The pure encode/eligibility cases stay in refresh-run.test.ts.
  //
  // WHAT WENT WRONG THE FIRST TIME. The gate shipped keyed on "does this run's
  // scope contain the DEFAULT LANE?" — a proxy for the question the digest asks,
  // which is "did this run sweep every player I am about to report on?". The
  // proxy holds only while the default lane holds everyone, and `players lists
  // create` + `set-default` breaks it in two commands: the first case below is
  // that exact sequence, and it read `fresh` off a sweep of zero players.
  describe("coverage-keyed freshness watermark (#192)", () => {
    /** The digest's content day; the clock's host date (2026-07-19) is strictly after it. */
    const CONTENT_DATE = "2026-07-18";

    /** The recorded scope of the one run this suite's sweeps produce. */
    const recordedScope = async (): Promise<string | null> => {
      const rows = await opened.db.select().from(refreshRuns);
      expect(rows).toHaveLength(1);
      return rows[0]?.scopeListIds ?? null;
    };

    beforeEach(async () => {
      // Both watched sports published, so nothing a calendar does can downgrade
      // these runs and every one of them settles a clean `ok`.
      await insertCalendars2026(opened.db);
    });

    it("an EMPTY default lane with players elsewhere settles `ok` and the digest reads STALE", async () => {
      // THE #192 STAGE-4 REGRESSION CASE, reachable through supported commands:
      // `players lists create --name New`, `players lists set-default --name
      // New`, `refresh`. The sweep touches zero players and legitimately settles
      // `ok` (nothing failed, nothing was passed over), and under the old
      // default-lane proxy that `ok` certified the WHOLE Watch List as `fresh`.
      const stranded = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      const emptyDefault = await enrollInDefaultLane(opened.db, []);
      expect(stranded.active).toBe(true);

      const summary = await runRefresh(deps({ scope: scopeOf(emptyDefault) }));

      // The run is honest about itself...
      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 0 });
      // ...and honest about what it covered: one active player was left out, so
      // the row records the lane rather than the whole-list `NULL`.
      expect(await recordedScope()).toBe(`,${emptyDefault.id},`);
      // ...so the banner over a whole-Watch-List digest reads `stale`, which is
      // TRUE. This is the assertion the shipped predicate failed.
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
    });

    it("a default lane missing EXACTLY ONE active player reads STALE", async () => {
      // One player short is the boundary: the predicate is coverage, so it must
      // fail on the smallest possible gap, not only on an empty lane.
      const covered = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      await insertPlayer(opened.db, { externalId: AAA_PERSON_ID }); // on no lane
      const lane = await enrollInDefaultLane(opened.db, [covered]);

      const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 1 });
      expect(await recordedScope()).toBe(`,${lane.id},`);
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
    });

    it("a default lane containing EVERY active player reads FRESH, recorded as NULL", async () => {
      const one = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      const two = await insertPlayer(opened.db, { externalId: AAA_PERSON_ID });
      const lane = await enrollInDefaultLane(opened.db, [one, two]);

      const summary = await runRefresh(deps({ scope: scopeOf(lane) }));

      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 2 });
      // `NULL` is not a fudge here — it is the column's documented meaning, and
      // this run genuinely did sweep the whole Watch List.
      expect(await recordedScope()).toBeNull();
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
    });

    it("a NON-DEFAULT lane containing every active player also reads FRESH", async () => {
      // The predicate is COVERAGE, NOT IDENTITY. This run swept everyone, so it
      // certifies everyone — even though the default lane is empty and its id
      // appears nowhere. Under the old proxy this was `stale`, which was a
      // pessimistic lie in the same way the case above was an optimistic one.
      const one = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      const two = await insertPlayer(opened.db, { externalId: AAA_PERSON_ID });
      const named = await insertLane(opened.db, "Everyone", [one, two]);
      const defaultLane = await enrollInDefaultLane(opened.db, []);
      expect(named.id).not.toBe(defaultLane.id);

      const summary = await runRefresh(deps({ scope: scopeOf(named) }));

      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 2 });
      expect(await recordedScope()).toBeNull();
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
    });

    it("an UNSCOPED run reads FRESH — MCP, REST, and every pre-#192 caller unchanged", async () => {
      await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      await insertPlayer(opened.db, { externalId: AAA_PERSON_ID });

      const summary = await runRefresh(deps());

      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 2 });
      expect(await recordedScope()).toBeNull();
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
    });

    it("a DEACTIVATED player off the lane does not block coverage", async () => {
      // `players.active` is the master gate above membership (decision 1), so
      // the coverage count has to apply it too — otherwise every host that has
      // ever deactivated a player would be permanently `stale`.
      const covered = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      await insertPlayer(opened.db, { externalId: AAA_PERSON_ID, active: false });
      const lane = await enrollInDefaultLane(opened.db, [covered]);

      await runRefresh(deps({ scope: scopeOf(lane) }));

      expect(await recordedScope()).toBeNull();
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("fresh");
    });

    it("selection and coverage come from ONE snapshot: an enrollment racing the claim cannot forge FRESH", async () => {
      // PR #201 Reviewer P1. Coverage used to be a SECOND read taken after
      // selection had already returned, and two reads take two snapshots that
      // disagree in the FAIL-OPEN direction. This models the disagreement with
      // the write that causes it: an ALREADY-ACTIVE, off-lane player is enrolled
      // into the in-scope lane inside the window between them.
      const covered = await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });
      const racer = await insertPlayer(opened.db, { externalId: AAA_PERSON_ID }); // active, off-lane
      const lane = await enrollInDefaultLane(opened.db, [covered]);

      let enrolled = false;
      const racingDb = enrollWhenPlayersFirstRead(opened.db, () => {
        // Raw SQL on the same connection, SYNCHRONOUS, so the whole write lands
        // inside the window rather than interleaving with the caller's next read.
        opened.sqlite
          .prepare("INSERT INTO list_members (list_id, player_id, created_at) VALUES (?, ?, ?)")
          .run(lane.id, racer.id, clock.now().toISOString());
        enrolled = true;
      });

      const summary = await runRefresh(deps({ db: racingDb, scope: scopeOf(lane) }));

      // The injection has to have happened, or every assertion below passes for
      // the wrong reason (rules/testing.md: a guard nobody broke pins nothing).
      expect(enrolled).toBe(true);
      // He was NOT swept — selection had already returned without him — and the
      // assertion is on the CLIENT, because the ADR 0029 upsert is idempotent.
      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 1 });
      expect(peopleFetched()).toEqual([MLB_PERSON_ID]);
      // ...so this run must NOT claim it covered everyone. Under the two-read
      // shape the coverage query saw the enrollment the sweep itself missed,
      // recorded the whole-list `NULL`, and the banner forged `fresh` over a
      // player nobody fetched.
      expect(await recordedScope()).toBe(`,${lane.id},`);
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
    });

    it("a ZERO-LANE scope on a host with active players records its (empty) scope and reads STALE", async () => {
      // #193's due-lane driver ticks with an empty due set. Zero lanes cover
      // nobody, so on a host with anybody active this must never collapse to the
      // whole-list `NULL` through a vacuously-true coverage test.
      await insertPlayer(opened.db, { externalId: MLB_PERSON_ID });

      const summary = await runRefresh(deps({ scope: { lists: [], listIds: [] } }));

      expect(summary).toMatchObject({ skipped: false, status: "ok", playersRefreshed: 0 });
      expect(await recordedScope()).toBe(",,");
      expect(digestFreshnessFor(opened.db, CONTENT_DATE, TEST_TZ).state).toBe("stale");
    });
  });
});
