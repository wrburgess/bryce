import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { openDb } from "../src/db/client.js";
import { digestDeliveries, statLines } from "../src/db/schema.js";
import { LEASE_MS, claimDelivery } from "../src/jobs/delivery-claim.js";
import type { DigestDeps, DigestResult } from "../src/jobs/digest.js";
import { runDigest } from "../src/jobs/digest.js";
import {
  CapturingMailer,
  GatedMailer,
  InjectedFault,
  LookupMailer,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  faultingDb,
  fakeClock,
  insertCalendar,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertStatLine,
  testDb,
  testFileDb,
} from "./factories.js";

/**
 * The cell values of the table row starting with `startsWith`, whitespace
 * collapsed — asserts every column without depending on column padding, which
 * shifts whenever a wider value shares the table.
 */
const cells = (text: string, startsWith: string): string[] =>
  (text.split("\n").find((l) => l.startsWith(startsWith)) ?? "").trim().split(/\s+/);

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
    spec: "1d",
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

  it("aggregates the window's lines, sends both parts with stat content, and stamps nothing", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { plateAppearances: 4, atBats: 4, hits: 2, homeRuns: 1, rbi: 3, totalBases: 5 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-17",
      stats: { plateAppearances: 5, atBats: 5, hits: 1, strikeOuts: 2, totalBases: 1 },
    });

    // A 7d window ending on the last completed day covers 07-12..07-18.
    const linesBefore = await opened.db.select().from(statLines);
    const result = await runDigest({ ...deps(), spec: "7d" });
    expect(result).toMatchObject({
      kind: "digest",
      action: "sent",
      statLineCount: 2,
      playerCount: 1,
      window: "Last 7 Days (Jul 12-18)",
    });

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail?.to).toBe("hc@example.com");
    expect(mail?.subject).toBe("ScoreKeeps Baseball (Default) - Prev 7 Days");
    // Never assert only success: BOTH parts carry the actual stat content, and
    // the numbers are the WINDOW's — 3-for-9 with 6 total bases across two
    // games, derived from summed counters rather than averaged per game.
    expect(cells(mail?.text ?? "", "M Acosta")).toEqual(
      ["M", "Acosta", "AAA", "2", ".333/.333/.667", "9", "3", "0", "2", "0", "0", "1", "3", "0", "0", "0", "0"],
    );
    expect(mail?.html).toContain("<td");
    expect(mail?.html).toContain("M Acosta");
    expect(mail?.html).toContain(".333/.333/.667");
    // Level sections are gone: the level is a column now, because a window can
    // span a promotion and a section heading could not say that.
    expect(mail?.html).not.toContain("<h2>MiLB - Triple-A</h2>");

    // An ON-DEMAND window writes no delivery row at all. The claim exists so
    // the DAILY digest cannot go out twice for one date; its slot is keyed
    // (kind, date_covered) with no room for a window, so letting a 7d report
    // occupy it would refuse the day's 1d run as already-sent.
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    // ...and nothing is written to stat_lines either, in any window.
    expect(await opened.db.select().from(statLines)).toEqual(linesBefore);
  });

  it("the DAILY 1d digest still claims a slot and records its counts", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const result = await runDigest({ ...deps(), spec: "1d" });
    expect(result.action).toBe("sent");

    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      statLineCount: 1,
      playerCount: 1,
    });
  });

  it("the daily 1d digest carries a freshness verdict; an on-demand window carries none (ADR 0043)", async () => {
    // The full freshness matrix lives in test/digest-freshness.test.ts; this
    // pins the DigestResult shape change on the core paths. With no refresh run
    // recorded, the daily digest reads stale (and still sends, annotated).
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const daily = await runDigest({ ...deps(), spec: "1d" });
    expect(daily.action).toBe("sent");
    expect(daily.freshness).toBe("stale");

    const onDemand = await runDigest({ ...deps(), spec: "7d" });
    expect(onDemand.freshness).toBeNull();
  });

  it("recovers a previous day's FAILED digest slot after the date rolls", async () => {
    // A failed slot for a prior date used to be orphaned forever: claimDelivery
    // only ever looked at today's date, and novelty (which re-reported the lines
    // for free) is gone. The next day's run must catch it up.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-17" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    // A failed digest slot for 2026-07-19 (its 1d window covers Jul 18).
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "failed",
      sentAt: null,
    });

    // Today is 2026-07-20 (clock is MID_SEASON = 2026-07-19T17:00Z → hostDate
    // 2026-07-19... so advance it a day).
    clock.set("2026-07-20T17:00:00Z");
    const result = await runDigest({ ...deps(), spec: "1d" });

    // Two emails went out: the recovered Jul 18 day, then today's Jul 19 day.
    expect(result.action).toBe("sent");
    expect(mailer.sent).toHaveLength(2);
    const subjects = mailer.sent.map((m) => m.subject);
    expect(subjects).toContain("ScoreKeeps Baseball (Default) - Sat, July 18, 2026"); // recovered
    expect(subjects).toContain("ScoreKeeps Baseball (Default) - Sun, July 19, 2026"); // today

    // The recovered slot is now settled sent, not left failed.
    const rows = await opened.db
      .select()
      .from(digestDeliveries)
      .where(eq(digestDeliveries.dateCovered, "2026-07-19"));
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.attemptCount).toBe(2); // re-claimed, not fresh
  });

  it("reconciles a previous day's stale SENDING slot instead of re-sending it", async () => {
    // A run that crashed after the provider accepted leaves a `sending` row.
    // Recovery must ASK the provider first: if it already landed, settle it
    // reconciled and send nothing, or the HC gets that day twice.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    // An expired sending slot for Jul 19 — claimedAt well beyond the lease.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      sentAt: null,
      claimedAt: "2026-07-19T00:00:00.000Z",
      attemptCount: 1,
    });

    // A mailer that CONFIRMS the crashed Jul 19 attempt already landed.
    const lookup = new LookupMailer();
    lookup.result = { outcome: "accepted", providerMessageId: "pm-jul19" };
    clock.set("2026-07-20T17:00:00Z");
    const result = await runDigest({ ...deps(), mailer: lookup, spec: "1d" });

    // Today's Jul 19 digest sent; the recovered slot was reconciled, NOT re-sent.
    expect(result.action).toBe("sent");
    const recovered = await opened.db
      .select()
      .from(digestDeliveries)
      .where(eq(digestDeliveries.dateCovered, "2026-07-19"));
    expect(recovered[0]?.status).toBe("sent");
    expect(recovered[0]?.reconciledAt).not.toBeNull();
    // The recovery reconciled and sent NOTHING; only today's digest hit send().
    // Today is Jul 20, so its 1d window covers Jul 19 — proof the reconciled
    // slot did not also re-send its own Jul 18 content.
    expect(lookup.sent).toHaveLength(1);
    expect(lookup.sent[0]?.subject).toBe("ScoreKeeps Baseball (Default) - Sun, July 19, 2026");
    expect(lookup.lookups.map((l) => l.deliveryKey)).toContain("bryce:digest:2026-07-19");
  });

  it("a 7d request is not refused because the day's 1d digest already went out", async () => {
    // The slot is keyed (kind, date_covered) with no room for a window. When
    // every window shared it, the day's scheduled 1d report claimed the slot
    // and a later 7d request came back already-sent-today — the headline
    // feature refusing to run because the daily one had.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    expect((await runDigest({ ...deps(), spec: "1d" })).action).toBe("sent");
    const onDemand = await runDigest({ ...deps(), spec: "7d" });
    expect(onDemand.action).toBe("sent");
    expect(onDemand.window).toBe("Last 7 Days (Jul 12-18)");
    expect(mailer.sent).toHaveLength(2);
  });

  it("a failed on-demand window is never settled by the next daily digest", async () => {
    // The other half of the same collision: a failed 7d attempt left a `failed`
    // row in the shared slot, and the next 1d run reclaimed it, sent 1d content
    // and settled that row `sent`. The 7d report never landed, and the slot
    // said it had.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const failing = new CapturingMailer();
    failing.send = () => Promise.reject(new Error("provider exploded"));
    const failed = await runDigest({ ...deps(), mailer: failing, spec: "7d" });
    expect(failed.action).toBe("failed");
    // It holds no slot to strand.
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

    const daily = await runDigest({ ...deps(), spec: "1d" });
    expect(daily.action).toBe("sent");
    const rows = await opened.db.select().from(digestDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptCount).toBe(1); // a fresh claim, not a reclaimed 7d row
  });

  it("gives an on-demand report its own provider key, so daily recovery cannot see it", async () => {
    // The daily digest's stale-claim recovery asks the provider "did the
    // crashed attempt already land?", and a positive answer SUPPRESSES the
    // send. If an ad-hoc report carried bryce:digest:{date}, that lookup would
    // find the report and silently skip the real digest.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    await runDigest({ ...deps(), spec: "7d" });
    await runDigest({ ...deps(), spec: "1d" });

    const keys = mailer.contexts.map((c) => c?.deliveryKey);
    expect(keys).toContain("bryce:report:7d:2026-07-18");
    expect(keys).toContain("bryce:digest:2026-07-19");
    expect(new Set(keys).size).toBe(2); // distinct namespaces, no collision
  });

  it("answers an explicit window during Offseason Sleep instead of a heartbeat", async () => {
    // Sleep stops the DAILY artifact mailing nothing for months. Answering an
    // explicit "give me my season to date" with a liveness heartbeat is not
    // that — it is refusing the question.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    clock.set(OFFSEASON);

    const scheduled = await runDigest({ ...deps(), spec: "1d" });
    expect(scheduled.kind).toBe("heartbeat");

    const asked = await runDigest({ ...deps(), spec: "ytd" });
    expect(asked.kind).toBe("digest");
  });

  it("excludes an unclassified stat field AND reports it", async () => {
    // Fail-closed has two halves. Excluding the field is the safe one; saying
    // so is the other. Without the warning an upstream field addition is
    // dropped from every future report and nobody learns the tables went stale.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 2, atBats: 4, warpDriveEfficiency: 9 },
    });

    const warnings: string[] = [];
    const result = await runDigest({ ...deps(), spec: "7d", warn: (m) => warnings.push(m) });

    // Excluded, not summed, and the run still succeeds.
    expect(result.action).toBe("sent");
    expect(mailer.sent.at(-1)?.text).not.toContain("warpDriveEfficiency");
    // ...and reported, by name, with somewhere to go fix it.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("warpDriveEfficiency");
    expect(warnings[0]).toContain("src/stats/fields.ts");
  });

  it("surfaces an unclassified FIELDING key, which the fielding-to-batting merge could hide", async () => {
    // A fielding split is reduced to its error count before aggregation, so an
    // unknown fielding key never reaches an aggregate — it was being dropped
    // silently, the exact staleness the warning exists to catch. The union is
    // computed from the raw splits so it sees fielding keys by their own type.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990101,
      statType: "batting",
      gameDate: "2026-07-18",
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990101,
      statType: "fielding",
      gameDate: "2026-07-18",
      stats: { errors: 0, warpFielding: 3 },
    });

    const warnings: string[] = [];
    await runDigest({ ...deps(), spec: "7d", warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("warpFielding");
  });

  it("accepts the derived catcher caught-stealing percentage from a fielding split", async () => {
    // MLB emits this rate alongside the catcher SB/CS counters. The Digest must
    // recompute it from those counters, not warn that a known source field is
    // unknown just because the fielding table also carries it.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990102,
      statType: "batting",
      gameDate: "2026-07-18",
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 990102,
      statType: "fielding",
      gameDate: "2026-07-18",
      stats: { errors: 0, stolenBases: 2, caughtStealing: 1, caughtStealingPercentage: ".333" },
    });

    const warnings: string[] = [];
    await runDigest({ ...deps(), spec: "7d", warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("recovers a prior failed slot even when TODAY is in Offseason Sleep", async () => {
    // Recovery must run BEFORE the sleep check. A digest that failed on the
    // season's last day would otherwise never recover: the next run is already
    // asleep and returns a heartbeat before reaching the recovery pass.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-10-30" });

    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-10-31",
      status: "failed",
      sentAt: null,
    });

    clock.set(OFFSEASON); // 2026-12-05: deep in the offseason
    const result = await runDigest({ ...deps(), spec: "1d" });

    // Today's run is the offseason heartbeat...
    expect(result.kind).toBe("heartbeat");
    // ...but the failed Oct 31 slot was still caught up first.
    const recovered = await opened.db
      .select()
      .from(digestDeliveries)
      .where(eq(digestDeliveries.dateCovered, "2026-10-31"));
    expect(recovered[0]?.status).toBe("sent");
    expect(recovered[0]?.attemptCount).toBe(2);
  });

  it("says nothing when every field is classified", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const warnings: string[] = [];
    await runDigest({ ...deps(), spec: "7d", warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("does not straddle midnight: slot date and content window come from one anchor", async () => {
    // The run reads the clock for sleep, the slot date, the claim, assembly,
    // the In Season filter and settlement. Read live, a run starting at
    // 23:59:59.9 claims yesterday's slot and then assembles today's window —
    // the same content goes out under two slots on two consecutive days.
    //
    // This clock advances past midnight after the first three reads, which is
    // exactly where the divergence used to appear.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    let reads = 0;
    const straddling = (): Date => {
      reads += 1;
      // 04:59:59.900Z = 23:59:59.900 CDT on Jul 19; 05:00:00.100Z = 00:00:00.100 CDT on Jul 20.
      return reads <= 3
        ? new Date("2026-07-20T04:59:59.900Z")
        : new Date("2026-07-20T05:00:00.100Z");
    };

    const result = await runDigest({ ...deps(), now: straddling, spec: "1d" });
    expect(result.action).toBe("sent");

    // The slot the run claimed...
    const rows = await opened.db.select().from(digestDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dateCovered).toBe("2026-07-19");
    // ...and the content it sent must describe the SAME day. A 1d window on
    // Jul 19 covers Jul 18, so the subject names Jul 18 — not Jul 19, which is
    // what an unfrozen clock produced.
    expect(mailer.sent.at(-1)?.subject).toBe("ScoreKeeps Baseball (Default) - Sat, July 18, 2026");

    // The direct pin: the run reads the clock ONCE, so this clock never gets a
    // second chance to advance. Before the anchor existed there were nine reads
    // and the subject came out "Sun, July 19, 2026" — a day of content that the
    // Jul 19 slot does not cover, and that Jul 20's run would send again.
    expect(reads).toBe(1);
  });

  it("leaves stat_lines byte-identical, whether the send succeeds or fails", async () => {
    // Replaces the old per-outcome "nothing carries a delivery stamp" checks.
    // Those could only ask whether one column was null; this asks the question
    // they stood for — did the run change ANY stored line — and it keeps
    // working now that the stamp column is gone (ADR 0035).
    //
    // The failing arm matters most: settleFailed is the path that used to be
    // able to damage delivery state, so a run that dies at the provider is
    // where a stray write would surface.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    const before = await opened.db.select().from(statLines);
    expect(before).not.toHaveLength(0); // a vacuous snapshot would prove nothing

    await runDigest(deps());
    expect(await opened.db.select().from(statLines)).toEqual(before);

    const failing = new CapturingMailer();
    failing.send = () => Promise.reject(new Error("provider exploded"));
    const failed = await runDigest({ ...deps(), mailer: failing, spec: "7d", force: true });
    expect(failed.action).toBe("failed");
    expect(await opened.db.select().from(statLines)).toEqual(before);
  });

  it("re-running the same window sends the same content", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    // The point of the redesign: under novelty selection the second run
    // reported nothing, because the first had consumed the line.
    const first = await runDigest({ ...deps(), spec: "7d", force: true });
    const second = await runDigest({ ...deps(), spec: "7d", force: true });
    expect(second.statLineCount).toBe(first.statLineCount);
    expect(second.statLineCount).toBe(1);
    expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
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

  it("sends the next day's digest even when the window is empty, as a zero row", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await runDigest(deps());

    // 07-20's 1d window is 07-19, on which nobody played.
    clock.set("2026-07-20T17:00:00Z");
    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(result.statLineCount).toBe(0);
    const mail = mailer.sent[1];
    expect(mail?.subject).toBe("ScoreKeeps Baseball (Default) - Sun, July 19, 2026");
    // A GP 0 row says it better than the old "no new stats" tail.
    expect(cells(mail?.text ?? "", "M Acosta")).toEqual(
      ["M", "Acosta", "AAA", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
    );
    expect(mail?.html).toContain("M Acosta");
  });

  it("reports a line by its GAME date, so a late arrival lands in the window it belongs to", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await runDigest(deps());

    // A late final from 07-17 lands after the 07-19 digest already went out. It
    // is NOT carried forward: it belongs to 07-17, and a window that covers
    // 07-17 reports it — which is what makes re-running one meaningful.
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-17",
      stats: { plateAppearances: 4, atBats: 4, hits: 3 },
    });
    clock.set("2026-07-20T17:00:00Z");
    const nextDay = await runDigest(deps());
    expect(nextDay.statLineCount).toBe(0); // 1d window is 07-19: nothing there

    clock.set("2026-07-21T17:00:00Z");
    const wide = await runDigest({ ...deps(), spec: "7d" });
    expect(wide.statLineCount).toBe(2);
    expect(cells(mailer.sent[2]?.text ?? "", "M Acosta")[5]).toBe("8"); // PA 4 + 4
  });

  it("orders rows by the level ladder and labels each with the level the GAME was played at", async () => {
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
    // Batters, top of the ladder first; no level SECTIONS, just a Lvl column.
    expect(text).not.toContain("MiLB - Triple-A");
    expect(text.indexOf("M Acosta")).toBeLessThan(text.indexOf("D Guy"));
    expect(cells(text, "M Acosta")[2]).toBe("AAA");
    expect(cells(text, "D Guy")[2]).toBe("AA");
    // The pitcher's whole row, including the derived single-game rates and the
    // QS S BS HLD RW RL tail. This fixture's win row carries no gamesStarted, so
    // the fail-closed rule leaves RW 0 — an appearance counts as relief only when
    // gamesStarted is present and 0. (A realistic MLB start, gamesStarted:1, is
    // exercised in digest-preview.test.ts.)
    expect(cells(text, "P Skenes")).toEqual(
      ["P", "Skenes", "MLB", "6.0", "1", "8", "12.00", "2", "4", "0", "1.50", "1.00", "1", "0", "0", "0", "0", "0"],
    );
    const html = mailer.sent[0]?.html ?? "";
    expect(html.indexOf("<h2>Batters</h2>")).toBeLessThan(html.indexOf("<h2>Pitchers</h2>"));
  });

  it("places an NCAA row last on the ladder", async () => {
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
    expect(cells(text, "M Acosta")[2]).toBe("AAA");
    expect(cells(text, "C Guy")[2]).toBe("NCAA");
    // NCAA is the bottom of the ladder, below every MiLB level.
    expect(text.indexOf("M Acosta")).toBeLessThan(text.indexOf("C Guy"));
    expect(mailer.sent[0]?.html).toContain("C Guy");
  });

  it("omits an out-of-season player entirely from the zero rows", async () => {
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
    expect(text).toContain("S Playing");
    expect(text).not.toContain("Season Guy");
  });

  it("renders a doubleheader as two Gm rows in a 1d window and folds it in a 7d one", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880001,
      gameDate: "2026-07-18",
      gameNumber: 1,
      stats: { plateAppearances: 3, atBats: 3, hits: 1, totalBases: 1 },
    });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 880002,
      gameDate: "2026-07-18",
      gameNumber: 2,
      stats: { plateAppearances: 4, atBats: 4, hits: 2, totalBases: 3 },
    });

    await runDigest(deps());
    const oneDay = mailer.sent[0]?.text ?? "";
    // Two rows, told apart by Gm — there is no opponent column to do it.
    expect(oneDay.split("\n").filter((l) => l.startsWith("M Acosta"))).toHaveLength(2);
    expect(oneDay).toMatch(/Player\s+Lvl\s+Gm\s+PA/);
    const rows = oneDay.split("\n").filter((l) => l.startsWith("M Acosta"));
    expect(rows[0]?.trim().split(/\s+/).slice(2, 6)).toEqual(["AAA", "1", "3", "1"]);
    expect(rows[1]?.trim().split(/\s+/).slice(2, 6)).toEqual(["AAA", "2", "4", "2"]);

    // The same day inside a 7d window is one row of two games, no Gm column.
    const week = await runDigest({ ...deps(), spec: "7d", force: true });
    expect(week.statLineCount).toBe(2);
    const weekText = mailer.sent[1]?.text ?? "";
    expect(weekText.split("\n").filter((l) => l.startsWith("M Acosta"))).toHaveLength(1);
    expect(cells(weekText, "M Acosta").slice(2, 6)).toEqual(["AAA", "2", ".429/.429/.571", "7"]);
  });

  it("gives a two-way player a row in each table, and leaves Gm blank for one game", async () => {
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
    // One game apiece, so no Gm value on either row: the third cell is PA / IP.
    expect(cells(text, "T Way")).toEqual(
      ["T", "Way", "AAA", "4", "2", "0", "1", "0", "0", "1", "3", "1", "0", "0", "0"],
    );
    const pitchingRow = text.slice(text.indexOf("Pitchers"));
    expect(cells(pitchingRow, "T Way")).toEqual(
      ["T", "Way", "AAA", "5.0", "2", "6", "10.80", "1", "3", "0", "3.60", "0.80", "0", "0", "0", "0", "0", "0"],
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
    // One row, carrying the batting line with E merged in — never a third table.
    expect(text.split("\n").filter((l) => l.startsWith("E Prone"))).toHaveLength(1);
    expect(cells(text, "E Prone")).toEqual(
      ["E", "Prone", "AAA", "4", "1", "0", "2", "0", "0", "0", "0", "0", "0", "0", "2"],
    );
    expect(text).not.toContain("Fielders");
    // Both stored rows are in the window's count.
    expect(result.statLineCount).toBe(2);
  });

  it("renders a fielding-only game as a zeros batting row carrying only E", async () => {
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
    expect(cells(text, "D Sub")).toEqual(
      ["D", "Sub", "AAA", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1"],
    );
    expect(result.statLineCount).toBe(1);
  });

  it("on send failure records a failed delivery, and the retry sends the same window", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    mailer.failWith = new Error("postmark down");

    const failed = await runDigest(deps());
    expect(failed.action).toBe("failed");
    expect(failed.reason).toBe("postmark down");

    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "failed", errorMessage: "postmark down" });

    // Same-day retry after the outage: re-claims the slot and sends the SAME
    // window, because a failed send consumed nothing there was to consume.
    mailer.failWith = null;
    const retried = await runDigest(deps());
    expect(retried.action).toBe("sent");
    expect(retried.statLineCount).toBe(1);
    const after = await opened.db.select().from(digestDeliveries);
    expect(after).toHaveLength(1); // the failed row was upgraded, not duplicated
    expect(after[0]?.status).toBe("sent");
  });

  it("excludes deactivated players' lines from the digest", async () => {
    const gone = await insertPlayer(opened.db, { fullName: "Deactivated Guy", active: false });
    await insertStatLine(opened.db, { playerId: gone.id });
    const active = await insertPlayer(opened.db, { fullName: "Active Guy" });
    await insertStatLine(opened.db, { playerId: active.id });

    const result = await runDigest(deps());
    expect(result.statLineCount).toBe(1);
    const text = mailer.sent[0]?.text ?? "";
    expect(text).toContain("A Guy");
    expect(text).not.toContain("D Guy");
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
    spec: "1d",
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

/**
 * ADR 0034. Two things are being proved here, and they are different:
 *   - MUTUAL EXCLUSION IS EXACT — at most one invocation per (kind, date) slot
 *     reaches the mail provider at a time.
 *   - THE CRASH-AFTER-ACCEPTANCE WINDOW IS AT-LEAST-ONCE — a delivery whose
 *     acceptance was never durably recorded is re-sent once its lease expires.
 * The duplicate in that second case is asserted out loud (test: "re-sends the
 * duplicate"), never hidden: a bounded, observable duplicate is the accepted
 * outcome; a silently missing digest is not.
 *
 * Concurrency is expressed as an explicit promise barrier (GatedMailer), never
 * a wall-clock sleep (rules/testing.md) — a sleep would make the race probable,
 * the barrier makes it certain.
 */
describe("delivery claim under concurrency (ADR 0034)", () => {
  let opened: OpenedDb;
  let mailer: GatedMailer;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    spec: "1d",
  });

  beforeEach(async () => {
    opened = testDb();
    mailer = new GatedMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("refuses a second digest while the first holds a live claim mid-send", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await insertStatLine(opened.db, { playerId: player.id });

    const first = runDigest(deps());
    await mailer.waitForInFlight(1); // A is parked AT the provider, claim held

    const second = await runDigest(deps());
    expect(second.action).toBe("skipped");
    expect(second.reason).toBe("claimed-by-another-run");
    expect(mailer.attempts).toHaveLength(1); // B never reached the provider

    mailer.release();
    expect(await first).toMatchObject({ action: "sent", statLineCount: 2 });

    expect(mailer.sent).toHaveLength(1);
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "sent", attemptCount: 1, statLineCount: 2 });
    // There is no line state to race over: neither run writes to stat_lines.
  });

  it("lets only one of two truly interleaved invocations reach the provider", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    // Both start before either can claim: real event-loop interleaving.
    const both = Promise.all([runDigest(deps()), runDigest(deps())]);
    await mailer.waitForInFlight(1);
    mailer.release();
    const results = await both;

    const actions = results.map((r) => r.action).sort();
    expect(actions).toEqual(["sent", "skipped"]);
    // Whichever lost may see a live claim or an already-settled one, depending
    // on where it resumed — both are refusals, and neither may send.
    const skipped = results.find((r) => r.action === "skipped");
    expect(["claimed-by-another-run", "already-sent-today"]).toContain(skipped?.reason);

    expect(mailer.attempts).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1); // no duplicate row
    expect(deliveries[0]?.status).toBe("sent");
  });

  it("excludes across two connections to one database file (launchd CLI vs the server)", async () => {
    // Models the real race: the scheduled CLI and the long-running server are
    // separate connections. The claim is durable in the FILE, so exclusion
    // survives it. (What this cannot exercise in one process is lock
    // contention — better-sqlite3 is synchronous, so two transactions on one
    // process never overlap. That the connections carry busy_timeout at all is
    // asserted in test/schema.test.ts.)
    const file = testFileDb();
    const second = openDb(file.path);
    const gated = new GatedMailer();
    const base = {
      mailer: gated,
      now: clock.now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
      spec: "1d" as const,
    };
    try {
      await insertCalendars2026(file.opened.db);
      const player = await insertPlayer(file.opened.db);
      await insertStatLine(file.opened.db, { playerId: player.id });

      const both = Promise.all([
        runDigest({ ...base, db: file.opened.db }),
        runDigest({ ...base, db: second.db }),
      ]);
      await gated.waitForInFlight(1);
      gated.release();
      const results = await both;

      expect(results.map((r) => r.action).sort()).toEqual(["sent", "skipped"]);
      expect(gated.attempts).toHaveLength(1);
      expect(gated.sent).toHaveLength(1);
      // Read the outcome back on the OTHER connection: the claim was durable.
      const deliveries = await second.db.select().from(digestDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ status: "sent", attemptCount: 1 });
    } finally {
      second.close();
      file.cleanup();
    }
  });

  it("refuses a second heartbeat while the first holds a live claim mid-send", async () => {
    clock.set(OFFSEASON);
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    await insertPlayer(opened.db, { fullName: "Watched Two" });

    const both = Promise.all([runDigest(deps()), runDigest(deps())]);
    await mailer.waitForInFlight(1);
    mailer.release();
    const results = await both;

    expect(results.map((r) => r.action).sort()).toEqual(["sent", "skipped"]);
    expect(results.every((r) => r.kind === "heartbeat")).toBe(true);
    expect(mailer.attempts).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: "heartbeat", status: "sent" });
  });

  it("holds the rolling seven-day heartbeat rule across two DIFFERENT days in one week", async () => {
    // The slot key is (heartbeat, date), so two runs on different days never
    // collide on the unique index — only the rule evaluated INSIDE the claim
    // transaction stops the second one.
    clock.set(OFFSEASON); // 2026-12-05 Chicago
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });

    const first = runDigest(deps());
    await mailer.waitForInFlight(1);
    mailer.release();
    expect((await first).action).toBe("sent");

    clock.set("2026-12-07T18:00:00Z"); // two days later: a different slot key
    const second = await runDigest(deps());
    expect(second.action).toBe("skipped");
    expect(second.reason).toBe("heartbeat-sent-within-week");

    expect(mailer.attempts).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.dateCovered).toBe("2026-12-05");
  });
});

describe("delivery recovery after a crash (ADR 0034)", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;

  /** MID_SEASON + 11 minutes: past the 10-minute claim lease, same Chicago date. */
  const PAST_LEASE = "2026-07-19T17:11:00Z";

  const deps = (): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    spec: "1d",
  });

  const deliveries = () => opened.db.select().from(digestDeliveries);

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("does not recover a claim eagerly: a fresh sending row blocks and sends nothing", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    // Durable aftermath of a run that claimed and died BEFORE sending.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: MID_SEASON,
      attemptCount: 1,
    });

    const result = await runDigest(deps());
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("claimed-by-another-run");
    expect(mailer.sent).toHaveLength(0);
  });

  it("re-sends the duplicate when a run dies after acceptance and before the settle", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    const crashed = runDigest({ ...deps(), db: faultingDb(opened.db, { failAt: "before-settle" }) });
    await expect(crashed).rejects.toThrow(/before the settle transaction/);

    // Durable aftermath: the provider took the mail, we never recorded it.
    expect(mailer.sent).toHaveLength(1);
    const stuck = await deliveries();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ status: "sending", sentAt: null, attemptCount: 1 });

    // Past the lease, the slot heals — and the healing RE-SENDS. This second
    // mail is the documented at-least-once limitation, asserted rather than
    // wished away (ADR 0034; issue #22 AC #5).
    clock.set(PAST_LEASE);
    const healed = await runDigest(deps());
    expect(healed).toMatchObject({ action: "sent", reason: "recovered-stale-claim", statLineCount: 1 });
    expect(mailer.sent).toHaveLength(2);

    const after = await deliveries();
    expect(after).toHaveLength(1); // recovered in place, never a duplicate row
    expect(after[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      sentAt: "2026-07-19T17:11:00.000Z",
    });
  });

  it("rolls the settle back when the process dies inside it, before COMMIT", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await insertStatLine(opened.db, { playerId: player.id });

    const crashed = runDigest({ ...deps(), db: faultingDb(opened.db, { failAt: "in-settle" }) });
    // The message pins WHERE the fault fired: the statement ran, COMMIT did not.
    await expect(crashed).rejects.toThrow(/inside the settle, before COMMIT/);

    expect(mailer.sent).toHaveLength(1);
    // The delivery update is GONE — SQLite rolled the transaction back, so the
    // slot is left claimed rather than half-settled, and the lease heals it.
    const stuck = await deliveries();
    expect(stuck[0]).toMatchObject({ status: "sending", sentAt: null });

    clock.set(PAST_LEASE);
    const healed = await runDigest(deps());
    expect(healed).toMatchObject({ action: "sent", statLineCount: 2, reason: "recovered-stale-claim" });
    expect((await deliveries())[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      statLineCount: 2,
    });
  });

  it("reclaims a sending row older than the lease and bumps the attempt count", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: "2026-07-19T16:30:00.000Z", // 30 minutes ago: lease expired
      attemptCount: 1,
      statLineCount: 0,
      playerCount: 0,
    });

    const result = await runDigest(deps());
    expect(result).toMatchObject({ action: "sent", reason: "recovered-stale-claim" });
    expect(mailer.sent).toHaveLength(1);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attemptCount: 2, statLineCount: 1 });
  });

  it("clears the previous attempt's error and provider id when re-claiming a slot", async () => {
    // A `sending` row describes the attempt IN FLIGHT. If a re-claim left the
    // prior attempt's failure text or provider id behind, /health would show an
    // in-flight delivery alongside a stale error — the observability this design
    // leans on would be lying. Asserted mid-flight, because settling would
    // overwrite both fields anyway and hide the bug.
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "failed",
      errorMessage: "postmark down",
      providerMessageId: "old-provider-id",
      attemptCount: 1,
      statLineCount: 0,
      playerCount: 0,
    });

    const gated = new GatedMailer();
    const inFlight = runDigest({ ...deps(), mailer: gated });
    await gated.waitForInFlight(1);

    const claimed = (await deliveries())[0];
    expect(claimed).toMatchObject({ status: "sending", attemptCount: 2 });
    expect(claimed?.errorMessage).toBeNull();
    expect(claimed?.providerMessageId).toBeNull();

    gated.release();
    await inFlight;
  });

  it("heals a crashed heartbeat and restarts the seven-day clock from the NEW send", async () => {
    clock.set(OFFSEASON); // 2026-12-05T18:00:00Z
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });

    const crashed = runDigest({ ...deps(), db: faultingDb(opened.db, { failAt: "before-settle" }) });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    expect(mailer.sent).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({
      kind: "heartbeat",
      status: "sending",
      sentAt: null,
    });

    clock.set("2026-12-05T18:11:00Z"); // past the lease
    const healed = await runDigest(deps());
    expect(healed).toMatchObject({ kind: "heartbeat", action: "sent", reason: "recovered-stale-claim" });
    expect(mailer.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      sentAt: "2026-12-05T18:11:00.000Z",
    });

    // Next-eligible time runs from the NEW sent_at (18:11), not the crashed
    // attempt (18:00) — six minutes that would otherwise let a heartbeat out early.
    clock.set("2026-12-12T18:05:00Z");
    const tooSoon = await runDigest(deps());
    expect(tooSoon.action).toBe("skipped");
    expect(tooSoon.reason).toBe("heartbeat-sent-within-week");
    expect(mailer.sent).toHaveLength(2);

    clock.set("2026-12-12T18:11:00Z"); // exactly seven days after the real send
    const due = await runDigest(deps());
    expect(due.action).toBe("sent");
    expect(mailer.sent).toHaveLength(3);
  });

  it("never lets a stuck sending heartbeat satisfy the seven-day rule", async () => {
    clock.set(OFFSEASON); // 2026-12-05
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    // A heartbeat claimed two days ago that never settled. If `sending` counted
    // toward the rule this would suppress today's heartbeat — silencing the
    // liveness signal for a week off the back of a crash.
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-12-03",
      status: "sending",
      claimedAt: "2026-12-03T18:00:00.000Z",
      attemptCount: 1,
    });

    const result = await runDigest(deps());
    expect(result).toMatchObject({ kind: "heartbeat", action: "sent" });
    expect(mailer.sent).toHaveLength(1);
    const rows = await deliveries();
    expect(rows).toHaveLength(2); // the stuck row is a different slot, untouched
    const stuck = rows.find((r) => r.dateCovered === "2026-12-03");
    expect(stuck).toMatchObject({ status: "sending", sentAt: null });
    const fresh = rows.find((r) => r.dateCovered === "2026-12-05");
    expect(fresh).toMatchObject({ status: "sent" });
  });

  it("records the provider's message id on the settled delivery", async () => {
    mailer.providerMessageId = "postmark-abc-123";
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    await runDigest(deps());
    const rows = await deliveries();
    expect(rows[0]?.providerMessageId).toBe("postmark-abc-123");
    // The slot key handed to the provider is stable per (kind, date).
    expect(mailer.contexts[0]).toEqual({ deliveryKey: "bryce:digest:2026-07-19" });
  });

  it("releases the slot on provider rejection so the retry re-claims it", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    mailer.failWith = new Error("postmark down");

    const failed: DigestResult = await runDigest(deps());
    expect(failed.action).toBe("failed");
    expect((await deliveries())[0]).toMatchObject({
      status: "failed",
      sentAt: null,
      attemptCount: 1,
      errorMessage: "postmark down",
    });

    mailer.failWith = null;
    const retried = await runDigest(deps());
    expect(retried.action).toBe("sent");
    expect(retried.reason).toBeNull(); // a retry is not a stale-claim recovery
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attemptCount: 2, errorMessage: null });
  });
});

/**
 * Provider reconciliation on the recovery path (ADR 0034 amendment, issue #41).
 *
 * #40 left one window open: a run that dies between provider acceptance and the
 * settle re-sends once its lease expires. A recovered claim now asks the
 * provider whether that delivery key already landed — and suppresses the resend
 * ONLY on a positive confirmation.
 *
 * The dangerous direction here is inverted from the rest of ADR 0034: a wrong
 * "accepted" suppresses a REAL send, which is silent mail loss — strictly worse
 * than the duplicate this avoids. So every ambiguous answer re-sends, and the
 * two ways of being ambiguous are asserted separately rather than assumed.
 */
describe("provider reconciliation on recovery (ADR 0034 amendment)", () => {
  let opened: OpenedDb;
  let mailer: LookupMailer;
  let clock: ReturnType<typeof fakeClock>;

  /** MID_SEASON + 11 minutes: past the 10-minute claim lease, same Chicago date. */
  const PAST_LEASE = "2026-07-19T17:11:00Z";
  const RECONCILED_AT = "2026-07-19T17:11:00.000Z";

  const deps = (): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    spec: "1d",
  });

  const deliveries = () => opened.db.select().from(digestDeliveries);

  /** Crash a digest run between provider acceptance and the settle commit. */
  async function crashAfterAcceptance(): Promise<void> {
    const crashed = runDigest({ ...deps(), db: faultingDb(opened.db, { failAt: "before-settle" }) });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
  }

  beforeEach(async () => {
    opened = testDb();
    mailer = new LookupMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("suppresses the resend, marking NO stat lines, when the provider confirms acceptance", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await crashAfterAcceptance();
    expect(mailer.sent).toHaveLength(1);

    mailer.result = { outcome: "accepted", providerMessageId: "pm-already-accepted" };
    clock.set(PAST_LEASE);
    const healed = await runDigest(deps());

    expect(healed).toMatchObject({
      kind: "digest",
      action: "skipped",
      reason: "reconciled-already-accepted",
      statLineCount: 0,
    });
    // The whole point: NO second email.
    expect(mailer.sent).toHaveLength(1);
    // Asked about the right slot, bounded by the CRASHED attempt's claim time
    // (17:00) — not the recovery's own claim, which overwrote it.
    expect(mailer.lookups).toEqual([
      { deliveryKey: "bryce:digest:2026-07-19", since: "2026-07-19T17:00:00.000Z" },
    ]);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      sentAt: RECONCILED_AT,
      reconciledAt: RECONCILED_AT,
      providerMessageId: "pm-already-accepted",
      statLineCount: 0,
      playerCount: 0,
    });
    // ZERO Stat Lines marked. The crashed attempt emailed a set of lines we
    // never recorded; marking TODAY's assembly would report lines that may
    // never have been sent (Refresh can run in between) — silent content loss.
  });

  it("re-sends when the provider reports the delivery key as not found", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await crashAfterAcceptance();

    mailer.result = { outcome: "not-found" };
    clock.set(PAST_LEASE);
    const healed = await runDigest(deps());

    // Postmark documents no search-consistency guarantee, so a miss moments
    // after acceptance is expected — and re-sending on it is the design.
    expect(healed).toMatchObject({ action: "sent", reason: "recovered-stale-claim", statLineCount: 1 });
    expect(mailer.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({
      status: "sent",
      statLineCount: 1,
      reconciledAt: null,
    });
  });

  it("re-sends when the lookup is unavailable — a failed lookup never suppresses", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await crashAfterAcceptance();

    mailer.result = { outcome: "unavailable", detail: "Postmark lookup timed out after 5000ms" };
    clock.set(PAST_LEASE);
    const healed = await runDigest(deps());

    expect(healed).toMatchObject({ action: "sent", reason: "recovered-stale-claim", statLineCount: 1 });
    expect(mailer.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({ status: "sent", reconciledAt: null });
  });

  it("re-sends without any lookup for a provider that cannot answer one (SMTP/console)", async () => {
    const plain = new CapturingMailer();
    // The capability is optional BY CONSTRUCTION: no method, no lookup, and the
    // documented at-least-once behaviour is preserved exactly.
    expect("findAccepted" in plain).toBe(false);
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    const crashed = runDigest({
      ...deps(),
      mailer: plain,
      db: faultingDb(opened.db, { failAt: "before-settle" }),
    });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    expect(plain.sent).toHaveLength(1);

    clock.set(PAST_LEASE);
    const healed = await runDigest({ ...deps(), mailer: plain });
    expect(healed).toMatchObject({ action: "sent", reason: "recovered-stale-claim" });
    expect(plain.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({ status: "sent", reconciledAt: null });
  });

  it("re-sends when the lookup BREAKS ITS CONTRACT and throws", async () => {
    // findAccepted is documented as never throwing. A provider that does anyway
    // is still only "we do not know", and not knowing must re-send. Without
    // this case the catch-block fail-open path is unpinned: inverting it to
    // suppress the send fails no test, which is how a provider bug would
    // silently become mail loss.
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await crashAfterAcceptance();

    mailer.throwWith = new Error("postmark search exploded");
    clock.set(PAST_LEASE);

    const healed = await runDigest(deps());
    expect(healed).toMatchObject({ action: "sent", reason: "recovered-stale-claim" });
    expect(mailer.lookups).toHaveLength(1); // it was asked, and it blew up
    expect(mailer.sent).toHaveLength(2); // and we re-sent anyway
    expect((await deliveries())[0]).toMatchObject({ status: "sent", reconciledAt: null });
  });

  it("CONTENT-LOSS GUARD: the reconciled window's content is still reachable after", async () => {
    // A reconciled delivery composed nothing and recorded nothing. Under window
    // selection its content cannot be lost by construction — the window is a
    // date range over stored lines, so re-asking for it returns it. This pins
    // that the reconciliation path leaves no state that could hide it.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { plateAppearances: 4, atBats: 4, hits: 2, homeRuns: 1, rbi: 3, totalBases: 5 },
    });
    await crashAfterAcceptance();

    mailer.result = { outcome: "accepted", providerMessageId: "pm-already-accepted" };
    clock.set(PAST_LEASE);
    expect((await runDigest(deps())).reason).toBe("reconciled-already-accepted");
    expect(mailer.sent).toHaveLength(1);

    // Next day: a fresh slot, an ordinary send over a window that still covers
    // 07-18 — and it carries the line the reconciled delivery never recorded.
    clock.set("2026-07-20T17:00:00Z");
    const nextDay = await runDigest({ ...deps(), spec: "7d" });
    expect(nextDay).toMatchObject({ action: "sent", statLineCount: 1 });
    expect(mailer.sent).toHaveLength(2);
    expect(cells(mailer.sent[1]?.text ?? "", "M Acosta")).toEqual(
      ["M", "Acosta", "AAA", "1", ".500/.500/1.250", "4", "2", "0", "0", "0", "0", "1", "3", "0", "0", "0", "0"],
    );
  });

  it("never looks up on a fresh claim or a failed-row retry", async () => {
    // Reconciliation is strictly a RECOVERY concern. A fresh claim has no
    // crashed attempt to ask about, and a `failed` row means the provider
    // rejected the mail — it never accepted it.
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    mailer.result = { outcome: "accepted", providerMessageId: "pm-must-not-be-used" };

    mailer.failWith = new Error("postmark down");
    expect((await runDigest(deps())).action).toBe("failed");
    expect(mailer.lookups).toHaveLength(0);

    mailer.failWith = null;
    const retried = await runDigest(deps());
    expect(retried).toMatchObject({ action: "sent", reason: null });
    expect(mailer.lookups).toHaveLength(0);
    expect(mailer.sent).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      reconciledAt: null,
      providerMessageId: null,
    });
  });

  it("reconciles a crashed heartbeat and runs the seven-day clock from that settle", async () => {
    clock.set(OFFSEASON); // 2026-12-05T18:00:00Z
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });

    const crashed = runDigest({ ...deps(), db: faultingDb(opened.db, { failAt: "before-settle" }) });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    expect(mailer.sent).toHaveLength(1);

    mailer.result = { outcome: "accepted", providerMessageId: "pm-heartbeat-accepted" };
    clock.set("2026-12-05T18:11:00Z"); // past the lease
    const healed = await runDigest(deps());

    expect(healed).toMatchObject({
      kind: "heartbeat",
      action: "skipped",
      reason: "reconciled-already-accepted",
    });
    expect(mailer.sent).toHaveLength(1); // no second heartbeat
    expect(mailer.lookups).toEqual([
      { deliveryKey: "bryce:heartbeat:2026-12-05", since: "2026-12-05T18:00:00.000Z" },
    ]);
    expect((await deliveries())[0]).toMatchObject({
      kind: "heartbeat",
      status: "sent",
      attemptCount: 2,
      sentAt: "2026-12-05T18:11:00.000Z",
      reconciledAt: "2026-12-05T18:11:00.000Z",
    });

    // The seven-day clock runs from the RECONCILED settle (18:11), not the
    // crashed attempt (18:00) — the eleven minutes that would otherwise let the
    // next heartbeat out early.
    clock.set("2026-12-12T18:05:00Z");
    const tooSoon = await runDigest(deps());
    expect(tooSoon).toMatchObject({ action: "skipped", reason: "heartbeat-sent-within-week" });
    expect(mailer.sent).toHaveLength(1);

    clock.set("2026-12-12T18:11:00Z");
    const due = await runDigest(deps());
    expect(due.action).toBe("sent");
    expect(mailer.sent).toHaveLength(2);
    // A new slot is a FRESH claim, so it sent without consulting the provider.
    expect(mailer.lookups).toHaveLength(1);
  });
});

describe("claimDelivery lease boundary (ADR 0034)", () => {
  let opened: OpenedDb;
  const CLAIMED_AT = "2026-07-19T17:00:00.000Z";

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  async function withStaleness(ms: number, leaseMs?: number) {
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: CLAIMED_AT,
      attemptCount: 1,
    });
    return claimDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      now: new Date(Date.parse(CLAIMED_AT) + ms),
      ...(leaseMs !== undefined ? { leaseMs } : {}),
    });
  }

  it("holds the claim right up to the lease and releases it exactly at expiry", async () => {
    // One millisecond short of the lease: still someone else's.
    expect(await withStaleness(LEASE_MS - 1)).toEqual({
      claimed: false,
      reason: "claimed-by-another-run",
    });
    opened.close();
    opened = testDb();
    // Exactly at the lease: expired, and recovery is flagged as such.
    expect(await withStaleness(LEASE_MS)).toMatchObject({
      claimed: true,
      attempt: 2,
      recovered: true,
    });
  });

  it("honors an explicit lease override and treats an unstamped claim as stale", async () => {
    expect(await withStaleness(1500, 1000)).toMatchObject({ claimed: true, recovered: true });

    opened.close();
    opened = testDb();
    // A `sending` row with no claimed_at cannot prove it is live, so it never
    // gets to hold the slot forever.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: null,
      attemptCount: 4,
    });
    expect(
      claimDelivery(opened.db, {
        kind: "digest",
        dateCovered: "2026-07-19",
        now: new Date(CLAIMED_AT),
      }),
    ).toMatchObject({ claimed: true, attempt: 5, recovered: true });
  });
});

/**
 * The force flag. One rule governs every test below:
 *
 *   When force is what ALLOWED the run to proceed, the run is a REPLAY — it
 *   sends the mail and writes NOTHING. When force was not needed, the run is
 *   ordinary and records normally.
 *
 * Two of these are regression tests for failures the replay design exists to
 * make impossible, and they are labeled as such: a forced send whose mailer
 * throws must not destroy the record of a genuinely delivered digest, and a
 * forced heartbeat must not restart the rolling seven-day clock. Both would be
 * silent — the operator would learn about them a day (or a week) later.
 */
describe("forced delivery", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;

  const deps = (force = false): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    spec: "1d",
    force,
  });

  const deliveries = () => opened.db.select().from(digestDeliveries);

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  // --- Claim layer ---------------------------------------------------------

  it("replays a forced claim over a sent row, leaving the row byte-identical", async () => {
    const row = await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      sentAt: "2026-07-19T17:00:00.000Z",
      playerCount: 2,
      statLineCount: 3,
      providerMessageId: "postmark-original",
      attemptCount: 1,
    });
    const before = (await deliveries())[0];

    const claim = claimDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      now: new Date(MID_SEASON),
      force: true,
    });
    // A replay holds NO claim to settle, and carries no delivery id at all —
    // a settle cannot be reached from this arm even after a null check. It once
    // carried the replayed delivery's id so assembly could re-include that
    // delivery's lines; a window stamps nothing, so there is nothing to widen.
    expect(claim).toEqual({ claimed: true, replay: true });
    expect(row.id).toBeGreaterThan(0);

    // Every field: status, sentAt, counts, providerMessageId, attemptCount.
    const after = await deliveries();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("GUARANTEE: a forced DIGEST claim against a LIVE sending lease is still refused", async () => {
    // ADR 0034's exact mutual exclusion. Force is a statement about
    // de-duplication bookkeeping, never about concurrency safety — overriding
    // this would put two invocations at the mail provider for one slot.
    // (The digest kind passes no precondition, so this case alone does not pin
    // the BRANCH ORDER — the heartbeat pair further down does that.)
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: MID_SEASON,
      attemptCount: 1,
    });

    expect(
      claimDelivery(opened.db, {
        kind: "digest",
        dateCovered: "2026-07-19",
        now: new Date(MID_SEASON),
        force: true,
      }),
    ).toEqual({ claimed: false, reason: "claimed-by-another-run" });

    // And end to end: the forced run skips without reaching the provider.
    const result = await runDigest(deps(true));
    expect(result).toMatchObject({ action: "skipped", reason: "claimed-by-another-run" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("treats a forced claim over an EXPIRED sending lease as ordinary recovery", async () => {
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: "2026-07-19T16:30:00.000Z", // 30 minutes ago: lease expired
      attemptCount: 1,
    });

    // Force was not NEEDED here (an expired lease is reclaimable anyway), so
    // the run is ordinary: a real claim, settled and recorded normally.
    expect(
      claimDelivery(opened.db, {
        kind: "digest",
        dateCovered: "2026-07-19",
        now: new Date(MID_SEASON),
        force: true,
      }),
    ).toMatchObject({ claimed: true, replay: false, attempt: 2, recovered: true });
    expect((await deliveries())[0]).toMatchObject({ status: "sending", attemptCount: 2 });
  });

  it("treats a forced claim with no row as an ordinary first claim", async () => {
    expect(
      claimDelivery(opened.db, {
        kind: "digest",
        dateCovered: "2026-07-19",
        now: new Date(MID_SEASON),
        force: true,
      }),
    ).toMatchObject({ claimed: true, replay: false, attempt: 1, recovered: false });
    expect((await deliveries())[0]).toMatchObject({
      status: "sending",
      sentAt: null,
      attemptCount: 1,
    });
  });

  it("treats a forced claim over a failed row as an ordinary retry re-claim", async () => {
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "failed",
      errorMessage: "postmark down",
      attemptCount: 1,
    });

    expect(
      claimDelivery(opened.db, {
        kind: "digest",
        dateCovered: "2026-07-19",
        now: new Date(MID_SEASON),
        force: true,
      }),
    ).toMatchObject({ claimed: true, replay: false, attempt: 2, recovered: false });
    expect((await deliveries())[0]).toMatchObject({ status: "sending", errorMessage: null });
  });

  // --- Digest job ----------------------------------------------------------

  it("re-sends the same rendered stat lines after a same-day send", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 2, atBats: 4, homeRuns: 1, rbi: 3 },
    });

    await runDigest(deps());
    expect(mailer.sent).toHaveLength(1);

    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ action: "sent", statLineCount: 1, playerCount: 1 });
    expect(mailer.sent).toHaveLength(2);

    // The CONTENT is the point: a replay that assembled an empty report would
    // still say action=sent while being useless as a test send.
    expect(cells(mailer.sent[1]?.text ?? "", "M Acosta")[4]).toBe("2"); // H
    expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
    expect(mailer.sent[1]?.html).toBe(mailer.sent[0]?.html);
    expect(mailer.sent[1]?.subject).toBe(mailer.sent[0]?.subject);
  });

  it("reports reason 'forced', in preference to 'recovered-stale-claim'", async () => {
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    // An expired lease: unforced, this run reports recovered-stale-claim.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: "2026-07-19T16:30:00.000Z",
      attemptCount: 1,
      statLineCount: 0,
      playerCount: 0,
    });

    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ action: "sent", reason: "forced" });
    // The recovery still HAPPENED — it is only outranked as the explanation.
    expect((await deliveries())[0]).toMatchObject({ status: "sent", attemptCount: 2 });
  });

  it("leaves the delivery row exactly as the real send left it", async () => {
    mailer.providerMessageId = "postmark-first";
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    await runDigest(deps());
    const before = (await deliveries())[0];
    expect(before).toMatchObject({ status: "sent", providerMessageId: "postmark-first" });

    // A later instant on the same Chicago date, and a different provider id:
    // if the replay wrote anything at all, one of these would move.
    clock.set("2026-07-19T18:00:00Z");
    mailer.providerMessageId = "postmark-forced";
    expect((await runDigest(deps(true))).action).toBe("sent");

    const after = await deliveries();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before); // id, status, sentAt, counts, provider id
  });

  it("picks up a line that arrived after the real send, and consumes nothing", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { plateAppearances: 4, atBats: 4, hits: 2 },
    });
    await runDigest(deps());
    expect(cells(mailer.sent[0]?.text ?? "", "M Acosta")[3]).toBe("4"); // PA, 1d window

    // A late final for the SAME date, landing after the real send went out.
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 870009,
      gameNumber: 2,
      gameDate: "2026-07-18",
      stats: { plateAppearances: 5, atBats: 5, hits: 3 },
    });

    // A replay re-reads the window, so it carries both games — no novelty
    // predicate to widen, and nothing about the first send to work around.
    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ action: "sent", statLineCount: 2 });
    const rows = (mailer.sent[1]?.text ?? "").split("\n").filter((l) => l.startsWith("M Acosta"));
    expect(rows).toHaveLength(2);

    // A test send consumes nothing, so the next SCHEDULED run over the same
    // window would report exactly the same thing.
    clock.set("2026-07-19T18:30:00Z");
    const next = await runDigest(deps(true));
    expect(next).toMatchObject({ action: "sent", statLineCount: 2 });
    expect(mailer.sent[2]?.text).toBe(mailer.sent[1]?.text);
  });

  it("DATA LOSS: a forced send whose mailer throws leaves the delivered row sent", async () => {
    // The regression this whole design exists for. If the forced run had
    // re-claimed the sent row, settleFailed would set status='failed',
    // sent_at=NULL — destroying the record of a genuinely delivered email — and
    // the next scheduled run would re-claim that failed row and mail an EMPTY
    // digest, because a window reports whatever falls inside it.
    mailer.providerMessageId = "postmark-first";
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await runDigest(deps());
    const before = (await deliveries())[0];

    mailer.failWith = new Error("postmark down");
    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ action: "failed", reason: "postmark down" });

    const after = await deliveries();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
    expect(after[0]).toMatchObject({
      status: "sent",
      sentAt: before?.sentAt,
      statLineCount: 1,
      playerCount: 1,
      providerMessageId: "postmark-first",
      errorMessage: null,
    });

    // And the day is still closed: the next scheduled run does not "retry".
    mailer.failWith = null;
    const next = await runDigest(deps());
    expect(next).toMatchObject({ action: "skipped", reason: "already-sent-today" });
    expect(mailer.sent).toHaveLength(1);
  });

  it("REPLAY NEVER RECONCILES: a forced send is not suppressed by the provider lookup", async () => {
    // Where force meets the issue-#41 reconciliation. A replay's slot HAS
    // landed — that is its premise — so a lookup would answer "accepted" and
    // suppress the very send the operator asked for, and settleReconciled would
    // stamp a fresh sent_at/reconciled_at on the delivered row and zero its
    // counts.
    //
    // This pins the BEHAVIOUR, not a mechanism: two things currently prevent it
    // (the `!claim.replay` narrowing in runDigest, and `reconciled`'s early
    // return on `!claim.recovered`, which a replay meets only because its arm has
    // no such field). Removing either alone leaves this green; removing both
    // turns it red. That is deliberate — the test should survive a refactor that
    // drops the accidental one, and fail if the behaviour itself is lost.
    const lookupMailer = new LookupMailer();
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });
    await runDigest({ ...deps(), mailer: lookupMailer });
    const before = (await deliveries())[0];
    expect(lookupMailer.sent).toHaveLength(1);

    // The provider would confirm this slot already landed, if it were asked.
    lookupMailer.result = { outcome: "accepted", providerMessageId: "pm-already-accepted" };
    const forced = await runDigest({ ...deps(true), mailer: lookupMailer });

    // Force wins: a second mail goes out, carrying the same line.
    expect(forced).toMatchObject({ action: "sent", reason: "forced", statLineCount: 1 });
    expect(lookupMailer.sent).toHaveLength(2);

    // The lookup was never even asked — a replay does not take the recovery path.
    expect(lookupMailer.lookups).toEqual([]);

    // And settleReconciled never ran: the delivered row is untouched.
    expect(await deliveries()).toHaveLength(1);
    expect((await deliveries())[0]).toEqual(before);
    expect((await deliveries())[0]).toMatchObject({ reconciledAt: null, statLineCount: 1 });
  });

  // --- Heartbeat / Offseason Sleep ----------------------------------------

  /**
   * The live-lease/precondition BRANCH ORDER, pinned. Both tests below stage a
   * heartbeat that is BOTH live-leased AND inside the seven-day window, so the
   * two branches disagree about the outcome and only the order decides it:
   *
   *   live lease first (correct) -> refuse `claimed-by-another-run`, send nothing
   *   precondition first (wrong) -> forced: REPLAY, which MAILS past a live claim
   *
   * That second outcome is two invocations at the mail provider for one slot —
   * ADR 0034's exact mutual exclusion, broken by a testing affordance. The
   * digest-kind guarantee test above cannot catch it: `kind: "digest"` passes no
   * precondition, so it reaches the live-lease check under EITHER order.
   */
  const liveLeasedHeartbeatInsideWindow = async () => {
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    // Two days ago: unforced, the rolling seven-day rule alone WOULD refuse.
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-12-03",
      sentAt: "2026-12-03T18:00:00.000Z",
    });
    // ...and today's slot is held by a run that is at the provider right now.
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-12-05",
      status: "sending",
      claimedAt: OFFSEASON,
      attemptCount: 1,
    });
  };

  it("GUARANTEE: a forced HEARTBEAT never replays past a LIVE lease (branch order)", async () => {
    clock.set(OFFSEASON); // 2026-12-05 Chicago
    await liveLeasedHeartbeatInsideWindow();
    const before = await deliveries();

    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({
      kind: "heartbeat",
      action: "skipped",
      reason: "claimed-by-another-run",
    });
    // The whole point: no second invocation reached the provider.
    expect(mailer.sent).toHaveLength(0);
    // A refusal is not a replay: nothing was written either.
    expect(await deliveries()).toEqual(before);
  });

  it("refuses an UNFORCED heartbeat the same way, naming the lease not the week", async () => {
    // The unforced control for the test above. It also pins the reason STRING,
    // which the reorder changed: this case used to report
    // `heartbeat-sent-within-week`, and the string flows to REST, MCP and the
    // CLI log. Both refusals skip, but they mean different things to a reader —
    // "someone else is sending right now" is not "we already sent this week".
    clock.set(OFFSEASON);
    await liveLeasedHeartbeatInsideWindow();
    const before = await deliveries();

    const result = await runDigest(deps());
    expect(result).toMatchObject({
      kind: "heartbeat",
      action: "skipped",
      reason: "claimed-by-another-run",
    });
    expect(mailer.sent).toHaveLength(0);
    expect(await deliveries()).toEqual(before);
  });

  /**
   * A precondition refusal turned into a replay writes nothing, whatever this
   * slot's own row happens to be. The rolling rule reads the latest `sent`
   * heartbeat of ANY date, so it can refuse while this slot's row is `failed`,
   * or absent entirely — none of which the replay is allowed to touch.
   */
  it.each([
    ["a failed row for this slot", { status: "failed" as const, errorMessage: "postmark down" }],
    ["a sent row for this slot", { status: "sent" as const, sentAt: OFFSEASON }],
  ])("replays a refused heartbeat and writes nothing, given %s", async (_label, overrides) => {
    const existing = await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-12-05",
      ...overrides,
    });

    expect(
      claimDelivery(opened.db, {
        kind: "heartbeat",
        dateCovered: "2026-12-05",
        now: new Date(OFFSEASON),
        force: true,
        precondition: () => "heartbeat-sent-within-week",
      }),
    ).toEqual({ claimed: true, replay: true });

    expect(await deliveries()).toEqual([existing]);
  });

  it("sends a heartbeat when forced inside the seven-day window", async () => {
    clock.set(OFFSEASON); // 2026-12-05 Chicago
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-11-29",
      sentAt: "2026-11-29T18:00:00.000Z", // 6 days ago: unforced, this refuses
    });

    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ kind: "heartbeat", action: "sent", reason: "forced" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe("Bryce heartbeat - 2026-12-05");
    expect(mailer.sent[0]?.text).toContain("alive; 1 players watched");
  });

  it("CLOCK RESET: a forced heartbeat does not move the seven-day clock", async () => {
    // If the forced heartbeat took a fresh (heartbeat, today) slot and settled
    // it, the rolling clock would restart from today — silencing the next REAL
    // liveness signal for a week. That is invisible until the week of silence.
    clock.set(OFFSEASON);
    await insertPlayer(opened.db, { fullName: "Watched One", level: "mlb", milbLevel: null });
    await insertDelivery(opened.db, {
      kind: "heartbeat",
      dateCovered: "2026-11-29",
      sentAt: "2026-11-29T18:00:00.000Z",
    });

    expect((await runDigest(deps(true))).action).toBe("sent");

    // Nothing was written: no new slot, no new sent_at.
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dateCovered: "2026-11-29", sentAt: "2026-11-29T18:00:00.000Z" });

    // The schedule is untouched: still due seven days after the REAL heartbeat.
    clock.set("2026-12-06T17:59:00Z"); // one minute short of seven days
    expect(await runDigest(deps())).toMatchObject({
      action: "skipped",
      reason: "heartbeat-sent-within-week",
    });
    expect(mailer.sent).toHaveLength(1);

    clock.set("2026-12-06T18:00:00Z"); // exactly seven days after the real one
    expect(await runDigest(deps())).toMatchObject({ kind: "heartbeat", action: "sent" });
    expect(mailer.sent).toHaveLength(2);
  });

  it("sends a HEARTBEAT when forced during sleep, never a digest", async () => {
    // Force overrides bookkeeping, NOT the Offseason Sleep decision — a flag
    // that mailed a digest in December would make test sends lie about
    // production behaviour and could mask a genuine seasonal bug.
    clock.set(OFFSEASON);
    const player = await insertPlayer(opened.db, {
      fullName: "Watched One",
      level: "mlb",
      milbLevel: null,
    });
    await insertStatLine(opened.db, { playerId: player.id });

    const forced = await runDigest(deps(true));
    expect(forced).toMatchObject({ kind: "heartbeat", action: "sent", statLineCount: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe("Bryce heartbeat - 2026-12-05");
    expect(mailer.sent[0]?.text).not.toContain("Charlotte Knights");
    // No digest slot was taken, and the stat line is untouched.
    const rows = await deliveries();
    expect(rows.every((r) => r.kind === "heartbeat")).toBe(true);
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
      spec: "1d",
    });
    const deliveries = await opened.db.select().from(digestDeliveries);
    expect(deliveries[0]?.dateCovered).toBe("2026-07-19");
    opened.close();
  });
});
