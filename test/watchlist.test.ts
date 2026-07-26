import { describe, expect, it } from "vitest";
import { HighlightlyIdentityMismatchError } from "../src/highlightly/client.js";
import { claimRefreshRun } from "../src/jobs/refresh-run.js";
import { eq } from "drizzle-orm";
import { highlightlyPlayerCursors, listMembers, playerLists, playerTags, players, statLines } from "../src/db/schema.js";
import { PlayerNotFoundError, PlayerPromotionConflictError, UnknownPersonError, addHighlightlyNcaaPlayer, deactivatePlayer, promoteHighlightlyNcaaPlayer } from "../src/watchlist/service.js";
import { MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, insertPlayer, insertPlayerTag, insertStatLine, testDb } from "./factories.js";

describe("watchlist NCAA identity", () => {
  it("adds by explicit Highlightly identity", async () => {
    const opened = testDb();
    try {
      const result = await addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      expect(result.player).toMatchObject({ level: "ncaa", highlightlyPlayerId: 501, ncaaPlayerSeq: null });
    } finally { opened.close(); }
  });

  it("rejects a name/team assertion that does not match Highlightly", async () => {
    const opened = testDb();
    try {
      await expect(addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "Wrong", teamId: 10 })).rejects.toBeInstanceOf(HighlightlyIdentityMismatchError);
    } finally { opened.close(); }
  });

  it("deactivates by Highlightly ID while retaining the row", async () => {
    const opened = testDb();
    try {
      await addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: fakeClock(MID_SEASON).now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      const player = await deactivatePlayer({ db: opened.db, now: fakeClock(MID_SEASON).now }, { kind: "highlightly", playerId: 501 });
      expect(player.active).toBe(false);
    } finally { opened.close(); }
  });

  it("promotes the same Highlightly NCAA row to MLB and retires its NCAA address", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      const deps = {
        db: opened.db,
        client: {
          findPerson: async () => ({ id: 77, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }),
          getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }),
        } as never,
        highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ,
      };
      const before = await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      const after = await promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 });
      expect(after).toMatchObject({ id: before.player.id, externalId: 77, level: "mlb", highlightlyPlayerId: null, ncaaPlayerSeq: null, ncaaSourceState: null });
      await expect(deactivatePlayer({ db: opened.db, now: clock.now }, { kind: "highlightly", playerId: 501 })).rejects.toBeInstanceOf(PlayerNotFoundError);
    } finally { opened.close(); }
  });

  it("preserves history, lists, notes, and manual tags while replacing derived tags and the NCAA cursor", async () => {
    const opened = testDb(); const clock = fakeClock(MID_SEASON);
    try {
      const deps = { db: opened.db, client: {
        findPerson: async () => ({ id: 77, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }),
        getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }),
      } as never, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ };
      const source = await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      await opened.db.update(players).set({ notes: "keep this note" }).where(eq(players.id, source.player.id));
      await insertStatLine(opened.db, { playerId: source.player.id });
      const list = (await opened.db.insert(playerLists).values({ name: "College prospects", createdAt: MID_SEASON, updatedAt: MID_SEASON }).returning())[0]!;
      await opened.db.insert(listMembers).values({ listId: list.id, playerId: source.player.id, createdAt: MID_SEASON });
      await insertPlayerTag(opened.db, { playerId: source.player.id, namespace: "status", value: "watch", source: "manual" });
      await opened.db.update(highlightlyPlayerCursors).set({ nextMatchDate: "2026-03-01" }).where(eq(highlightlyPlayerCursors.playerId, source.player.id));

      const promoted = await promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 });
      expect(promoted).toMatchObject({ id: source.player.id, notes: "keep this note", schoolName: null, externalId: 77, level: "mlb" });
      expect(await opened.db.select().from(statLines).where(eq(statLines.playerId, source.player.id))).toHaveLength(1);
      expect(await opened.db.select().from(listMembers).where(eq(listMembers.playerId, source.player.id))).toHaveLength(1);
      expect(await opened.db.select().from(highlightlyPlayerCursors).where(eq(highlightlyPlayerCursors.playerId, source.player.id))).toEqual([]);
      const tags = await opened.db.select().from(playerTags).where(eq(playerTags.playerId, source.player.id));
      expect(tags).toContainEqual(expect.objectContaining({ namespace: "status", value: "watch", source: "manual" }));
      expect(tags).toContainEqual(expect.objectContaining({ namespace: "level", value: "mlb", source: "derived" }));
      expect(tags).not.toContainEqual(expect.objectContaining({ namespace: "level", value: "ncaa", source: "derived" }));
    } finally { opened.close(); }
  });

  it("leaves the NCAA row untouched on unknown-person and typed identity conflicts, then permits a retry", async () => {
    const opened = testDb(); const clock = fakeClock(MID_SEASON);
    try {
      const client = { findPerson: async (id: number) => id === 404 ? null : ({ id, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }), getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }) } as never;
      const deps = { db: opened.db, client, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ };
      await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      await insertPlayer(opened.db, { externalId: 77 });
      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 404 })).rejects.toBeInstanceOf(UnknownPersonError);
      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 })).rejects.toBeInstanceOf(PlayerPromotionConflictError);
      expect((await opened.db.select().from(players).where(eq(players.highlightlyPlayerId, 501)))[0]).toMatchObject({ level: "ncaa", externalId: null });
      await opened.db.delete(players).where(eq(players.externalId, 77));
      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 })).resolves.toMatchObject({ externalId: 77, level: "mlb" });
    } finally { opened.close(); }
  });

  it("refuses an inactive Highlightly source before it can be promoted", async () => {
    const opened = testDb(); const clock = fakeClock(MID_SEASON);
    try {
      const deps = { db: opened.db, client: {
        findPerson: async () => ({ id: 77, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }),
        getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }),
      } as never, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ };
      const source = await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      await deactivatePlayer({ db: opened.db, now: clock.now }, { kind: "highlightly", playerId: 501 });

      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 }))
        .rejects.toBeInstanceOf(PlayerNotFoundError);
      expect((await opened.db.select().from(players).where(eq(players.id, source.player.id)))[0])
        .toMatchObject({ active: false, externalId: null, highlightlyPlayerId: 501, level: "ncaa" });
    } finally { opened.close(); }
  });

  it("rolls back the identity change when derived-tag maintenance faults", async () => {
    const opened = testDb(); const clock = fakeClock(MID_SEASON);
    try {
      const deps = { db: opened.db, client: {
        findPerson: async () => ({ id: 77, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }),
        getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }),
      } as never, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ };
      const source = await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      opened.sqlite.exec("CREATE TRIGGER promotion_tag_fault BEFORE INSERT ON player_tags BEGIN SELECT RAISE(ABORT, 'promotion tag fault'); END;");

      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 })).rejects.toThrow("promotion tag fault");
      expect((await opened.db.select().from(players).where(eq(players.id, source.player.id)))[0])
        .toMatchObject({ externalId: null, highlightlyPlayerId: 501, ncaaSourceState: "highlightly_active", level: "ncaa" });
    } finally { opened.close(); }
  });

  it("maps a unique-index race to a stable conflict and permits only one concurrent attempt", async () => {
    const opened = testDb(); const clock = fakeClock(MID_SEASON);
    try {
      const deps = { db: opened.db, client: {
        findPerson: async () => ({ id: 77, fullName: "Pro Guy", primaryPosition: { abbreviation: "SS" } }),
        getTeam: async () => ({ id: 1, name: "Unused", sport: { id: 1 } }),
      } as never, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ };
      await addHighlightlyNcaaPlayer(deps, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      opened.sqlite.exec("CREATE TRIGGER promotion_unique_fault BEFORE UPDATE ON players WHEN NEW.external_id = 77 BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: players.external_id'); END;");
      await expect(promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 }))
        .rejects.toBeInstanceOf(PlayerPromotionConflictError);
      opened.sqlite.exec("DROP TRIGGER promotion_unique_fault");

      const attempts = await Promise.allSettled([
        promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 }),
        promoteHighlightlyNcaaPlayer(deps, { highlightlyPlayerId: 501, personId: 77 }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      expect(await opened.db.select().from(players).where(eq(players.externalId, 77))).toHaveLength(1);
    } finally { opened.close(); }
  });

  it("returns the deferred first-refresh reason while a whole sweep is live", async () => {
    const opened = testDb();
    const clock = fakeClock(MID_SEASON);
    try {
      expect(claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 }).claimed).toBe(true);
      const result = await addHighlightlyNcaaPlayer({
        db: opened.db, client: {} as never, highlightlyClient: fakeHighlightlyClient(), now: clock.now, tz: TEST_TZ,
      }, { playerId: 501, canonicalName: "C Guy", teamId: 10 });
      expect(result.refresh).toMatchObject({ skipped: true, reason: "whole-refresh-running", inserted: 0, updated: 0 });
    } finally { opened.close(); }
  });
});
