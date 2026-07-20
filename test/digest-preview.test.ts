import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, statLines } from "../src/db/schema.js";
import { assembleDigest } from "../src/digest/assemble.js";
import { renderDigest } from "../src/digest/render.js";
import { runDigest } from "../src/jobs/digest.js";
import {
  CapturingMailer,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  fakeClock,
  insertCalendar,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  testDb,
} from "./factories.js";

describe("assembleDigest (pure digest preview)", () => {
  let opened: OpenedDb;
  let clock: ReturnType<typeof fakeClock>;

  const deps = () => ({ now: clock.now, tz: TEST_TZ });

  beforeEach(async () => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("returns exactly what runDigest would send", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 2, atBats: 4, homeRuns: 1, rbi: 3 },
    });
    await insertPlayer(opened.db, { fullName: "Quiet Guy" }); // in-season, no lines

    const assembly = await assembleDigest(opened.db, deps());
    const previewMail = renderDigest({
      date: assembly.date,
      lines: assembly.lines,
      noNewStats: assembly.noNewStats,
    });

    const mailer = new CapturingMailer();
    const result = await runDigest({
      db: opened.db,
      mailer,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
    });

    // The sent mail IS the previewed mail, byte for byte.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe(previewMail.subject);
    expect(mailer.sent[0]?.text).toBe(previewMail.text);
    expect(mailer.sent[0]?.html).toBe(previewMail.html);
    expect(result.statLineCount).toBe(assembly.reportedIds.length);
    expect(result.playerCount).toBe(assembly.playerCount);

    expect(assembly.date).toBe("2026-07-19");
    expect(previewMail.text).toContain(
      "2026-07-18 vs Charlotte Knights: PA 4, H 2, BB 0, K 0, 2B 0, 3B 0, HR 1, RBI 3, R 0, SB 0, CS 0, E 0",
    );
    expect(previewMail.text).toContain("No new stats: Quiet Guy");
  });

  it("merges fielding rows into batting lines and still reports their ids", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Error Prone" });
    const batting = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990001,
      statType: "batting",
      stats: { hits: 2, atBats: 4 },
    });
    const fielding = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990001,
      statType: "fielding",
      stats: { errors: 1 },
    });

    const assembly = await assembleDigest(opened.db, deps());
    // One rendered line — the fielding row merged, never a standalone line.
    expect(assembly.lines).toHaveLength(1);
    expect(assembly.lines[0]?.statType).toBe("batting");
    expect(assembly.lines[0]?.stats.errors).toBe(1);
    // BOTH stored rows are earmarked for marking.
    expect([...assembly.reportedIds].sort((a, b) => a - b)).toEqual(
      [batting.id, fielding.id].sort((a, b) => a - b),
    );
    expect(assembly.playerCount).toBe(1);
  });

  it("touches no delivery rows and marks no lines (db state identical before/after)", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    const linesBefore = await opened.db.select().from(statLines);
    const deliveriesBefore = await opened.db.select().from(digestDeliveries);

    const assembly = await assembleDigest(opened.db, deps());
    expect(assembly.reportedIds).toHaveLength(1);

    const linesAfter = await opened.db.select().from(statLines);
    const deliveriesAfter = await opened.db.select().from(digestDeliveries);
    expect(linesAfter).toEqual(linesBefore);
    expect(deliveriesAfter).toEqual(deliveriesBefore);
    expect(deliveriesAfter).toHaveLength(0);
    expect(linesAfter.every((l) => l.digestDeliveryId === null)).toBe(true);

    // Preview twice: still identical — reads are repeatable, nothing consumed.
    const again = await assembleDigest(opened.db, deps());
    expect(again.reportedIds).toEqual(assembly.reportedIds);
  });

  it("assembles empty: no lines, in-season players in the no-new-stats tail", async () => {
    await insertPlayer(opened.db, { fullName: "Quiet Guy" });

    const assembly = await assembleDigest(opened.db, deps());
    expect(assembly.lines).toEqual([]);
    expect(assembly.reportedIds).toEqual([]);
    expect(assembly.playerCount).toBe(0);
    expect(assembly.noNewStats.map((p) => p.fullName)).toEqual(["Quiet Guy"]);
    expect(assembly.date).toBe("2026-07-19");
  });

  it("omits out-of-season and inactive players from the tail", async () => {
    clock.set("2026-10-01T17:00:00Z"); // AAA over (09-27), MLB runs to 10-31
    await insertPlayer(opened.db, { fullName: "Out Of Season Guy" }); // AAA
    await insertPlayer(opened.db, {
      fullName: "Still Playing",
      level: "mlb",
      milbLevel: null,
      teamName: "Miami Marlins",
    });
    await insertPlayer(opened.db, { fullName: "Gone Guy", level: "mlb", milbLevel: null, active: false });

    const assembly = await assembleDigest(opened.db, deps());
    expect(assembly.noNewStats.map((p) => p.fullName)).toEqual(["Still Playing"]);
  });

  it("lists an In Season NCAA player with no lines in the no-new-stats tail (school shown)", async () => {
    clock.set("2026-03-15T17:00:00Z"); // NCAA In Season (opens 2026-02-13)
    await insertCalendar(opened.db, {
      sportId: 22,
      season: "2026",
      regularSeasonStart: "2026-02-13",
      regularSeasonEnd: "2026-06-22",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      fullName: "College Guy",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      schoolName: "LSU",
    });

    const assembly = await assembleDigest(opened.db, deps());
    expect(assembly.noNewStats.map((p) => p.fullName)).toEqual(["College Guy"]);
    // The preview mail renders the school in the tail-less section; the tail itself is names only.
    const mail = renderDigest({ date: assembly.date, lines: assembly.lines, noNewStats: assembly.noNewStats });
    expect(mail.text).toContain("No new stats: College Guy");
    // Preview is side-effect free.
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
  });

  it("omits an out-of-season NCAA player from the tail (July, NCAA season over)", async () => {
    // MID_SEASON is 2026-07-19; NCAA 2026 ended 2026-06-22.
    await insertCalendar(opened.db, {
      sportId: 22,
      season: "2026",
      regularSeasonStart: "2026-02-13",
      regularSeasonEnd: "2026-06-22",
      postSeasonStart: null,
      postSeasonEnd: null,
      springStart: null,
      springEnd: null,
    });
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      fullName: "College Guy",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      schoolName: "LSU",
    });

    const assembly = await assembleDigest(opened.db, deps());
    expect(assembly.noNewStats.map((p) => p.fullName)).toEqual([]);
  });

  it("leaves the heartbeat path unaffected (runDigest still heartbeats in the offseason)", async () => {
    clock.set(OFFSEASON);
    await insertPlayer(opened.db, { fullName: "Watched One" });
    const mailer = new CapturingMailer();
    const result = await runDigest({
      db: opened.db,
      mailer,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
    });
    expect(result).toMatchObject({ kind: "heartbeat", action: "sent", playerCount: 1 });
    expect(mailer.sent[0]?.subject).toBe("Bryce heartbeat - 2026-12-05");
  });
});
