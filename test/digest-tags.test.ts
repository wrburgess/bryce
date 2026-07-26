import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, statLines } from "../src/db/schema.js";
import { assembleDigest } from "../src/digest/assemble.js";
import { runDigest } from "../src/jobs/digest.js";
import { addToList, createList } from "../src/lists/service.js";
import { resolveTagScope } from "../src/tags/service.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertPlayerTag,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * The tag-scoped cohort digest (#140 / ADR 0050). This is the sibling of
 * `digest-list.test.ts` and exists for the same headline hazard: `assembleDigest`
 * selects players in the main stat-line join AND via the active-player set (which
 * feeds the idle/zero-row tail and `seasonStartFor`). Scope one and not the other
 * and an off-cohort player leaks — as a real row, as a zero row, or by silently
 * moving a `ytd` window's start date. Every assertion is over assembled content
 * or observable delivery state, never over the query that produced it.
 */
describe("tag-scoped digest (#140)", () => {
  let opened: OpenedDb;
  const clock = fakeClock(MID_SEASON);

  beforeEach(async () => {
    opened = testDb();
    await insertCalendars2026(opened.db);
  });
  afterEach(() => {
    opened.close();
  });

  /** Names of every batter+pitcher row (real and zero) the assembly produced. */
  function rowNames(assembly: Awaited<ReturnType<typeof assembleDigest>>): string[] {
    return [...assembly.batters, ...assembly.pitchers].map((r) => r.player.fullName).sort();
  }

  it("scopes BOTH selection sites: an untagged player with stats and an untagged idle both vanish", async () => {
    // Tagged, with a stat line in the 1d window -> a real row.
    const tagged = await insertPlayer(opened.db, { fullName: "Tagged Withstats" });
    await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });

    // Tagged, NO stats but in season -> a zero row (should appear).
    const taggedIdle = await insertPlayer(opened.db, { fullName: "Tagged Idle" });
    await insertPlayerTag(opened.db, { playerId: taggedIdle.id, namespace: "status", value: "rostered" });

    // UNtagged with a stat line -> must NOT leak through the main join.
    const untagged = await insertPlayer(opened.db, { fullName: "Untagged Withstats" });
    await insertStatLine(opened.db, { playerId: untagged.id, gameDate: "2026-07-18" });

    // UNtagged idle -> must NOT leak as a zero row (the second selection site).
    await insertPlayer(opened.db, { fullName: "Untagged Idle" });

    // Tagged in a DIFFERENT namespace/value -> the selector must not match him.
    const otherTag = await insertPlayer(opened.db, { fullName: "Othertag Withstats" });
    await insertPlayerTag(opened.db, { playerId: otherTag.id, namespace: "status", value: "scouted" });
    await insertStatLine(opened.db, { playerId: otherTag.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      tagScope: resolveTagScope("status:rostered"),
    });
    expect(rowNames(scoped)).toEqual(["Tagged Idle", "Tagged Withstats"]);
    expect(scoped.playerCount).toBe(1); // only the tagged player with a line is counted
    expect(scoped.statLineCount).toBe(1);
    expect(scoped.tagSelector).toBe("status:rostered");
  });

  it("with no tagScope, every active player appears (regression guard)", async () => {
    const tagged = await insertPlayer(opened.db, { fullName: "Tagged Withstats" });
    await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });
    const untagged = await insertPlayer(opened.db, { fullName: "Untagged Withstats" });
    await insertStatLine(opened.db, { playerId: untagged.id, gameDate: "2026-07-18" });

    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "1d" });
    expect(rowNames(unscoped)).toContain("Untagged Withstats");
    expect(unscoped.playerCount).toBe(2);
    expect(unscoped.tagSelector).toBeUndefined();
  });

  it("a selector matching NOBODY yields an empty report, not an error", async () => {
    const p = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: p.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      // Well-formed, but no player carries it.
      tagScope: resolveTagScope("status:scouted"),
    });
    expect(scoped.batters).toEqual([]);
    expect(scoped.pitchers).toEqual([]);
    expect(scoped.playerCount).toBe(0);
    expect(scoped.statLineCount).toBe(0);
  });

  it("a bare namespace matches any value in it", async () => {
    const rostered = await insertPlayer(opened.db, { fullName: "Rostered Guy" });
    await insertPlayerTag(opened.db, { playerId: rostered.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: rostered.id, gameDate: "2026-07-18" });
    const scouted = await insertPlayer(opened.db, { fullName: "Scouted Guy" });
    await insertPlayerTag(opened.db, { playerId: scouted.id, namespace: "status", value: "scouted" });
    await insertStatLine(opened.db, { playerId: scouted.id, gameDate: "2026-07-18" });
    await insertPlayer(opened.db, { fullName: "Untagged Guy" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      tagScope: resolveTagScope("status"),
    });
    expect(rowNames(scoped)).toEqual(["Rostered Guy", "Scouted Guy"]);
  });

  it("tags AND list INTERSECT — in both directions", async () => {
    const list = await createList(opened.db, "L", clock.now());

    // In the list AND tagged -> the only row.
    const both = await insertPlayer(opened.db, { fullName: "Both Qualified" });
    await insertPlayerTag(opened.db, { playerId: both.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: both.id, gameDate: "2026-07-18" });

    // In the list but NOT tagged -> excluded by the tag half.
    const listOnly = await insertPlayer(opened.db, { fullName: "Listonly Untagged" });
    await insertStatLine(opened.db, { playerId: listOnly.id, gameDate: "2026-07-18" });

    // Tagged but NOT in the list -> excluded by the list half.
    const tagOnly = await insertPlayer(opened.db, { fullName: "Tagonly Unlisted" });
    await insertPlayerTag(opened.db, { playerId: tagOnly.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: tagOnly.id, gameDate: "2026-07-18" });

    await addToList(opened.db, "L", [both.externalId!, listOnly.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
      listName: list.name,
      tagScope: resolveTagScope("status:rostered"),
    });
    expect(rowNames(scoped)).toEqual(["Both Qualified"]);
    expect(scoped.listName).toBe("L");
    expect(scoped.tagSelector).toBe("status:rostered");
  });

  it("multiple tokens AND together", async () => {
    const both = await insertPlayer(opened.db, { fullName: "Aaa Rostered", level: "milb", milbLevel: "Triple-A" });
    await insertPlayerTag(opened.db, { playerId: both.id, namespace: "status", value: "rostered" });
    await insertPlayerTag(opened.db, { playerId: both.id, namespace: "level", value: "aaa", source: "derived" });
    await insertStatLine(opened.db, { playerId: both.id, gameDate: "2026-07-18" });

    // Rostered but AA -> fails the level token.
    const wrongLevel = await insertPlayer(opened.db, { fullName: "Aa Rostered" });
    await insertPlayerTag(opened.db, { playerId: wrongLevel.id, namespace: "status", value: "rostered" });
    await insertPlayerTag(opened.db, { playerId: wrongLevel.id, namespace: "level", value: "aa", source: "derived" });
    await insertStatLine(opened.db, { playerId: wrongLevel.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      tagScope: resolveTagScope("level:aaa,status:rostered"),
    });
    expect(rowNames(scoped)).toEqual(["Aaa Rostered"]);
  });

  it("excludes a DEACTIVATED player even when he carries every tag", async () => {
    const active = await insertPlayer(opened.db, { fullName: "Active Tagged" });
    await insertPlayerTag(opened.db, { playerId: active.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: active.id, gameDate: "2026-07-18" });

    const gone = await insertPlayer(opened.db, { fullName: "Deactivated Tagged", active: false });
    await insertPlayerTag(opened.db, { playerId: gone.id, namespace: "status", value: "rostered" });
    await insertStatLine(opened.db, { playerId: gone.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      tagScope: resolveTagScope("status:rostered"),
    });
    expect(rowNames(scoped)).toEqual(["Active Tagged"]);
  });

  it("seasonStartFor uses only the scoped cohort's sports (ytd window.from)", async () => {
    // Tagged player is Triple-A (sportId 11, regular season starts 2026-03-27).
    const tagged = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A" });
    await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
    // Untagged player is MLB (sportId 1, starts earlier: 2026-03-25).
    await insertPlayer(opened.db, { level: "mlb", milbLevel: null });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "ytd",
      tagScope: resolveTagScope("status:rostered"),
    });
    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "ytd" });
    // Scoped to Triple-A only -> ytd anchors on 2026-03-27; unscoped includes
    // MLB's earlier 2026-03-25. The two windows differ, proving the second
    // selection site (seasonStartFor) is scoped too.
    expect(scoped.window.from).toBe("2026-03-27");
    expect(unscoped.window.from).toBe("2026-03-25");
  });

  it("a promoted player still yields one row per level under a tag scope", async () => {
    const promoted = await insertPlayer(opened.db, { fullName: "Promoted Player", level: "milb", milbLevel: "Triple-A" });
    await insertPlayerTag(opened.db, { playerId: promoted.id, namespace: "status", value: "rostered" });
    // Two levels inside a 7d window: Triple-A (sportId 11) then MLB (sportId 1).
    await insertStatLine(opened.db, { playerId: promoted.id, gameDate: "2026-07-14", sportId: 11 });
    await insertStatLine(opened.db, { playerId: promoted.id, gameDate: "2026-07-17", sportId: 1 });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "7d",
      tagScope: resolveTagScope("status:rostered"),
    });
    // Rows group by (player, LEVEL), and `lvl` comes from the stat line's
    // sportId — never from players.level (ADR 0029).
    const levels = scoped.batters.map((r) => r.lvl).sort();
    expect(levels).toEqual(["AAA", "MLB"]);
    // Neither level's row absorbed the other's game.
    expect(scoped.batters.every((r) => r.agg.games === 1)).toBe(true);
  });

  describe("delivery-slot behavior", () => {
    async function sendTagged(): ReturnType<typeof runDigest> {
      const mailer = new CapturingMailer();
      return runDigest({
        db: opened.db,
        mailer,
        now: clock.now,
        tz: TEST_TZ,
        to: "hc@example.com",
        from: "bryce@example.com",
        spec: "1d",
        tagScope: resolveTagScope("status:rostered"),
      });
    }

    it("mails only cohort content, on-demand: no delivery row, label names the cohort", async () => {
      const tagged = await insertPlayer(opened.db, { fullName: "Mailed Cohortrow" });
      await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
      await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });
      const untagged = await insertPlayer(opened.db, { fullName: "Hidden Untaggedrow" });
      await insertStatLine(opened.db, { playerId: untagged.id, gameDate: "2026-07-18" });

      const mailer = new CapturingMailer();
      const result = await runDigest({
        db: opened.db,
        mailer,
        now: clock.now,
        tz: TEST_TZ,
        to: "hc@example.com",
        from: "bryce@example.com",
        spec: "1d",
        tagScope: resolveTagScope("status:rostered"),
      });

      expect(result.action).toBe("sent");
      expect(result.playerCount).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      // The renderer abbreviates the first name, so assert on the unique surname.
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      expect(body).toContain("Cohortrow");
      expect(body).not.toContain("Untaggedrow");
      expect(mailer.sent[0]?.subject).toBe(
        "ScoreKeeps Baseball (Tags: status:rostered) - Sat, July 18, 2026",
      );
      // On-demand: the slot key has no tag dimension, so nothing is recorded.
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    });

    it("writes NOTHING: every stat-line row is byte-identical after the run", async () => {
      const tagged = await insertPlayer(opened.db);
      await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
      await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });

      // The read-only guarantee is the whole reason a cohort report can be re-run
      // freely (#29). Window selection replaced novelty selection (ADR 0035), so
      // there is no per-line delivery stamp left to check — the honest assertion
      // is that the rows themselves did not move at all, `updatedAt` included.
      const before = await opened.db.select().from(statLines);
      await sendTagged();
      const after = await opened.db.select().from(statLines);

      expect(after).toEqual(before);
      expect(after).toHaveLength(1);
    });

    it("slot isolation: after a tag-scoped send, the daily 1d slot is still unclaimed and claimable", async () => {
      const tagged = await insertPlayer(opened.db, { fullName: "Cohort Member" });
      await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });
      await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });

      const tagRun = await sendTagged();
      expect(tagRun.action).toBe("sent");
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

      // The scheduled daily run passes no tags — it must still take its slot and
      // record a delivery row, exactly as if the cohort send had never happened.
      const mailer = new CapturingMailer();
      const daily = await runDigest({
        db: opened.db,
        mailer,
        now: clock.now,
        tz: TEST_TZ,
        to: "hc@example.com",
        from: "bryce@example.com",
        spec: "1d",
      });
      expect(daily.action).toBe("sent");
      const deliveries = await opened.db.select().from(digestDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.dateCovered).toBe("2026-07-19");
    });
  });
});
