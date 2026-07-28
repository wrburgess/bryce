import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { OpenedDb } from "../src/db/client.js";
import type { ListsDeps } from "../src/cli/lists.js";
import { runLists } from "../src/cli/lists.js";
import { playerLists } from "../src/db/schema.js";
import { InvalidListConfigError, addToList, configureList, createList } from "../src/lists/service.js";
import { fakeClock, insertPlayer, testDb } from "./factories.js";

/**
 * Named-list CLI (issue #70). Exercised end to end through injected deps so the
 * observable effects are asserted — greppable `key=value` output, `error=` on
 * failure, and non-zero exit — not merely a parse (rules/testing.md).
 */
describe("lists CLI", () => {
  let opened: OpenedDb;
  let out: string[];
  let err: string[];
  const clock = fakeClock("2026-07-19T17:00:00.000Z");

  const deps = (): ListsDeps => ({
    db: opened.db,
    now: clock.now,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  beforeEach(() => {
    opened = testDb();
    out = [];
    err = [];
  });
  afterEach(() => {
    opened.close();
  });

  it("create: writes a greppable line and persists the list", async () => {
    const code = await runLists(["create", "--name", "Prospects"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list created id=\d+ name=Prospects$/);
  });

  it("add + show: adds a member and shows the roster", async () => {
    await createList(opened.db, "L", clock.now());
    const p = await insertPlayer(opened.db, { fullName: "Cli Member" });

    const addCode = await runLists(
      ["add", "--name", "L", "--person-ids", String(p.externalId)],
      deps(),
    );
    expect(addCode).toBe(0);
    expect(out[0]).toBe("list add name=L added=1 refs=1");

    out = [];
    const showCode = await runLists(["show", "--name", "L"], deps());
    expect(showCode).toBe(0);
    expect(out[0]).toContain(`playerId=${p.id}`);
    expect(out.at(-1)).toBe("total=1");
  });

  // ADR 0047: players:lists is a human-facing app CLI. `show` renders the member's
  // stored (canonical NFC) identity in UTF-8 — never ASCII-folded — the same policy
  // seed follows. The name carries precomposed non-ASCII letters (é, ñ) written as
  // explicit escapes so a genuine non-ASCII byte is present in the fixture.
  it("show --name: echoes a member's non-ASCII identity in UTF-8 (ADR 0047)", async () => {
    const NAME = "Jos\u00e9 Acu\u00f1a"; // "Jose Acuna" with precomposed (NFC) e-acute and n-tilde
    await createList(opened.db, "L", clock.now());
    const p = await insertPlayer(opened.db, { fullName: NAME });
    await addToList(opened.db, "L", [p.externalId!], clock.now());

    const code = await runLists(["show", "--name", "L"], deps());
    expect(code).toBe(0);
    const line = out.find((l) => l.startsWith("member "));
    expect(line).toBeDefined();
    expect(line as string).toContain(`name=${NAME}`); // verbatim UTF-8
    expect(line as string).not.toContain("Acu?a"); // not ASCII-folded
    expect(line as string).not.toMatch(/\\u[0-9a-f]{4}/i); // not `\uXXXX`-escaped
  });

  it("show (all): lists live lists with member counts", async () => {
    const list = await createList(opened.db, "Alpha", clock.now());
    const p = await insertPlayer(opened.db);
    await addToList(opened.db, "Alpha", [p.externalId!], clock.now());
    const code = await runLists(["show"], deps());
    expect(code).toBe(0);
    // Ordered by name, and each line now states whether the list is THE default
    // lane (#190) — the migration-seeded `Watchlist` is, `Alpha` is not.
    expect(out[0]).toBe(`list id=${list.id} name=Alpha members=1 default=false`);
    expect(out[1]).toMatch(/^list id=\d+ name=Watchlist members=0 default=true$/);
    expect(out.at(-1)).toBe("total=2");
  });

  it("rename: renames a live list", async () => {
    await createList(opened.db, "Old", clock.now());
    const code = await runLists(["rename", "--name", "Old", "--to", "New"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list renamed id=\d+ name=New$/);
  });

  it("delete: soft-deletes and frees the name", async () => {
    await createList(opened.db, "Temp", clock.now());
    const code = await runLists(["delete", "--name", "Temp"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list deleted id=\d+ name=Temp$/);
    // Recreating the freed name succeeds via the CLI.
    expect(await runLists(["create", "--name", "Temp"], deps())).toBe(0);
  });

  it("sad path: an unknown list exits 1 with a greppable error= line", async () => {
    const code = await runLists(["show", "--name", "ghost"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
    expect(err[0]).toContain('no list named "ghost"');
  });

  it("sad path: a duplicate create exits 1 with error=", async () => {
    await createList(opened.db, "Dupes", clock.now());
    const code = await runLists(["create", "--name", "Dupes"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
  });

  it("sad path: adding an unknown player ref exits 1 and writes nothing", async () => {
    await createList(opened.db, "L", clock.now());
    const code = await runLists(["add", "--name", "L", "--person-ids", "99999999"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
  });

  it("sad path: a control char in the create name exits 1 and writes nothing", async () => {
    const code = await runLists(["create", "--name", "a\nb"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
    // Validation fails closed at the service, before any insert — nothing was
    // created, so only the migration-seeded default lane is listed (#190).
    const listCode = await runLists(["show"], deps());
    expect(listCode).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^list id=\d+ name=Watchlist members=0 default=true$/);
    expect(out[1]).toBe("total=1");
  });

  it("sad path: an unknown subcommand exits 1 with usage", async () => {
    const code = await runLists(["frobnicate"], deps());
    expect(code).toBe(1);
    expect(err[0]).toContain("error=usage:");
    // The new verb is discoverable from the usage line, not only from the docs.
    expect(err[0]).toContain("set-default");
  });

  describe("set-default (#190)", () => {
    it("points the default at a list and clears the previous one", async () => {
      const list = await createList(opened.db, "Prospects", clock.now());
      const code = await runLists(["set-default", "--name", "Prospects"], deps());
      expect(code).toBe(0);
      expect(out[0]).toBe(`list default id=${list.id} name=Prospects`);

      // Asserted through `show`, so the observable CLI state is what changed —
      // exactly one list marked default.
      out.length = 0;
      await runLists(["show"], deps());
      expect(out.filter((l) => l.includes("default=true"))).toEqual([
        `list id=${list.id} name=Prospects members=0 default=true`,
      ]);
    });

    it("sad path: an unknown list writes error= and exits 1, moving nothing", async () => {
      const code = await runLists(["set-default", "--name", "ghost"], deps());
      expect(code).toBe(1);
      expect(err[0]).toBe('error=no list named "ghost"');
      expect(out).toEqual([]);

      await runLists(["show"], deps());
      expect(out.filter((l) => l.includes("default=true"))).toHaveLength(1);
      expect(out[0]).toContain("name=Watchlist");
    });

    it("sad path: a missing --name writes error= and exits 1", async () => {
      const code = await runLists(["set-default"], deps());
      expect(code).toBe(1);
      expect(err[0]).toContain("--name is required");
    });
  });

  describe("configure (#191)", () => {
    /** The three cadence columns as stored, read straight from the row. */
    const cadence = async (name: string): Promise<{ every: number | null; hour: number | null; to: string | null }> => {
      const row = (await opened.db.select().from(playerLists).where(eq(playerLists.name, name)))[0]!;
      return { every: row.refreshIntervalMinutes, hour: row.digestHour, to: row.digestTo };
    };

    beforeEach(async () => {
      await createList(opened.db, "Lane", clock.now());
    });

    it("sets each column INDIVIDUALLY, leaving the other two untouched", async () => {
      // The defect this pins: a patch that wrote all three columns every time
      // would clear two of them here, and the success line would not say so.
      await configureList(opened.db, "Lane", { refreshIntervalMinutes: 60, digestHour: 5, digestTo: "hc@example.com" }, clock.now());

      expect(await runLists(["configure", "--name", "Lane", "--digest-hour", "9"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: 60, hour: 9, to: "hc@example.com" });

      expect(await runLists(["configure", "--name", "Lane", "--refresh-every", "30"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: 30, hour: 9, to: "hc@example.com" });

      expect(await runLists(["configure", "--name", "Lane", "--digest-to", "other@example.com"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: 30, hour: 9, to: "other@example.com" });
    });

    it("sets all three at once and reports them on one greppable line", async () => {
      expect(await runLists(
        ["configure", "--name", "Lane", "--refresh-every", "1440", "--digest-hour", "5", "--digest-to", "hc@example.com"],
        deps(),
      )).toBe(0);
      expect(out[0]).toMatch(
        /^list configured id=\d+ name=Lane refreshEvery=1440 digestHour=5 digestTo=hc@example\.com$/,
      );
      expect(await cadence("Lane")).toEqual({ every: 1440, hour: 5, to: "hc@example.com" });
    });

    it("`none` clears EACH column to null and renders it as -", async () => {
      await configureList(opened.db, "Lane", { refreshIntervalMinutes: 60, digestHour: 5, digestTo: "hc@example.com" }, clock.now());

      expect(await runLists(["configure", "--name", "Lane", "--digest-hour", "none"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: 60, hour: null, to: "hc@example.com" });
      expect(out[0]).toContain("digestHour=-");

      expect(await runLists(["configure", "--name", "Lane", "--refresh-every", "none"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: null, hour: null, to: "hc@example.com" });

      expect(await runLists(["configure", "--name", "Lane", "--digest-to", "none"], deps())).toBe(0);
      expect(await cadence("Lane")).toEqual({ every: null, hour: null, to: null });
      expect(out.at(-1)).toMatch(/refreshEvery=- digestHour=- digestTo=-$/);
    });

    it("--digest-hour 0 SUCCEEDS and stores 0 — midnight is a real digest hour", async () => {
      // The trap this guards: `positiveInteger` rejects 0, but the DB CHECK
      // explicitly allows it. Reusing that validator would refuse a lane the
      // database accepts, and the failure would look like a typo to the HC.
      expect(await runLists(["configure", "--name", "Lane", "--digest-hour", "0"], deps())).toBe(0);
      expect((await cadence("Lane")).hour).toBe(0);
      // Rendered as 0, never collapsed to the null spelling by a falsy check.
      expect(out[0]).toContain("digestHour=0");
      expect(out[0]).not.toContain("digestHour=-");
      // And 23 is still in range while 24 is not.
      expect(await runLists(["configure", "--name", "Lane", "--digest-hour", "23"], deps())).toBe(0);
      expect((await cadence("Lane")).hour).toBe(23);
    });

    it("refuses every out-of-range and non-canonical value, writing nothing", async () => {
      await configureList(opened.db, "Lane", { digestHour: 5, refreshIntervalMinutes: 60 }, clock.now());
      const cases: Array<[string, string]> = [
        ["--digest-hour", "24"],
        ["--digest-hour", "-1"],
        ["--refresh-every", "0"],
        ["--digest-hour", "07"],
        ["--refresh-every", "1e2"],
        ["--refresh-every", "+5"],
        ["--digest-hour", "3.0"],
      ];
      for (const [flag, value] of cases) {
        err.length = 0;
        out.length = 0;
        expect(await runLists(["configure", "--name", "Lane", flag, value], deps()), `${flag} ${value}`).toBe(1);
        expect(err[0], `${flag} ${value}`).toMatch(/^error=/);
        expect(out, `${flag} ${value}`).toEqual([]);
      }
      // Nothing moved across the whole matrix.
      expect(await cadence("Lane")).toEqual({ every: 60, hour: 5, to: null });
    });

    it("sad path: an unknown list exits 1 with error= and updates no row", async () => {
      expect(await runLists(["configure", "--name", "ghost", "--digest-hour", "5"], deps())).toBe(1);
      expect(err[0]).toBe('error=no list named "ghost"');
      expect(out).toEqual([]);
      expect(await cadence("Lane")).toEqual({ every: null, hour: null, to: null });
    });

    it("sad path: --name with no other flag fails LOUDLY rather than no-opping", async () => {
      expect(await runLists(["configure", "--name", "Lane"], deps())).toBe(1);
      expect(err[0]).toContain("requires at least one of --refresh-every, --digest-hour, --digest-to");
      expect(out).toEqual([]);
    });

    it("sad path: a missing --name writes error= and exits 1", async () => {
      expect(await runLists(["configure", "--digest-hour", "5"], deps())).toBe(1);
      expect(err[0]).toContain("--name is required");
    });

    it("renders an InvalidListConfigError from the SERVICE as error= + exit 1", async () => {
      // The service is the last line of defense, and it is reachable without the
      // router: a caller that hands it an out-of-range value must still get the
      // typed error rendered through this surface's seam (rules/backend.md),
      // never an unhandled throw. Driven through the presenter's own catch by
      // bypassing the CLI's canonical-integer parse with the service directly.
      await expect(configureList(opened.db, "Lane", { digestHour: 24 }, clock.now()))
        .rejects.toBeInstanceOf(InvalidListConfigError);

      // And through the CLI: the presenter's catch list knows the type.
      expect(await runLists(["configure", "--name", "Lane", "--digest-hour", "99"], deps())).toBe(1);
      expect(err[0]).toMatch(/^error=/);
      expect(await cadence("Lane")).toEqual({ every: null, hour: null, to: null });
    });

    it("is discoverable from the usage line, not only from the docs", async () => {
      expect(await runLists(["frobnicate"], deps())).toBe(1);
      expect(err[0]).toContain("configure");
    });
  });

  it("sad path: deleting the DEFAULT list writes error= and exits 1, leaving it live", async () => {
    const code = await runLists(["delete", "--name", "Watchlist"], deps());
    expect(code).toBe(1);
    expect(err[0]).toContain("is the default list");
    // The error names the recovery command, so the operator is not left guessing.
    expect(err[0]).toContain("sk players lists set-default --name NAME");
    expect(out).toEqual([]);

    await runLists(["show"], deps());
    expect(out[0]).toMatch(/^list id=\d+ name=Watchlist members=0 default=true$/);
  });
});
