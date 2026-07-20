import { isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, statLines } from "../src/db/schema.js";
import type { DigestDeps } from "../src/jobs/digest.js";
import { runDigest } from "../src/jobs/digest.js";
import {
  CapturingMailer,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  fakeClock,
  insertCalendar,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertStatLine,
  testDb,
} from "./factories.js";

describe("runDigest", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
  });

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("selects unreported lines, sends both parts with stat content, and marks them", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 2, atBats: 4, homeRuns: 1, rbi: 3 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-17",
      stats: { hits: 1, atBats: 5, strikeOuts: 2 },
    });

    const result = await runDigest(deps());
    expect(result).toMatchObject({ kind: "digest", action: "sent", statLineCount: 2, playerCount: 1 });

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail?.to).toBe("hc@example.com");
    expect(mail?.subject).toBe("Bryce digest - 2026-07-19");
    // Never assert only success: BOTH parts carry the actual stat content.
    // Fixed-format lines (ADR 0033): every stat always shown, zeros included.
    expect(mail?.text).toContain("Maximo Acosta");
    expect(mail?.text).toContain(
      "2026-07-18 vs Charlotte Knights: PA 4, H 2, K 0, 2B 0, 3B 0, HR 1, RBI 3, R 0, SB 0, CS 0, E 0, BB 0",
    );
    expect(mail?.text).toContain(
      "2026-07-17 vs Charlotte Knights: PA 5, H 1, K 2, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 0, BB 0",
    );
    expect(mail?.html).toContain("Maximo Acosta");
    expect(mail?.html).toContain("PA 4, H 2, K 0, 2B 0, 3B 0, HR 1, RBI 3, R 0, SB 0, CS 0, E 0, BB 0");
    expect(mail?.html).toContain("<h2>MiLB - Triple-A</h2>");

    // Lines are marked with the delivery; the delivery row records the counts.
    const unmarked = await opened.db.select().from(statLines).where(isNull(statLines.digestDeliveryId));
    expect(unmarked).toHaveLength(0);
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      statLineCount: 2,
      playerCount: 1,
    });
    const marked = await opened.db.select().from(statLines);
    expect(marked.every((l) => l.digestDeliveryId === deliveries[0]?.id)).toBe(true);
  });

  it("a same-day re-run does not send a second digest", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await runDigest(deps());
    const second = await runDigest(deps());
    expect(second.action).toBe("skipped");
    expect(second.reason).toBe("already-sent-today");
    expect(mailer.sent).toHaveLength(1);
  });

  it("sends the next-day digest even when empty, listing In Season players under No new stats", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id });
    await runDigest(deps());

    clock.set("2026-07-20T17:00:00Z");
    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(result.statLineCount).toBe(0);
    const mail = mailer.sent[1];
    expect(mail?.subject).toBe("Bryce digest - 2026-07-20");
    expect(mail?.text).toContain("No new stat lines today.");
    expect(mail?.text).toContain("No new stats: Maximo Acosta");
    expect(mail?.html).toContain("No new stats: Maximo Acosta");
  });

  it("reports a late-arriving line the next day (novelty-driven, never lost)", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await runDigest(deps());

    // A late final from 07-17 lands after the 07-19 digest already went out.
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-17",
      stats: { hits: 3, atBats: 4 },
    });
    clock.set("2026-07-20T17:00:00Z");
    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(result.statLineCount).toBe(1);
    expect(mailer.sent[1]?.text).toContain("2026-07-17 vs Charlotte Knights: PA 4, H 3,");
  });

  it("groups MLB before MiLB, with MiLB subgrouped by MiLB Level", async () => {
    const mlb = await insertPlayer(opened.db, {
      fullName: "Paul Skenes",
      level: "mlb",
      milbLevel: null,
      teamName: "Pittsburgh Pirates",
    });
    const aaa = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    const aa = await insertPlayer(opened.db, {
      fullName: "Double Guy",
      milbLevel: "Double-A",
      teamName: "Pensacola Blue Wahoos",
    });
    await insertStatLine(opened.db, {
      playerId: mlb.id,
      statType: "pitching",
      sportId: 1,
      stats: { inningsPitched: "6.0", hits: 4, earnedRuns: 1, baseOnBalls: 2, strikeOuts: 8, wins: 1 },
    });
    await insertStatLine(opened.db, { playerId: aaa.id });
    await insertStatLine(opened.db, { playerId: aa.id, sportId: 12 });

    await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    const mlbAt = text.indexOf("MLB");
    const aaaAt = text.indexOf("MiLB - Triple-A");
    const aaAt = text.indexOf("MiLB - Double-A");
    expect(mlbAt).toBeGreaterThanOrEqual(0);
    expect(aaaAt).toBeGreaterThan(mlbAt);
    expect(aaAt).toBeGreaterThan(aaaAt);
    expect(text).toContain(
      "IP 6.0, ER 1, K 8, K/9 12.0, BB 2, HA 4, HRA 0, ERA 1.50, WHIP 1.00, S 0, HLD 0, QS 1",
    );
    const html = mailer.sent[0]?.html ?? "";
    expect(html.indexOf("<h2>MLB</h2>")).toBeLessThan(html.indexOf("<h2>MiLB - Triple-A</h2>"));
  });

  it("groups MLB then MiLB then NCAA, labeling NCAA players with their school", async () => {
    const mlb = await insertPlayer(opened.db, {
      fullName: "Paul Skenes",
      level: "mlb",
      milbLevel: null,
      teamName: "Pittsburgh Pirates",
    });
    const aaa = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      fullName: "College Guy",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      schoolName: "LSU",
    });
    await insertStatLine(opened.db, {
      playerId: mlb.id,
      statType: "pitching",
      sportId: 1,
      stats: { inningsPitched: "6.0", hits: 4, earnedRuns: 1, baseOnBalls: 2, strikeOuts: 8, wins: 1 },
    });
    await insertStatLine(opened.db, { playerId: aaa.id });
    await insertStatLine(opened.db, {
      playerId: ncaa.id,
      sportId: 22,
      opponentName: "Georgia",
      stats: { hits: 2, atBats: 4, homeRuns: 1, rbi: 3 },
    });

    await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    const mlbAt = text.indexOf("MLB");
    const aaaAt = text.indexOf("MiLB - Triple-A");
    const ncaaAt = text.indexOf("NCAA");
    expect(mlbAt).toBeGreaterThanOrEqual(0);
    expect(aaaAt).toBeGreaterThan(mlbAt);
    expect(ncaaAt).toBeGreaterThan(aaaAt);
    // NCAA players are labeled with their school where a team would appear.
    expect(text).toContain("College Guy (LSU)");
    const html = mailer.sent[0]?.html ?? "";
    expect(html).toContain("<h2>NCAA</h2>");
    expect(html).toContain("College Guy (LSU)");
  });

  it("omits an out-of-season player entirely from the No new stats tail", async () => {
    // AAA season ended 2026-09-27; MLB runs to 10-31.
    clock.set("2026-10-01T17:00:00Z");
    await insertPlayer(opened.db, { fullName: "Out Of Season Guy" }); // AAA, no lines
    await insertPlayer(opened.db, {
      fullName: "Still Playing",
      level: "mlb",
      milbLevel: null,
      teamName: "Miami Marlins",
    });

    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain("No new stats: Still Playing");
    expect(text).not.toContain("Out Of Season Guy");
  });

  it("labels doubleheader games Game 1 / Game 2 (presentation only)", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880001,
      gameDate: "2026-06-01",
      gameNumber: 1,
      stats: { hits: 1, atBats: 3 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880002,
      gameDate: "2026-06-01",
      gameNumber: 2,
      stats: { hits: 2, atBats: 4 },
    });
    await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain("(Game 1): PA 3, H 1,");
    expect(text).toContain("(Game 2): PA 4, H 2,");
  });

  it("does not label a single game, and a two-way player keeps separate batting and pitching lines", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Two Way" });
    await insertStatLine(opened.db, { playerId: player.id, gameId: 880001, statType: "batting" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880001,
      statType: "pitching",
      stats: { inningsPitched: "5.0", hits: 3, earnedRuns: 2, baseOnBalls: 1, strikeOuts: 6 },
    });
    await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    expect(text).not.toContain("(Game");
    // Both roles render, each in its own fixed format (ADR 0033).
    expect(text).toContain("PA 4, H 2, K 1, 2B 0, 3B 0, HR 1, RBI 3, R 1, SB 0, CS 0, E 0, BB 0");
    expect(text).toContain(
      "IP 5.0, ER 2, K 6, K/9 10.8, BB 1, HA 3, HRA 0, ERA 3.60, WHIP 0.80, S 0, HLD 0, QS 0",
    );
  });

  it("merges a fielding row's errors into the same game's batting line, never a third line", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Error Prone" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880010,
      statType: "batting",
      gameDate: "2026-07-18",
      stats: { hits: 1, atBats: 4, strikeOuts: 2 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880010,
      statType: "fielding",
      gameDate: "2026-07-18",
      stats: { errors: 2, assists: 3, putOuts: 1 },
    });

    const result = await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain(
      "2026-07-18 vs Charlotte Knights: PA 4, H 1, K 2, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 2, BB 0",
    );
    // Exactly ONE rendered line for the game — the fielding row never stands alone.
    expect(text.match(/2026-07-18 vs Charlotte Knights/g)).toHaveLength(1);
    // Both stored rows (batting + fielding) are marked reported.
    expect(result.statLineCount).toBe(2);
    const unmarked = await opened.db.select().from(statLines).where(isNull(statLines.digestDeliveryId));
    expect(unmarked).toHaveLength(0);
  });

  it("renders a fielding-only game as a zeros batting line with E, and marks the fielding row", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Defensive Sub" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880020,
      statType: "fielding",
      gameDate: "2026-07-18",
      stats: { errors: 1, putOuts: 4 },
    });

    const result = await runDigest(deps());
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain("Defensive Sub");
    expect(text).toContain(
      "2026-07-18 vs Charlotte Knights: PA 0, H 0, K 0, 2B 0, 3B 0, HR 0, RBI 0, R 0, SB 0, CS 0, E 1, BB 0",
    );
    expect(result.statLineCount).toBe(1);
    // No unreported fielding rows remain after the digest runs.
    const unmarked = await opened.db.select().from(statLines).where(isNull(statLines.digestDeliveryId));
    expect(unmarked).toHaveLength(0);
  });

  it("on send failure records a failed delivery, leaves lines unmarked, and the retry succeeds", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    mailer.failWith = new Error("postmark down");

    const failed = await runDigest(deps());
    expect(failed.action).toBe("failed");
    expect(failed.reason).toBe("postmark down");

    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "failed", errorMessage: "postmark down" });
    const unmarked = await opened.db.select().from(statLines).where(isNull(statLines.digestDeliveryId));
    expect(unmarked).toHaveLength(1);

    // Same-day retry after the outage: sends and marks.
    mailer.failWith = null;
    const retried = await runDigest(deps());
    expect(retried.action).toBe("sent");
    expect(retried.statLineCount).toBe(1);
    const after = await opened.db.select().from(digestDeliveries);
    expect(after).toHaveLength(1); // the failed row was upgraded, not duplicated
    expect(after[0]?.status).toBe("sent");
    const stillUnmarked = await opened.db
      .select()
      .from(statLines)
      .where(isNull(statLines.digestDeliveryId));
    expect(stillUnmarked).toHaveLength(0);
  });

  it("excludes deactivated players' lines from the digest", async () => {
    const gone = await insertPlayer(opened.db, { fullName: "Deactivated Guy", active: false });
    await insertStatLine(opened.db, { playerId: gone.id });
    const active = await insertPlayer(opened.db, { fullName: "Active Guy" });
    await insertStatLine(opened.db, { playerId: active.id });

    const result = await runDigest(deps());
    expect(result.statLineCount).toBe(1);
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain("Active Guy");
    expect(text).not.toContain("Deactivated Guy");
  });
});

describe("runDigest heartbeat (Offseason Sleep, ADR 0031)", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
  });

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(OFFSEASON); // 2026-12-05 Chicago: after the World Series
    await insertCalendars2026(opened.db);
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    await insertPlayer(opened.db, { fullName: "Watched Two" });
    await insertPlayer(opened.db, { fullName: "Watched Three" });
  });

  afterEach(() => {
    opened.close();
  });

  it("sends a heartbeat with player count and ~TBD when the next season is unpublished", async () => {
    const result = await runDigest(deps());
    expect(result).toMatchObject({ kind: "heartbeat", action: "sent", playerCount: 3 });
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe("Bryce heartbeat - 2026-12-05");
    expect(mail?.text).toContain("alive; 3 players watched; games resume ~TBD");
    expect(mail?.html).toContain("alive; 3 players watched; games resume ~TBD");
  });

  it("shows the next opening day once the next season is published", async () => {
    await insertCalendar(opened.db, {
      season: "2027",
      regularSeasonStart: "2027-03-30",
      regularSeasonEnd: "2027-10-03",
      postSeasonStart: "2027-10-05",
      postSeasonEnd: "2027-11-01",
    });
    await runDigest(deps());
    expect(mailer.sent[0]?.text).toContain("games resume ~2027-03-30");
  });

  it("skips when a heartbeat was sent 6 days ago", async () => {
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-11-29",
      sentAt: "2026-11-29T18:00:00.000Z", // exactly 6 days before now
    });
    const result = await runDigest(deps());
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("heartbeat-sent-within-week");
    expect(mailer.sent).toHaveLength(0);
  });

  it("sends when the last heartbeat is 7+ days old", async () => {
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-11-28",
      sentAt: "2026-11-28T18:00:00.000Z", // exactly 7 days before now
    });
    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
  });

  it("records a failed heartbeat and does not count it as sent", async () => {
    mailer.failWith = new Error("smtp refused");
    const result = await runDigest(deps());
    expect(result.action).toBe("failed");
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries[0]).toMatchObject({ kind: "heartbeat", status: "failed", errorMessage: "smtp refused" });

    // Next run still sends (a failed heartbeat never suppresses the retry).
    mailer.failWith = null;
    const retry = await runDigest(deps());
    expect(retry.action).toBe("sent");
  });
});

describe("digest respects host-timezone dates", () => {
  it("covers the Chicago date, not the UTC date, near midnight UTC", async () => {
    const opened = testDb();
    const mailer = new CapturingMailer();
    // 2026-07-20T03:00Z is still 2026-07-19 in Chicago.
    const clock = fakeClock("2026-07-20T03:00:00Z");
    await insertCalendars2026(opened.db);
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await runDigest({
      db: opened.db,
      mailer,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
    });
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries[0]?.dateCovered).toBe("2026-07-19");
    opened.close();
  });
});
