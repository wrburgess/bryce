import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, statLines } from "../src/db/schema.js";
import type { SeedDeps } from "../src/cli/seed.js";
import { runSeed } from "../src/cli/seed.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendars2026,
  makeGameLogBody,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

describe("seed CLI", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;
  let output: string[];

  const deps = (): SeedDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
    write: (line) => output.push(line),
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    output = [];
    ncaaApi = new FakeNcaaApi();
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
  });

  afterEach(() => {
    opened.close();
  });

  it("add --person-id creates the Player and runs his first Refresh (season backfill)", async () => {
    const code = await runSeed(["add", "--person-id", "691185"], deps());
    expect(code).toBe(0);

    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: 691185,
      fullName: "Maximo Acosta",
      level: "milb",
      milbLevel: "Triple-A",
      teamName: "Jacksonville Jumbo Shrimp",
      active: true,
    });

    const lines = await opened.db.select().from(statLines);
    expect(lines).toHaveLength(2); // adding a Player IS his first Refresh

    expect(output[0]).toBe(`added player id=${rows[0]?.id} personId=691185 name=Maximo Acosta`);
    expect(output[1]).toBe("refresh done inserted=2 updated=0");
  });

  it("duplicate add is a no-op update: same Player row, no second refresh", async () => {
    await runSeed(["add", "--person-id", "691185"], deps());
    const before = await opened.db.select().from(statLines);
    const callsBefore = api.calls.length;
    output = [];

    const code = await runSeed(["add", "--person-id", "691185"], deps());
    expect(code).toBe(0);
    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(output[0]).toContain("updated player");
    // Identity fetch only — no game-log sweep on a duplicate add.
    const newCalls = api.calls.slice(callsBefore);
    expect(newCalls.some((u) => u.includes("stats=gameLog"))).toBe(false);
    const after = await opened.db.select().from(statLines);
    expect(after).toHaveLength(before.length);
  });

  it("skips the first Refresh during Offseason Sleep", async () => {
    await insertCalendars2026(opened.db);
    // Seed an already-watched player so the sleep window has a watched level.
    await runSeed(["add", "--person-id", "691185"], deps());
    output = [];
    clock.set("2026-12-05T18:00:00Z");

    api.options.person = makePerson({ id: 700000, fullName: "Winter Add" });
    const code = await runSeed(["add", "--person-id", "700000"], deps());
    expect(code).toBe(0);
    expect(output[1]).toBe("refresh skipped reason=offseason-sleep");
    const lines = await opened.db.select().from(statLines);
    const winterAdd = (await opened.db.select().from(players).where(eq(players.externalId, 700000)))[0];
    expect(lines.filter((l) => l.playerId === winterAdd?.id)).toHaveLength(0);
  });

  it("deactivate keeps the Player row and his history", async () => {
    await runSeed(["add", "--person-id", "691185"], deps());
    output = [];
    const code = await runSeed(["deactivate", "--person-id", "691185"], deps());
    expect(code).toBe(0);

    const row = (await opened.db.select().from(players))[0];
    expect(row?.active).toBe(false);
    const lines = await opened.db.select().from(statLines);
    expect(lines.length).toBeGreaterThan(0); // history preserved
    expect(output[0]).toBe(`deactivated player id=${row?.id} personId=691185 name=Maximo Acosta`);
  });

  it("deactivate of an unknown personId fails with exit code 1", async () => {
    const code = await runSeed(["deactivate", "--person-id", "424242"], deps());
    expect(code).toBe(1);
    expect(output[0]).toBe("error: no player with personId=424242");
  });

  it("add --search with multiple matches lists candidates and exits non-zero", async () => {
    api.options.searchResults = [
      makePerson({ id: 111, fullName: "Bobby Witt Jr." }),
      makePerson({ id: 222, fullName: "Bobby Witt Sr." }),
    ];
    const code = await runSeed(["add", "--search", "witt"], deps());
    expect(code).toBe(1);
    expect(output[0]).toBe("multiple matches for search=witt; re-run with --pick I");
    expect(output[1]).toBe("[1] personId=111 name=Bobby Witt Jr. position=SS");
    expect(output[2]).toBe("[2] personId=222 name=Bobby Witt Sr. position=SS");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("add --search --pick selects the listed candidate", async () => {
    api.options.searchResults = [
      makePerson({ id: 691185, fullName: "Maximo Acosta" }),
      makePerson({ id: 222, fullName: "Other Guy" }),
    ];
    const code = await runSeed(["add", "--search", "acosta", "--pick", "1"], deps());
    expect(code).toBe(0);
    const rows = await opened.db.select().from(players);
    expect(rows[0]?.externalId).toBe(691185);
  });

  it("add --search with a single match adds directly", async () => {
    api.options.searchResults = [makePerson()];
    const code = await runSeed(["add", "--search", "acosta"], deps());
    expect(code).toBe(0);
    expect((await opened.db.select().from(players))[0]?.externalId).toBe(691185);
  });

  it("add --ncaa-seq creates the NCAA player and runs his first Refresh", async () => {
    clock.set("2026-03-15T17:00:00Z"); // NCAA In Season
    ncaaApi.options.pages = {
      "2649785:batting": makeNcaaGameLogHtml({
        fullName: "College Guy",
        schoolName: "LSU",
        rows: [
          { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 2, HR: 1 } },
        ],
      }),
      "2649785:pitching": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
      "2649785:fielding": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
    };

    const code = await runSeed(["add", "--ncaa-seq", "2649785"], deps());
    expect(code).toBe(0);
    const rows = await opened.db.select().from(players);
    expect(rows[0]).toMatchObject({
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      schoolName: "LSU",
    });
    const lines = await opened.db.select().from(statLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.sportId).toBe(22);
    expect(output[0]).toBe(`added player id=${rows[0]?.id} ncaaSeq=2649785 name=College Guy`);
    expect(output[1]).toBe("refresh done inserted=1 updated=0");
  });

  it("add --ncaa-seq with an unresolvable seq exits non-zero", async () => {
    clock.set("2026-03-15T17:00:00Z");
    const code = await runSeed(["add", "--ncaa-seq", "999999"], deps());
    expect(code).toBe(1);
    expect(output[0]).toBe("error: no NCAA player with ncaaPlayerSeq=999999");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("list prints the school and seq for NCAA rows, unchanged for MLB/MiLB", async () => {
    await insertCalendars2026(opened.db);
    await runSeed(["add", "--person-id", "691185"], deps());
    await opened.db
      .insert(players)
      .values({
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: "College Guy",
        schoolName: "LSU",
        active: true,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      })
      .run();
    output = [];
    const code = await runSeed(["list"], deps());
    expect(code).toBe(0);
    // The MLB row keeps its exact legacy format.
    expect(output[0]).toBe(
      "player id=1 personId=691185 name=Maximo Acosta level=milb milbLevel=Triple-A team=Jacksonville Jumbo Shrimp active=true",
    );
    // The NCAA row appends school and seq.
    expect(output[1]).toBe(
      "player id=2 personId=- name=College Guy level=ncaa milbLevel=- team=- active=true school=LSU ncaaSeq=2649785",
    );
  });

  it("list prints deterministic greppable rows", async () => {
    await runSeed(["add", "--person-id", "691185"], deps());
    output = [];
    const code = await runSeed(["list"], deps());
    expect(code).toBe(0);
    expect(output).toEqual([
      "player id=1 personId=691185 name=Maximo Acosta level=milb milbLevel=Triple-A team=Jacksonville Jumbo Shrimp active=true",
      "total=1",
    ]);
  });

  it("rejects malformed invocations with exit code 1", async () => {
    expect(await runSeed([], deps())).toBe(1);
    expect(await runSeed(["add"], deps())).toBe(1);
    expect(await runSeed(["add", "--person-id", "not-a-number"], deps())).toBe(1);
    expect(await runSeed(["add", "--search", "x", "--pick", "9"], deps())).toBe(1);
    for (const line of output) {
      expect(line).toMatch(/^(error:|multiple matches|\[\d+\])/);
    }
  });

  it("emits ASCII-only stdout (rules/scripting.md)", async () => {
    await runSeed(["add", "--person-id", "691185"], deps());
    await runSeed(["list"], deps());
    await runSeed(["bogus"], deps());
    expect(output.length).toBeGreaterThan(3);
    for (const line of output) {
      // Printable ASCII only — no unicode arrows, no emoji, no control bytes.
      expect(line).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  describe("tag commands", () => {
    it("add/list/remove a manual status tag round-trips", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];

      expect(await runSeed(["tag", "add", "--person-id", "691185", "--tag", "status:rostered"], deps())).toBe(0);
      expect(output.some((l) => /^tag added .*namespace=status value=rostered source=manual$/.test(l))).toBe(true);

      output = [];
      expect(await runSeed(["tag", "list", "--person-id", "691185"], deps())).toBe(0);
      expect(output.some((l) => l.includes("namespace=status value=rostered source=manual"))).toBe(true);
      // Derived tags are listed too (the added player is a Triple-A shortstop).
      expect(output.some((l) => l.includes("namespace=level value=aaa source=derived"))).toBe(true);

      output = [];
      expect(await runSeed(["tag", "remove", "--person-id", "691185", "--tag", "status:rostered"], deps())).toBe(0);
      output = [];
      await runSeed(["tag", "list", "--person-id", "691185"], deps());
      expect(output.some((l) => l.includes("value=rostered"))).toBe(false);
    });

    it("list --tags filters the roster by an AND selector", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      await runSeed(["tag", "add", "--person-id", "691185", "--tag", "status:rostered"], deps());
      output = [];

      expect(await runSeed(["list", "--tags", "level:aaa,status:rostered"], deps())).toBe(0);
      expect(output.some((l) => l.startsWith("player ") && l.includes("personId=691185"))).toBe(true);
      expect(output).toContain("total=1");

      output = [];
      // A zero-match selector lists nobody.
      await runSeed(["list", "--tags", "status:scouted"], deps());
      expect(output).toContain("total=0");
    });

    it("rebuild re-derives tags for every player", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];
      expect(await runSeed(["tag", "rebuild"], deps())).toBe(0);
      expect(output.some((l) => /^rebuilt derived tags players=\d+$/.test(l))).toBe(true);
    });

    it("rejects a manual write to a derived namespace, exit 1", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];
      expect(await runSeed(["tag", "add", "--person-id", "691185", "--tag", "level:aaa"], deps())).toBe(1);
      expect(output.some((l) => l.startsWith("error:"))).toBe(true);
    });

    it("rejects an unknown status value, exit 1", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];
      expect(await runSeed(["tag", "add", "--person-id", "691185", "--tag", "status:bogus"], deps())).toBe(1);
      expect(output.some((l) => l.startsWith("error:"))).toBe(true);
    });

    it("errors on an unknown player, exit 1", async () => {
      expect(await runSeed(["tag", "list", "--person-id", "424242"], deps())).toBe(1);
      expect(output.some((l) => l.startsWith("error:"))).toBe(true);
    });

    it("errors on a malformed --tag, exit 1", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];
      expect(await runSeed(["tag", "add", "--person-id", "691185", "--tag", "notacolon"], deps())).toBe(1);
      expect(output.some((l) => l.startsWith("error:"))).toBe(true);
    });

    it("list --tags with a malformed selector exits 1", async () => {
      await runSeed(["add", "--person-id", "691185"], deps());
      output = [];
      expect(await runSeed(["list", "--tags", ":foo"], deps())).toBe(1);
      expect(output.some((l) => l.startsWith("error:"))).toBe(true);
    });
  });
});
