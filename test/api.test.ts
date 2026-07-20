import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, players, statLines } from "../src/db/schema.js";
import { MlbClient } from "../src/mlb/client.js";
import type { AppDeps } from "../src/server.js";
import { createApp } from "../src/server.js";
import {
  CapturingMailer,
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  makeGameLogBody,
  makeMlbTeam,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testAppDeps,
  testDb,
} from "./factories.js";

const AUTH = { Authorization: `Bearer ${TEST_API_TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

describe("REST API", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;
  let deps: AppDeps;

  beforeEach(async () => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    mailer = new CapturingMailer();
    ncaaApi = new FakeNcaaApi({
      pages: {
        "2649785:batting": makeNcaaGameLogHtml({
          fullName: "College Guy",
          schoolName: "LSU",
          rows: [
            { date: "2026-03-13", opponentName: "Georgia", isHome: true, contestId: 6001, stats: { AB: 4, H: 2, HR: 1 } },
          ],
        }),
        "2649785:pitching": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
      },
    });
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: {
        "11:hitting": makeGameLogBody("hitting", [
          makeSplit({ game: { gamePk: 900001, gameNumber: 1 } }),
          makeSplit({ date: "2026-04-16", game: { gamePk: 900002, gameNumber: 1 } }),
        ]),
      },
    });
    await insertCalendars2026(opened.db);
    deps = testAppDeps(opened, {
      client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
      ncaaClient: fakeNcaaClient(ncaaApi),
      mailer,
      now: clock.now,
      tz: TEST_TZ,
    });
  });

  afterEach(() => {
    opened.close();
  });

  const app = () => createApp(deps);

  describe("auth (rules/security.md: deny by default)", () => {
    it("401s /api and /mcp without a token, without echoing anything", async () => {
      for (const path of ["/api/players", "/mcp"]) {
        const res = await app().request(path, { method: path === "/mcp" ? "POST" : "GET" });
        expect(res.status, path).toBe(401);
        const body = await res.text();
        expect(body).toBe(JSON.stringify({ error: "unauthorized" }));
        expect(body).not.toContain(TEST_API_TOKEN);
      }
    });

    it("401s a wrong token and a malformed Authorization header", async () => {
      for (const header of ["Bearer wrong-token", "Basic abc", TEST_API_TOKEN]) {
        const res = await app().request("/api/players", { headers: { Authorization: header } });
        expect(res.status, header).toBe(401);
      }
    });

    it("keeps /health public", async () => {
      const res = await app().request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, players: 0, statLines: 0, lastDelivery: null });
    });
  });

  describe("GET /api/players", () => {
    it("lists active players by default; inactive and all on request", async () => {
      await insertPlayer(opened.db, { fullName: "Active Guy" });
      await insertPlayer(opened.db, { fullName: "Gone Guy", active: false });

      const res = await app().request("/api/players", { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { players: Array<{ fullName: string }> };
      expect(body.players.map((p) => p.fullName)).toEqual(["Active Guy"]);

      const all = (await (
        await app().request("/api/players?active=all", { headers: AUTH })
      ).json()) as { players: Array<{ fullName: string }> };
      expect(all.players.map((p) => p.fullName)).toEqual(["Active Guy", "Gone Guy"]);

      const inactive = (await (
        await app().request("/api/players?active=false", { headers: AUTH })
      ).json()) as { players: Array<{ fullName: string }> };
      expect(inactive.players.map((p) => p.fullName)).toEqual(["Gone Guy"]);
    });

    it("400s an invalid active filter", async () => {
      const res = await app().request("/api/players?active=nope", { headers: AUTH });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; issues: unknown[] };
      expect(body.error).toBe("invalid-input");
      expect(body.issues.length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/players", () => {
    it("adds the player, runs his first Refresh, and returns 201", async () => {
      const res = await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 691185 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        action: string;
        player: { id: number; fullName: string };
        refresh: { skipped: boolean; inserted: number };
      };
      expect(body.action).toBe("added");
      expect(body.player.fullName).toBe("Maximo Acosta");
      expect(body.refresh).toMatchObject({ skipped: false, inserted: 2 });

      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalId: 691185, level: "milb", milbLevel: "Triple-A" });
      expect(await opened.db.select().from(statLines)).toHaveLength(2);
    });

    it("returns 200 with action=updated on a duplicate add", async () => {
      await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 691185 }),
      });
      const res = await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 691185 }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { action: string }).action).toBe("updated");
      expect(await opened.db.select().from(players)).toHaveLength(1);
    });

    it("400s a missing personId with Zod issue detail; 404s an unknown person", async () => {
      const bad = await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string; issues: Array<{ path: unknown[] }> };
      expect(badBody.error).toBe("invalid-input");
      expect(badBody.issues[0]?.path).toEqual(["personId"]);

      api.options.person = undefined;
      const missing = await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 424242 }),
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toContain("424242");
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });
  });

  describe("POST /api/players/ncaa", () => {
    it("adds an NCAA player by seq, backfills, and returns 201", async () => {
      const res = await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        action: string;
        player: { ncaaPlayerSeq: number; schoolName: string; level: string };
        refresh: { inserted: number };
      };
      expect(body.action).toBe("added");
      expect(body.player).toMatchObject({ ncaaPlayerSeq: 2649785, schoolName: "LSU", level: "ncaa" });
      expect(body.refresh.inserted).toBe(1);

      const rows = await opened.db.select().from(players);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalId: null, ncaaPlayerSeq: 2649785, schoolName: "LSU" });
      const lines = await opened.db.select().from(statLines);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sportId).toBe(22);
    });

    it("400s a missing/invalid ncaaPlayerSeq; 404s an unresolvable seq", async () => {
      const bad = await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: -5 }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid-input");

      const missing = await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 999999 }),
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toContain("999999");
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });
  });

  describe("POST /api/players/ncaa/:seq/deactivate", () => {
    it("deactivates an NCAA player by seq, keeping history", async () => {
      const ncaa = await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: "College Guy",
        schoolName: "LSU",
      });
      await insertStatLine(opened.db, { playerId: ncaa.id, sportId: 22 });

      const res = await app().request("/api/players/ncaa/2649785/deactivate", {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { player: { active: boolean } }).player.active).toBe(false);
      expect((await opened.db.select().from(players))[0]?.active).toBe(false);
      expect(await opened.db.select().from(statLines)).toHaveLength(1);

      const missing = await app().request("/api/players/ncaa/999999/deactivate", {
        method: "POST",
        headers: AUTH,
      });
      expect(missing.status).toBe(404);
    });
  });

  describe("POST /api/players/:id/deactivate", () => {
    it("deactivates by personId, keeping history", async () => {
      const player = await insertPlayer(opened.db, { externalId: 691185 });
      await insertStatLine(opened.db, { playerId: player.id });

      const res = await app().request("/api/players/691185/deactivate", {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { player: { active: boolean } }).player.active).toBe(false);
      expect((await opened.db.select().from(players))[0]?.active).toBe(false);
      expect(await opened.db.select().from(statLines)).toHaveLength(1);
    });

    it("404s an unknown personId and 400s a malformed one", async () => {
      const missing = await app().request("/api/players/424242/deactivate", {
        method: "POST",
        headers: AUTH,
      });
      expect(missing.status).toBe(404);

      const malformed = await app().request("/api/players/not-a-number/deactivate", {
        method: "POST",
        headers: AUTH,
      });
      expect(malformed.status).toBe(400);
    });
  });

  describe("GET /api/players/search", () => {
    it("maps search hits with team/level resolution", async () => {
      api.options.searchResults = [makePerson()];
      const res = await app().request("/api/players/search?q=acosta", { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          {
            personId: 691185,
            fullName: "Maximo Acosta",
            position: "SS",
            level: "milb",
            milbLevel: "Triple-A",
            teamName: "Jacksonville Jumbo Shrimp",
          },
        ],
      });
    });

    it("400s a missing/blank q", async () => {
      expect((await app().request("/api/players/search", { headers: AUTH })).status).toBe(400);
      expect(
        (await app().request("/api/players/search?q=%20%20", { headers: AUTH })).status,
      ).toBe(400);
    });
  });

  describe("GET /api/stat-lines", () => {
    it("filters and returns joined content", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-06-01" });

      const res = await app().request(
        `/api/stat-lines?playerId=${player.id}&from=2026-07-01&to=2026-07-31`,
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { statLines: Array<Record<string, unknown>> };
      expect(body.statLines).toHaveLength(1);
      expect(body.statLines[0]).toMatchObject({
        playerName: "Maximo Acosta",
        gameDate: "2026-07-18",
        statType: "batting",
      });
    });

    it("400s from > to with issue detail", async () => {
      const res = await app().request("/api/stat-lines?from=2026-07-20&to=2026-07-01", {
        headers: AUTH,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes("from must be <= to"))).toBe(true);
    });
  });

  describe("GET /api/digest/preview", () => {
    it("previews without sending, marking, or recording anything", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

      const res = await app().request("/api/digest/preview", { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        date: string;
        statLineCount: number;
        playerCount: number;
        mail: { subject: string; text: string };
      };
      expect(body.date).toBe("2026-07-19");
      expect(body.statLineCount).toBe(1);
      expect(body.playerCount).toBe(1);
      expect(body.mail.subject).toBe("Bryce digest - 2026-07-19");
      expect(body.mail.text).toContain("Maximo Acosta");

      // Read-only: no send, no delivery row, no marking.
      expect(mailer.sent).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
      const unmarked = await opened.db
        .select()
        .from(statLines)
        .where(isNull(statLines.digestDeliveryId));
      expect(unmarked).toHaveLength(1);
    });
  });

  describe("POST /api/digest/send", () => {
    it("sends the digest, marks lines, and records the delivery", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

      const res = await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        kind: "digest",
        action: "sent",
        statLineCount: 1,
        playerCount: 1,
      });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe("hc@example.com");
      expect(mailer.sent[0]?.text).toContain("Maximo Acosta");
      const deliveries = await opened.db.select().from(digestDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ kind: "digest", status: "sent", dateCovered: "2026-07-19" });
      const unmarked = await opened.db
        .select()
        .from(statLines)
        .where(isNull(statLines.digestDeliveryId));
      expect(unmarked).toHaveLength(0);
    });

    it("502s when the mailer fails, recording the failed delivery", async () => {
      const player = await insertPlayer(opened.db);
      await insertStatLine(opened.db, { playerId: player.id });
      mailer.failWith = new Error("postmark down");

      const res = await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ action: "failed", reason: "postmark down" });
      expect((await opened.db.select().from(digestDeliveries))[0]?.status).toBe("failed");
    });
  });

  describe("POST /api/refresh", () => {
    it("refreshes one player by personId, upserting his season", async () => {
      await insertPlayer(opened.db, { externalId: 691185, fullName: "Maximo Acosta" });

      const res = await app().request("/api/refresh", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 691185 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: false, inserted: 2, updated: 0 });
      const lines = await opened.db.select().from(statLines);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.gameId).sort()).toEqual([900001, 900002]);
    });

    it("refreshes everything with an empty body and is idempotent", async () => {
      await insertPlayer(opened.db, { externalId: 691185 });

      const first = await app().request("/api/refresh", { method: "POST", headers: AUTH });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        skipped: false,
        playersRefreshed: 1,
        statLinesInserted: 2,
      });

      const second = await app().request("/api/refresh", { method: "POST", headers: AUTH });
      expect(await second.json()).toMatchObject({ statLinesInserted: 0, statLinesUpdated: 2 });
      expect(await opened.db.select().from(statLines)).toHaveLength(2);
    });

    it("404s an unknown personId", async () => {
      const res = await app().request("/api/refresh", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 424242 }),
      });
      expect(res.status).toBe(404);
    });

    it("refreshes one NCAA player by ncaaPlayerSeq, upserting his season", async () => {
      await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: "College Guy",
        schoolName: "LSU",
      });
      const res = await app().request("/api/refresh", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: false, inserted: 1, updated: 0 });
      const lines = await opened.db.select().from(statLines);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sportId).toBe(22);
    });

    it("400s malformed JSON without refreshing anything", async () => {
      await insertPlayer(opened.db, { externalId: 691185 });

      const res = await app().request("/api/refresh", {
        method: "POST",
        headers: JSON_AUTH,
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid-input" });
      expect(await opened.db.select().from(statLines)).toHaveLength(0);
    });
  });

  it("player row updates flow through: deactivated player excluded from digest send", async () => {
    const gone = await insertPlayer(opened.db, { externalId: 424, fullName: "Gone Guy" });
    await insertStatLine(opened.db, { playerId: gone.id });
    await app().request("/api/players/424/deactivate", { method: "POST", headers: AUTH });

    const res = await app().request("/api/digest/send", { method: "POST", headers: AUTH });
    expect(await res.json()).toMatchObject({ action: "sent", statLineCount: 0 });
    const unmarked = await opened.db
      .select()
      .from(statLines)
      .where(eq(statLines.playerId, gone.id));
    expect(unmarked[0]?.digestDeliveryId).toBeNull();
  });
});
