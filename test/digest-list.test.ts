import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { assembleDigest } from "../src/digest/assemble.js";
import { runDigest } from "../src/jobs/digest.js";
import { addToList, createList } from "../src/lists/service.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * The scoped digest (issue #70 / ADR 0046). The headline hazard is the
 * two-selection-site leak: `assembleDigest` selects players in the main
 * stat-line join AND via the active-player set (which feeds the idle/zero-row
 * tail and `seasonStartFor`). Both must be scoped or an off-list player leaks —
 * as a real row OR as a zero row. Every assertion is over the assembled content.
 */
describe("scoped digest (#70)", () => {
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

  it("scopes BOTH selection sites: a non-member with stats and a non-member idle both vanish", async () => {
    const list = await createList(opened.db, "L", clock.now());

    // A member with a stat line in the 1d window -> a real row.
    const member = await insertPlayer(opened.db, { fullName: "Member Withstats" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });

    // A member with NO stats but in season -> a zero row (should appear).
    const memberIdle = await insertPlayer(opened.db, { fullName: "Member Idle" });

    // A NON-member with a stat line -> must NOT leak through the main join.
    const nonMember = await insertPlayer(opened.db, { fullName: "Nonmember Withstats" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });

    // A NON-member idle -> must NOT leak as a zero row (the second selection site).
    await insertPlayer(opened.db, { fullName: "Nonmember Idle" });

    await addToList(opened.db, "L", [member.externalId!, memberIdle.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
      listName: list.name,
    });
    expect(rowNames(scoped)).toEqual(["Member Idle", "Member Withstats"]);
    expect(scoped.playerCount).toBe(1); // only the member with a line is counted
    expect(scoped.statLineCount).toBe(1);
  });

  it("with no listId, every active player appears (regression guard)", async () => {
    const list = await createList(opened.db, "L", clock.now());
    const member = await insertPlayer(opened.db, { fullName: "Member Withstats" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
    const nonMember = await insertPlayer(opened.db, { fullName: "Nonmember Withstats" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "1d" });
    expect(rowNames(unscoped)).toContain("Nonmember Withstats");
    expect(unscoped.playerCount).toBe(2);
    expect(list.id).toBeGreaterThan(0);
  });

  it("a named EMPTY list yields empty batters/pitchers and playerCount 0", async () => {
    const list = await createList(opened.db, "Empty", clock.now());
    // An active player with stats exists but is not a member.
    const p = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: p.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
      listName: list.name,
    });
    expect(scoped.batters).toEqual([]);
    expect(scoped.pitchers).toEqual([]);
    expect(scoped.playerCount).toBe(0);
    expect(scoped.statLineCount).toBe(0);
  });

  it("excludes a deactivated member from a scoped digest", async () => {
    const list = await createList(opened.db, "L", clock.now());
    const active = await insertPlayer(opened.db, { fullName: "Active Member" });
    await insertStatLine(opened.db, { playerId: active.id, gameDate: "2026-07-18" });
    const gone = await insertPlayer(opened.db, { fullName: "Deactivated Member", active: false });
    await insertStatLine(opened.db, { playerId: gone.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [active.externalId!], clock.now());
    // gone is a member row too, but deactivated.
    await addToList(opened.db, "L", [gone.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
    });
    expect(rowNames(scoped)).toEqual(["Active Member"]);
  });

  it("seasonStartFor uses only the scoped members' sports (ytd window.from)", async () => {
    const list = await createList(opened.db, "L", clock.now());
    // Member plays Triple-A (sportId 11, regular season starts 2026-03-27).
    const member = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A" });
    // Non-member plays MLB (sportId 1, starts earlier: 2026-03-25).
    await insertPlayer(opened.db, { level: "mlb", milbLevel: null });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "ytd",
      listId: list.id,
    });
    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "ytd" });
    // Scoped to Triple-A only -> ytd anchors on 2026-03-27; unscoped includes
    // MLB's earlier 2026-03-25. The two windows differ, proving the second
    // selection site (seasonStartFor) is scoped too.
    expect(scoped.window.from).toBe("2026-03-27");
    expect(unscoped.window.from).toBe("2026-03-25");
  });

  it("runDigest scoped by list mails only member content (on-demand, no delivery row)", async () => {
    const list = await createList(opened.db, "L", clock.now());
    const member = await insertPlayer(opened.db, { fullName: "Mailed Memberrow" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
    const nonMember = await insertPlayer(opened.db, { fullName: "Hidden Nonmemberrow" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const mailer = new CapturingMailer();
    const result = await runDigest({
      db: opened.db,
      mailer,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
      spec: "1d",
      listId: list.id,
      listName: list.name,
    });
    expect(result.action).toBe("sent");
    expect(result.playerCount).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    // The renderer abbreviates the first name, so assert on the unique surname.
    const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
    expect(body).toContain("Memberrow");
    expect(body).not.toContain("Nonmemberrow");
    expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (L) - Sat, July 18, 2026");
  });
});
