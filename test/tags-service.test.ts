import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { OpenedDb } from "../src/db/client.js";
import { players } from "../src/db/schema.js";
import {
  ManualWriteToDerivedNamespaceError,
  UnknownTagError,
  addManualTag,
  listTags,
  parseTagSelector,
  playerIdsMatchingTags,
  removeManualTag,
  syncAllDerivedTags,
  syncDerivedTags,
} from "../src/tags/service.js";
import { fakeClock, insertPlayer, insertStatLine, testDb } from "./factories.js";

const NOW = new Date("2026-07-19T17:00:00.000Z");

describe("tag service", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  /** All tags for a player as a `namespace:value:source` set. */
  const tagKeys = (playerId: number): Set<string> =>
    new Set(listTags(opened.db, playerId).map((t) => `${t.namespace}:${t.value}:${t.source}`));

  describe("syncDerivedTags", () => {
    it("is idempotent: running twice yields the identical set with no duplicates", async () => {
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      syncDerivedTags(opened.db, player.id, NOW);
      const first = tagKeys(player.id);
      syncDerivedTags(opened.db, player.id, NOW);
      const second = tagKeys(player.id);
      expect(second).toEqual(first);
      expect(listTags(opened.db, player.id)).toHaveLength(first.size);
    });

    it("leaves manual tags untouched while replacing derived ones", async () => {
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      addManualTag(opened.db, player.id, "status", "rostered", NOW);
      syncDerivedTags(opened.db, player.id, NOW);
      expect(tagKeys(player.id).has("status:rostered:manual")).toBe(true);

      // A level change replaces the derived level tag; the manual tag survives.
      await opened.db.update(players).set({ milbLevel: "Double-A" }).where(eq(players.id, player.id));
      syncDerivedTags(opened.db, player.id, NOW);
      const keys = tagKeys(player.id);
      expect(keys.has("status:rostered:manual")).toBe(true);
      expect(keys.has("level:aa:derived")).toBe(true);
      expect(keys.has("level:aaa:derived")).toBe(false);
    });

    it("promotion Rookie -> AA -> AAA -> MLB moves level: and drops prospect at MLB", async () => {
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Rookie", position: "SS" });
      syncDerivedTags(opened.db, player.id, NOW);
      expect(tagKeys(player.id).has("level:rookie:derived")).toBe(true);
      expect(tagKeys(player.id).has("prospect:prospect:derived")).toBe(true);

      for (const [milbLevel, tag] of [
        ["Double-A", "level:aa:derived"],
        ["Triple-A", "level:aaa:derived"],
      ] as const) {
        await opened.db.update(players).set({ milbLevel }).where(eq(players.id, player.id));
        syncDerivedTags(opened.db, player.id, NOW);
        const keys = tagKeys(player.id);
        expect(keys.has(tag)).toBe(true);
        expect([...keys].filter((k) => k.startsWith("level:"))).toHaveLength(1);
        expect(keys.has("prospect:prospect:derived")).toBe(true);
      }

      await opened.db.update(players).set({ level: "mlb", milbLevel: null }).where(eq(players.id, player.id));
      syncDerivedTags(opened.db, player.id, NOW);
      const keys = tagKeys(player.id);
      expect(keys.has("level:mlb:derived")).toBe(true);
      expect(keys.has("prospect:prospect:derived")).toBe(false);
    });

    it("upgrades level:rookie to level:dsl on a first DSL stat line, then stays idempotent", async () => {
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Rookie", position: null });
      syncDerivedTags(opened.db, player.id, NOW);
      expect(tagKeys(player.id).has("level:rookie:derived")).toBe(true);

      await insertStatLine(opened.db, {
        playerId: player.id,
        sportId: 16,
        leagueName: "Dominican Summer League",
        gameDate: "2026-07-01",
      });
      syncDerivedTags(opened.db, player.id, NOW);
      let keys = tagKeys(player.id);
      expect(keys.has("level:dsl:derived")).toBe(true);
      expect(keys.has("level:rookie:derived")).toBe(false);

      // Re-sync: no flip-back, no duplicate.
      syncDerivedTags(opened.db, player.id, NOW);
      keys = tagKeys(player.id);
      expect(keys.has("level:dsl:derived")).toBe(true);
      expect([...keys].filter((k) => k.startsWith("level:"))).toHaveLength(1);
    });

    it("derives a deactivated player's tags without reactivating him", async () => {
      const player = await insertPlayer(opened.db, {
        level: "milb",
        milbLevel: "Triple-A",
        position: "SS",
        active: false,
      });
      syncDerivedTags(opened.db, player.id, NOW);
      expect(tagKeys(player.id).has("level:aaa:derived")).toBe(true);
      const row = (await opened.db.select().from(players).where(eq(players.id, player.id)))[0];
      expect(row?.active).toBe(false);
    });
  });

  describe("syncAllDerivedTags", () => {
    it("sweeps every player — active, inactive, and season-over NCAA", async () => {
      const clock = fakeClock("2026-12-05T18:00:00.000Z"); // deep offseason
      const active = await insertPlayer(opened.db, { level: "mlb", milbLevel: null, position: "SP" });
      const inactive = await insertPlayer(opened.db, {
        level: "milb",
        milbLevel: "Double-A",
        position: "1B",
        active: false,
      });
      const ncaa = await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        position: null,
      });

      const count = syncAllDerivedTags(opened.db, clock.now());
      expect(count).toBe(3);
      expect(tagKeys(active.id).has("level:mlb:derived")).toBe(true);
      expect(tagKeys(inactive.id).has("level:aa:derived")).toBe(true);
      expect(tagKeys(ncaa.id).has("level:ncaa:derived")).toBe(true);
      expect(tagKeys(ncaa.id).has("prospect:prospect:derived")).toBe(true);
      // The inactive player is not resurrected by the sweep.
      const row = (await opened.db.select().from(players).where(eq(players.id, inactive.id)))[0];
      expect(row?.active).toBe(false);
    });
  });

  describe("addManualTag / removeManualTag", () => {
    it("rejects a manual write to a derived namespace", async () => {
      const player = await insertPlayer(opened.db);
      expect(() => addManualTag(opened.db, player.id, "level", "aaa", NOW)).toThrow(
        ManualWriteToDerivedNamespaceError,
      );
      expect(() => addManualTag(opened.db, player.id, "pos", "ss", NOW)).toThrow(
        ManualWriteToDerivedNamespaceError,
      );
    });

    it("rejects an unknown namespace and an unknown status value", async () => {
      const player = await insertPlayer(opened.db);
      expect(() => addManualTag(opened.db, player.id, "bogus", "x", NOW)).toThrow(UnknownTagError);
      expect(() => addManualTag(opened.db, player.id, "status", "bogus", NOW)).toThrow(UnknownTagError);
    });

    it("is idempotent: a duplicate add makes no second row", async () => {
      const player = await insertPlayer(opened.db);
      addManualTag(opened.db, player.id, "status", "rostered", NOW);
      addManualTag(opened.db, player.id, "status", "rostered", NOW);
      expect(listTags(opened.db, player.id).filter((t) => t.source === "manual")).toHaveLength(1);
    });

    it("removeManualTag is a no-op on an absent tag and rejects a derived namespace", async () => {
      const player = await insertPlayer(opened.db);
      expect(() => removeManualTag(opened.db, player.id, "status", "scouted")).not.toThrow();
      addManualTag(opened.db, player.id, "status", "rostered", NOW);
      removeManualTag(opened.db, player.id, "status", "rostered");
      expect(listTags(opened.db, player.id).filter((t) => t.source === "manual")).toHaveLength(0);
      expect(() => removeManualTag(opened.db, player.id, "level", "aaa")).toThrow(
        ManualWriteToDerivedNamespaceError,
      );
    });

    it("lists tags ordered by namespace, value, source", async () => {
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      syncDerivedTags(opened.db, player.id, NOW);
      addManualTag(opened.db, player.id, "status", "rostered", NOW);
      const rows = listTags(opened.db, player.id);
      const sorted = [...rows].sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) ||
          a.value.localeCompare(b.value) ||
          a.source.localeCompare(b.source),
      );
      expect(rows).toEqual(sorted);
    });
  });

  describe("parseTagSelector", () => {
    it("splits, trims, drops empties, and dedupes", () => {
      expect(parseTagSelector(" level:aaa , status:rostered ")).toEqual([
        { namespace: "level", value: "aaa" },
        { namespace: "status", value: "rostered" },
      ]);
      expect(parseTagSelector("prospect,prospect")).toEqual([{ namespace: "prospect", value: null }]);
      expect(parseTagSelector("pos,pos:ss")).toEqual([
        { namespace: "pos", value: null },
        { namespace: "pos", value: "ss" },
      ]);
    });

    it("throws a ZodError on a malformed token", () => {
      expect(() => parseTagSelector(":foo")).toThrow(ZodError);
      expect(() => parseTagSelector("foo:")).toThrow(ZodError);
    });

    it("throws a ZodError when a PROVIDED selector normalizes to zero tokens", () => {
      // A present-but-empty expression (only separators or whitespace) must error,
      // NOT filter down to an empty token list that reads as "no filter" and
      // returns the whole roster.
      expect(() => parseTagSelector(",,,")).toThrow(ZodError);
      expect(() => parseTagSelector("   ")).toThrow(ZodError);
      expect(() => parseTagSelector(" , , ")).toThrow(ZodError);
    });

    it("splits a token on the FIRST colon only; extra colons ride in the value (matching nothing)", async () => {
      // Pinned behavior for `foo:bar:baz`: namespace='foo', value='bar:baz'.
      const tokens = parseTagSelector("foo:bar:baz");
      expect(tokens).toEqual([{ namespace: "foo", value: "bar:baz" }]);
      // A real tag exists, but no tag has value 'bar:baz', so the selector matches nobody.
      const player = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      syncDerivedTags(opened.db, player.id, NOW);
      expect(playerIdsMatchingTags(opened.db, tokens)).toEqual([]);
    });

    it("throws a ZodError when the distinct token count exceeds the bound", () => {
      const expr = Array.from({ length: 17 }, (_, i) => `ns${i}`).join(",");
      expect(() => parseTagSelector(expr)).toThrow(ZodError);
    });
  });

  describe("playerIdsMatchingTags — AND semantics", () => {
    it("intersects, handles a bare namespace, overlap, and a zero-match selector", async () => {
      const rostered = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      const notRostered = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      syncDerivedTags(opened.db, rostered.id, NOW);
      syncDerivedTags(opened.db, notRostered.id, NOW);
      addManualTag(opened.db, rostered.id, "status", "rostered", NOW);

      // AND: only the rostered AAA player.
      expect(playerIdsMatchingTags(opened.db, parseTagSelector("level:aaa,status:rostered"))).toEqual([
        rostered.id,
      ]);
      // Bare namespace matches any value: both are prospects.
      expect(
        new Set(playerIdsMatchingTags(opened.db, parseTagSelector("prospect"))),
      ).toEqual(new Set([rostered.id, notRostered.id]));
      // Overlap: a bare pos and a specific pos:ss are satisfied by different rows.
      expect(
        new Set(playerIdsMatchingTags(opened.db, parseTagSelector("pos,pos:ss"))),
      ).toEqual(new Set([rostered.id, notRostered.id]));
      // Zero match: nobody is scouted.
      expect(playerIdsMatchingTags(opened.db, parseTagSelector("status:scouted"))).toEqual([]);
    });

    it("an empty token list returns every player id", async () => {
      const a = await insertPlayer(opened.db);
      const b = await insertPlayer(opened.db);
      expect(new Set(playerIdsMatchingTags(opened.db, []))).toEqual(new Set([a.id, b.id]));
    });
  });
});
