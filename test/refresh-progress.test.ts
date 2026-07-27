import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import { playerTags, refreshRuns } from "../src/db/schema.js";
import type { RefreshDeps, RefreshSummary } from "../src/jobs/refresh.js";
import { runRefresh, runRefreshForPlayer } from "../src/jobs/refresh.js";
import type { RefreshProgressEvent } from "../src/jobs/refresh-progress.js";
import type * as RefreshRunModuleNs from "../src/jobs/refresh-run.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertRefreshRun,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * The Refresh **Liveness** stream (issue #146, ADR 0056).
 *
 * Every case here drives `runRefresh` through a RECORDING SINK — no global
 * stdout/stderr capture — and asserts the event stream itself, because the
 * stream is the contract the CLI presenter is written against. Rendering is
 * `test/cli-refresh.test.ts`'s job; nothing here asserts a rendered line.
 *
 * The sharpest property under test is the ORDERING INVARIANT: `player-settled`
 * is emitted only AFTER that player's progress write has committed, so the
 * console can never show N+1 settled while `/health` shows N.
 */

// A controllable stand-in for the ONE function whose false return the ordering
// invariant hinges on. Everything else in the module passes straight through, so
// the sweep under test is the real one.
type RefreshRunModule = typeof RefreshRunModuleNs;
const progressControl = { failAtCall: null as number | null, calls: 0 };
vi.mock("../src/jobs/refresh-run.js", async (importOriginal) => {
  const actual = await importOriginal<RefreshRunModule>();
  return {
    ...actual,
    updateRefreshRunProgress: (
      ...args: Parameters<RefreshRunModule["updateRefreshRunProgress"]>
    ): boolean => {
      progressControl.calls += 1;
      if (progressControl.failAtCall === progressControl.calls) return false;
      return actual.updateRefreshRunProgress(...args);
    },
  };
});

// Imported AFTER the mock declaration for clarity; vi.mock is hoisted anyway.
const { claimRefreshRun, refreshHealth } = await import("../src/jobs/refresh-run.js");

/** A player-shaped identity that costs zero HTTP and is always Passed Over mid-summer. */
const passedOverNcaa = (seq: number, name: string) => ({
  externalId: null,
  ncaaPlayerSeq: seq,
  ncaaSourceState: "legacy_html" as const,
  level: "ncaa" as const,
  milbLevel: null,
  fullName: name,
  schoolName: "State",
});

/** A db proxy that makes every `player_tags` write throw — and ONLY those. */
function tagWritesThrow(db: Db, err: Error): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
      const realTransaction = (
        value as (fn: (tx: unknown) => unknown, config?: unknown) => unknown
      ).bind(target);
      return (fn: (tx: unknown) => unknown, config?: unknown): unknown =>
        realTransaction((tx: unknown) => {
          const txProxy = new Proxy(tx as object, {
            get(t, p) {
              const v: unknown = Reflect.get(t, p);
              if (p === "insert" || p === "delete") {
                return (table: unknown) => {
                  if (table === playerTags) throw err;
                  return (v as (arg: unknown) => unknown).call(t, table);
                };
              }
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
          return fn(txProxy);
        }, config);
    },
  }) as Db;
}

describe("runRefresh liveness event stream (#146, ADR 0056)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;
  let events: RefreshProgressEvent[];
  let legacyLines: string[];

  const sink = (event: RefreshProgressEvent): void => { events.push(event); };

  const deps = (overrides: Partial<RefreshDeps> = {}): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
    onProgress: sink,
    writeLegacyNotice: (line) => legacyLines.push(line),
    ...overrides,
  });

  const kinds = (): string[] => events.map((e) => e.kind);
  const of = <K extends RefreshProgressEvent["kind"]>(
    kind: K,
  ): Extract<RefreshProgressEvent, { kind: K }>[] =>
    events.filter((e): e is Extract<RefreshProgressEvent, { kind: K }> => e.kind === kind);

  beforeEach(() => {
    progressControl.failAtCall = null;
    progressControl.calls = 0;
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
    events = [];
    legacyLines = [];
  });

  afterEach(() => {
    opened.close();
  });

  it("opens with sweep-started carrying the denominator, before any player event", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });

    const summary = await runRefresh(deps());

    expect(events[0]).toEqual({
      kind: "sweep-started", runId: summary.runId, playersTotal: 2, season: "2026",
    });
    // Nothing about a player may precede the announcement of how many there are:
    // a presenter renders `index/total` from the first player on.
    const firstPlayerEvent = events.findIndex((e) => e.kind.startsWith("player-"));
    expect(firstPlayerEvent).toBeGreaterThan(0);
    expect(of("player-started").map((e) => e.player.index)).toEqual([1, 2]);
    expect(of("player-started").every((e) => e.player.total === 2)).toBe(true);
    // The phases bracket the work an operator would otherwise read as a hang.
    expect(of("phase-started").map((e) => e.phase)).toEqual(["calendars", "ncaa-calendar", "players"]);
    expect(of("phase-finished").map((e) => e.phase)).toEqual(["calendars", "ncaa-calendar", "players"]);
    expect(kinds().at(-1)).toBe("sweep-finished");
  });

  it("times every job-owned external call, in both directions", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await runRefresh(deps());

    // Each started call has its matching finished call...
    expect(of("call-started")).toHaveLength(of("call-finished").length);
    const finished = of("call-finished");
    // ...covering the complete job-owned set reachable on this fixture.
    expect(new Set(finished.map((e) => e.call))).toEqual(
      new Set(["getSeason", "getPerson", "getTeam", "getGameLog"]),
    );
    // The calendar phase runs before the loop, so its calls belong to NO player;
    // every per-player call carries its player explicitly.
    expect(finished.filter((e) => e.call === "getSeason").every((e) => e.player === null)).toBe(true);
    expect(finished.filter((e) => e.call === "getGameLog").every((e) => e.player?.playerId !== undefined)).toBe(true);
    expect(finished.every((e) => e.outcome === "ok" && Number.isInteger(e.elapsedMs))).toBe(true);
  });

  it("reports a failing call as call-finished outcome=error with its reason, not as silence", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const client = new MlbClient({
      fetchImpl: (url: string) =>
        url.includes("/people/691185?") ? Promise.reject(new Error("upstream down")) : api.fetch(url),
      delayMs: 0,
    });
    await runRefresh(deps({ client }));

    const failed = of("call-finished").filter((e) => e.outcome === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ call: "getPerson", personId: 691185, reason: "upstream down" });
  });

  // The distill's first reworded criterion. Against today's behavior this is the
  // case that shows nothing at all: `playersRefreshed` sits at 0 for the whole
  // sweep, so a counter derived from Accounting never moves — yet the operator
  // must still see each Passed-Over Player go by.
  it("still advances player-by-player when EVERY player is passed over", async () => {
    await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One"));
    await insertPlayer(opened.db, passedOverNcaa(700006, "Legacy Two"));

    const summary = await runRefresh(deps());
    expect(summary.playersRefreshed).toBe(0);
    expect(summary.playersSkipped).toBe(2);

    const settled = of("player-settled");
    expect(settled).toHaveLength(2);
    expect(settled.map((e) => e.outcome)).toEqual(["passed-over", "passed-over"]);
    expect(settled.map((e) => e.player.index)).toEqual([1, 2]);
    // The running tally that a console counter reads ADVANCES...
    expect(settled.map((e) => e.counts.passedOver)).toEqual([1, 2]);
    // ...while the refreshed count — the only thing #95 exposed — never does.
    expect(settled.map((e) => e.counts.refreshed)).toEqual([0, 0]);
    // A Passed-Over Player carries no write counts to misreport.
    expect(settled.every((e) => e.inserted === undefined && e.updated === undefined)).toBe(true);
  });

  it("classifies a failed player without inventing inserted/updated counts", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    const client = new MlbClient({
      fetchImpl: (url: string) =>
        url.includes("/people/660271?") ? Promise.reject(new Error("b down")) : api.fetch(url),
      delayMs: 0,
    });

    await runRefresh(deps({ client }));
    const settled = of("player-settled");
    expect(settled.map((e) => e.outcome)).toEqual(["refreshed", "failed"]);
    expect(settled[0]).toMatchObject({ inserted: 1, updated: 0 });
    // refreshOnePlayer buffers all HTTP before its single atomic write, so a
    // throw leaves NO partial write — reporting 0 would read as "wrote nothing"
    // rather than "never got that far".
    expect(settled[1]?.inserted).toBeUndefined();
    expect(settled[1]?.updated).toBeUndefined();
    expect(settled[1]?.reason).toBe("b down");
    expect(settled[1]?.counts).toEqual({ refreshed: 1, passedOver: 0, failed: 1 });
  });

  // THE ORDERING INVARIANT (ADR 0056 s2). Without it the console could print a
  // player as done that the database never recorded, and #146's "console counts
  // and /health counts agree" would be clerical rather than structural.
  it("never emits player-settled when that player's progress write did not commit", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    await insertPlayer(opened.db, { externalId: 592450 });
    progressControl.failAtCall = 3; // the THIRD player's progress write loses ownership

    const summary = await runRefresh(deps());
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });

    // Player 3 started and then the sweep gave up — no settled event for him.
    expect(of("player-started").map((e) => e.player.index)).toEqual([1, 2, 3]);
    expect(of("player-settled").map((e) => e.player.index)).toEqual([1, 2]);
    // The stream's last word on a player is that player 3 STARTED, and the last
    // event of all is the abort — so an operator sees exactly "3 was in flight
    // when we lost the lease", never "3 finished".
    expect(kinds().filter((k) => k.startsWith("player-")).at(-1)).toBe("player-started");
    expect(kinds().at(-1)).toBe("sweep-superseded");
    expect(of("sweep-superseded")[0]?.at).toBe("progress");
    // ...and no sweep-finished, because nothing settled a terminal status.
    expect(kinds()).not.toContain("sweep-finished");

    // The persisted row agrees: 2 players, exactly what the stream showed settled.
    const row = opened.db.select().from(refreshRuns).all()[0];
    expect(row?.playersRefreshed).toBe(2);
  });

  it("names WHERE a sweep lost its lease: the renew fence", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    // Reap from inside the sink, the instant player 1 has settled: the loop then
    // reaches player 2's top-of-loop renew and must abort there.
    let reaped = false;
    const reapingSink = (event: RefreshProgressEvent): void => {
      events.push(event);
      if (event.kind === "player-settled" && !reaped) {
        reaped = true;
        claimRefreshRun(opened.db, { now: new Date("2026-07-19T17:11:00.000Z"), playersTotal: 2 });
      }
    };

    const summary = await runRefresh(deps({ onProgress: reapingSink }));
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });
    expect(of("sweep-superseded")[0]?.at).toBe("renew");
    expect(of("player-started").map((e) => e.player.index)).toEqual([1]);
    expect(kinds()).not.toContain("sweep-finished");
  });

  it("names WHERE a sweep lost its lease: the per-player write fence", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    let reaped = false;
    const client = new MlbClient({
      fetchImpl: (url: string) => {
        if (!reaped && url.includes("/people/691185?")) {
          reaped = true;
          claimRefreshRun(opened.db, { now: new Date("2026-07-19T17:11:00.000Z"), playersTotal: 1 });
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh(deps({ client }));
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });
    expect(of("sweep-superseded")[0]?.at).toBe("player-fence");
    // A superseded abort is NOT a player failure, so no settled event forges one.
    expect(of("player-settled")).toEqual([]);
    expect(summary.playerFailures).toEqual([]);
  });

  it("names WHERE a sweep lost its lease: the calendar-phase fence", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    let reaped = false;
    const client = new MlbClient({
      fetchImpl: (url: string) => {
        if (!reaped && url.includes("/seasons")) {
          reaped = true;
          claimRefreshRun(opened.db, { now: new Date("2026-07-19T17:11:00.000Z"), playersTotal: 1 });
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    const summary = await runRefresh(deps({ client }));
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });
    expect(of("sweep-superseded")[0]?.at).toBe("calendar-fence");
    expect(of("player-started")).toEqual([]);
  });

  it("names WHERE a sweep lost its lease: the terminal settle", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    // Reap once the player loop is over — the one window the per-iteration renew
    // cannot cover, where the settle itself owns nothing.
    const reapingSink = (event: RefreshProgressEvent): void => {
      events.push(event);
      if (event.kind === "phase-finished" && event.phase === "players") {
        claimRefreshRun(opened.db, { now: new Date("2026-07-19T17:11:00.000Z"), playersTotal: 1 });
      }
    };

    const summary = await runRefresh(deps({ onProgress: reapingSink }));
    expect(summary).toMatchObject({ skipped: true, reason: "superseded" });
    expect(of("sweep-superseded")[0]?.at).toBe("settle");
    // The player DID settle (his write committed) — only the run did not.
    expect(of("player-settled")).toHaveLength(1);
    expect(kinds()).not.toContain("sweep-finished");
  });

  it("announces a Skipped Sweep — offseason sleep and a concurrent live lease", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    await runRefresh(deps());
    expect(events).toEqual([{ kind: "sweep-skipped", reason: "offseason-sleep" }]);

    events = [];
    clock.set(MID_SEASON);
    await insertRefreshRun(opened.db, {
      status: "running", startedAt: MID_SEASON, claimedAt: MID_SEASON, finishedAt: null,
    });
    await runRefresh(deps());
    expect(events).toEqual([{ kind: "sweep-skipped", reason: "already-running" }]);
  });

  it("emits sweep-started then sweep-finished for an empty watch list, with no player events", async () => {
    const summary = await runRefresh(deps());
    expect(summary.status).toBe("ok");
    expect(of("sweep-started")[0]?.playersTotal).toBe(0);
    expect(kinds().filter((k) => k.startsWith("player-"))).toEqual([]);
    expect(of("sweep-finished")[0]).toMatchObject({
      status: "ok", playersRefreshed: 0, playersSkipped: 0, playersFailed: 0, playersTotal: 0,
    });
  });

  it("closes with sweep-finished carrying the same field set the terminal line prints", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One"));
    const summary = await runRefresh(deps());
    expect(of("sweep-finished")[0]).toEqual({
      kind: "sweep-finished",
      status: summary.status,
      playersRefreshed: summary.playersRefreshed,
      playersSkipped: summary.playersSkipped,
      playersFailed: summary.playersFailed,
      playersTotal: 2,
      statLinesInserted: summary.statLinesInserted,
      statLinesUpdated: summary.statLinesUpdated,
    });
  });
});

describe("a presenter fault is never a sweep fault (ADR 0056 s7)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (onProgress: RefreshDeps["onProgress"]): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
    onProgress,
  });

  beforeEach(() => {
    progressControl.failAtCall = null;
    progressControl.calls = 0;
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
  });

  afterEach(() => {
    opened.close();
  });

  it("a THROWING sink leaves the run clean — never a fabricated player failure", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    // Without safeEmit this throw lands in runRefresh's per-player catch and is
    // recorded as a player failure: a `failed` run and a wrong exit code, caused
    // entirely by a formatting bug.
    const summary = await runRefresh(deps((event) => {
      if (event.kind === "player-settled") throw new Error("presenter blew up");
    }));

    expect(summary.status).toBe("ok");
    expect(summary.playerFailures).toEqual([]);
    expect(summary.playersFailed).toBe(0);
    expect(summary.playersRefreshed).toBe(1);
  });

  it("a sink returning a REJECTED promise neither fails the sweep nor raises an unhandled rejection", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const summary = await runRefresh(deps(
        // A `=> void` sink CAN return a thenable at runtime — this is JavaScript.
        // Discarding it silently would make it an unhandled rejection, which under
        // Node's default `--unhandled-rejections=throw` kills a healthy sweep.
        ((): unknown => Promise.reject(new Error("async presenter blew up"))) as RefreshDeps["onProgress"],
      ));
      expect(summary.status).toBe("ok");
      expect(summary.playerFailures).toEqual([]);
      // Rejections are reported after the microtask queue drains, so give the
      // process a real turn before concluding none fired.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("attaching a sink changes nothing about the sweep (ADR 0056 s1)", () => {
  beforeEach(() => {
    progressControl.failAtCall = null;
    progressControl.calls = 0;
  });

  const runOnFreshDb = async (onProgress?: RefreshDeps["onProgress"]): Promise<RefreshSummary> => {
    const opened = testDb();
    try {
      const api = new FakeStatsApi({
        person: makePerson(),
        teams: { 564: makeTeam(), 146: makeMlbTeam() },
        seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
        gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
      });
      await insertPlayer(opened.db, { externalId: 691185 });
      await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One"));
      return await runRefresh({
        db: opened.db,
        client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
        onProgress,
      });
    } finally {
      opened.close();
    }
  };

  it("produces a field-for-field identical RefreshSummary with and without a sink", async () => {
    const withoutSink = await runOnFreshDb(undefined);
    const recorded: RefreshProgressEvent[] = [];
    const withSink = await runOnFreshDb((event) => { recorded.push(event); });

    expect(withSink).toEqual(withoutSink);
    // Guard against the vacuous version of this assertion: if the sink were
    // never called, "identical" would prove nothing at all.
    expect(recorded.length).toBeGreaterThan(0);
  });
});

describe("the three legacy notices (ADR 0056 s5)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;
  let events: RefreshProgressEvent[];
  let legacyLines: string[];

  const baseDeps = (overrides: Partial<RefreshDeps> = {}): RefreshDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
    writeLegacyNotice: (line) => legacyLines.push(line),
    ...overrides,
  });

  beforeEach(() => {
    progressControl.failAtCall = null;
    progressControl.calls = 0;
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
    events = [];
    legacyLines = [];
  });

  afterEach(() => {
    opened.close();
  });

  const failingSeasons = (): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) =>
        url.includes("/seasons") ? Promise.reject(new Error("cal down")) : api.fetch(url),
      delayMs: 0,
    });

  it("WITH a sink: each notice becomes a typed event and NOTHING is written to a stream", async () => {
    // 1. No bundled NCAA season for the year.
    clock.set("2027-07-19T17:00:00Z");
    await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One"));
    await runRefresh(baseDeps({ onProgress: (e) => events.push(e) }));
    expect(events.filter((e) => e.kind === "notice")).toEqual([
      { kind: "notice", code: "ncaa-season-missing", season: "2027" },
    ]);

    // 2. Tag sync failed, after the player's identity/stats already committed.
    events = [];
    clock.set(MID_SEASON);
    await insertPlayer(opened.db, { externalId: 691185 });
    await runRefresh(baseDeps({
      db: tagWritesThrow(opened.db, new Error("tags exploded")),
      onProgress: (e) => events.push(e),
    }));
    expect(events.filter((e) => e.kind === "notice")).toEqual([
      { kind: "notice", code: "tag-sync-failed", playerId: expect.any(Number) as number, reason: "tags exploded" },
    ]);

    // 3. Calendar failures during a TARGETED single-player refresh.
    events = [];
    const player = await insertPlayer(opened.db, { externalId: 592450 });
    await runRefreshForPlayer(
      baseDeps({ client: failingSeasons(), onProgress: (e) => events.push(e) }),
      player.id,
    );
    const targeted = events.filter((e) => e.kind === "notice");
    expect(targeted).toHaveLength(1);
    expect(targeted[0]).toMatchObject({ code: "targeted-calendar-failures", playerId: player.id });

    // The whole point of the split: with a sink attached, the job touches no stream.
    expect(legacyLines).toEqual([]);
  });

  it("WITHOUT a sink: each notice writes its EXACT pre-#146 stderr line and nothing else", async () => {
    // MCP, REST, and the watchlist seed path attach no sink. They must see today's
    // stderr — no diagnostic lost, and no per-player progress gained.
    clock.set("2027-07-19T17:00:00Z");
    await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One"));
    await runRefresh(baseDeps());
    expect(legacyLines).toEqual([
      "refresh: no bundled NCAA season lookup for year=2027; " +
        "NCAA treated as not In Season (update src/ncaa/seasons.ts)\n",
    ]);

    legacyLines = [];
    clock.set(MID_SEASON);
    const tagged = await insertPlayer(opened.db, { externalId: 691185 });
    await runRefresh(baseDeps({ db: tagWritesThrow(opened.db, new Error("tags exploded")) }));
    expect(legacyLines).toEqual([
      `refresh: tag sync failed for player id=${tagged.id} ` +
        "(identity/stats already committed; will heal next refresh): tags exploded\n",
    ]);

    legacyLines = [];
    const player = await insertPlayer(opened.db, { externalId: 592450 });
    const result = await runRefreshForPlayer(baseDeps({ client: failingSeasons() }), player.id);
    expect(result.calendarFailures.length).toBeGreaterThan(0);
    expect(legacyLines).toHaveLength(1);
    expect(legacyLines[0]).toBe(
      `refresh: ${result.calendarFailures.length} calendar fetch(es) failed during single-player ` +
        `refresh of player id=${player.id}: ` +
        result.calendarFailures.map((f) => `${f.sportId} (${f.reason})`).join("; ") +
        "\n",
    );
  });
});

/**
 * AC-6: "Console counts and /health / MCP status counts agree for the same run."
 * The sink-derived tallies and the persisted row are compared directly, so the
 * agreement is proven rather than assumed. This fails against pre-#146 code
 * because `players_skipped` / `players_failed` did not exist to compare against.
 */
describe("the liveness stream and the durable accounting agree (#146 AC-6)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    progressControl.failAtCall = null;
    progressControl.calls = 0;
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
  });

  afterEach(() => {
    opened.close();
  });

  it("a settled mixed sweep: sink tallies equal /health, and the three add up to the total", async () => {
    await insertPlayer(opened.db, { externalId: 691185 }); // refreshed
    await insertPlayer(opened.db, passedOverNcaa(700005, "Legacy One")); // passed over
    await insertPlayer(opened.db, { externalId: 660271 }); // fails

    const events: RefreshProgressEvent[] = [];
    const summary = await runRefresh({
      db: opened.db,
      client: new MlbClient({
        fetchImpl: (url: string) =>
          url.includes("/people/660271?") ? Promise.reject(new Error("b down")) : api.fetch(url),
        delayMs: 0,
      }),
      now: clock.now,
      tz: TEST_TZ,
      onProgress: (event) => events.push(event),
    });
    expect(summary.status).toBe("partial");

    // What a console counter would show, derived ONLY from the stream.
    const settled = events.filter(
      (e): e is Extract<RefreshProgressEvent, { kind: "player-settled" }> => e.kind === "player-settled",
    );
    const fromStream = settled.at(-1)!.counts;
    expect(fromStream).toEqual({ refreshed: 1, passedOver: 1, failed: 1 });

    // What /health and the MCP status tool would report for that same run.
    const health = refreshHealth(opened.db, clock.now(), TEST_TZ);
    expect(health).toMatchObject({
      playersRefreshed: fromStream.refreshed,
      playersSkipped: fromStream.passedOver,
      playersFailed: fromStream.failed,
      playersTotal: 3,
    });
    // The identity holds for a sweep whose loop ran to completion.
    expect(fromStream.refreshed + fromStream.passedOver + fromStream.failed).toBe(3);
  });

  it("a SUPERSEDED sweep agrees on its partial tallies, and deliberately falls short of the total", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    await insertPlayer(opened.db, { externalId: 592450 });
    progressControl.failAtCall = 2;

    const events: RefreshProgressEvent[] = [];
    const summary = await runRefresh({
      db: opened.db,
      client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
      now: clock.now,
      tz: TEST_TZ,
      onProgress: (event) => events.push(event),
    });
    expect(summary.reason).toBe("superseded");

    const settled = events.filter(
      (e): e is Extract<RefreshProgressEvent, { kind: "player-settled" }> => e.kind === "player-settled",
    );
    const fromStream = settled.at(-1)!.counts;
    expect(fromStream).toEqual({ refreshed: 1, passedOver: 0, failed: 0 });

    const row = opened.db.select().from(refreshRuns).all().find((r) => r.id === summary.runId);
    expect(row).toMatchObject({
      playersRefreshed: fromStream.refreshed,
      playersSkipped: fromStream.passedOver,
      playersFailed: fromStream.failed,
      playersTotal: 3,
    });
    // An abandoned sweep is SHORT of its total on purpose — that is correct, not
    // a violation of the identity, which is scoped to sweeps that ran to the end.
    expect(fromStream.refreshed + fromStream.passedOver + fromStream.failed).toBeLessThan(3);
  });
});
