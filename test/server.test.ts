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
    expect(await res.json()).toEqual({ ok: true, players: 0, statLines: 0, lastDelivery: null });
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
