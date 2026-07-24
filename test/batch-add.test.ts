import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { OpenedDb } from "../src/db/client.js";
import { playerTags, players, refreshRuns, statLines } from "../src/db/schema.js";
import type { FetchLike } from "../src/mlb/client.js";
import { MlbClient } from "../src/mlb/client.js";
import { runRefresh } from "../src/jobs/refresh.js";
import type { WatchlistDeps } from "../src/watchlist/service.js";
import { batchAddPlayers } from "../src/watchlist/service.js";
import { UnknownListError, createList, listMembersOf } from "../src/lists/service.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertPlayer,
  makeGameLogBody,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/** NCAA game-log pages for one seq, batting carrying two final (pre-today) games. */
const ncaaPages = (seq: number, fullName: string, schoolName: string) => ({
  [`${seq}:batting`]: makeNcaaGameLogHtml({
    fullName,
    schoolName,
    rows: [
      { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 2, HR: 1 } },
      { date: "2026-03-14", opponentName: "Georgia", isHome: false, contestId: 6002, stats: { AB: 3, H: 1, HR: 0 } },
    ],
  }),
  [`${seq}:pitching`]: makeNcaaGameLogHtml({ fullName, schoolName, rows: [] }),
  [`${seq}:fielding`]: makeNcaaGameLogHtml({ fullName, schoolName, rows: [] }),
});

describe("batchAddPlayers", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (client?: MlbClient): WatchlistDeps => ({
    db: opened.db,
    client: client ?? new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: {
        "11:hitting": makeGameLogBody("hitting", [
          makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
          makeSplit({ date: "2026-04-16", game: { gamePk: 900002, gameNumber: 1 } }),
        ]),
      },
    });
    ncaaApi = new FakeNcaaApi();
  });

  afterEach(() => {
    opened.close();
  });

  describe("happy paths", () => {
    it("adds a mixed batch {personId, ncaaPlayerSeq, name->1 hit}: added===3, three rows", async () => {
      ncaaApi.options.pages = ncaaPages(2649785, "College Guy", "LSU");
      api.options.searchResults = [makePerson({ id: 700001, fullName: "Search Hit" })];

      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 691185 }, { ncaaPlayerSeq: 2649785 }, { name: "Search Hit" }],
      });

      expect(result.summary).toEqual({ added: 3, updated: 0, unresolved: 0, failed: 0, total: 3 });
      expect(result.entries.map((e) => e.status)).toEqual(["added", "added", "added"]);
      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.externalId).sort()).toEqual([691185, 700001, null].sort());
    });

    it("re-adds an existing (deactivated) player as `updated`, re-activated, no dup row", async () => {
      await insertPlayer(opened.db, { externalId: 691185, fullName: "Old Name", active: false });

      const result = await batchAddPlayers(deps(), { entries: [{ personId: 691185 }] });

      expect(result.summary).toMatchObject({ added: 0, updated: 1, total: 1 });
      const entry = result.entries[0];
      expect(entry?.status).toBe("updated");
      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalId: 691185, active: true, fullName: "Maximo Acosta" });
    });

    it("derives tags on the `updated` path, healing a re-added untagged player", async () => {
      // An existing row with NO tags (a prior failed add). A batch re-add takes the
      // `updated` path, which must now also derive his tags (idempotent).
      const existing = await insertPlayer(opened.db, {
        externalId: 691185,
        milbLevel: "Triple-A",
        position: "SS",
        active: false,
      });
      expect(
        await opened.db.select().from(playerTags).where(eq(playerTags.playerId, existing.id)),
      ).toHaveLength(0);

      const result = await batchAddPlayers(deps(), { entries: [{ personId: 691185 }] });
      expect(result.entries[0]?.status).toBe("updated");
      const keys = new Set(
        (await opened.db.select().from(playerTags).where(eq(playerTags.playerId, existing.id))).map(
          (t) => `${t.namespace}:${t.value}`,
        ),
      );
      expect(keys.has("level:aaa")).toBe(true);
      expect(keys.has("pos:ss")).toBe(true);
      expect(keys.has("prospect:prospect")).toBe(true);
    });

    it("echoes the NORMALIZED (trimmed) name in the outcome entry", async () => {
      api.options.searchResults = [makePerson({ id: 700001, fullName: "Search Hit" })];
      const result = await batchAddPlayers(deps(), { entries: [{ name: "  Search Hit  " }] });
      expect(result.entries[0]?.entry).toEqual({ name: "Search Hit" });
    });

    it("keeps the summary invariant added+updated+unresolved+failed === total === entries.length", async () => {
      api.options.person = undefined; // every personId is not-found -> unresolved
      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 1 }, { personId: 2 }, { personId: 3 }],
      });
      const s = result.summary;
      expect(s.added + s.updated + s.unresolved + s.failed).toBe(s.total);
      expect(s.total).toBe(result.entries.length);
      expect(s.total).toBe(3);
    });
  });

  describe("deferred backfill (ADR 0045 crux)", () => {
    it("stages identity ONLY — zero stat_lines, zero refresh_runs, one NCAA identity fetch — then runRefresh backfills", async () => {
      clock.set("2026-03-15T17:00:00Z"); // NCAA in season, MLB games still in the future
      ncaaApi.options.pages = ncaaPages(2649785, "College Guy", "LSU");

      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 691185 }, { ncaaPlayerSeq: 2649785 }],
      });
      expect(result.summary).toMatchObject({ added: 2, total: 2 });

      // Two players STAGED, but nothing backfilled and no freshness run recorded.
      expect(await opened.db.select().from(players)).toHaveLength(2);
      expect(await opened.db.select().from(statLines)).toHaveLength(0);
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(0);

      // The NCAA entry cost EXACTLY one identity fetch (batting only), never the
      // three-category batting+pitching+fielding sweep a Refresh performs.
      expect(ncaaApi.callsMatching(/stats_player_seq=2649785/)).toHaveLength(1);
      expect(ncaaApi.callsMatching(/year_stat_category_id=/)).toHaveLength(1);
      // The MLB entry cost only identity (person + team), never a game-log sweep.
      expect(api.callsMatching(/stats=gameLog/)).toHaveLength(0);

      // The next Refresh sweeps the active list and backfills the staged players.
      const refresh = await runRefresh(deps());
      expect(refresh.skipped).toBe(false);
      const lines = await opened.db.select().from(statLines);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.sportId === 22)).toBe(true); // the NCAA batting games
      expect(await opened.db.select().from(refreshRuns)).toHaveLength(1);
    });
  });

  describe("name resolution", () => {
    it("0 hits -> unresolved/name_no_match, no row written", async () => {
      api.options.searchResults = [];
      const result = await batchAddPlayers(deps(), { entries: [{ name: "Nobody" }] });
      expect(result.summary).toMatchObject({ unresolved: 1, added: 0 });
      expect(result.entries[0]).toMatchObject({ status: "unresolved", reason: "name_no_match" });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it(">1 hits -> unresolved/name_ambiguous with candidates, never guessed, no row", async () => {
      api.options.searchResults = [
        makePerson({ id: 1, fullName: "Al Pha", currentTeam: { id: 146, name: "Miami Marlins", link: "x" } }),
        makePerson({ id: 2, fullName: "Be Ta", currentTeam: undefined }),
      ];
      const result = await batchAddPlayers(deps(), { entries: [{ name: "ambiguous" }] });

      const entry = result.entries[0];
      expect(entry).toMatchObject({ status: "unresolved", reason: "name_ambiguous" });
      const candidates = entry?.status === "unresolved" ? entry.candidates : undefined;
      expect(candidates).toHaveLength(2);
      expect(candidates?.[0]).toEqual({ personId: 1, fullName: "Al Pha", teamName: "Miami Marlins", position: "SS" });
      expect(candidates?.[1]).toEqual({ personId: 2, fullName: "Be Ta", teamName: null, position: "SS" });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("candidates are ONLY present for name_ambiguous", async () => {
      api.options.searchResults = [];
      const result = await batchAddPlayers(deps(), { entries: [{ name: "Nobody" }] });
      const entry = result.entries[0];
      expect(entry?.status === "unresolved" && entry.candidates).toBeUndefined();
    });
  });

  describe("clean not-found is unresolved (NOT failed)", () => {
    it("personId with no MLB person -> unresolved/person_not_found", async () => {
      api.options.person = undefined;
      const result = await batchAddPlayers(deps(), { entries: [{ personId: 424242 }] });
      expect(result.entries[0]).toMatchObject({ status: "unresolved", reason: "person_not_found" });
      expect(result.summary).toMatchObject({ unresolved: 1, failed: 0 });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("NCAA seq with an upstream 404 -> unresolved/ncaa_not_found", async () => {
      ncaaApi.options.status = 404;
      const result = await batchAddPlayers(deps(), { entries: [{ ncaaPlayerSeq: 2649785 }] });
      expect(result.entries[0]).toMatchObject({ status: "unresolved", reason: "ncaa_not_found" });
      expect(result.summary).toMatchObject({ unresolved: 1, failed: 0 });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });
  });

  describe("capture-and-continue (best-effort, non-transactional)", () => {
    it("one entry's MlbApiError fails that entry only; the others still add and persist", async () => {
      const failingId = 999999;
      const baseFetch = api.fetch;
      const client = new MlbClient({
        fetchImpl: ((url: string) =>
          url.includes(`/people/${failingId}?`)
            ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
            : baseFetch(url)) as FetchLike,
        delayMs: 0,
      });

      const result = await batchAddPlayers(deps(client), {
        entries: [{ personId: 691185 }, { personId: failingId }, { personId: 700001 }],
      });

      expect(result.entries.map((e) => e.status)).toEqual(["added", "failed", "added"]);
      expect(result.entries[1]).toMatchObject({ status: "failed", reason: "upstream_error" });
      expect(result.summary).toMatchObject({ added: 2, failed: 1, total: 3 });
      // The two good entries persisted; the failed one wrote nothing (no rollback of the earlier insert).
      const rows = await opened.db.select().from(players);
      expect(rows.map((r) => r.externalId).sort()).toEqual([691185, 700001].sort());
    });
  });

  describe("hard failures", () => {
    it("MLB team-lookup failure AFTER the person resolved -> failed/upstream_error", async () => {
      const baseFetch = api.fetch;
      const client = new MlbClient({
        fetchImpl: ((url: string) =>
          /\/teams\/564$/.test(new URL(url).pathname)
            ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
            : baseFetch(url)) as FetchLike,
        delayMs: 0,
      });
      const result = await batchAddPlayers(deps(client), { entries: [{ personId: 691185 }] });
      expect(result.entries[0]).toMatchObject({ status: "failed", reason: "upstream_error" });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("a ZodError parsing an UPSTREAM response -> failed/upstream_error", async () => {
      const client = new MlbClient({
        fetchImpl: (() =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ people: [{ id: "not-a-number" }] }),
          })) as FetchLike,
        delayMs: 0,
      });
      const result = await batchAddPlayers(deps(client), { entries: [{ personId: 691185 }] });
      expect(result.entries[0]).toMatchObject({ status: "failed", reason: "upstream_error" });
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("an unbundled NCAA season -> failed/unsupported_season", async () => {
      clock.set("2030-03-15T17:00:00Z"); // no bundled stats.ncaa.org entry for 2030
      const result = await batchAddPlayers(deps(), { entries: [{ ncaaPlayerSeq: 2649785 }] });
      expect(result.entries[0]).toMatchObject({ status: "failed", reason: "unsupported_season" });
      expect(await opened.db.select().from(players)).toHaveLength(0);
      expect(ncaaApi.calls).toHaveLength(0); // thrown before any HTTP
    });
  });

  describe("single clock and shared team cache", () => {
    it("stamps every row with ONE uniform timestamp", async () => {
      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 1001 }, { personId: 1002 }],
      });
      expect(result.summary).toMatchObject({ added: 2 });
      const rows = await opened.db.select().from(players);
      const iso = clock.now().toISOString();
      for (const row of rows) {
        expect(row.createdAt).toBe(iso);
        expect(row.updatedAt).toBe(iso);
      }
    });

    it("fetches a shared team only once across the batch", async () => {
      await batchAddPlayers(deps(), { entries: [{ personId: 1001 }, { personId: 1002 }] });
      expect(api.callsMatching(/\/teams\/564$/)).toHaveLength(1);
    });
  });

  describe("strict-shape rejection aborts the whole call before any write", () => {
    const expectRejectsNoWrite = async (input: unknown): Promise<void> => {
      await expect(batchAddPlayers(deps(), input)).rejects.toBeInstanceOf(ZodError);
      expect(await opened.db.select().from(players)).toHaveLength(0);
      expect(await opened.db.select().from(statLines)).toHaveLength(0);
    };

    it("rejects an empty entries array", () => expectRejectsNoWrite({ entries: [] }));

    it("rejects 26 entries (over the cap)", () =>
      expectRejectsNoWrite({ entries: Array.from({ length: 26 }, (_, i) => ({ personId: i + 1 })) }));

    it("rejects an untyped {} entry", () => expectRejectsNoWrite({ entries: [{}] }));

    it("rejects a multi-key {personId, name} entry", () =>
      expectRejectsNoWrite({ entries: [{ personId: 5, name: "both" }] }));

    it("rejects an entry with an unknown key (.strict())", () =>
      expectRejectsNoWrite({ entries: [{ personId: 5, note: "nope" }] }));

    it("rejects a top-level unknown key (.strict())", () =>
      expectRejectsNoWrite({ entries: [{ personId: 5 }], surprise: 1 }));

    it("rejects an in-batch duplicate personId", () =>
      expectRejectsNoWrite({ entries: [{ personId: 5 }, { personId: 5 }] }));

    it("rejects an in-batch duplicate name (trimmed + lowercased)", () =>
      expectRejectsNoWrite({ entries: [{ name: "Bob Smith" }, { name: "  bob smith  " }] }));

    it("rejects invalid numerics 0, -1, and 1.5", async () => {
      await expectRejectsNoWrite({ entries: [{ personId: 0 }] });
      await expectRejectsNoWrite({ entries: [{ personId: -1 }] });
      await expectRejectsNoWrite({ entries: [{ ncaaPlayerSeq: 1.5 }] });
    });

    it("rejects a blank name", () => expectRejectsNoWrite({ entries: [{ name: "   " }] }));

    // A batch JSON identity is a REAL JSON number, not a coerced string: the batch
    // schema is z.number() (NOT z.coerce.number()), so a boolean, array, or numeric
    // STRING must be rejected outright — coercion would turn `true`->1 or `[123]`->123
    // and stage the wrong player, defeating the strict-shape guarantee (PR #84 review).
    it("rejects a boolean personId (no coercion of true->1)", () =>
      expectRejectsNoWrite({ entries: [{ personId: true }] }));

    it("rejects an array personId (no coercion of [123]->123)", () =>
      expectRejectsNoWrite({ entries: [{ personId: [123] }] }));

    it("rejects a numeric-string personId (a JSON number is required)", () =>
      expectRejectsNoWrite({ entries: [{ personId: "123" }] }));

    it("rejects a boolean ncaaPlayerSeq (no coercion of true->1)", () =>
      expectRejectsNoWrite({ entries: [{ ncaaPlayerSeq: true }] }));
  });

  describe("strict-shape acceptance", () => {
    it("accepts exactly 25 entries (the cap)", async () => {
      const entries = Array.from({ length: 25 }, (_, i) => ({ personId: i + 1 }));
      const result = await batchAddPlayers(deps(), { entries });
      expect(result.summary.total).toBe(25);
      expect(result.summary.added).toBe(25);
    });

    it("adds staged players to an existing `list` (#70)", async () => {
      const list = await createList(opened.db, "prospects", clock.now());
      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 691185 }],
        list: "prospects",
      });
      expect(result.summary).toMatchObject({ added: 1, total: 1 });
      const player = (await opened.db.select().from(players))[0]!;
      // The staged player is now an active member of the named list.
      const members = await listMembersOf(opened.db, "prospects");
      expect(members.map((m) => m.id)).toEqual([player.id]);
      expect(list.name).toBe("prospects");
    });

    it("rejects the whole call when `list` names no existing list (#70)", async () => {
      await expect(
        batchAddPlayers(deps(), { entries: [{ personId: 691185 }], list: "ghost" }),
      ).rejects.toBeInstanceOf(UnknownListError);
      // Fail-closed BEFORE any write: nothing staged.
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("treats personId N and ncaaPlayerSeq N as DIFFERENT humans, not a duplicate", async () => {
      ncaaApi.options.pages = ncaaPages(5, "College Guy", "LSU");
      const result = await batchAddPlayers(deps(), {
        entries: [{ personId: 5 }, { ncaaPlayerSeq: 5 }],
      });
      expect(result.summary.total).toBe(2);
      expect(result.summary.added).toBe(2);
      expect(await opened.db.select().from(players)).toHaveLength(2);
    });
  });

  it("stages nothing to refresh_runs and never touches an existing player's history", async () => {
    const existing = await insertPlayer(opened.db, { externalId: 691185, active: false });
    await batchAddPlayers(deps(), { entries: [{ personId: 691185 }] });
    // The re-activation is an update, but batch-add records NO freshness run.
    expect(await opened.db.select().from(refreshRuns)).toHaveLength(0);
    const row = (await opened.db.select().from(players).where(eq(players.id, existing.id)))[0];
    expect(row?.active).toBe(true);
  });
});
