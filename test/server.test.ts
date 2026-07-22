import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries } from "../src/db/schema.js";
import { createApp } from "../src/server.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertRefreshRun,
  insertStatLine,
  testAppDeps,
  testDb,
} from "./factories.js";

describe("GET /health", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("reports zero counts and no delivery on an empty database", async () => {
    const app = createApp(testAppDeps(opened));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      players: 0,
      statLines: 0,
      lastDelivery: null,
      refresh: null,
    });
  });

  it("reports active player count, stat line count and the last delivery", async () => {
    const player = await insertPlayer(opened.db);
    await insertPlayer(opened.db, { fullName: "Inactive Guy", active: false });
    await insertStatLine(opened.db, { playerId: player.id });
    await insertStatLine(opened.db, { playerId: player.id });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      sentAt: "2026-07-19T12:00:00.000Z",
      createdAt: "2026-07-19T12:00:00.000Z",
    });

    const app = createApp(testAppDeps(opened));
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.players).toBe(1); // active only
    expect(body.statLines).toBe(2);
    expect(body.lastDelivery).toEqual({
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      sentAt: "2026-07-19T12:00:00.000Z",
    });
  });

  it("reports a retried delivery as last by send time, not row creation time", async () => {
    // Row created earlier but retried (sentAt updated in place) after the newer row's send.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-18",
      status: "sent",
      sentAt: "2026-07-19T13:00:00.000Z",
      createdAt: "2026-07-18T12:00:00.000Z",
    });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      sentAt: "2026-07-19T12:00:00.000Z",
      createdAt: "2026-07-19T12:00:00.000Z",
    });

    const app = createApp(testAppDeps(opened));
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.lastDelivery).toMatchObject({ dateCovered: "2026-07-18" });
  });

  it("reports a fresh failed attempt (null sentAt) as last by creation time", async () => {
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-18",
      status: "sent",
      sentAt: "2026-07-18T12:00:00.000Z",
      createdAt: "2026-07-18T12:00:00.000Z",
    });
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "failed",
      sentAt: null,
      createdAt: "2026-07-19T12:00:00.000Z",
    });

    const app = createApp(testAppDeps(opened));
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.lastDelivery).toMatchObject({ dateCovered: "2026-07-19", status: "failed" });
  });

  it("surfaces an in-flight `sending` claim instead of hiding or mislabeling it", async () => {
    // A stuck claim is exactly what an operator needs to SEE (ADR 0034). The
    // snapshot's status type is the schema's own union, so a widened state
    // machine can never leave this surface reporting a lie (rules/backend.md).
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: "2026-07-19T12:00:00.000Z",
      createdAt: "2026-07-19T12:00:00.000Z",
      attemptCount: 2,
    });

    const app = createApp(testAppDeps(opened));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      lastDelivery: {
        kind: "digest",
        dateCovered: "2026-07-19",
        status: "sending",
        sentAt: null,
      },
    });
  });

  it("is unchanged by a forced send: the delivery still reads sent, with its own sentAt", async () => {
    // /health is the operator's whole view of delivery state (ADR 0034). A test
    // send that could make it report `sending`, `failed`, or a moved sentAt
    // would turn the one honest signal into a lie.
    const mailer = new CapturingMailer();
    const clock = fakeClock(MID_SEASON);
    await insertCalendars2026(opened.db);
    const player = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: player.id });

    const app = createApp(testAppDeps(opened, { mailer, now: clock.now, tz: TEST_TZ }));
    const AUTH = { Authorization: `Bearer ${TEST_API_TOKEN}` };
    const health = async () =>
      (await (await app.request("/health")).json()) as Record<string, unknown>;

    await app.request("/api/digest/send", { method: "POST", headers: AUTH });
    const before = await health();
    expect(before.lastDelivery).toMatchObject({ kind: "digest", status: "sent" });

    const forced = await app.request("/api/digest/send", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect(mailer.sent).toHaveLength(2);

    expect(await health()).toEqual(before);
    // Asserted on the row itself, not just through /health: the replay held no
    // claim, so the row was never re-taken — `attempt_count` never moved and it
    // never passed back through `sending`. Re-claiming it would bump the count
    // to 2 even though /health's own projection can't show that.
    const rows = await opened.db.select().from(digestDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attemptCount: 1 });
    expect(rows[0]?.sentAt).not.toBeNull();
  });
});

/**
 * The ingestion-freshness block of /health (ADR 0043, issue #34 AC #3): a
 * DERIVED state distinguishing fresh / stale / running / partial / failed, so an
 * operator can tell a healthy pipeline from a silently-stalled one. The app's
 * clock is MID_SEASON (2026-07-19 Chicago), so "today" for the derivation is
 * 2026-07-19.
 */
describe("GET /health refresh freshness (ADR 0043)", () => {
  let opened: OpenedDb;

  const health = async () => {
    const app = createApp(testAppDeps(opened));
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    return body.refresh as Record<string, unknown> | null;
  };

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("is null when no refresh has ever run", async () => {
    expect(await health()).toBeNull();
  });

  it("reports `fresh` when the latest ok run started today (host)", async () => {
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-19T07:00:00.000Z",
      finishedAt: "2026-07-19T07:20:00.000Z",
      playersRefreshed: 4,
      playersTotal: 4,
    });
    expect(await health()).toMatchObject({
      state: "fresh",
      lastStartedAt: "2026-07-19T07:00:00.000Z",
      lastFinishedAt: "2026-07-19T07:20:00.000Z",
      lastSuccessAt: "2026-07-19T07:20:00.000Z",
      playersRefreshed: 4,
      playersTotal: 4,
    });
  });

  it("reports `stale` when the latest ok run is from a prior host date", async () => {
    await insertRefreshRun(opened.db, {
      status: "ok",
      startedAt: "2026-07-18T07:00:00.000Z",
      finishedAt: "2026-07-18T07:20:00.000Z",
    });
    expect(await health()).toMatchObject({ state: "stale", lastSuccessAt: "2026-07-18T07:20:00.000Z" });
  });

  it("reports `running` while a claim holds a live lease", async () => {
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: "2026-07-19T16:59:00.000Z",
      claimedAt: "2026-07-19T16:59:00.000Z", // one minute before the app clock
      finishedAt: null,
    });
    expect(await health()).toMatchObject({ state: "running", lastFinishedAt: null });
  });

  it("reports `partial` when the latest terminal run left players unrefreshed", async () => {
    await insertRefreshRun(opened.db, {
      status: "partial",
      startedAt: "2026-07-19T07:00:00.000Z",
      finishedAt: "2026-07-19T07:20:00.000Z",
      playersRefreshed: 2,
      playersTotal: 5,
    });
    expect(await health()).toMatchObject({ state: "partial", playersRefreshed: 2, playersTotal: 5 });
  });

  it("reports `failed` when the latest terminal run errored", async () => {
    await insertRefreshRun(opened.db, {
      status: "failed",
      startedAt: "2026-07-19T07:00:00.000Z",
      finishedAt: "2026-07-19T07:20:00.000Z",
      playersRefreshed: 0,
      playersTotal: 5,
    });
    expect(await health()).toMatchObject({ state: "failed" });
  });

  it("does NOT report `running` for a crashed run whose lease expired", async () => {
    await insertRefreshRun(opened.db, {
      status: "running",
      startedAt: "2026-07-19T15:00:00.000Z",
      claimedAt: "2026-07-19T15:00:00.000Z", // two hours before the app clock: expired
      finishedAt: null,
    });
    const refresh = await health();
    expect(refresh?.state).not.toBe("running");
    expect(refresh?.state).toBe("stale");
  });
});
