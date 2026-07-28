import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { OpenedDb } from "../src/db/client.js";
import { listMembers, playerLists, players } from "../src/db/schema.js";
import {
  BlankListNameError,
  CannotDeleteDefaultListError,
  DuplicateListNameError,
  InvalidListConfigError,
  NoDefaultListError,
  UnknownListError,
  addPlayerIdsToLiveList,
  addToList,
  configureList,
  createList,
  deleteList,
  listLists,
  listMemberIds,
  listMembersOf,
  removeFromList,
  renameList,
  resolveDefaultList,
  resolveListByName,
  resolveListOrDefault,
  setDefaultList,
} from "../src/lists/service.js";
import { PlayerNotFoundError } from "../src/watchlist/service.js";
import { fakeClock, insertPlayer, testDb } from "./factories.js";

/**
 * How many lists a freshly migrated database already holds: exactly one, the
 * default lane `Watchlist` seeded by drizzle/0012 (#190). Named rather than
 * folded into each literal so a count here still reads as "the lists this test
 * created", plus the one it inherited.
 */
const SEEDED_LISTS = 1;

/**
 * Named-list service (issue #70 / ADR 0046). Every assertion is over DB/content
 * state, not a bare return; the clock is always injected (rules/testing.md).
 */
describe("lists service", () => {
  let opened: OpenedDb;
  const clock = fakeClock("2026-07-19T17:00:00.000Z");

  beforeEach(() => {
    opened = testDb();
  });
  afterEach(() => {
    opened.close();
  });

  describe("createList", () => {
    it("creates a live list and trims the name", async () => {
      const list = await createList(opened.db, "  Prospects  ", clock.now());
      expect(list.name).toBe("Prospects");
      expect(list.deletedAt).toBeNull();
      const rows = await opened.db.select().from(playerLists);
      expect(rows).toHaveLength(SEEDED_LISTS + 1);
    });

    it("rejects a duplicate live name", async () => {
      await createList(opened.db, "Dupes", clock.now());
      await expect(createList(opened.db, "Dupes", clock.now())).rejects.toBeInstanceOf(
        DuplicateListNameError,
      );
      expect(await opened.db.select().from(playerLists)).toHaveLength(SEEDED_LISTS + 1);
    });

    it("rejects a blank/whitespace name", async () => {
      await expect(createList(opened.db, "   ", clock.now())).rejects.toBeInstanceOf(
        BlankListNameError,
      );
    });

    it("is case-sensitive (two names differing only in case coexist)", async () => {
      await createList(opened.db, "prospects", clock.now());
      await createList(opened.db, "Prospects", clock.now());
      expect(await opened.db.select().from(playerLists)).toHaveLength(SEEDED_LISTS + 2);
    });
  });

  describe("renameList", () => {
    it("renames a live list", async () => {
      await createList(opened.db, "Old", clock.now());
      const renamed = await renameList(opened.db, "Old", "New", clock.now());
      expect(renamed.name).toBe("New");
      await expect(resolveListByName(opened.db, "Old")).rejects.toBeInstanceOf(UnknownListError);
      expect((await resolveListByName(opened.db, "New")).id).toBe(renamed.id);
    });

    it("rejects an unknown list", async () => {
      await expect(renameList(opened.db, "ghost", "x", clock.now())).rejects.toBeInstanceOf(
        UnknownListError,
      );
    });

    it("rejects a collision with another live list", async () => {
      await createList(opened.db, "A", clock.now());
      await createList(opened.db, "B", clock.now());
      await expect(renameList(opened.db, "A", "B", clock.now())).rejects.toBeInstanceOf(
        DuplicateListNameError,
      );
    });
  });

  describe("deleteList (soft)", () => {
    it("hides the list, frees the name, and makes it unresolvable for scoping", async () => {
      const created = await createList(opened.db, "Temp", clock.now());
      const deleted = await deleteList(opened.db, "Temp", clock.now());
      expect(deleted.deletedAt).not.toBeNull();

      // Gone from listLists and unresolvable...
      expect(await listLists(opened.db)).toHaveLength(SEEDED_LISTS);
      await expect(resolveListByName(opened.db, "Temp")).rejects.toBeInstanceOf(UnknownListError);

      // ...but the name is reusable, and that is a NEW row (soft-delete kept the old).
      const reused = await createList(opened.db, "Temp", clock.now());
      expect(reused.id).not.toBe(created.id);
      expect(await opened.db.select().from(playerLists)).toHaveLength(SEEDED_LISTS + 2);
    });
  });

  describe("listLists", () => {
    it("returns live lists with active-member counts, ordered by name", async () => {
      const a = await createList(opened.db, "Alpha", clock.now());
      await createList(opened.db, "Bravo", clock.now());
      const p1 = await insertPlayer(opened.db);
      const p2 = await insertPlayer(opened.db);
      const inactive = await insertPlayer(opened.db, { active: false });
      await addToList(opened.db, "Alpha", [p1.externalId!, p2.externalId!], clock.now());
      // A deactivated member is not counted (players.active is the master gate).
      await opened.db.insert(listMembers).values({
        listId: a.id,
        playerId: inactive.id,
        createdAt: "2026-07-19T17:00:00.000Z",
      });

      const summaries = await listLists(opened.db);
      // The seeded default lane sorts last by name (#190).
      expect(summaries.map((s) => s.name)).toEqual(["Alpha", "Bravo", "Watchlist"]);
      expect(summaries[0]?.memberCount).toBe(2);
      expect(summaries[1]?.memberCount).toBe(0);
      expect(summaries.map((s) => s.isDefault)).toEqual([false, false, true]);
    });
  });

  describe("addToList / removeFromList", () => {
    it("adds members and is idempotent on re-add", async () => {
      await createList(opened.db, "L", clock.now());
      const p = await insertPlayer(opened.db);
      const first = await addToList(opened.db, "L", [p.externalId!], clock.now());
      expect(first.changed).toBe(1);
      const again = await addToList(opened.db, "L", [p.externalId!], clock.now());
      expect(again.changed).toBe(0);
      const rows = await opened.db.select().from(listMembers);
      expect(rows).toHaveLength(1);
    });

    it("adds multiple players by mixed ref types", async () => {
      const list = await createList(opened.db, "L", clock.now());
      const mlb = await insertPlayer(opened.db);
      const ncaa = await insertPlayer(opened.db, {
        externalId: null,
        highlightlyPlayerId: 555,
        highlightlyTeamId: 10,
        level: "ncaa",
        milbLevel: null,
      });
      const result = await addToList(
        opened.db,
        "L",
        [mlb.externalId!, { kind: "highlightly", playerId: 555 }],
        clock.now(),
      );
      expect(result.changed).toBe(2);
      const ids = await listMemberIds(opened.db, list.id);
      expect(ids).toEqual([mlb.id, ncaa.id]);
    });

    it("rejects an unknown list on add, writing nothing", async () => {
      const p = await insertPlayer(opened.db);
      await expect(
        addToList(opened.db, "ghost", [p.externalId!], clock.now()),
      ).rejects.toBeInstanceOf(UnknownListError);
      expect(await opened.db.select().from(listMembers)).toHaveLength(0);
    });

    it("rejects an unknown player ref on add, writing nothing", async () => {
      await createList(opened.db, "L", clock.now());
      const p = await insertPlayer(opened.db);
      await expect(
        addToList(opened.db, "L", [p.externalId!, 99999999], clock.now()),
      ).rejects.toBeInstanceOf(PlayerNotFoundError);
      expect(await opened.db.select().from(listMembers)).toHaveLength(0);
    });

    it("removes a member and no-ops on a non-member", async () => {
      const list = await createList(opened.db, "L", clock.now());
      const p = await insertPlayer(opened.db);
      const other = await insertPlayer(opened.db);
      await addToList(opened.db, "L", [p.externalId!], clock.now());

      const removed = await removeFromList(opened.db, "L", [p.externalId!], clock.now());
      expect(removed.changed).toBe(1);
      expect(await listMemberIds(opened.db, list.id)).toEqual([]);

      const noop = await removeFromList(opened.db, "L", [other.externalId!], clock.now());
      expect(noop.changed).toBe(0);
    });

    it("rejects an unknown list on remove", async () => {
      const p = await insertPlayer(opened.db);
      await expect(
        removeFromList(opened.db, "ghost", [p.externalId!], clock.now()),
      ).rejects.toBeInstanceOf(UnknownListError);
    });
  });

  describe("listMembersOf", () => {
    it("returns active members ordered by id and excludes a deactivated member", async () => {
      const list = await createList(opened.db, "L", clock.now());
      const p1 = await insertPlayer(opened.db);
      const p2 = await insertPlayer(opened.db);
      await addToList(opened.db, "L", [p1.externalId!, p2.externalId!], clock.now());
      // Deactivate p1: still a member row, but not an active member.
      await opened.db.update(players).set({ active: false }).where(eq(players.id, p1.id));

      const members = await listMembersOf(opened.db, "L");
      expect(members.map((m) => m.id)).toEqual([p2.id]);
      // The membership row itself is untouched by deactivation.
      expect(await opened.db.select().from(listMembers).where(eq(listMembers.listId, list.id))).toHaveLength(2);
    });

    it("returns [] for an empty list", async () => {
      await createList(opened.db, "Empty", clock.now());
      expect(await listMembersOf(opened.db, "Empty")).toEqual([]);
    });
  });

  it("a player in two lists appears in both (many-to-many)", async () => {
    const a = await createList(opened.db, "A", clock.now());
    const b = await createList(opened.db, "B", clock.now());
    const p = await insertPlayer(opened.db);
    await addToList(opened.db, "A", [p.externalId!], clock.now());
    await addToList(opened.db, "B", [p.externalId!], clock.now());
    expect(await listMemberIds(opened.db, a.id)).toEqual([p.id]);
    expect(await listMemberIds(opened.db, b.id)).toEqual([p.id]);
  });
});

/**
 * The default LANE (#190): the list an unscoped command means. Everything here
 * asserts DB state, and the constraint tests drive the DATABASE's own refusal —
 * a service-level guard that agrees with an index proves nothing about what
 * happens under concurrency, which is the case the index exists for.
 */
describe("default list / lane (#190)", () => {
  let opened: OpenedDb;
  const clock = fakeClock("2026-07-19T17:00:00.000Z");

  beforeEach(() => {
    opened = testDb();
  });
  afterEach(() => {
    opened.close();
  });

  /** The lane drizzle/0012 seeds into every freshly migrated database. */
  async function seededLane() {
    return resolveDefaultList(opened.db);
  }

  describe("schema constraints", () => {
    it("refuses a second LIVE default", async () => {
      await expect(
        opened.db.insert(playerLists).values({
          name: "Rival",
          isDefault: true,
          createdAt: "2026-07-19T17:00:00.000Z",
          updatedAt: "2026-07-19T17:00:00.000Z",
        }),
      ).rejects.toThrow(/UNIQUE constraint failed/i);
      expect(await listLists(opened.db)).toHaveLength(SEEDED_LISTS);
    });

    it("lets a SOFT-DELETED default coexist with a live one", async () => {
      // The case a non-partial index would silently break: once the default is
      // deleted, no replacement could ever be set, and every unscoped command
      // would fail forever.
      const lane = await seededLane();
      await opened.db
        .update(playerLists)
        .set({ deletedAt: "2026-07-19T17:00:00.000Z" })
        .where(eq(playerLists.id, lane.id));

      const replacement = await opened.db
        .insert(playerLists)
        .values({
          name: "Replacement",
          isDefault: true,
          createdAt: "2026-07-19T17:00:00.000Z",
          updatedAt: "2026-07-19T17:00:00.000Z",
        })
        .returning();
      expect(replacement[0]?.isDefault).toBe(true);
      expect((await resolveDefaultList(opened.db)).name).toBe("Replacement");
    });

    it("refuses a NULL list_id on a delivery", async () => {
      // THE NULL TRAP. SQLite treats NULLs as DISTINCT in a unique index, so a
      // nullable list_id would permit unlimited (digest, <date>, NULL) rows and
      // silently void the slot uniqueness ADR 0034's durable claim rests on.
      // Verified by the rules/testing.md discipline: dropping `NOT NULL` from
      // the rebuilt table in drizzle/0012 makes THIS named test fail and no
      // other, so the guard is known to bite.
      // Driven on the RAW handle so the assertion sees SQLite's own message
      // rather than drizzle's wrapper — the point is which constraint fired.
      expect(() =>
        opened.sqlite
          .prepare(
            "INSERT INTO digest_deliveries (kind, date_covered, status, created_at, list_id) VALUES ('digest', '2026-07-19', 'sent', '2026-07-19T17:00:00.000Z', NULL)",
          )
          .run(),
      ).toThrow(/NOT NULL constraint failed: digest_deliveries\.list_id/i);
    });

    it("bounds digest_hour at BOTH ends", async () => {
      for (const digestHour of [24, -1]) {
        await expect(
          opened.db.insert(playerLists).values({
            name: `Hour ${digestHour}`,
            digestHour,
            createdAt: "2026-07-19T17:00:00.000Z",
            updatedAt: "2026-07-19T17:00:00.000Z",
          }),
        ).rejects.toThrow(/player_lists_digest_hour_range_ck/);
      }
      // 0 and 23 are legal hours, so the bound rejects only what it should.
      for (const digestHour of [0, 23]) {
        await opened.db.insert(playerLists).values({
          name: `Hour ${digestHour}`,
          digestHour,
          createdAt: "2026-07-19T17:00:00.000Z",
          updatedAt: "2026-07-19T17:00:00.000Z",
        });
      }
      expect(await listLists(opened.db)).toHaveLength(SEEDED_LISTS + 2);
    });

    it("bounds refresh_interval_minutes at BOTH ends", async () => {
      for (const refreshIntervalMinutes of [0, -1]) {
        await expect(
          opened.db.insert(playerLists).values({
            name: `Interval ${refreshIntervalMinutes}`,
            refreshIntervalMinutes,
            createdAt: "2026-07-19T17:00:00.000Z",
            updatedAt: "2026-07-19T17:00:00.000Z",
          }),
        ).rejects.toThrow(/player_lists_refresh_interval_positive_ck/);
      }
      await opened.db.insert(playerLists).values({
        name: "Interval 1",
        refreshIntervalMinutes: 1,
        createdAt: "2026-07-19T17:00:00.000Z",
        updatedAt: "2026-07-19T17:00:00.000Z",
      });
      expect(await listLists(opened.db)).toHaveLength(SEEDED_LISTS + 1);
    });
  });

  describe("setDefaultList", () => {
    it("moves the flag atomically: the prior default is cleared and the new one set", async () => {
      const previous = await seededLane();
      await createList(opened.db, "Next", clock.now());

      const now = await setDefaultList(opened.db, "Next", clock.now());
      expect(now.name).toBe("Next");

      // BOTH rows asserted — a test that checked only the new default would pass
      // against an implementation that left two defaults behind in a database
      // without the index.
      const rows = await opened.db.select().from(playerLists).orderBy(playerLists.id);
      expect(rows.map((r) => [r.name, r.isDefault])).toEqual([
        [previous.name, false],
        ["Next", true],
      ]);
      expect((await resolveDefaultList(opened.db)).id).toBe(now.id);
    });

    it("sets a default when none exists", async () => {
      const lane = await seededLane();
      await opened.db.update(playerLists).set({ isDefault: false }).where(eq(playerLists.id, lane.id));
      await expect(resolveDefaultList(opened.db)).rejects.toBeInstanceOf(NoDefaultListError);

      await setDefaultList(opened.db, lane.name, clock.now());
      expect((await resolveDefaultList(opened.db)).id).toBe(lane.id);
    });

    it("is an idempotent no-op on the CURRENT default and writes nothing", async () => {
      const lane = await seededLane();
      const again = await setDefaultList(opened.db, lane.name, new Date("2027-01-01T00:00:00.000Z"));
      expect(again).toEqual(lane);
      // Not merely equal by id: `updated_at` is untouched, so a re-run does not
      // read as a change in an audit.
      const stored = (await opened.db.select().from(playerLists).where(eq(playerLists.id, lane.id)))[0];
      expect(stored?.updatedAt).toBe(lane.updatedAt);
    });

    it("rejects an unknown list and moves nothing", async () => {
      const before = await opened.db.select().from(playerLists).orderBy(playerLists.id);
      await expect(setDefaultList(opened.db, "ghost", clock.now())).rejects.toBeInstanceOf(
        UnknownListError,
      );
      expect(await opened.db.select().from(playerLists).orderBy(playerLists.id)).toEqual(before);
    });

    it("rejects a SOFT-DELETED list and moves nothing", async () => {
      await createList(opened.db, "Temp", clock.now());
      await deleteList(opened.db, "Temp", clock.now());
      await expect(setDefaultList(opened.db, "Temp", clock.now())).rejects.toBeInstanceOf(
        UnknownListError,
      );
      expect((await resolveDefaultList(opened.db)).name).toBe("Watchlist");
    });
  });

  describe("deleteList refuses the default", () => {
    it("refuses, leaving the list live and still the default", async () => {
      const lane = await seededLane();
      await expect(deleteList(opened.db, lane.name, clock.now())).rejects.toBeInstanceOf(
        CannotDeleteDefaultListError,
      );

      // Nothing half-applied: still live, still default, `updated_at` untouched.
      const stored = (await opened.db.select().from(playerLists).where(eq(playerLists.id, lane.id)))[0];
      expect(stored).toEqual(lane);
    });

    it("names the recovery command in the error", async () => {
      const lane = await seededLane();
      await expect(deleteList(opened.db, lane.name, clock.now())).rejects.toThrow(
        /set another default first: sk players lists set-default --name NAME/,
      );
    });

    it("refuses a list that BECAME the default, deciding on live state rather than a prior read", async () => {
      // The interleaving finding-5 guards against: an implementation that reads
      // "is this the default?" and then deletes on the answer would delete a
      // list that became the default in the gap, leaving NO default at all.
      // Deletion here is one conditional UPDATE inside BEGIN IMMEDIATE, so the
      // predicate is evaluated against the row the write itself sees.
      await createList(opened.db, "Promoted", clock.now());
      const seeded = await seededLane();
      expect(await deleteList(opened.db, "Promoted", clock.now())).toMatchObject({ name: "Promoted" });

      // Same list name, re-created and THEN promoted: now the same call is refused.
      await createList(opened.db, "Promoted", clock.now());
      await setDefaultList(opened.db, "Promoted", clock.now());
      await expect(deleteList(opened.db, "Promoted", clock.now())).rejects.toBeInstanceOf(
        CannotDeleteDefaultListError,
      );
      expect((await resolveDefaultList(opened.db)).name).toBe("Promoted");
      // And the previously-seeded lane really did lose the flag, so the refusal
      // is not an artifact of two lists both claiming it.
      const previous = (await opened.db.select().from(playerLists).where(eq(playerLists.id, seeded.id)))[0];
      expect(previous?.isDefault).toBe(false);
    });

    it("still deletes a NON-default list", async () => {
      await createList(opened.db, "Ordinary", clock.now());
      const deleted = await deleteList(opened.db, "Ordinary", clock.now());
      expect(deleted.deletedAt).not.toBeNull();
    });

    it("reports an unknown list as unknown, not as the default", async () => {
      await expect(deleteList(opened.db, "ghost", clock.now())).rejects.toBeInstanceOf(
        UnknownListError,
      );
    });
  });

  describe("resolveDefaultList / resolveListOrDefault", () => {
    it("throws NoDefaultListError when no LIVE default exists", async () => {
      const lane = await seededLane();
      await opened.db.update(playerLists).set({ isDefault: false }).where(eq(playerLists.id, lane.id));
      await expect(resolveDefaultList(opened.db)).rejects.toBeInstanceOf(NoDefaultListError);
      await expect(resolveDefaultList(opened.db)).rejects.toThrow(
        /run: sk players lists set-default --name NAME/,
      );
    });

    it("ignores a soft-deleted default", async () => {
      const lane = await seededLane();
      await opened.db
        .update(playerLists)
        .set({ deletedAt: "2026-07-19T17:00:00.000Z" })
        .where(eq(playerLists.id, lane.id));
      await expect(resolveDefaultList(opened.db)).rejects.toBeInstanceOf(NoDefaultListError);
    });

    it("prefers an EXPLICIT name over the default", async () => {
      const explicit = await createList(opened.db, "Explicit", clock.now());
      expect((await resolveListOrDefault(opened.db, "Explicit")).id).toBe(explicit.id);
    });

    it("resolves the default when no name is given", async () => {
      const lane = await seededLane();
      expect((await resolveListOrDefault(opened.db)).id).toBe(lane.id);
    });

    it("FAILS CLOSED on a soft-deleted name instead of falling back to the default", async () => {
      // The property that keeps a typo from silently widening a scope: a name
      // that no longer resolves is an error, never "well, use the default then".
      await createList(opened.db, "Gone", clock.now());
      await deleteList(opened.db, "Gone", clock.now());
      await expect(resolveListOrDefault(opened.db, "Gone")).rejects.toBeInstanceOf(UnknownListError);
    });

    it("FAILS CLOSED on an unknown name instead of falling back to the default", async () => {
      await expect(resolveListOrDefault(opened.db, "ghost")).rejects.toBeInstanceOf(
        UnknownListError,
      );
    });
  });
  describe("configureList (#191)", () => {
    /** The three cadence columns as stored. */
    const cadence = async (id: number) => {
      const row = (await opened.db.select().from(playerLists).where(eq(playerLists.id, id)))[0]!;
      return { every: row.refreshIntervalMinutes, hour: row.digestHour, to: row.digestTo };
    };

    it("writes ONLY the supplied keys — absent means untouched, null means cleared", async () => {
      const lane = await createList(opened.db, "Lane", clock.now());
      await configureList(opened.db, "Lane", { refreshIntervalMinutes: 60, digestHour: 5, digestTo: "hc@example.com" }, clock.now());

      // An absent key leaves its column alone...
      await configureList(opened.db, "Lane", { digestHour: 9 }, clock.now());
      expect(await cadence(lane.id)).toEqual({ every: 60, hour: 9, to: "hc@example.com" });
      // ...and an explicit null clears exactly that one.
      await configureList(opened.db, "Lane", { digestTo: null }, clock.now());
      expect(await cadence(lane.id)).toEqual({ every: 60, hour: 9, to: null });
    });

    it("enforces the bounds at the SERVICE, independently of the router", async () => {
      // The router validates too, but this function is reachable from a test, a
      // future REST/MCP surface, and any caller that never sees an option table.
      // "The router checked it" is an assumption, not a guarantee.
      await createList(opened.db, "Lane", clock.now());
      for (const patch of [
        { digestHour: 24 },
        { digestHour: -1 },
        { digestHour: 1.5 },
        { refreshIntervalMinutes: 0 },
        { refreshIntervalMinutes: -5 },
        { digestTo: "   " },
        { digestTo: "a\nBcc: x@y" },
      ]) {
        await expect(configureList(opened.db, "Lane", patch, clock.now()), JSON.stringify(patch))
          .rejects.toBeInstanceOf(InvalidListConfigError);
      }
      // Nothing was written by any of them.
      const row = (await opened.db.select().from(playerLists).where(eq(playerLists.name, "Lane")))[0]!;
      expect([row.refreshIntervalMinutes, row.digestHour, row.digestTo]).toEqual([null, null, null]);
    });

    it("accepts hour 0 and hour 23, the inclusive bounds the DB CHECK allows", async () => {
      const lane = await createList(opened.db, "Lane", clock.now());
      await configureList(opened.db, "Lane", { digestHour: 0 }, clock.now());
      expect((await cadence(lane.id)).hour).toBe(0);
      await configureList(opened.db, "Lane", { digestHour: 23 }, clock.now());
      expect((await cadence(lane.id)).hour).toBe(23);
    });

    it("refuses an EMPTY patch rather than silently bumping updated_at", async () => {
      await createList(opened.db, "Lane", clock.now());
      await expect(configureList(opened.db, "Lane", {}, clock.now()))
        .rejects.toBeInstanceOf(InvalidListConfigError);
    });

    it("throws UnknownListError for an unknown or SOFT-DELETED list", async () => {
      await expect(configureList(opened.db, "ghost", { digestHour: 5 }, clock.now()))
        .rejects.toBeInstanceOf(UnknownListError);
      await createList(opened.db, "Gone", clock.now());
      await deleteList(opened.db, "Gone", clock.now());
      await expect(configureList(opened.db, "Gone", { digestHour: 5 }, clock.now()))
        .rejects.toBeInstanceOf(UnknownListError);
    });
  });

  describe("addPlayerIdsToLiveList (#191)", () => {
    it("attaches idempotently and reports only rows actually written", async () => {
      const lane = await createList(opened.db, "Lane", clock.now());
      const player = await insertPlayer(opened.db);
      expect(await addPlayerIdsToLiveList(opened.db, lane, [player.id], clock.now())).toBe(1);
      // A re-attach conflicts on the unique key and is a no-op.
      expect(await addPlayerIdsToLiveList(opened.db, lane, [player.id], clock.now())).toBe(0);
      expect(await opened.db.select().from(listMembers).where(eq(listMembers.listId, lane.id))).toHaveLength(1);
    });

    it("REFUSES a lane soft-deleted after it was resolved, writing no membership row", async () => {
      // The check-then-act gap `sk players add` opens: the lane is resolved,
      // then a network call and a player insert happen, and only then is
      // membership written. A `lists delete` landing in between would otherwise
      // attach a player to a dead lane — invisible to every scope query.
      const lane = await createList(opened.db, "Lane", clock.now());
      const player = await insertPlayer(opened.db);
      await deleteList(opened.db, "Lane", clock.now());

      await expect(addPlayerIdsToLiveList(opened.db, lane, [player.id], clock.now()))
        .rejects.toBeInstanceOf(UnknownListError);
      // The refusal NAMES the lane rather than quoting a bare id at the operator.
      await expect(addPlayerIdsToLiveList(opened.db, lane, [player.id], clock.now()))
        .rejects.toThrow(/no list named "Lane"/);
      expect(await opened.db.select().from(listMembers).where(eq(listMembers.listId, lane.id))).toHaveLength(0);
    });

    it("is a no-op for an empty id list", async () => {
      const lane = await createList(opened.db, "Lane", clock.now());
      expect(await addPlayerIdsToLiveList(opened.db, lane, [], clock.now())).toBe(0);
    });
  });
});
