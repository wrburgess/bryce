import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { OpenedDb } from "../src/db/client.js";
import type { SeedDeps } from "../src/cli/seed.js";
import { runSeed } from "../src/cli/seed.js";
import { players } from "../src/db/schema.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertPlayer,
  makePerson,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * `sk seed` surface coverage.
 *
 * test/seed.test.ts pins the Highlightly/promote paths and is deliberately left
 * untouched — it is the proof that #191's extraction of the shared identity
 * rules into src/cli/pick.ts was VERBATIM. This file covers the rest of the
 * presenter, which had no direct tests at all: the MLB `--search`/`--pick`
 * rules as `seed` invokes them, `deactivate`, `list --tags`, and the whole
 * `tag` verb, plus every usage refusal.
 *
 * Every assertion is on the greppable line AND the resulting database state —
 * a refusal that still wrote a row would pass an exit-code-only check.
 */
describe("seed CLI surface", () => {
  let opened: OpenedDb;
  let out: string[];
  const clock = fakeClock(MID_SEASON);
  let searchResults: Array<Record<string, unknown>>;
  let person: Record<string, unknown>;

  const deps = (overrides: Partial<SeedDeps> = {}): SeedDeps => {
    const api = new FakeStatsApi({ person, teams: { 564: makeTeam() }, searchResults });
    return {
      db: opened.db,
      client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
      now: clock.now,
      tz: TEST_TZ,
      write: (line) => out.push(line),
      ...overrides,
    };
  };

  const countPlayers = (): number =>
    (opened.sqlite.prepare("SELECT count(*) AS c FROM players").get() as { c: number }).c;

  beforeEach(() => {
    opened = testDb();
    out = [];
    person = makePerson();
    searchResults = [makePerson()];
  });
  afterEach(() => {
    opened.close();
  });

  it("refuses an unknown subcommand with usage and exit 1", async () => {
    expect(await runSeed(["frobnicate"], deps())).toBe(1);
    expect(out[0]).toContain("error: usage: seed <add|promote|deactivate|list|tag>");
    expect(countPlayers()).toBe(0);
  });

  describe("add", () => {
    it("adds a sole --search match and prints its first-refresh line", async () => {
      expect(await runSeed(["add", "--search", "acosta"], deps())).toBe(0);
      expect(out[0]).toBe("added player id=1 personId=691185 name=Maximo Acosta");
      // A brand-new player IS his first refresh (ADR 0030), reported either way.
      expect(out[1]).toMatch(/^refresh (done|skipped) /);
      expect(countPlayers()).toBe(1);
    });

    it("re-adding is a no-op update with NO refresh line", async () => {
      expect(await runSeed(["add", "--search", "acosta"], deps())).toBe(0);
      out = [];
      expect(await runSeed(["add", "--person-id", "691185"], deps())).toBe(0);
      expect(out[0]).toBe("updated player id=1 personId=691185 name=Maximo Acosta");
      expect(out.filter((line) => line.startsWith("refresh "))).toEqual([]);
      expect(countPlayers()).toBe(1);
    });

    it("lists candidates and writes nothing when several match and no --pick is given", async () => {
      searchResults = [makePerson({ id: 1, fullName: "Al Smith" }), makePerson({ id: 2, fullName: "Bo Smith" })];
      expect(await runSeed(["add", "--search", "smith"], deps())).toBe(1);
      expect(out[0]).toBe("multiple matches for search=smith; re-run with --pick I");
      expect(out[1]).toContain("[1] personId=1 name=Al Smith");
      expect(countPlayers()).toBe(0);
    });

    it("--pick chooses the one-based candidate, and an out-of-range pick writes nothing", async () => {
      searchResults = [makePerson({ id: 1, fullName: "Al Smith" }), makePerson({ id: 2, fullName: "Bo Smith" })];
      expect(await runSeed(["add", "--search", "smith", "--pick", "2"], deps())).toBe(0);
      expect(out[0]).toContain("personId=2");

      out = [];
      expect(await runSeed(["add", "--search", "smith", "--pick", "9"], deps())).toBe(1);
      expect(out[0]).toBe("error: --pick 9 out of range 1..2");
      expect(countPlayers()).toBe(1); // only the --pick 2 add
    });

    it("refuses a search nothing matches", async () => {
      searchResults = [];
      expect(await runSeed(["add", "--search", "nobody"], deps())).toBe(1);
      expect(out[0]).toBe("error: no matches for search=nobody");
      expect(countPlayers()).toBe(0);
    });

    it("refuses a non-positive --person-id and a wholly unselected add", async () => {
      expect(await runSeed(["add", "--person-id", "0"], deps())).toBe(1);
      expect(out[0]).toBe("error: invalid --person-id 0");
      out = [];
      expect(await runSeed(["add"], deps())).toBe(1);
      expect(out[0]).toContain("add requires --person-id N");
      expect(countPlayers()).toBe(0);
    });

    it("reports an unknown MLB person and writes nothing", async () => {
      person = {};
      expect(await runSeed(["add", "--person-id", "424242"], deps({
        client: new MlbClient({ fetchImpl: new FakeStatsApi({ teams: {} }).fetch, delayMs: 0 }),
      }))).toBe(1);
      expect(out[0]).toBe("error: no MLB person with personId=424242");
      expect(countPlayers()).toBe(0);
    });

    it("refuses a half-specified NCAA name search either way round", async () => {
      expect(await runSeed(["add", "--ncaa"], deps())).toBe(1);
      expect(out[0]).toBe("error: NCAA name search requires --ncaa --name NAME");
      out = [];
      expect(await runSeed(["add", "--name", "Roch"], deps())).toBe(1);
      expect(out[0]).toBe("error: NCAA name search requires --ncaa --name NAME");
      expect(countPlayers()).toBe(0);
    });

    it("refuses --ncaa --name combined with another selector", async () => {
      expect(await runSeed(["add", "--ncaa", "--name", "Roch", "--search", "smith"], deps())).toBe(1);
      expect(out[0]).toBe("error: --ncaa --name cannot be combined with another player selector");
      expect(countPlayers()).toBe(0);
    });

    it("exits 78 when Highlightly is not configured", async () => {
      expect(await runSeed(["add", "--ncaa", "--name", "Roch"], deps())).toBe(78);
      expect(out[0]).toContain("highlightly_not_configured");
    });

    it("reports zero NCAA matches without writing", async () => {
      const highlightlyClient = new HighlightlyClient({
        apiKey: "test",
        fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ data: [], pagination: { totalCount: 0, offset: 0, limit: 10 } }) }),
      });
      expect(await runSeed(["add", "--ncaa", "--name", "Nobody"], deps({ highlightlyClient }))).toBe(1);
      expect(out[0]).toBe("error: no NCAA matches for name=Nobody");
      expect(countPlayers()).toBe(0);
    });

    it("refuses an incomplete explicit Highlightly identity", async () => {
      expect(await runSeed(["add", "--highlightly-player-id", "501"], deps())).toBe(1);
      expect(out[0]).toContain("requires --highlightly-player-id N --canonical-name NAME --team-id N");
      expect(countPlayers()).toBe(0);
    });
  });

  describe("deactivate", () => {
    it("deactivates by personId and by Highlightly id", async () => {
      const mlb = await insertPlayer(opened.db, { externalId: 691185 });
      expect(await runSeed(["deactivate", "--person-id", "691185"], deps())).toBe(0);
      expect(out[0]).toContain(`deactivated player id=${mlb.id} personId=691185`);
      expect((await opened.db.select().from(players).where(eq(players.id, mlb.id)))[0]?.active).toBe(false);

      const ncaa = await insertPlayer(opened.db, { externalId: null, highlightlyPlayerId: 501, level: "ncaa" });
      out = [];
      expect(await runSeed(["deactivate", "--highlightly-player-id", "501"], deps())).toBe(0);
      expect(out[0]).toContain(`deactivated player id=${ncaa.id} highlightlyPlayerId=501`);
    });

    it("refuses malformed and unknown references", async () => {
      expect(await runSeed(["deactivate", "--highlightly-player-id", "0"], deps())).toBe(1);
      expect(out[0]).toContain("deactivate requires --highlightly-player-id N");
      out = [];
      expect(await runSeed(["deactivate"], deps())).toBe(1);
      expect(out[0]).toContain("deactivate requires --person-id N");
      out = [];
      expect(await runSeed(["deactivate", "--person-id", "999999"], deps())).toBe(1);
      expect(out[0]).toBe("error: no player with personId=999999");
    });
  });

  describe("list", () => {
    it("prints every row plus a total, with the NCAA suffix on NCAA rows", async () => {
      await insertPlayer(opened.db, { fullName: "Mlb Guy" });
      await insertPlayer(opened.db, { fullName: "Ncaa Guy", externalId: null, highlightlyPlayerId: 77, level: "ncaa", schoolName: "UCLA" });

      expect(await runSeed(["list"], deps())).toBe(0);
      expect(out[0]).toContain("name=Mlb Guy");
      expect(out[0]).not.toContain("highlightlyPlayerId=");
      expect(out[1]).toContain("school=UCLA highlightlyPlayerId=77");
      expect(out.at(-1)).toBe("total=2");
    });

    it("refuses a PRESENT-but-empty --tags rather than listing the whole roster", async () => {
      await insertPlayer(opened.db);
      // The falsely-unfiltered result this guards: an empty selector must not
      // read as "no filter" and print everyone.
      expect(await runSeed(["list", "--tags"], deps())).toBe(1);
      expect(out[0]).toBe("error: --tags requires a selector expression");
      expect(out.some((line) => line.startsWith("total="))).toBe(false);
    });

    it("reports a malformed selector as a usage error, not a crash", async () => {
      await insertPlayer(opened.db);
      expect(await runSeed(["list", "--tags", "level:AAA"], deps())).toBe(1);
      expect(out[0]).toMatch(/^error: /);
      expect(out.some((line) => line.startsWith("total="))).toBe(false);
    });

    it("filters by a well-formed selector", async () => {
      const tagged = await insertPlayer(opened.db, { fullName: "Tagged Guy" });
      await insertPlayer(opened.db, { fullName: "Untagged Guy" });
      await runSeed(["tag", "add", "--person-id", String(tagged.externalId), "--tag", "status:rostered"], deps());
      out = [];

      expect(await runSeed(["list", "--tags", "status:rostered"], deps())).toBe(0);
      expect(out[0]).toContain("Tagged Guy");
      expect(out.at(-1)).toBe("total=1");
    });
  });

  describe("tag", () => {
    it("adds, lists, and removes a manual tag", async () => {
      const player = await insertPlayer(opened.db);
      const id = String(player.externalId);

      expect(await runSeed(["tag", "add", "--person-id", id, "--tag", "status:rostered"], deps())).toBe(0);
      expect(out[0]).toBe(`tag added playerId=${player.id} namespace=status value=rostered source=manual`);

      out = [];
      expect(await runSeed(["tag", "list", "--person-id", id], deps())).toBe(0);
      expect(out.some((line) => line.includes("namespace=status value=rostered"))).toBe(true);
      expect(out.at(-1)).toMatch(/^total=\d+$/);

      out = [];
      expect(await runSeed(["tag", "remove", "--person-id", id, "--tag", "status:rostered"], deps())).toBe(0);
      expect(out[0]).toBe(`tag removed playerId=${player.id} namespace=status value=rostered`);
    });

    it("refuses a write to a DERIVED namespace and a malformed --tag", async () => {
      const player = await insertPlayer(opened.db);
      const id = String(player.externalId);

      expect(await runSeed(["tag", "add", "--person-id", id, "--tag", "level:aaa"], deps())).toBe(1);
      expect(out[0]).toMatch(/^error: /);
      out = [];
      expect(await runSeed(["tag", "add", "--person-id", id, "--tag", "nocolon"], deps())).toBe(1);
      expect(out[0]).toBe("error: tag add requires --tag ns:value");
      out = [];
      expect(await runSeed(["tag", "remove", "--person-id", id, "--tag", "nocolon"], deps())).toBe(1);
      expect(out[0]).toBe("error: tag remove requires --tag ns:value");
    });

    it("refuses an unresolvable or malformed player reference", async () => {
      expect(await runSeed(["tag", "list", "--highlightly-player-id", "0"], deps())).toBe(1);
      expect(out[0]).toBe("error: invalid --highlightly-player-id 0");
      out = [];
      expect(await runSeed(["tag", "list", "--highlightly-player-id", "999"], deps())).toBe(1);
      expect(out[0]).toBe("error: no player with highlightlyPlayerId=999");
      out = [];
      expect(await runSeed(["tag", "list"], deps())).toBe(1);
      expect(out[0]).toContain("tag requires --person-id N");
      out = [];
      expect(await runSeed(["tag", "list", "--person-id", "999999"], deps())).toBe(1);
      expect(out[0]).toBe("error: no player with personId=999999");
    });

    it("resolves a player by his Highlightly identity", async () => {
      const ncaa = await insertPlayer(opened.db, { externalId: null, highlightlyPlayerId: 77, level: "ncaa" });
      expect(await runSeed(["tag", "add", "--highlightly-player-id", "77", "--tag", "status:scouted"], deps())).toBe(0);
      expect(out[0]).toContain(`tag added playerId=${ncaa.id}`);
    });

    it("rebuilds derived tags for every player", async () => {
      await insertPlayer(opened.db);
      await insertPlayer(opened.db);
      expect(await runSeed(["tag", "rebuild"], deps())).toBe(0);
      expect(out[0]).toBe("rebuilt derived tags players=2");
    });

    it("refuses an unknown tag subcommand with usage", async () => {
      expect(await runSeed(["tag", "frobnicate"], deps())).toBe(1);
      expect(out[0]).toContain("error: usage: seed tag <add|remove|list|rebuild>");
    });
  });
});
