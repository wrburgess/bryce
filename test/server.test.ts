import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { createApp } from "../src/server.js";
import { insertDelivery, insertPlayer, insertStatLine, testAppDeps, testDb } from "./factories.js";

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
});
