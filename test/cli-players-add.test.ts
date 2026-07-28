import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db, OpenedDb } from "../src/db/client.js";
import type { PlayersAddDeps } from "../src/cli/players-add.js";
import { runPlayersAdd } from "../src/cli/players-add.js";
import { listMembers, playerLists, players } from "../src/db/schema.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
import { MlbClient } from "../src/mlb/client.js";
import { createList, resolveDefaultList, setDefaultList } from "../src/lists/service.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  makePerson,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * `sk players add` (#191). Exercised end to end through injected deps — no
 * subprocess — and every assertion is over the OBSERVABLE result: the greppable
 * line, the exit code, and the DATABASE state.
 *
 * The three refusal cases assert the ABSENCE OF THE ARTIFACT (a `players` count
 * taken before and after, plus a spy proving the MLB client was never called),
 * not merely a non-zero exit. A command that exits 1 having already written a
 * player row is exactly the failure this ordering exists to prevent, and an
 * exit-code-only assertion cannot see it.
 */
describe("players add CLI", () => {
  let opened: OpenedDb;
  let out: string[];
  let err: string[];
  const clock = fakeClock(MID_SEASON);

  /** The MLB people-search hits a run should see, settable per test. */
  let searchResults: Array<Record<string, unknown>>;
  /** What `findPerson` resolves the chosen id to, settable per test. */
  let person: Record<string, unknown>;
  /** Every `searchPeople` call, so "the client was NEVER touched" is provable. */
  let searchSpy: ReturnType<typeof vi.fn>;

  const mlbClient = (): MlbClient => {
    const api = new FakeStatsApi({
      person,
      teams: { 564: makeTeam(), 146: makeTeam({ id: 146 }) },
      searchResults,
    });
    const client = new MlbClient({ fetchImpl: api.fetch, delayMs: 0 });
    const real = client.searchPeople.bind(client);
    searchSpy = vi.fn(real);
    client.searchPeople = searchSpy as typeof client.searchPeople;
    return client;
  };

  const deps = (overrides: Partial<PlayersAddDeps> = {}): PlayersAddDeps => ({
    db: opened.db,
    client: mlbClient(),
    now: clock.now,
    tz: TEST_TZ,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    ...overrides,
  });

  const countPlayers = (): number =>
    (opened.sqlite.prepare("SELECT count(*) AS c FROM players").get() as { c: number }).c;
  const countMembers = (): number =>
    (opened.sqlite.prepare("SELECT count(*) AS c FROM list_members").get() as { c: number }).c;

  beforeEach(() => {
    opened = testDb();
    out = [];
    err = [];
    person = makePerson();
    searchResults = [makePerson()];
  });
  afterEach(() => {
    opened.close();
  });

  it("adds a single MLB match to an explicit list and writes both rows", async () => {
    const list = await createList(opened.db, "Prospects", clock.now());

    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "Prospects"], deps())).toBe(0);
    expect(out[0]).toBe(
      "added player id=1 personId=691185 name=Maximo Acosta list=Prospects member=added",
    );

    // Both writes actually landed — the line alone proves nothing.
    const player = (await opened.db.select().from(players).where(eq(players.externalId, 691185)))[0];
    expect(player).toBeDefined();
    const members = await opened.db.select().from(listMembers).where(eq(listMembers.listId, list.id));
    expect(members.map((m) => m.playerId)).toEqual([player!.id]);
  });

  it("resolves the DEFAULT lane when --list is omitted, and membership lands on it", async () => {
    const fallback = await resolveDefaultList(opened.db);

    expect(await runPlayersAdd(["--name", "Maximo Acosta"], deps())).toBe(0);
    expect(out[0]).toContain(`list=${fallback.name}`);
    const members = await opened.db.select().from(listMembers);
    expect(members).toHaveLength(1);
    expect(members[0]?.listId).toBe(fallback.id);
  });

  it("follows the default lane when it MOVES, rather than a hardcoded one", async () => {
    // The default is a movable flag (#190), so resolving it must be a lookup.
    const moved = await createList(opened.db, "Prospects", clock.now());
    await setDefaultList(opened.db, "Prospects", clock.now());

    expect(await runPlayersAdd(["--name", "Maximo Acosta"], deps())).toBe(0);
    expect(out[0]).toContain("list=Prospects");
    const members = await opened.db.select().from(listMembers);
    expect(members[0]?.listId).toBe(moved.id);
  });

  it("refuses with NO default lane and no --list, writing no player row", async () => {
    await opened.db.update(playerLists).set({ isDefault: false });
    const before = countPlayers();

    expect(await runPlayersAdd(["--name", "Maximo Acosta"], deps())).toBe(1);
    expect(err[0]).toContain("no default list is set");
    // The refusal names the command that fixes it.
    expect(err[0]).toContain("sk players lists set-default --name NAME");
    expect(countPlayers()).toBe(before);
    expect(countMembers()).toBe(0);
    // And it refused BEFORE spending an upstream call.
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown --list before touching the MLB client or writing anything", async () => {
    const before = countPlayers();
    const runDeps = deps();

    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "ghost"], runDeps)).toBe(1);
    expect(err[0]).toBe('error: no list named "ghost"');
    expect(countPlayers()).toBe(before);
    expect(countMembers()).toBe(0);
    // THE point of resolving the lane first: a typo costs no API call. Asserted
    // with a spy rather than inferred from the exit code.
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("is case-SENSITIVE about the list name (ADR 0046)", async () => {
    await createList(opened.db, "Prospects", clock.now());
    const before = countPlayers();

    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "prospects"], deps())).toBe(1);
    expect(err[0]).toContain('no list named "prospects"');
    expect(countPlayers()).toBe(before);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("refuses several matches with no --pick, listing candidates and writing nothing", async () => {
    searchResults = [
      makePerson({ id: 1, fullName: "Al Smith" }),
      makePerson({ id: 2, fullName: "Bo Smith" }),
      makePerson({ id: 3, fullName: "Cy Smith" }),
    ];
    const before = countPlayers();

    expect(await runPlayersAdd(["--name", "smith"], deps())).toBe(1);
    expect(err[0]).toBe("multiple matches for search=smith; re-run with --pick I");
    expect(err[1]).toContain("[1] personId=1 name=Al Smith");
    expect(err[3]).toContain("[3] personId=3 name=Cy Smith");
    // A guessed pick would be the WRONG player under a right-looking summary.
    expect(countPlayers()).toBe(before);
    expect(countMembers()).toBe(0);
  });

  it("--pick 2 of 3 adds exactly the second candidate", async () => {
    searchResults = [
      makePerson({ id: 1, fullName: "Al Smith" }),
      makePerson({ id: 2, fullName: "Bo Smith" }),
      makePerson({ id: 3, fullName: "Cy Smith" }),
    ];

    expect(await runPlayersAdd(["--name", "smith", "--pick", "2"], deps())).toBe(0);
    expect(out[0]).toContain("personId=2");
    const rows = await opened.db.select().from(players);
    expect(rows.map((r) => r.externalId)).toEqual([2]);
  });

  it("--pick out of range refuses and writes no player row", async () => {
    searchResults = [makePerson({ id: 1 }), makePerson({ id: 2 })];
    const before = countPlayers();

    expect(await runPlayersAdd(["--name", "smith", "--pick", "9"], deps())).toBe(1);
    expect(err[0]).toBe("error: --pick 9 out of range 1..2");
    expect(countPlayers()).toBe(before);
    expect(countMembers()).toBe(0);
  });

  it("refuses a name nothing matches", async () => {
    searchResults = [];
    const before = countPlayers();

    expect(await runPlayersAdd(["--name", "nobody"], deps())).toBe(1);
    expect(err[0]).toBe("error: no matches for search=nobody");
    expect(countPlayers()).toBe(before);
  });

  it("re-adding an existing member is idempotent: member=existing, no refresh line", async () => {
    await createList(opened.db, "Prospects", clock.now());
    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "Prospects"], deps())).toBe(0);
    const firstLines = [...out];
    expect(firstLines.some((line) => line.startsWith("refresh "))).toBe(true);

    out = [];
    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "Prospects"], deps())).toBe(0);
    expect(out[0]).toContain("member=existing");
    expect(out[0]).toMatch(/^updated player /);
    // A re-add runs NO refresh, so a line claiming one would be a lie. This is
    // the assertion `seed add`'s action==="added" guard exists for.
    expect(out.filter((line) => line.startsWith("refresh "))).toEqual([]);
    expect(countPlayers()).toBe(1);
    expect(countMembers()).toBe(1);
  });

  it("echoes an NFD-composed upstream name back in canonical NFC, verbatim UTF-8 (ADR 0047)", async () => {
    // Written as \uXXXX escapes ON PURPOSE (rules/testing.md): a typed accented
    // character collapses NFD and NFC into ONE form in this source file, and the
    // test would then prove nothing at all. NFD is base letter + combining mark;
    // NFC is the precomposed code point.
    const NFD = "José Acuña"; // e + U+0301, n + U+0303
    const NFC = "José Acuña"; // precomposed e-acute, n-tilde
    expect(NFD).not.toBe(NFC); // the fixture is genuinely decomposed
    expect(NFD.normalize("NFC")).toBe(NFC);
    person = makePerson({ id: 424242, fullName: NFD });
    searchResults = [person];

    expect(await runPlayersAdd(["--name", "acuna"], deps())).toBe(0);
    expect(out[0]).toContain(`name=${NFC}`);
    expect(out[0]).not.toContain(NFD);
    expect(out[0]).not.toContain("Acu?a"); // not ASCII-folded
    expect(out[0]).not.toMatch(/\\u[0-9a-f]{4}/i); // not `\uXXXX`-escaped
  });

  it("echoes a non-ASCII LIST name verbatim, not folded (ADR 0047)", async () => {
    const LIST = "Prospectos Espa\u00f1oles"; // precomposed n-tilde, written as an escape
    await createList(opened.db, LIST, clock.now());

    expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", LIST], deps())).toBe(0);
    expect(out[0]).toContain(`list=${LIST}`);
    expect(out[0]).not.toContain("Espa?oles");
  });

  it("reads -l as --list (#191)", async () => {
    const list = await createList(opened.db, "Prospects", clock.now());
    expect(await runPlayersAdd(["--name", "Maximo Acosta", "-l", "Prospects"], deps())).toBe(0);
    expect(out[0]).toContain("list=Prospects");
    const members = await opened.db.select().from(listMembers);
    expect(members[0]?.listId).toBe(list.id);
  });

  describe("--ncaa", () => {
    /** A Highlightly boundary returning `hits` from the fuzzy name search. */
    const ncaaClient = (hits: Array<{ id: number; fullName: string }>): HighlightlyClient =>
      new HighlightlyClient({
        apiKey: "test",
        fetchImpl: async (url) => {
          if (url.includes("/players?")) {
            return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ data: hits, pagination: { totalCount: hits.length, offset: 0, limit: 10 } }) };
          }
          if (url.includes("/matches?")) {
            return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ data: [], pagination: { totalCount: 0, offset: 0, limit: 100 } }) };
          }
          const id = Number(/\/players\/(\d+)/.exec(url)?.[1] ?? 0);
          const hit = hits.find((h) => h.id === id) ?? hits[0]!;
          return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ id: hit.id, fullName: hit.fullName, team: { id: 10, name: "Bruins", league: "NCAA" }, statistics: [] }) };
        },
      });

    it("adds a sole Highlightly hit and names it by highlightlyPlayerId", async () => {
      await createList(opened.db, "Prospects", clock.now());
      const highlightlyClient = ncaaClient([{ id: 501, fullName: "Roch Cholowsky" }]);

      expect(await runPlayersAdd(
        ["--name", "Roch Cholowsky", "--ncaa", "--list", "Prospects"],
        deps({ client: {} as never, highlightlyClient }),
      )).toBe(0);
      expect(out[0]).toContain("highlightlyPlayerId=501 name=Roch Cholowsky list=Prospects member=added");
      expect(out[0]).not.toContain("personId=");
      expect(countMembers()).toBe(1);
    });

    it("refuses several Highlightly hits with the explicit-identity candidates, writing nothing", async () => {
      const highlightlyClient = ncaaClient([
        { id: 501, fullName: "Roch Cholowsky" },
        { id: 502, fullName: "Roch Cholowski" },
      ]);
      const before = countPlayers();

      expect(await runPlayersAdd(
        ["--name", "Roch", "--ncaa"],
        deps({ client: {} as never, highlightlyClient }),
      )).toBe(1);
      // There is deliberately NO --pick escape here: the candidates carry the
      // explicit identity to retry with, exactly as `seed add --ncaa` does.
      expect(err[0]).toBe("multiple NCAA matches for name=Roch; re-run with an explicit Highlightly identity");
      expect(err[1]).toContain("[1] highlightlyPlayerId=501");
      expect(err[2]).toContain("[2] highlightlyPlayerId=502");
      expect(countPlayers()).toBe(before);
      expect(countMembers()).toBe(0);
    });

    it("refuses --ncaa --pick rather than minting a second ambiguity rule", async () => {
      const before = countPlayers();
      expect(await runPlayersAdd(
        ["--name", "Roch", "--ncaa", "--pick", "1"],
        deps({ client: {} as never, highlightlyClient: ncaaClient([{ id: 501, fullName: "Roch" }]) }),
      )).toBe(1);
      expect(err[0]).toContain("cannot be combined with '--ncaa'");
      expect(countPlayers()).toBe(before);
    });

    it("exits 78 when Highlightly is not configured, before any write", async () => {
      const before = countPlayers();
      expect(await runPlayersAdd(
        ["--name", "Roch", "--ncaa"],
        deps({ client: {} as never, highlightlyClient: undefined }),
      )).toBe(78);
      expect(err[0]).toContain("highlightly_not_configured");
      expect(countPlayers()).toBe(before);
    });

    it("maps an upstream Highlightly failure to its documented exit code", async () => {
      const highlightlyClient = new HighlightlyClient({
        apiKey: "test",
        fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => "0" }, json: async () => ({}) }),
      });
      const before = countPlayers();

      const code = await runPlayersAdd(
        ["--name", "Roch", "--ncaa"],
        deps({ client: {} as never, highlightlyClient }),
      );
      // 75 = quota/coverage (retry later), the same mapping `seed add` uses.
      expect(code).toBe(75);
      expect(err[0]).toMatch(/^error: highlightly_/);
      expect(countPlayers()).toBe(before);
    });
  });

  describe("the two-write boundary", () => {
    /**
     * A db whose Nth transaction throws — the ONLY honest way to observe what
     * SQLite durably left behind when the attach dies after the player row is
     * already committed. The attach is a transaction; on the re-add path the
     * only earlier one is `syncDerivedTags`, so `skip: 1` targets the attach.
     * If it ever landed elsewhere the error message asserted below would not
     * match, so this cannot silently drift into testing the wrong write.
     */
    const dbFailingAt = (db: Db, skip: number): Db => {
      let seen = 0;
      return new Proxy(db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
          const real = (value as (...args: unknown[]) => unknown).bind(target);
          return (...args: unknown[]): unknown => {
            seen += 1;
            if (seen <= skip) return real(...args);
            throw new Error("injected attach failure");
          };
        },
      }) as Db;
    };

    it("reports the residual state and the exact repair when the attach fails", async () => {
      await createList(opened.db, "Prospects", clock.now());
      // Seed the player first, so the create path is the no-refresh `updated`
      // branch and the attach is the transaction being faulted.
      expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", "Prospects"], deps())).toBe(0);
      await opened.db.delete(listMembers);
      out = [];
      err = [];

      const code = await runPlayersAdd(
        ["--name", "Maximo Acosta", "--list", "Prospects"],
        deps({ db: dbFailingAt(opened.db, 1) }),
      );
      expect(code).toBe(1);
      // The command does NOT pretend nothing happened: it names what exists,
      // what does not, and the one command that finishes the job.
      expect(err[0]).toBe(
        "error: player id=1 created but not attached to list=Prospects - " +
          "re-run: sk players lists add --name 'Prospects' --person-ids 691185",
      );
      expect(out).toEqual([]);
      // The residual state is exactly what the message claims.
      expect(countPlayers()).toBe(1);
      expect(countMembers()).toBe(0);
    });

    // Reviewer P2. List names legitimately carry spaces — this repo's own help
    // text uses `'Top 30'` — and an unquoted repair pastes as
    // `--name Top 30 --person-ids ...`, where `Top` is the value and `30` is an
    // unexpected argument. The recovery command the operator was told to run
    // would fail, which is the exact failure this message exists to prevent.
    it("quotes a list name with spaces or a quote so the repair can actually be pasted", async () => {
      for (const [listName, expected] of [
        ["Top 30", "'Top 30'"],
        ["Dad's Guys", "'Dad'\\''s Guys'"],
      ] as const) {
        opened.close();
        opened = testDb();
        out = [];
        err = [];
        await createList(opened.db, listName, clock.now());
        expect(await runPlayersAdd(["--name", "Maximo Acosta", "--list", listName], deps())).toBe(0);
        await opened.db.delete(listMembers);
        err = [];

        const code = await runPlayersAdd(
          ["--name", "Maximo Acosta", "--list", listName],
          deps({ db: dbFailingAt(opened.db, 1) }),
        );
        expect(code).toBe(1);
        expect(err[0], listName).toContain(`re-run: sk players lists add --name ${expected} --person-ids 691185`);
      }
    });

    it("refuses to attach onto a lane soft-deleted between resolve and attach", async () => {
      const list = await createList(opened.db, "Prospects", clock.now());
      // Model the concurrent `lists delete`: the lane resolved fine, then died
      // before the attach. Without the liveness re-check this writes a
      // membership row onto a dead lane — invisible to every scope query.
      const racingDb = new Proxy(opened.db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
          const real = (value as (...args: unknown[]) => unknown).bind(target);
          return (...args: unknown[]): unknown => {
            opened.sqlite
              .prepare("UPDATE player_lists SET deleted_at = ? WHERE id = ?")
              .run(clock.now().toISOString(), list.id);
            return real(...args);
          };
        },
      }) as Db;

      const code = await runPlayersAdd(["--name", "Maximo Acosta", "--list", "Prospects"], deps({ db: racingDb }));
      expect(code).toBe(1);
      expect(countMembers()).toBe(0);
      // A DELETED lane gets a DIFFERENT message from a generic attach failure,
      // because the generic repair (`players lists add --name Prospects`) would
      // fail the same way against a lane that no longer resolves. Printing a
      // repair the operator cannot run is worse than printing none.
      expect(err[0]).toBe(
        "error: player id=1 created but not attached - " +
          "list=Prospects was deleted mid-add; re-create it or re-run with a live --list",
      );
      expect(err[0]).not.toContain("re-run: sk players lists add");
    });
  });

  it("rejects a blank or missing --name before anything else", async () => {
    const before = countPlayers();
    expect(await runPlayersAdd([], deps())).toBe(1);
    expect(err[0]).toContain("missing required option '--name'");
    expect(await runPlayersAdd(["--name", "   "], deps())).toBe(1);
    expect(countPlayers()).toBe(before);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
