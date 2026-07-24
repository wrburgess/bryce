import { eq } from "drizzle-orm";
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
        "2649785:fielding": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
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
      expect(await res.json()).toEqual({
        ok: true,
        players: 0,
        statLines: 0,
        lastDelivery: null,
        refresh: null,
      });
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

    it("502s an NCAA upstream failure — not 404, not 500 — writing no row", async () => {
      ncaaApi.options.status = 500;
      const res = await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("stats.ncaa.org request failed with HTTP 500");
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("503s an unbundled NCAA season (our data gap, not upstream), writing no row", async () => {
      clock.set("2030-03-15T17:00:00Z"); // no bundled stats.ncaa.org entry for 2030
      const res = await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no bundled stats.ncaa.org season lookup for year 2030");
      expect(await opened.db.select().from(players)).toHaveLength(0);
      expect(ncaaApi.calls).toHaveLength(0);
    });
  });

  describe("POST /api/players/batch", () => {
    it("stages a batch and returns 200 with a summary + per-entry outcomes (no inline backfill)", async () => {
      const res = await app().request("/api/players/batch", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ entries: [{ personId: 691185 }, { ncaaPlayerSeq: 2649785 }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { added: number; total: number };
        entries: Array<{ status: string }>;
      };
      expect(body.summary).toMatchObject({ added: 2, total: 2 });
      expect(body.entries.map((e) => e.status)).toEqual(["added", "added"]);

      // Two players STAGED, but the batch ran no first Refresh — deferred backfill.
      expect(await opened.db.select().from(players)).toHaveLength(2);
      expect(await opened.db.select().from(statLines)).toHaveLength(0);
    });

    it("keeps a soft per-entry failure INSIDE the 200 body (never the 4xx/5xx seam)", async () => {
      api.options.searchResults = []; // the name resolves to zero hits
      const res = await app().request("/api/players/batch", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ entries: [{ personId: 691185 }, { name: "Nobody At All" }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { added: number; unresolved: number };
        entries: Array<{ status: string; reason?: string }>;
      };
      expect(body.summary).toMatchObject({ added: 1, unresolved: 1 });
      expect(body.entries[1]).toMatchObject({ status: "unresolved", reason: "name_no_match" });
      expect(await opened.db.select().from(players)).toHaveLength(1);
    });

    it("400s a bad shape (empty entries) and writes nothing", async () => {
      const res = await app().request("/api/players/batch", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ entries: [] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid-input");
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("400s a non-coercing identity (personId: true, never coerced to 1) and writes nothing", async () => {
      const res = await app().request("/api/players/batch", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ entries: [{ personId: true }] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid-input");
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("413s a body over the 64 KB ceiling before parsing", async () => {
      const huge = JSON.stringify({ entries: [{ name: "x".repeat(70_000) }] });
      const res = await app().request("/api/players/batch", {
        method: "POST",
        headers: { ...JSON_AUTH, "content-length": String(huge.length) },
        body: huge,
      });
      expect(res.status).toBe(413);
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
    it("previews without sending, stamping, or recording anything", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

      const res = await app().request("/api/digest/preview", { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        window: { spec: string; from: string; to: string; label: string };
        statLineCount: number;
        playerCount: number;
        batters: Array<{ player: { fullName: string }; lvl: string }>;
        mail: { subject: string; text: string };
      };
      // Absent window means 1d, anchored on the last COMPLETED host date.
      expect(body.window).toMatchObject({ spec: "1d", from: "2026-07-18", to: "2026-07-18" });
      expect(body.statLineCount).toBe(1);
      expect(body.playerCount).toBe(1);
      expect(body.batters[0]).toMatchObject({ lvl: "AAA" });
      expect(body.batters[0]?.player.fullName).toBe("Maximo Acosta");
      expect(body.mail.subject).toBe("MLB Daily Tracker - Sat, July 18, 2026");
      expect(body.mail.text).toContain("M Acosta");

      // Read-only: no send, no delivery row, no stamping.
      expect(mailer.sent).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    });

    it("selects by ?window, and rejects an unsupported one", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-14" });

      const read = async (url: string) => {
        const res = await app().request(url, { headers: AUTH });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          window: { spec: string; from: string; label: string };
          statLineCount: number;
        };
      };

      const week = await read("/api/digest/preview?window=7d");
      expect(week.window).toMatchObject({ spec: "7d", from: "2026-07-12" });
      expect(week.statLineCount).toBe(2);

      const day = await read("/api/digest/preview?window=1d");
      expect(day.statLineCount).toBe(1);
      expect((await read("/api/digest/preview")).statLineCount).toBe(1); // default

      // Fails closed: an unsupported window is a 400, never a different report.
      const bogus = await app().request("/api/digest/preview?window=30d", { headers: AUTH });
      expect(bogus.status).toBe(400);
      expect(await bogus.json()).toMatchObject({ error: "invalid-input" });
    });

    it("is unchanged by ?force, which a window makes meaningless — but still validates it", async () => {
      // The coercion trap survives even though force no longer changes the
      // content: under z.coerce.boolean() the STRING "false" is truthy, so
      // ?force=false would force. The schema uses a string enum.
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      const deliveriesBefore = await opened.db.select().from(digestDeliveries);

      const read = async (url: string) => {
        const res = await app().request(url, { headers: AUTH });
        expect(res.status).toBe(200);
        return (await res.json()) as { statLineCount: number; mail: { text: string } };
      };

      // Selection is by window, so a preview after a real send still reports
      // the window's content — the blocker force used to exist for is gone.
      for (const url of [
        "/api/digest/preview?force=true",
        "/api/digest/preview?force=false",
        "/api/digest/preview",
      ]) {
        const body = await read(url);
        expect(body.statLineCount).toBe(1);
        expect(body.mail.text).toContain("M Acosta");
      }

      // A junk value is rejected, never treated as truthy.
      const bogus = await app().request("/api/digest/preview?force=maybe", { headers: AUTH });
      expect(bogus.status).toBe(400);

      // Every preview stayed read-only: one delivery row, unchanged.
      expect(await opened.db.select().from(digestDeliveries)).toEqual(deliveriesBefore);
      expect(mailer.sent).toHaveLength(1);
    });
  });

  describe("Presentation/Export formats (ADR 0037)", () => {
    const seedBatter = async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameId: 900500, gameDate: "2026-07-18" });
      return player;
    };

    it("GET /api/digest/preview json is byte-identical with format omitted or =json", async () => {
      const expected = {
        window: { spec: "1d", from: "2026-07-18", to: "2026-07-18", label: "Jul 18", groupBy: "game" },
        statLineCount: 0,
        playerCount: 0,
        batters: [],
        pitchers: [],
        unknownFields: [],
        mail: {
          subject: "MLB Daily Tracker - Sat, July 18, 2026",
          html: "<h1>Sat, July 18, 2026</h1>\n<p>No games in this window.</p>",
          text: "Sat, July 18, 2026\n\nNo games in this window.\n",
        },
      };
      const omitted = await app().request("/api/digest/preview", { headers: AUTH });
      const explicit = await app().request("/api/digest/preview?format=json", { headers: AUTH });
      expect(omitted.headers.get("content-type")).toContain("application/json");
      const omittedBody = await omitted.text();
      expect(omittedBody).toBe(await explicit.text());
      expect(JSON.parse(omittedBody)).toEqual(expected);
    });

    it("GET /api/digest/preview?format=html downloads a document", async () => {
      await seedBatter();
      const res = await app().request("/api/digest/preview?format=html", { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="bryce-digest-1d.html"',
      );
      expect((await res.text()).startsWith("<!doctype html>")).toBe(true);
    });

    it("GET /api/digest/preview?window=7d&format=md downloads markdown named for the window", async () => {
      await seedBatter();
      const res = await app().request("/api/digest/preview?window=7d&format=md", { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="bryce-digest-7d.md"',
      );
      const mdText = await res.text();
      expect(mdText.startsWith("# ")).toBe(true);
      expect(mdText).not.toContain("Bryce - ");
    });

    it("GET /api/digest/preview?format=csv exports one table, named for table+window", async () => {
      await seedBatter();
      const batters = await app().request("/api/digest/preview?format=csv", { headers: AUTH });
      expect(batters.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(batters.headers.get("content-disposition")).toBe(
        'attachment; filename="bryce-batters-1d.csv"',
      );
      expect(await batters.text()).toContain("M Acosta");

      // Header-only when the chosen table has no rows.
      const pitchers = await app().request("/api/digest/preview?format=csv&table=pitchers", {
        headers: AUTH,
      });
      expect(pitchers.headers.get("content-disposition")).toBe(
        'attachment; filename="bryce-pitchers-1d.csv"',
      );
      const body = await pitchers.text();
      expect(body.startsWith("Player,Lvl,")).toBe(true);
      expect(body).toContain("IP,ER,K");
      expect(body.split("\r\n").filter((l) => l.length > 0)).toHaveLength(1);
    });

    it("accepts and IGNORES table for a Presentation format (html renders both tables)", async () => {
      await seedBatter();
      const pitcher = await insertPlayer(opened.db, { fullName: "Zack Wheeler", position: "P" });
      await insertStatLine(opened.db, {
        playerId: pitcher.id,
        gameId: 900600,
        gameDate: "2026-07-18",
        statType: "pitching",
        stats: { inningsPitched: "6.0", earnedRuns: 1, strikeOuts: 7 },
      });
      const res = await app().request("/api/digest/preview?format=html&table=pitchers", {
        headers: AUTH,
      });
      const body = await res.text();
      expect(body).toContain("<h2>Batters</h2>");
      expect(body).toContain("<h2>Pitchers</h2>");
    });

    it("400s an invalid format", async () => {
      const res = await app().request("/api/digest/preview?format=bogus", { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid-input" });
    });

    it("GET /api/stat-lines?format=csv downloads the fixed-header CSV; json unchanged", async () => {
      await seedBatter();
      const csv = await app().request("/api/stat-lines?format=csv", { headers: AUTH });
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(csv.headers.get("content-disposition")).toBe(
        'attachment; filename="bryce-stat-lines.csv"',
      );
      const body = await csv.text();
      expect(body.startsWith("id,playerId,playerName,")).toBe(true);
      expect(body).toContain("Maximo Acosta");

      const omitted = await app().request("/api/stat-lines", { headers: AUTH });
      const explicit = await app().request("/api/stat-lines?format=json", { headers: AUTH });
      const omittedText = await omitted.text();
      expect(omittedText).toBe(await explicit.text());
      // Anchor the wrapper + row shape to today's contract, so a REST-wrapper-only
      // added field (e.g. { statLines, extra }) can't false-green past the matchObject
      // test above or the omitted==explicit check.
      const parsed = JSON.parse(omittedText) as { statLines: Array<Record<string, unknown>> };
      expect(Object.keys(parsed)).toEqual(["statLines"]);
      expect(Object.keys(parsed.statLines[0]!).sort()).toEqual([
        "gameDate", "gameId", "gameNumber", "gameType", "id", "isHome", "leagueName",
        "level", "milbLevel", "opponentName", "playerId", "playerName", "sportId",
        "statType", "stats", "teamName",
      ]);
    });

    it("guards a dangerous player name end-to-end in digest and stat-lines CSV", async () => {
      const player = await insertPlayer(opened.db, { fullName: "=DANGER" });
      await insertStatLine(opened.db, { playerId: player.id, gameId: 900700, gameDate: "2026-07-18" });

      const stat = await (await app().request("/api/stat-lines?format=csv", { headers: AUTH })).text();
      expect(stat).toContain(",'=DANGER,");
      expect(stat).not.toContain(",=DANGER,");

      const digest = await (
        await app().request("/api/digest/preview?format=csv", { headers: AUTH })
      ).text();
      expect(digest).toContain("'=DANGER");
      // A bare formula must never START a cell (here, the first cell of a row).
      expect(digest.split("\r\n").some((line) => line.startsWith("=DANGER"))).toBe(false);
    });

    it("400s from>to with a format, and 401s a format path without a token", async () => {
      const bad = await app().request(
        "/api/stat-lines?format=csv&from=2026-07-20&to=2026-07-01",
        { headers: AUTH },
      );
      expect(bad.status).toBe(400);

      const noAuth = await app().request("/api/stat-lines?format=csv");
      expect(noAuth.status).toBe(401);
    });
  });

  describe("POST /api/digest/send", () => {
    it("sends the digest, records the delivery, and stamps nothing", async () => {
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
      expect(mailer.sent[0]?.text).toContain("M Acosta");
      const deliveries = await opened.db.select().from(digestDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ kind: "digest", status: "sent", dateCovered: "2026-07-19" });
    });

    it("sends the requested {window}, and rejects an unsupported one without sending", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-14" });

      const sent = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ window: "7d" }),
      });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({
        action: "sent",
        statLineCount: 2,
        window: "Last 7 Days (Jul 12-18)",
      });
      expect(mailer.sent[0]?.subject).toBe("MLB Daily Tracker - Last 7 Days (Jul 12-18)");

      const bogus = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ window: "30d" }),
      });
      expect(bogus.status).toBe(400);
      expect(mailer.sent).toHaveLength(1); // fail closed: nothing else went out
    });

    it("accepts a new long window (28d) on the on-demand path, recording no delivery", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      // Inside the 28d window (Jun 21..Jul 18) but outside the daily 1d one.
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-06-30" });

      const sent = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ window: "28d" }),
      });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ action: "sent", statLineCount: 2 });
      expect(mailer.sent[0]?.subject).toContain("Last 28 Days");
      // On-demand: the slot is keyed (kind, date) with no room for a window, so
      // any non-1d send takes no slot and writes no delivery row.
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

      // 30d is still not a supported window — fail closed, nothing else sent.
      const bogus = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ window: "30d" }),
      });
      expect(bogus.status).toBe(400);
      expect(mailer.sent).toHaveLength(1);
    });

    it("re-sends with {force:true} after a same-day send, recording nothing new", async () => {
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

      const first = await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      expect(first.status).toBe(200);
      const before = (await opened.db.select().from(digestDeliveries))[0];

      const res = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        kind: "digest",
        action: "sent",
        reason: "forced",
        statLineCount: 1,
      });

      // The same content went out twice, and the delivery row never moved.
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]?.text).toContain("M Acosta");
      expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
      const after = await opened.db.select().from(digestDeliveries);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(before);
    });

    it("still skips a same-day re-send with no body (the pre-force behaviour)", async () => {
      const player = await insertPlayer(opened.db);
      await insertStatLine(opened.db, { playerId: player.id });

      await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      const res = await app().request("/api/digest/send", { method: "POST", headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ action: "skipped", reason: "already-sent-today" });
      expect(mailer.sent).toHaveLength(1);
    });

    it("400s malformed JSON and a wrong-typed force rather than sending", async () => {
      const player = await insertPlayer(opened.db);
      await insertStatLine(opened.db, { playerId: player.id });

      const malformed = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: '{"force":true',
      });
      expect(malformed.status).toBe(400);

      const wrongType = await app().request("/api/digest/send", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ force: "yes" }),
      });
      expect(wrongType.status).toBe(400);

      // Neither reached the job: no mail, no delivery row.
      expect(mailer.sent).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
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

    it("502s an NCAA upstream failure on refresh, ingesting nothing", async () => {
      await insertPlayer(opened.db, {
        externalId: null,
        ncaaPlayerSeq: 2649785,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: "College Guy",
        schoolName: "LSU",
      });
      ncaaApi.options.status = 503;
      const res = await app().request("/api/refresh", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("stats.ncaa.org request failed with HTTP 503");
      expect(await opened.db.select().from(statLines)).toHaveLength(0);
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
    const kept = await opened.db.select().from(statLines).where(eq(statLines.playerId, gone.id));
    expect(kept).toHaveLength(1); // his history is kept, just never selected
  });

  describe("player tag routes (Phase A of #29)", () => {
    /** Add player 691185 (a Triple-A shortstop) — his first Refresh derives tags. */
    async function seedPlayer(): Promise<void> {
      await app().request("/api/players", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ personId: 691185 }),
      });
    }

    it("GET/POST/DELETE /players/:id/tags round-trips a manual tag alongside derived ones", async () => {
      await seedPlayer();

      const initial = (await (await app().request("/api/players/691185/tags", { headers: AUTH })).json()) as {
        tags: Array<{ namespace: string; value: string; source: string }>;
      };
      expect(initial.tags.some((t) => t.namespace === "level" && t.value === "aaa")).toBe(true);

      const added = await app().request("/api/players/691185/tags", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ namespace: "status", value: "rostered" }),
      });
      expect(added.status).toBe(201);
      expect((await added.json()) as { tag: Record<string, unknown> }).toMatchObject({
        tag: { namespace: "status", value: "rostered", source: "manual" },
      });

      const del = await app().request("/api/players/691185/tags/status/rostered", {
        method: "DELETE",
        headers: AUTH,
      });
      expect(del.status).toBe(200);
      expect(await del.json()).toMatchObject({ removed: true });

      const after = (await (await app().request("/api/players/691185/tags", { headers: AUTH })).json()) as {
        tags: Array<{ value: string }>;
      };
      expect(after.tags.some((t) => t.value === "rostered")).toBe(false);
    });

    it("GET /players?tags= filters the roster by an AND selector", async () => {
      await seedPlayer();
      await app().request("/api/players/691185/tags", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ namespace: "status", value: "rostered" }),
      });

      const matched = (await (
        await app().request("/api/players?tags=level:aaa,status:rostered", { headers: AUTH })
      ).json()) as { players: Array<{ externalId: number }> };
      expect(matched.players.map((p) => p.externalId)).toEqual([691185]);

      const none = (await (
        await app().request("/api/players?tags=status:scouted", { headers: AUTH })
      ).json()) as { players: unknown[] };
      expect(none.players).toHaveLength(0);
    });

    it("400s a manual write to a derived namespace and an unknown status value", async () => {
      await seedPlayer();
      const derived = await app().request("/api/players/691185/tags", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ namespace: "level", value: "aaa" }),
      });
      expect(derived.status).toBe(400);

      const unknown = await app().request("/api/players/691185/tags", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ namespace: "status", value: "bogus" }),
      });
      expect(unknown.status).toBe(400);
    });

    it("404s a tag op on an unknown player", async () => {
      const res = await app().request("/api/players/424242/tags", { headers: AUTH });
      expect(res.status).toBe(404);
    });

    it("serves the NCAA variant under /players/ncaa/:seq/tags", async () => {
      await app().request("/api/players/ncaa", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ncaaPlayerSeq: 2649785 }),
      });

      const tags = (await (
        await app().request("/api/players/ncaa/2649785/tags", { headers: AUTH })
      ).json()) as { tags: Array<{ namespace: string; value: string }> };
      expect(tags.tags.some((t) => t.namespace === "level" && t.value === "ncaa")).toBe(true);

      const added = await app().request("/api/players/ncaa/2649785/tags", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ namespace: "status", value: "scouted" }),
      });
      expect(added.status).toBe(201);

      const del = await app().request("/api/players/ncaa/2649785/tags/status/scouted", {
        method: "DELETE",
        headers: AUTH,
      });
      expect(del.status).toBe(200);
    });
  });
});
