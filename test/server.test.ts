import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { eq } from "drizzle-orm";
import { digestDeliveries, playerLists } from "../src/db/schema.js";
import { closeFailedBind, createApp, createBoundListener, createShutdown } from "../src/server.js";
import { vi } from "vitest";

describe("server shutdown", () => {
  it("closes the listener once, releases its lock, then drains before exit", async () => {
    let closeCallback: (() => void) | undefined;
    const close = vi.fn((callback: () => void) => { closeCallback = callback; });
    const release = vi.fn();
    const finish = vi.fn(async () => undefined as never);
    const shutdown = createShutdown({ close }, release, finish);

    shutdown();
    shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    closeCallback?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(finish).toHaveBeenCalledWith(0);
  });
});

describe("failed server bind cleanup", () => {
  it("closes readonly then writable and releases the lock last", () => {
    const calls: string[] = [];
    closeFailedBind(
      { close: () => { calls.push("readonly"); return undefined as never; } },
      { close: () => { calls.push("writable"); } },
      () => { calls.push("lock"); },
    );
    expect(calls).toEqual(["readonly", "writable", "lock"]);
  });

  it("still closes writable and releases the lock when readonly close throws", () => {
    const calls: string[] = [];
    expect(() => closeFailedBind(
      { close: () => { calls.push("readonly"); throw new Error("readonly"); } },
      { close: () => { calls.push("writable"); } },
      () => { calls.push("lock"); },
    )).toThrow("readonly");
    expect(calls).toEqual(["readonly", "writable", "lock"]);
  });

  it("closes both handles before releasing the lock when listener creation throws synchronously", async () => {
    const calls: string[] = [];
    await expect(createBoundListener(
      () => { throw new RangeError("port must be <= 65535"); },
      { close: () => { calls.push("readonly"); return undefined as never; } },
      { close: () => { calls.push("writable"); } },
      () => { calls.push("lock"); },
    )).rejects.toThrow("port must be <= 65535");
    expect(calls).toEqual(["readonly", "writable", "lock"]);
  });
});
import {
  CapturingMailer,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertLane,
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
      // The lane view is keyed on LANES, not on delivery rows (#193), so an
      // empty database still reports the one the migration seeds — configured
      // (digest hour 5, reproducing the retired 05:00 agent) and never
      // delivered. That combination is the "scheduled but silent" state, and it
      // is only visible BECAUSE the view starts from lanes.
      lanes: [
        {
          listId: 1,
          name: "Watchlist",
          isDefault: true,
          digestHour: 5,
          lastDelivery: null,
        },
      ],
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
 * The PER-LANE delivery view (#193 / ADR 0062 decision 5) — the owed view ADR
 * 0059 amendment 2 named, ALONGSIDE the host-wide `lastDelivery` rather than
 * replacing it.
 *
 * Its whole job is to make three states distinguishable, so every case below
 * builds all three in one fixture and asserts they read differently. The
 * ordering rule and the all-statuses-included rule are the Reviewer's must-fix 3
 * and are pinned individually, because either one silently inverted would turn
 * the dead-lane signal into a green light.
 */
describe("GET /health lanes (#193)", () => {
  let opened: OpenedDb;

  const health = async (): Promise<Record<string, unknown>> => {
    const app = createApp(testAppDeps(opened));
    return (await (await app.request("/health")).json()) as Record<string, unknown>;
  };
  const lanes = async (): Promise<Array<Record<string, unknown>>> =>
    (await health()).lanes as Array<Record<string, unknown>>;

  beforeEach(() => { opened = testDb(); });
  afterEach(() => { opened.close(); });

  it("reports the three states distinctly in ONE fixture", async () => {
    const player = await insertPlayer(opened.db);
    // 1. UNSCHEDULED — healthy by configuration, not silent.
    const unscheduled = await insertLane(opened.db, "Unscheduled", [player]);
    // 2. SCHEDULED, NEVER DELIVERED — visible only because the view is keyed on
    //    LANES; a view built from delivery rows structurally cannot show it.
    const never = await insertLane(opened.db, "Never", [player]);
    await opened.db.update(playerLists).set({ digestHour: 5 }).where(eq(playerLists.id, never.id));
    // 3. SCHEDULED, DELIVERED — the healthy case, for contrast.
    const delivering = await insertLane(opened.db, "Delivering", [player]);
    await opened.db.update(playerLists).set({ digestHour: 6 }).where(eq(playerLists.id, delivering.id));
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-19", listId: delivering.id, status: "sent",
      sentAt: "2026-07-19T11:00:00.000Z", createdAt: "2026-07-19T11:00:00.000Z",
    });

    const byName = new Map((await lanes()).map((lane) => [lane.name as string, lane]));
    expect(byName.get("Unscheduled")).toMatchObject({ digestHour: null, lastDelivery: null });
    expect(byName.get("Never")).toMatchObject({ digestHour: 5, lastDelivery: null });
    expect(byName.get("Delivering")).toMatchObject({
      digestHour: 6,
      lastDelivery: { dateCovered: "2026-07-19", status: "sent", sentAt: "2026-07-19T11:00:00.000Z" },
    });
    // The seeded default lane is present too, and flagged.
    expect((await lanes()).filter((lane) => lane.isDefault === true)).toHaveLength(1);
    expect(unscheduled.id).toBeGreaterThan(0);
  });

  it("a newer FAILED row supersedes an older `sent` one — the dead-lane signal working", async () => {
    // Reviewer must-fix 3. Reporting the last SUCCESS instead would hide exactly
    // the state this view exists to surface: a lane that delivered yesterday and
    // is broken today would read healthy.
    const lane = await insertLane(opened.db, "L");
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-18", listId: lane.id, status: "sent",
      sentAt: "2026-07-18T11:00:00.000Z", createdAt: "2026-07-18T11:00:00.000Z",
    });
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-19", listId: lane.id, status: "failed",
      sentAt: null, createdAt: "2026-07-19T11:00:00.000Z",
    });

    const found = (await lanes()).find((entry) => entry.name === "L");
    expect(found?.lastDelivery).toEqual({
      dateCovered: "2026-07-19",
      status: "failed",
      sentAt: null,
    });
  });

  it("a live `sending` claim is shown as such, not hidden and not mislabeled", async () => {
    const lane = await insertLane(opened.db, "L");
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-19", listId: lane.id, status: "sending",
      claimedAt: "2026-07-19T11:00:00.000Z", createdAt: "2026-07-19T11:00:00.000Z",
      attemptCount: 2,
    });

    expect((await lanes()).find((entry) => entry.name === "L")?.lastDelivery).toEqual({
      dateCovered: "2026-07-19",
      status: "sending",
      sentAt: null,
    });
  });

  it("orders by the SAME rule the host-wide field uses: latest activity, not row order", async () => {
    // A retried row is updated in place — `sent_at` moves, `created_at` does not
    // — so "latest" has to mean `coalesce(sent_at, created_at)`. Built so row
    // ORDER and activity order disagree: the older-created row is the newer
    // activity, and it must win.
    const lane = await insertLane(opened.db, "L");
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-17", listId: lane.id, status: "sent",
      sentAt: "2026-07-19T13:00:00.000Z", createdAt: "2026-07-17T11:00:00.000Z",
    });
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-18", listId: lane.id, status: "sent",
      sentAt: "2026-07-19T12:00:00.000Z", createdAt: "2026-07-18T11:00:00.000Z",
    });

    expect((await lanes()).find((entry) => entry.name === "L")?.lastDelivery).toMatchObject({
      dateCovered: "2026-07-17",
    });
    // ...and the host-wide field agrees, which is the point of restating the rule.
    expect((await health()).lastDelivery).toMatchObject({ dateCovered: "2026-07-17" });
  });

  it("EXCLUDES heartbeat rows, so the default lane cannot inherit forged liveness", async () => {
    // A heartbeat rides the DEFAULT lane's slot purely because `list_id` is NOT
    // NULL (ADR 0059 amendment). Counting one here would make the default lane
    // read as delivering every week during the offseason while its DIGESTS were
    // silent — the precise lie this view exists to prevent, and only for that
    // one lane.
    const lane = await insertLane(opened.db, "L");
    await insertDelivery(opened.db, {
      kind: "heartbeat", dateCovered: "2026-12-05", listId: lane.id, status: "sent",
      sentAt: "2026-12-05T11:00:00.000Z", createdAt: "2026-12-05T11:00:00.000Z",
    });

    expect((await lanes()).find((entry) => entry.name === "L")?.lastDelivery).toBeNull();
    // The heartbeat IS still visible host-wide — it is real delivery activity.
    expect((await health()).lastDelivery).toMatchObject({ kind: "heartbeat" });
  });

  it("omits a SOFT-DELETED lane, and orders live lanes by id", async () => {
    const a = await insertLane(opened.db, "Alpha");
    await insertLane(opened.db, "Zulu");
    await opened.db
      .update(playerLists)
      .set({ deletedAt: "2026-07-19T00:00:00.000Z" })
      .where(eq(playerLists.id, a.id));

    const names = (await lanes()).map((lane) => lane.name);
    expect(names).not.toContain("Alpha");
    // Creation order (id), never name order: renaming a lane must not reorder
    // the view, because the same order decides which lane the tick attempts first.
    expect(names).toEqual(["Watchlist", "Zulu"]);
  });

  it("leaves the host-wide lastDelivery byte-identical", async () => {
    // The additive guarantee: the published field every existing consumer reads
    // is untouched by the lane view sitting beside it.
    const lane = await insertLane(opened.db, "L");
    await insertDelivery(opened.db, {
      kind: "digest", dateCovered: "2026-07-19", listId: lane.id, status: "sent",
      sentAt: "2026-07-19T11:00:00.000Z", createdAt: "2026-07-19T11:00:00.000Z",
    });

    expect((await health()).lastDelivery).toEqual({
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sent",
      sentAt: "2026-07-19T11:00:00.000Z",
    });
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
      playersRefreshed: 2,
      playersSkipped: 1,
      playersFailed: 1,
      playersTotal: 5,
      statLinesInserted: 7,
      statLinesUpdated: 3,
    });
    const body = await health();
    expect(body).toMatchObject({
      state: "running",
      lastFinishedAt: null,
      playersRefreshed: 2,
      playersSkipped: 1,
      playersFailed: 1,
      playersTotal: 5,
      statLinesInserted: 7,
      statLinesUpdated: 3,
    });
    // #146: asserted on the WIRE, and with `toHaveProperty` as well as a value —
    // `toMatchObject` alone would pass if a field-picking serializer dropped these
    // two, silently falsifying the contract docs/api and docs/mcp now publish.
    expect(body).toHaveProperty("playersSkipped");
    expect(body).toHaveProperty("playersFailed");
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
