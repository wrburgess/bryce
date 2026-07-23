import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { deriveTags } from "../src/tags/derive.js";
import { insertPlayer, insertStatLine, testDb } from "./factories.js";

/**
 * Pure derivation-engine tests (no DB writes under test): rows come from the
 * sanctioned builders, then `deriveTags` runs against them with no side effects.
 */

/** The derived tags as a `namespace:value` string set — order-independent. */
async function derive(
  opened: OpenedDb,
  overrides: Parameters<typeof insertPlayer>[1],
  statLine?: Omit<Parameters<typeof insertStatLine>[1], "playerId">,
): Promise<Set<string>> {
  const player = await insertPlayer(opened.db, overrides);
  const latestStatLine = statLine
    ? await insertStatLine(opened.db, { ...statLine, playerId: player.id })
    : null;
  return new Set(deriveTags({ player, latestStatLine }).map((t) => `${t.namespace}:${t.value}`));
}

describe("deriveTags", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  describe("levelRule — every rung of the (level, milbLevel) pair", () => {
    it("maps mlb", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: null });
      expect(tags.has("level:mlb")).toBe(true);
    });

    it.each([
      ["Triple-A", "level:aaa"],
      ["Double-A", "level:aa"],
      ["High-A", "level:high-a"],
      ["Single-A", "level:single-a"],
      ["Rookie", "level:rookie"],
    ])("maps milb %s to %s", async (milbLevel, expected) => {
      const tags = await derive(opened, { level: "milb", milbLevel, position: null });
      expect(tags.has(expected)).toBe(true);
      // Exactly one level tag.
      expect([...tags].filter((t) => t.startsWith("level:"))).toHaveLength(1);
    });

    it("maps ncaa", async () => {
      const tags = await derive(opened, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        position: null,
      });
      expect(tags.has("level:ncaa")).toBe(true);
    });

    it("emits NO level tag for the invalid (milb, null) pair", async () => {
      const tags = await derive(opened, { level: "milb", milbLevel: null, position: null });
      expect([...tags].filter((t) => t.startsWith("level:"))).toHaveLength(0);
    });
  });

  describe("posRule — granular AND coarse", () => {
    it("a shortstop (SS) gets granular + infield + batter", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "SS" });
      expect(tags.has("pos:ss")).toBe(true);
      expect(tags.has("pos:infield")).toBe(true);
      expect(tags.has("pos:batter")).toBe(true);
      expect(tags.has("pos:pitcher")).toBe(false);
    });

    it("a starting pitcher (SP) gets granular + pitcher, never batter", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "SP" });
      expect(tags.has("pos:sp")).toBe(true);
      expect(tags.has("pos:pitcher")).toBe(true);
      expect(tags.has("pos:batter")).toBe(false);
    });

    it("a catcher (C) gets granular + batter", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "C" });
      expect(tags.has("pos:c")).toBe(true);
      expect(tags.has("pos:batter")).toBe(true);
    });

    it("a DH gets granular + batter", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "DH" });
      expect(tags.has("pos:dh")).toBe(true);
      expect(tags.has("pos:batter")).toBe(true);
    });

    it("a two-way player (TWP) gets pitcher AND batter", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "TWP" });
      expect(tags.has("pos:twp")).toBe(true);
      expect(tags.has("pos:pitcher")).toBe(true);
      expect(tags.has("pos:batter")).toBe(true);
    });

    it("a null position yields NO pos tags (NCAA rows)", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: null });
      expect([...tags].filter((t) => t.startsWith("pos:"))).toHaveLength(0);
    });

    it("an unknown abbreviation yields NO pos tags (conservative)", async () => {
      const tags = await derive(opened, { level: "mlb", milbLevel: null, position: "XYZ" });
      expect([...tags].filter((t) => t.startsWith("pos:"))).toHaveLength(0);
    });
  });

  describe("prospectRule", () => {
    it("present iff level !== mlb (milb yes)", async () => {
      const milb = await derive(opened, { level: "milb", milbLevel: "Rookie", position: null });
      expect(milb.has("prospect:prospect")).toBe(true);
    });

    it("present for ncaa", async () => {
      const ncaa = await derive(opened, {
        externalId: null,
        ncaaPlayerSeq: 111,
        level: "ncaa",
        milbLevel: null,
        position: null,
      });
      expect(ncaa.has("prospect:prospect")).toBe(true);
    });

    it("absent for mlb", async () => {
      const mlb = await derive(opened, { level: "mlb", milbLevel: null, position: null });
      expect(mlb.has("prospect:prospect")).toBe(false);
    });
  });

  describe("dslRule — the one stat-derived tag", () => {
    it("a DSL-league latest stat line replaces level:rookie with level:dsl", async () => {
      const tags = await derive(
        opened,
        { level: "milb", milbLevel: "Rookie", position: null },
        { sportId: 16, leagueName: "Dominican Summer League" },
      );
      expect(tags.has("level:dsl")).toBe(true);
      expect(tags.has("level:rookie")).toBe(false);
      expect([...tags].filter((t) => t.startsWith("level:"))).toHaveLength(1);
    });

    it("a sportId-16 stat line in a domestic complex league stays level:rookie", async () => {
      const tags = await derive(
        opened,
        { level: "milb", milbLevel: "Rookie", position: null },
        { sportId: 16, leagueName: "Arizona Complex League" },
      );
      expect(tags.has("level:rookie")).toBe(true);
      expect(tags.has("level:dsl")).toBe(false);
      expect([...tags].filter((t) => t.startsWith("level:"))).toHaveLength(1);
    });
  });
});
