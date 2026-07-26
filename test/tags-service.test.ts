import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { OpenedDb } from "../src/db/client.js";
import { players } from "../src/db/schema.js";
import {
  ManualWriteToDerivedNamespaceError,
  UnknownTagError,
  addManualTag,
  formatTagSelector,
  listTags,
  parseTagSelector,
  playerIdsMatchingTags,
  removeManualTag,
  resolveTagScope,
  syncAllDerivedTags,
  syncDerivedTags,
  tagScopeCondition,
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

    it("REJECTS a value with stray colons (#140 — flipped from the old accept-and-match-nothing)", () => {
      // This assertion previously pinned the OPPOSITE: `foo:bar:baz` parsed to
      // namespace='foo', value='bar:baz' and quietly matched nobody. That
      // contradicted the documented grammar (docs/domain/tags.md), which has
      // always said a value with stray colons is rejected. Rejecting makes the
      // docs true and stops a typo'd selector from looking like an honest empty
      // cohort on the report surface (ADR 0050 decision 5).
      expect(() => parseTagSelector("foo:bar:baz")).toThrow(ZodError);
    });

    it("REJECTS anything outside [a-z0-9-] — the cohort label's security boundary (#140)", () => {
      // The parsed selector is rendered back into an SMTP subject header, an HTML
      // heading, and a Markdown heading. `trim()` only strips the ENDS of a token,
      // so an INTERIOR control character would otherwise survive into a mail
      // header. Rejecting here makes the label safe in every sink by construction
      // rather than trusting each sink to escape (ADR 0050 decision 5).
      // CR/LF — header injection.
      expect(() => parseTagSelector("level:a\r\nBcc: attacker@example.invalid")).toThrow(ZodError);
      expect(() => parseTagSelector("level:a\nb")).toThrow(ZodError);
      expect(() => parseTagSelector("lev\rel:aaa")).toThrow(ZodError);
      // Markdown — image/link injection into the rendered heading.
      expect(() => parseTagSelector("level:![img](http://example.invalid/x)")).toThrow(ZodError);
      expect(() => parseTagSelector("level:[a](b)")).toThrow(ZodError);
      // HTML — previously only pinned at the render sink, now at the boundary.
      expect(() => parseTagSelector("level:<script>")).toThrow(ZodError);
      // Uppercase: every stored value is lowercase, so this could never match —
      // it fails closed instead of returning a silently empty cohort.
      expect(() => parseTagSelector("level:AAA")).toThrow(ZodError);
      // Leading/trailing hyphens and internal spaces are not tag shapes.
      expect(() => parseTagSelector("-level:aaa")).toThrow(ZodError);
      expect(() => parseTagSelector("level:high a")).toThrow(ZodError);
    });

    it("ACCEPTS every value the system can actually store", () => {
      // The guard against a charset so tight it breaks the feature: these are the
      // real emitted values (src/tags/derive.ts) plus the manual status set.
      expect(parseTagSelector("level:high-a")).toEqual([{ namespace: "level", value: "high-a" }]);
      expect(parseTagSelector("level:single-a")).toEqual([{ namespace: "level", value: "single-a" }]);
      expect(parseTagSelector("pos:1b")).toEqual([{ namespace: "pos", value: "1b" }]);
      expect(parseTagSelector("pos:outfield")).toEqual([{ namespace: "pos", value: "outfield" }]);
      expect(parseTagSelector("prospect")).toEqual([{ namespace: "prospect", value: null }]);
      expect(parseTagSelector("status:scouted")).toEqual([{ namespace: "status", value: "scouted" }]);
      expect(parseTagSelector("level:dsl")).toEqual([{ namespace: "level", value: "dsl" }]);
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

  describe("tagScopeCondition — the two selection sites agree (#140)", () => {
    // A tag-scoped digest filters players TWICE: in SQL (this condition, pushed
    // into the stat_line join) and as an id set (playerIdsMatchingTags, filtering
    // the active-player list that feeds the idle/zero-row tail). If the two ever
    // disagreed, a player would appear in one half of the report and not the
    // other. They are one implementation; this proves it stays that way.
    async function seeded(): Promise<{ rostered: number; plain: number }> {
      const rostered = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A", position: "SS" });
      const plain = await insertPlayer(opened.db, { level: "mlb", milbLevel: null, position: "1B" });
      syncDerivedTags(opened.db, rostered.id, NOW);
      syncDerivedTags(opened.db, plain.id, NOW);
      addManualTag(opened.db, rostered.id, "status", "rostered", NOW);
      return { rostered: rostered.id, plain: plain.id };
    }

    /** The SQL path: select players.id under the condition alone. */
    function idsViaCondition(expr: string): number[] {
      const scope = tagScopeCondition(opened.db, parseTagSelector(expr));
      return opened.db
        .select({ id: players.id })
        .from(players)
        .where(scope)
        .all()
        .map((r) => r.id)
        .sort((a, b) => a - b);
    }

    it.each([
      "status:rostered", // specific value
      "prospect", // bare namespace
      "pos,pos:ss", // overlap: two tokens satisfied by different rows
      "level:aaa,status:rostered", // multi-token AND
      "status:scouted", // matches nobody
    ])("selects the same players as playerIdsMatchingTags for %s", async (expr) => {
      await seeded();
      const viaIds = playerIdsMatchingTags(opened.db, parseTagSelector(expr)).sort((a, b) => a - b);
      expect(idsViaCondition(expr)).toEqual(viaIds);
    });

    it("returns undefined for an empty token list (no scope, not an empty scope)", async () => {
      const { rostered, plain } = await seeded();
      expect(tagScopeCondition(opened.db, [])).toBeUndefined();
      // And an unscoped select therefore returns everyone.
      expect(
        new Set(opened.db.select({ id: players.id }).from(players).all().map((r) => r.id)),
      ).toEqual(new Set([rostered, plain]));
    });
  });

  describe("formatTagSelector / resolveTagScope", () => {
    it("renders the PARSED tokens, deduped and order-preserving", () => {
      expect(formatTagSelector(parseTagSelector(" level:aaa , status:rostered "))).toBe(
        "level:aaa, status:rostered",
      );
      // A bare namespace keeps its bare form.
      expect(formatTagSelector(parseTagSelector("pos,pos:ss"))).toBe("pos, pos:ss");
      // Duplicates collapsed by the parser never reach the label.
      expect(formatTagSelector(parseTagSelector("prospect,prospect"))).toBe("prospect");
    });

    it("resolveTagScope pairs the tokens with their label from ONE validated input", () => {
      expect(resolveTagScope(" status:rostered , level:aaa ")).toEqual({
        tokens: [
          { namespace: "status", value: "rostered" },
          { namespace: "level", value: "aaa" },
        ],
        label: "status:rostered, level:aaa",
      });
    });

    it("resolveTagScope rejects what the parser rejects — no second grammar", () => {
      expect(() => resolveTagScope("level:AAA")).toThrow(ZodError);
      expect(() => resolveTagScope(",,,")).toThrow(ZodError);
      expect(() => resolveTagScope("level:a\r\nBcc: x@y")).toThrow(ZodError);
    });
  });
});
