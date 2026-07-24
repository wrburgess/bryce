import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { OpenedDb } from "../src/db/client.js";
import { listMembers, playerLists, players } from "../src/db/schema.js";
import {
  BlankListNameError,
  DuplicateListNameError,
  UnknownListError,
  addToList,
  createList,
  deleteList,
  listLists,
  listMemberIds,
  listMembersOf,
  removeFromList,
  renameList,
  resolveListByName,
} from "../src/lists/service.js";
import { PlayerNotFoundError } from "../src/watchlist/service.js";
import { fakeClock, insertPlayer, testDb } from "./factories.js";

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
      expect(rows).toHaveLength(1);
    });

    it("rejects a duplicate live name", async () => {
      await createList(opened.db, "Dupes", clock.now());
      await expect(createList(opened.db, "Dupes", clock.now())).rejects.toBeInstanceOf(
        DuplicateListNameError,
      );
      expect(await opened.db.select().from(playerLists)).toHaveLength(1);
    });

    it("rejects a blank/whitespace name", async () => {
      await expect(createList(opened.db, "   ", clock.now())).rejects.toBeInstanceOf(
        BlankListNameError,
      );
    });

    it("is case-sensitive (two names differing only in case coexist)", async () => {
      await createList(opened.db, "prospects", clock.now());
      await createList(opened.db, "Prospects", clock.now());
      expect(await opened.db.select().from(playerLists)).toHaveLength(2);
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
      expect(await listLists(opened.db)).toHaveLength(0);
      await expect(resolveListByName(opened.db, "Temp")).rejects.toBeInstanceOf(UnknownListError);

      // ...but the name is reusable, and that is a NEW row (soft-delete kept the old).
      const reused = await createList(opened.db, "Temp", clock.now());
      expect(reused.id).not.toBe(created.id);
      expect(await opened.db.select().from(playerLists)).toHaveLength(2);
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
      expect(summaries.map((s) => s.name)).toEqual(["Alpha", "Bravo"]);
      expect(summaries[0]?.memberCount).toBe(2);
      expect(summaries[1]?.memberCount).toBe(0);
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
        ncaaPlayerSeq: 555,
        level: "ncaa",
        milbLevel: null,
      });
      const result = await addToList(
        opened.db,
        "L",
        [mlb.externalId!, { ncaaPlayerSeq: 555 }],
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
