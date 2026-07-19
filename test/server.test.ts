import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { createApp } from "../src/server.js";
import { insertDelivery, insertPlayer, insertStatLine, testDb } from "./factories.js";

describe("GET /health", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("reports zero counts and no delivery on an empty database", async () => {
    const app = createApp(opened.db);
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

    const app = createApp(opened.db);
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
});
