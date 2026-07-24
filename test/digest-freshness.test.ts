import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries } from "../src/db/schema.js";
import type { DigestDeps } from "../src/jobs/digest.js";
import { runDigest } from "../src/jobs/digest.js";
import {
  CapturingMailer,
  LookupMailer,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertRefreshRun,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * The Refresh→Digest freshness contract (ADR 0043, issue #34 AC #2). The daily
 * 1d digest reads the freshness watermark BEFORE assembly, anchored on the
 * content date (window.to = yesterday) and on each refresh run's START. A
 * stale/partial reading annotates the email — it NEVER suppresses it.
 */

// The stale banner is accurate whether the latest qualifying run failed, is
// still running, or none ever ran — so it says "no SUCCESSFUL refresh completed",
// never the false "no refresh has run".
const STALE_BANNER = "No successful refresh has completed for";
const PARTIAL_BANNER = "Last refresh was incomplete";

describe("digest freshness gate (ADR 0043)", () => {
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
    clock = fakeClock(MID_SEASON); // 2026-07-19 Chicago; 1d content date = 07-18
    await insertCalendars2026(opened.db);
  });

  afterEach(() => {
    opened.close();
  });

  it("stale: no qualifying refresh → stale banner and freshness === 'stale'", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(result.freshness).toBe("stale");

    const mail = mailer.sent[0];
    // Never suppressed: the digest still went out, annotated on BOTH bodies.
    expect(mail?.text).toContain(STALE_BANNER);
    expect(mail?.text).toContain("2026-07-18"); // the content date
    expect(mail?.text).toContain("as of last successful refresh: never");
    expect(mail?.html).toContain("<p>⚠️");
    // The subject is untouched — it names the content day, not the warning.
    expect(mail?.subject).toBe("ScoreKeeps Baseball (Default) - Sat, July 18, 2026");
  });

  it("stale banner dates itself by the last successful refresh when one exists", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    // A successful run, but it STARTED on the content date itself (07-18) — not
    // after it, so it does not qualify: stale, dated by its finish.
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-18T12:00:00.000Z",
      finishedAt: "2026-07-18T12:05:00.000Z",
    });

    const result = await runDigest(deps());
    expect(result.freshness).toBe("stale");
    expect(mailer.sent[0]?.text).toContain("as of last successful refresh: 2026-07-18T12:05:00.000Z");
  });

  it("stale: a FAILED latest run still yields the stale banner (a refresh ran, none succeeded)", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    // The latest run FAILED after starting past the content date. A refresh DID
    // run, so the old "no refresh has run since" wording would have lied; the
    // banner must still warn (no SUCCESSFUL refresh) and freshness stays stale.
    await insertRefreshRun(opened.db, {
      status: "failed",
      startedAt: "2026-07-19T07:00:00.000Z", // host 07-19 > content 07-18
      finishedAt: "2026-07-19T07:05:00.000Z",
      playersRefreshed: 0,
      playersTotal: 5,
    });

    const result = await runDigest(deps());
    expect(result.action).toBe("sent");
    expect(result.freshness).toBe("stale");
    const mail = mailer.sent[0];
    expect(mail?.text).toContain(STALE_BANNER);
    expect(mail?.text).toContain("2026-07-18"); // the content date
    expect(mail?.text).toContain("as of last successful refresh: never");
  });

  it("partial: a qualifying partial run → partial banner with N of M and freshness === 'partial'", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertRefreshRun(opened.db, {
      status: "partial",
      startedAt: "2026-07-19T07:00:00.000Z", // host 07-19 > content 07-18
      finishedAt: "2026-07-19T07:05:00.000Z",
      playersRefreshed: 3,
      playersTotal: 7,
    });

    const result = await runDigest(deps());
    expect(result.freshness).toBe("partial");
    const mail = mailer.sent[0];
    expect(mail?.text).toContain(PARTIAL_BANNER);
    expect(mail?.text).toContain("(3 of 7 watched players refreshed)");
    expect(mail?.text).not.toContain(STALE_BANNER);
  });

  it("fresh: a qualifying ok run → NO banner and freshness === 'fresh'", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T07:00:00.000Z",
      finishedAt: "2026-07-19T07:05:00.000Z",
    });

    const result = await runDigest(deps());
    expect(result.freshness).toBe("fresh");
    const mail = mailer.sent[0];
    expect(mail?.text).not.toContain("⚠️");
    // The body opens straight on the content heading — no banner line prepended.
    expect(mail?.text.startsWith("ScoreKeeps Baseball - Default List - Sat, July 18, 2026")).toBe(true);
  });

  it("pins the NORMAL scheduled case: refresh at 02:00, digest at 05:00 same host day → fresh", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    // 02:00 America/Chicago on 2026-07-19 == 07:00 UTC.
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T07:00:00.000Z",
      finishedAt: "2026-07-19T07:20:00.000Z",
    });
    // Digest fires at 05:00 Chicago == 10:00 UTC the same day.
    clock.set("2026-07-19T10:00:00Z");

    const result = await runDigest(deps());
    expect(result.freshness).toBe("fresh");
    expect(mailer.sent[0]?.text).not.toContain("⚠️");
  });

  it("an on-demand report NEVER annotates freshness, even with no refresh run", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const result = await runDigest({ ...deps(), spec: "7d" });
    expect(result.action).toBe("sent");
    expect(result.freshness).toBeNull();
    expect(mailer.sent[0]?.text).not.toContain("⚠️");
  });

  it("a claim-refusal (already-sent-today) returns freshness null", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    await runDigest(deps()); // sends and settles today's slot
    const second = await runDigest(deps());
    expect(second.action).toBe("skipped");
    expect(second.reason).toBe("already-sent-today");
    expect(second.freshness).toBeNull();
  });

  it("a reconciled recovery returns freshness null (it composes no digest)", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    // An expired sending slot for today whose crashed attempt the provider
    // confirms already landed → settled reconciled, never composed.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      sentAt: null,
      claimedAt: "2026-07-19T00:00:00.000Z", // well beyond the lease
      attemptCount: 1,
    });
    const lookup = new LookupMailer();
    lookup.result = { outcome: "accepted", providerMessageId: "pm-jul19" };

    const result = await runDigest({ ...deps(), mailer: lookup });
    expect(result.reason).toBe("reconciled-already-accepted");
    expect(result.freshness).toBeNull();
  });

  it("the offseason heartbeat returns freshness null", async () => {
    await insertPlayer(opened.db, { fullName: "Watched", level: "mlb", milbLevel: null });
    clock.set(OFFSEASON);

    const result = await runDigest(deps());
    expect(result.kind).toBe("heartbeat");
    expect(result.freshness).toBeNull();
  });

  it("orphan recovery annotates against ITS OWN content date, distinct from today's", async () => {
    // Today is 2026-07-20. Today's 1d content is 07-19; the orphaned slot
    // (dateCovered 07-19) covers 07-18. A single ok refresh STARTED on 07-19
    // qualifies for the orphan (07-18) but not for today (07-19), so the two
    // emails must carry DIFFERENT freshness verdicts.
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-17" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "failed",
      sentAt: null,
    });
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T07:00:00.000Z", // host 07-19
      finishedAt: "2026-07-19T07:20:00.000Z",
    });
    clock.set("2026-07-20T17:00:00Z"); // host 07-20

    const result = await runDigest(deps());
    // The returned result is today's (07-19 content): stale — the refresh did
    // not start after 07-19.
    expect(result.freshness).toBe("stale");

    expect(mailer.sent).toHaveLength(2);
    const orphan = mailer.sent.find((m) => m.subject.includes("July 18"));
    const today = mailer.sent.find((m) => m.subject.includes("July 19"));
    // The orphan (07-18 content) is FRESH — its email carries no banner...
    expect(orphan?.text).not.toContain("⚠️");
    // ...while today's (07-19 content) is annotated stale.
    expect(today?.text).toContain(STALE_BANNER);

    // Recovery still settled the orphan slot sent (never suppressed).
    const recovered = await opened.db
      .select()
      .from(digestDeliveries)
      .where(eq(digestDeliveries.dateCovered, "2026-07-19"));
    expect(recovered[0]?.status).toBe("sent");
  });

  it("TOCTOU: a refresh landing AFTER the pre-assembly read still yields the conservative reading", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    // No refresh run exists when freshness is read → stale.

    const injecting = new CapturingMailer();
    const capture = injecting.send.bind(injecting);
    injecting.send = async (msg, ctx) => {
      // A refresh completes `ok` DURING the send — strictly after the digest
      // already read freshness and rendered the banner. It must not retroactively
      // un-stale the email in flight (the read is BEFORE assembly, by design).
      await insertRefreshRun(opened.db, {
        status: "ok",
        startedAt: "2026-07-19T07:00:00.000Z",
        finishedAt: "2026-07-19T07:05:00.000Z",
      });
      return capture(msg, ctx);
    };

    const result = await runDigest({ ...deps(), mailer: injecting });
    expect(result.freshness).toBe("stale");
    expect(injecting.sent[0]?.text).toContain(STALE_BANNER);
  });
});
