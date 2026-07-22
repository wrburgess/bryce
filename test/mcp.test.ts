import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  insertDelivery,
  insertPlayer,
  insertStatLine,
  makeGameLogBody,
  makeNcaaGameLogHtml,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testAppDeps,
  testDb,
} from "./factories.js";

const ALL_TOOLS = [
  "watchlist_list",
  "watchlist_add",
  "watchlist_add_ncaa",
  "watchlist_deactivate",
  "player_search",
  "stat_lines",
  "digest_preview",
  "send_digest",
  "run_refresh",
  "sql_query",
  "status",
];

describe("MCP server over Streamable HTTP", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;
  let deps: AppDeps;
  let client: Client;

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
      teams: { 564: makeTeam() },
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
    client = await connect();
  });

  afterEach(async () => {
    await client.close();
    opened.close();
  });

  /** SDK client wired straight into the Hono app — no sockets, real transport. */
  async function connect(token: string | null = TEST_API_TOKEN): Promise<Client> {
    const app = createApp(deps);
    const c = new Client({ name: "bryce-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://bryce.local/mcp"), {
      fetch: async (url, init) => app.request(url.toString(), init),
      ...(token === null
        ? {}
        : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    });
    await c.connect(transport);
    return c;
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return result as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
  }

  it("exposes exactly the eleven tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
    }

    // Both digest tools enumerate all eight windows — including the three added
    // in #54 — so a client sees them without reading the source.
    const descriptionOf = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    for (const name of ["digest_preview", "send_digest"]) {
      for (const win of ["28d", "35d", "60d"]) {
        expect(descriptionOf(name), `${name} enumerates ${win}`).toContain(win);
      }
    }
    // send_digest names the new windows among the on-demand ones (no daily slot).
    expect(descriptionOf("send_digest")).toContain("on-demand");
    expect(descriptionOf("send_digest")).toContain("28d/35d/60d");
  });

  it("describes every input field of every exposed tool schema", async () => {
    const { tools } = await client.listTools();

    // The `description` string a JSON-Schema property carries, or undefined.
    const describedOf = (schema: unknown): string | undefined => {
      if (typeof schema === "object" && schema !== null && "description" in schema) {
        const value = (schema as { description: unknown }).description;
        return typeof value === "string" ? value : undefined;
      }
      return undefined;
    };
    const propertiesOf = (name: string): Record<string, unknown> =>
      (tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as Record<string, unknown>;

    // Every tool that declares input fields is checked; only field-less `status` is exempt.
    const toolsWithInputs = tools.filter(
      (t) => Object.keys(t.inputSchema.properties ?? {}).length > 0,
    );
    expect(toolsWithInputs.map((t) => t.name).sort()).toEqual(
      ALL_TOOLS.filter((n) => n !== "status").sort(),
    );

    // Every exposed field carries a genuinely informative description (`.describe()`
    // reaching the wire) — a bare or trivial label fails here.
    for (const tool of toolsWithInputs) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        const description = describedOf(schema);
        expect(typeof description, `${tool.name}.${field} description`).toBe("string");
        expect((description ?? "").length, `${tool.name}.${field} description`).toBeGreaterThan(20);
      }
    }

    // Semantic asserts: the descriptions must be authored correct, not merely present.
    // `level` names all three affiliations (the schema allows ncaa, so the prose must too).
    expect(describedOf(propertiesOf("stat_lines").level)).toMatch(/ncaa/i);
    // The shared `force` description names the digest_preview no-op on both digest tools.
    for (const name of ["digest_preview", "send_digest"]) {
      expect(describedOf(propertiesOf(name).force), `${name}.force`).toMatch(/preview/i);
    }
  });

  it("401s the /mcp endpoint without (or with a wrong) token", async () => {
    const app = createApp(deps);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(TEST_API_TOKEN);

    await expect(connect(null)).rejects.toThrow(/unauthorized/);
    await expect(connect("wrong-token")).rejects.toThrow(/unauthorized/);
  });

  it("watchlist_add creates the player and backfills his season", async () => {
    const result = await call("watchlist_add", { personId: 691185 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      action: "added",
      refresh: { skipped: false, inserted: 2, updated: 0 },
    });
    // The text part carries the same JSON.
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ action: "added" });

    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 691185, fullName: "Maximo Acosta" });
    expect(await opened.db.select().from(statLines)).toHaveLength(2);
  });

  it("watchlist_add reports an unknown person as a tool error", async () => {
    api.options.person = undefined;
    const result = await call("watchlist_add", { personId: 424242 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no MLB person with personId=424242");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("watchlist_add_ncaa creates the NCAA player and backfills his season", async () => {
    const result = await call("watchlist_add_ncaa", { ncaaPlayerSeq: 2649785 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      action: "added",
      player: { ncaaPlayerSeq: 2649785, schoolName: "LSU", level: "ncaa" },
      refresh: { skipped: false, inserted: 1 },
    });
    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: null, ncaaPlayerSeq: 2649785, schoolName: "LSU" });
    expect((await opened.db.select().from(statLines))[0]?.sportId).toBe(22);
  });

  it("watchlist_add_ncaa reports an unresolvable seq as a tool error", async () => {
    const result = await call("watchlist_add_ncaa", { ncaaPlayerSeq: 999999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no NCAA player with ncaaPlayerSeq=999999");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("watchlist_add_ncaa reports an NCAA upstream failure as a structured tool error", async () => {
    ncaaApi.options.status = 500;
    const result = await call("watchlist_add_ncaa", { ncaaPlayerSeq: 2649785 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("stats.ncaa.org request failed with HTTP 500");
    // Not misreported as a missing player, and nothing written.
    expect(result.content[0]?.text).not.toContain("no NCAA player");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("run_refresh reports an NCAA upstream failure as a structured tool error", async () => {
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });
    ncaaApi.options.status = 502;
    const result = await call("run_refresh", { ncaaPlayerSeq: 2649785 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("stats.ncaa.org request failed with HTTP 502");
    expect(await opened.db.select().from(statLines)).toHaveLength(0);
  });

  it("watchlist_deactivate and run_refresh accept NCAA addressing; list carries schoolName", async () => {
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "College Guy",
      schoolName: "LSU",
    });

    // list carries the school and seq.
    const listed = await call("watchlist_list");
    const players0 = listed.structuredContent?.players as Array<Record<string, unknown>>;
    expect(players0[0]).toMatchObject({ schoolName: "LSU", ncaaPlayerSeq: 2649785 });

    // run_refresh by ncaaPlayerSeq ingests his season.
    const refreshed = await call("run_refresh", { ncaaPlayerSeq: 2649785 });
    expect(refreshed.structuredContent).toMatchObject({ skipped: false, inserted: 1 });
    expect((await opened.db.select().from(statLines))[0]?.sportId).toBe(22);

    // deactivate by ncaaPlayerSeq.
    const deactivated = await call("watchlist_deactivate", { ncaaPlayerSeq: 2649785 });
    expect((deactivated.structuredContent?.player as { active: boolean }).active).toBe(false);
    expect((await opened.db.select().from(players)).find((p) => p.id === ncaa.id)?.active).toBe(false);

    // Ambiguous / empty addressing is a tool error.
    const bad = await call("watchlist_deactivate", { personId: 1, ncaaPlayerSeq: 2 });
    expect(bad.isError).toBe(true);
  });

  it("watchlist_list respects the active filter", async () => {
    await insertPlayer(opened.db, { fullName: "Active Guy" });
    await insertPlayer(opened.db, { fullName: "Gone Guy", active: false });

    const active = await call("watchlist_list");
    const activeNames = (active.structuredContent?.players as Array<{ fullName: string }>).map(
      (p) => p.fullName,
    );
    expect(activeNames).toEqual(["Active Guy"]);

    const all = await call("watchlist_list", { active: "all" });
    expect(all.structuredContent?.players as unknown[]).toHaveLength(2);
  });

  it("watchlist_deactivate flips active and keeps history", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    await insertStatLine(opened.db, { playerId: player.id });

    const result = await call("watchlist_deactivate", { personId: 691185 });
    expect((result.structuredContent?.player as { active: boolean }).active).toBe(false);
    expect((await opened.db.select().from(players))[0]?.active).toBe(false);
    expect(await opened.db.select().from(statLines)).toHaveLength(1);

    const missing = await call("watchlist_deactivate", { personId: 424242 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("no player with personId=424242");
  });

  it("player_search maps hits with team/level resolution", async () => {
    api.options.searchResults = [makePerson()];
    const result = await call("player_search", { q: "acosta" });
    expect(result.structuredContent?.results).toEqual([
      {
        personId: 691185,
        fullName: "Maximo Acosta",
        position: "SS",
        level: "milb",
        milbLevel: "Triple-A",
        teamName: "Jacksonville Jumbo Shrimp",
      },
    ]);

    const invalid = await call("player_search", { q: "   " });
    expect(invalid.isError).toBe(true);
  });

  it("stat_lines queries with bounds and rejects from > to", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-06-01" });

    const result = await call("stat_lines", { playerId: player.id, from: "2026-07-01" });
    const lines = result.structuredContent?.statLines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ playerName: "Maximo Acosta", gameDate: "2026-07-18" });

    const invalid = await call("stat_lines", { from: "2026-07-20", to: "2026-07-01" });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("from must be <= to");
  });

  it("digest_preview reports without sending or stamping", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const result = await call("digest_preview");
    expect(result.structuredContent).toMatchObject({ statLineCount: 1, playerCount: 1 });
    expect(result.structuredContent?.window).toMatchObject({
      spec: "1d",
      from: "2026-07-18",
      to: "2026-07-18",
    });
    expect((result.structuredContent?.mail as { subject: string }).subject).toBe("MLB Daily Tracker - Sat, July 18, 2026");

    expect(mailer.sent).toHaveLength(0);
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
  });

  it("both digest tools accept a window, and reject an unsupported one", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-14" });

    const week = await call("digest_preview", { window: "7d" });
    expect(week.structuredContent).toMatchObject({ statLineCount: 2 });
    expect(week.structuredContent?.window).toMatchObject({ spec: "7d", from: "2026-07-12" });
    expect((await call("digest_preview")).structuredContent).toMatchObject({ statLineCount: 1 });

    // A new long window (added in #54) is accepted on both tools.
    const long = await call("digest_preview", { window: "28d" });
    expect(long.structuredContent).toMatchObject({ statLineCount: 2 });
    expect(long.structuredContent?.window).toMatchObject({ spec: "28d" });

    // Fails closed on BOTH tools: named, refused, and nothing sent.
    for (const tool of ["digest_preview", "send_digest"]) {
      const bogus = await call(tool, { window: "30d" });
      expect(bogus.isError).toBe(true);
      expect(bogus.content[0]?.text).toContain("window");
    }
    expect(mailer.sent).toHaveLength(0);
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

    const sent = await call("send_digest", { window: "7d" });
    expect(sent.structuredContent).toMatchObject({
      action: "sent",
      statLineCount: 2,
      window: "Last 7 Days (Jul 12-18)",
    });
  });

  it("send_digest sends, records the delivery, and stamps nothing", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const result = await call("send_digest");
    expect(result.structuredContent).toMatchObject({
      kind: "digest",
      action: "sent",
      statLineCount: 1,
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("M Acosta");
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(1);
  });

  it("send_digest accepts force, replaying without recording", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    expect((await call("send_digest")).structuredContent).toMatchObject({ action: "sent" });
    const before = (await opened.db.select().from(digestDeliveries))[0];

    // Unforced, the day is closed — but the PREVIEW still reports the window,
    // because a window consumes nothing and a preview never claimed anything.
    expect((await call("send_digest")).structuredContent).toMatchObject({
      action: "skipped",
      reason: "already-sent-today",
    });
    const preview = await call("digest_preview");
    expect(preview.structuredContent).toMatchObject({ statLineCount: 1, playerCount: 1 });
    expect((preview.structuredContent?.mail as { text: string }).text).toContain("M Acosta");
    expect(mailer.sent).toHaveLength(1);

    // Forced send re-mails it and leaves the delivery row exactly as it was.
    const forced = await call("send_digest", { force: true });
    expect(forced.structuredContent).toMatchObject({
      kind: "digest",
      action: "sent",
      reason: "forced",
      statLineCount: 1,
    });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
    const after = await opened.db.select().from(digestDeliveries);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("rejects a wrong-typed force on both digest tools", async () => {
    // The tools declare force as a real boolean, so the string "yes" is an
    // error naming the offending field — never silently coerced into a send.
    for (const tool of ["send_digest", "digest_preview"]) {
      const result = await call(tool, { force: "yes" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("force");
      expect(result.content[0]?.text).toContain("boolean");
    }
    expect(mailer.sent).toHaveLength(0);
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
  });

  it("run_refresh refreshes one player or the whole watch list", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });

    const one = await call("run_refresh", { personId: 691185 });
    expect(one.structuredContent).toMatchObject({ skipped: false, inserted: 2, updated: 0 });
    expect(await opened.db.select().from(statLines)).toHaveLength(2);

    const all = await call("run_refresh");
    expect(all.structuredContent).toMatchObject({
      skipped: false,
      playersRefreshed: 1,
      statLinesInserted: 0,
      statLinesUpdated: 2,
    });

    const missing = await call("run_refresh", { personId: 424242 });
    expect(missing.isError).toBe(true);
  });

  it("sql_query returns rows and rejects writes", async () => {
    await insertPlayer(opened.db, { fullName: "Maximo Acosta" });

    const result = await call("sql_query", {
      sql: "SELECT full_name FROM players WHERE full_name = ?",
      params: ["Maximo Acosta"],
    });
    expect(result.structuredContent).toMatchObject({
      columns: ["full_name"],
      rows: [["Maximo Acosta"]],
      rowCount: 1,
      truncated: false,
    });

    for (const sql of ["DELETE FROM players", "PRAGMA user_version", "SELECT 1; SELECT 2"]) {
      const rejected = await call("sql_query", { sql });
      expect(rejected.isError, sql).toBe(true);
    }
    expect(await opened.db.select().from(players)).toHaveLength(1);
  });

  // --- Presentation/Export formats (ADR 0037, issue #55) -------------------

  it("advertises format/table on digest_preview ONLY, and format on the tabular tools", async () => {
    const { tools } = await client.listTools();
    const props = (name: string): string[] => {
      const tool = tools.find((t) => t.name === name);
      const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      return Object.keys(schema?.properties ?? {});
    };
    expect(props("digest_preview")).toEqual(expect.arrayContaining(["format", "table"]));
    expect(props("stat_lines")).toContain("format");
    expect(props("sql_query")).toContain("format");
    // send_digest keeps the bare digest shape — it must not gain format/table.
    expect(props("send_digest")).not.toContain("format");
    expect(props("send_digest")).not.toContain("table");
    // Only digest carries a table; the tabular tools do not.
    expect(props("stat_lines")).not.toContain("table");
  });

  it("digest_preview json is byte-identical with format omitted or format=json", async () => {
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
    const omitted = await call("digest_preview");
    const explicit = await call("digest_preview", { format: "json" });
    expect(omitted.structuredContent).toEqual(expected);
    expect(explicit.structuredContent).toEqual(expected);
    // The serialized text part is identical too — adding format=json changed nothing.
    expect(omitted.content[0]?.text).toBe(explicit.content[0]?.text);
  });

  it("digest_preview html/md return the rendered document as text, no structuredContent", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const html = await call("digest_preview", { format: "html" });
    expect(html.structuredContent).toBeUndefined();
    expect(html.content[0]?.text.startsWith("<!doctype html>")).toBe(true);
    expect(html.content[0]?.text).toContain("<h2>Batters</h2>");

    const md = await call("digest_preview", { format: "md" });
    expect(md.structuredContent).toBeUndefined();
    expect(md.content[0]?.text.startsWith("# ")).toBe(true);
    expect(md.content[0]?.text).not.toContain("Bryce - ");
    expect(md.content[0]?.text).toContain("## Batters");
  });

  it("digest_preview csv exports one table, chosen by table (default batters)", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });

    const batters = await call("digest_preview", { format: "csv" });
    expect(batters.structuredContent).toBeUndefined();
    expect(batters.content[0]?.text.startsWith("Player,Lvl,")).toBe(true);
    expect(batters.content[0]?.text).toContain("PA,H,BB,K"); // batting columns
    expect(batters.content[0]?.text).toContain("M Acosta");

    const pitchers = await call("digest_preview", { format: "csv", table: "pitchers" });
    expect(pitchers.content[0]?.text).toContain("IP,ER,K,K/9"); // pitching columns
    expect(pitchers.content[0]?.text).not.toContain("Batting");
  });

  it("digest_preview rejects an invalid format or table", async () => {
    expect((await call("digest_preview", { format: "xml" })).isError).toBe(true);
    expect((await call("digest_preview", { format: "csv", table: "fielders" })).isError).toBe(true);
  });

  it("stat_lines json is byte-identical with format omitted or format=json", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    const line = await insertStatLine(opened.db, {
      playerId: player.id,
      gameId: 900500,
      gameDate: "2026-07-18",
    });
    const expected = {
      statLines: [
        {
          id: line.id,
          playerId: player.id,
          playerName: "Maximo Acosta",
          level: "milb",
          milbLevel: "Triple-A",
          gameId: 900500,
          statType: "batting",
          gameDate: "2026-07-18",
          gameNumber: 1,
          gameType: "R",
          isHome: true,
          opponentName: "Charlotte Knights",
          teamName: "Jacksonville Jumbo Shrimp",
          sportId: 11,
          leagueName: "International League",
          stats: {
            hits: 2,
            atBats: 4,
            homeRuns: 1,
            doubles: 0,
            triples: 0,
            runs: 1,
            rbi: 3,
            stolenBases: 0,
            baseOnBalls: 0,
            strikeOuts: 1,
          },
        },
      ],
    };
    const omitted = await call("stat_lines");
    const explicit = await call("stat_lines", { format: "json" });
    expect(omitted.structuredContent).toEqual(expected);
    expect(explicit.structuredContent).toEqual(expected);
    expect(omitted.content[0]?.text).toBe(explicit.content[0]?.text);
  });

  it("stat_lines csv returns the fixed-header CSV; rejects invalid format and from>to", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameId: 900500, gameDate: "2026-07-18" });

    const csv = await call("stat_lines", { format: "csv" });
    expect(csv.structuredContent).toBeUndefined();
    expect(csv.content[0]?.text.startsWith("id,playerId,playerName,")).toBe(true);
    expect(csv.content[0]?.text).toContain("Maximo Acosta");
    // The JSON `stats` blob (commas + quotes) stays RFC-4180-quoted end-to-end:
    // JSON.stringify's `{"…":…}` is wrapped and its inner quotes doubled.
    expect(csv.content[0]?.text).toContain('"{""');

    expect((await call("stat_lines", { format: "xml" })).isError).toBe(true);
    const badRange = await call("stat_lines", { format: "csv", from: "2026-07-20", to: "2026-07-01" });
    expect(badRange.isError).toBe(true);
    expect(badRange.content[0]?.text).toContain("from must be <= to");
  });

  it("sql_query json is byte-identical with format omitted or format=json", async () => {
    await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    const expected = {
      columns: ["full_name"],
      rows: [["Maximo Acosta"]],
      rowCount: 1,
      truncated: false,
    };
    const args = { sql: "SELECT full_name FROM players WHERE full_name = ?", params: ["Maximo Acosta"] };
    const omitted = await call("sql_query", args);
    const explicit = await call("sql_query", { ...args, format: "json" });
    expect(omitted.structuredContent).toEqual(expected);
    expect(explicit.structuredContent).toEqual(expected);
    expect(omitted.content[0]?.text).toBe(explicit.content[0]?.text);
  });

  it("sql_query csv guards a dangerous cell value and a dangerous column alias", async () => {
    const result = await call("sql_query", {
      sql: `SELECT '=danger' AS "=evil", '@bad' AS plain`,
      format: "csv",
    });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe("'=evil,plain\r\n'=danger,'@bad\r\n");
  });

  it("sql_query csv adds a truncation warning part only when the row cap is hit", async () => {
    const over = await call("sql_query", {
      sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 201) SELECT n FROM c",
      format: "csv",
    });
    expect(over.content).toHaveLength(2);
    expect(over.content[1]?.text).toBe("warning: result truncated at 200 rows; narrow the query");

    const atCap = await call("sql_query", {
      sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 200) SELECT n FROM c",
      format: "csv",
    });
    expect(atCap.content).toHaveLength(1);
  });

  it("status matches the /health shape", async () => {
    await insertPlayer(opened.db);
    const result = await call("status");
    const app = createApp(deps);
    const health = await (await app.request("/health")).json();
    expect(result.structuredContent).toEqual(health);
  });

  it("status reports an in-flight `sending` delivery so a stuck claim is visible", async () => {
    // The second surface of the widened delivery state machine (ADR 0034):
    // rules/backend.md wants every seam updated in the same change, each with
    // its own sad-path test — this is the MCP tool's.
    await insertDelivery(opened.db, {
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      claimedAt: "2026-07-19T12:00:00.000Z",
      createdAt: "2026-07-19T12:00:00.000Z",
      attemptCount: 2,
    });

    const result = await call("status");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.lastDelivery).toEqual({
      kind: "digest",
      dateCovered: "2026-07-19",
      status: "sending",
      sentAt: null,
    });
  });
});
