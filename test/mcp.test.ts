import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, playerTags, players, refreshRuns, statLines } from "../src/db/schema.js";
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
  insertRefreshRun,
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
  "watchlist_batch_add",
  "watchlist_deactivate",
  "player_search",
  "stat_lines",
  "digest_preview",
  "send_digest",
  "run_refresh",
  "player_tag_add",
  "player_tag_remove",
  "player_tags_list",
  "sql_query",
  "status",
  "lists_list",
  "list_create",
  "list_rename",
  "list_delete",
  "list_members",
  "list_add_players",
  "list_remove_players",
];

/** Tools with NO input fields — exempt from the field-description check. */
const FIELDLESS_TOOLS = ["status", "lists_list"];

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

  it("exposes exactly the advertised tools", async () => {
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
      ALL_TOOLS.filter((n) => !FIELDLESS_TOOLS.includes(n)).sort(),
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

  it("watchlist_add_ncaa reports an NCAA access-denied page as a structured tool error", async () => {
    ncaaApi.options.body = "<html><title>Access Denied</title></html>";
    const result = await call("watchlist_add_ncaa", { ncaaPlayerSeq: 9702101 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("denied access");
    expect(result.content[0]?.text).not.toContain("no NCAA player");
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("watchlist_batch_add stages a batch and returns a structured summary (no inline backfill)", async () => {
    const result = await call("watchlist_batch_add", {
      entries: [{ personId: 691185 }, { ncaaPlayerSeq: 2649785 }],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as {
      summary: { added: number; total: number };
      entries: Array<{ status: string }>;
    };
    expect(sc.summary).toMatchObject({ added: 2, total: 2 });
    expect(sc.entries.map((e) => e.status)).toEqual(["added", "added"]);
    // Text part carries the same JSON.
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ summary: { added: 2 } });

    // Staged identity only — two rows, no stat lines (deferred to the next refresh).
    expect(await opened.db.select().from(players)).toHaveLength(2);
    expect(await opened.db.select().from(statLines)).toHaveLength(0);
  });

  it("watchlist_batch_add reports an in-batch duplicate as a structured tool error, writing nothing", async () => {
    const result = await call("watchlist_batch_add", {
      entries: [{ personId: 5 }, { personId: 5 }],
    });
    expect(result.isError).toBe(true);
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("watchlist_batch_add rejects an unknown top-level key (strict), writing nothing", async () => {
    // The tool registers the strict BatchAddInputBase object, so a stray sibling
    // of entries/list is rejected before any write — consistent with REST's 400
    // (ADR 0045). Registering the raw .shape would have silently stripped it.
    const result = await call("watchlist_batch_add", {
      entries: [{ personId: 691185 }],
      bogusKey: 1,
    });
    expect(result.isError).toBe(true);
    expect(await opened.db.select().from(players)).toHaveLength(0);
  });

  it("watchlist_batch_add keeps a soft per-entry failure inside the structured result", async () => {
    api.options.searchResults = [];
    const result = await call("watchlist_batch_add", {
      entries: [{ personId: 691185 }, { name: "Nobody At All" }],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as {
      summary: { added: number; unresolved: number };
      entries: Array<{ status: string; reason?: string }>;
    };
    expect(sc.summary).toMatchObject({ added: 1, unresolved: 1 });
    expect(sc.entries[1]).toMatchObject({ status: "unresolved", reason: "name_no_match" });
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
    expect((result.structuredContent?.mail as { subject: string }).subject).toBe("ScoreKeeps Baseball (Default) - Sat, July 18, 2026");

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

  it("send_digest carries a named list into the public title and scopes its content", async () => {
    const member = await insertPlayer(opened.db, { externalId: 821, fullName: "Trade Member" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
    const excluded = await insertPlayer(opened.db, { externalId: 822, fullName: "Excluded Prospect" });
    await insertStatLine(opened.db, { playerId: excluded.id, gameDate: "2026-07-18" });
    expect((await call("list_create", { name: "Tradebait" })).isError).toBeUndefined();
    expect(
      (await call("list_add_players", { name: "Tradebait", players: [{ personId: 821 }] })).isError,
    ).toBeUndefined();

    const result = await call("send_digest", { list: "Tradebait" });
    expect(result.structuredContent).toMatchObject({ action: "sent", playerCount: 1, statLineCount: 1 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (Tradebait) - Sat, July 18, 2026");
    expect(mailer.sent[0]?.text.split("\n")[0]).toBe(
      "ScoreKeeps Baseball - Tradebait List - Sat, July 18, 2026",
    );
    expect(mailer.sent[0]?.text).toContain("T Member");
    expect(mailer.sent[0]?.text).not.toContain("Prospect");
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
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

  it("run_refresh surfaces the #23 status + failure arrays verbatim (no output-shape issue)", async () => {
    // One refreshable player and one active MLB row with no externalId (skipped)
    // → a `partial` whole-list run. The new fields must pass through the tool's
    // structuredContent unchanged — the tool declares no outputSchema, so there
    // is no zod shape to reject them.
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, level: "mlb", milbLevel: null, fullName: "No Id Guy" });

    const all = await call("run_refresh");
    expect(all.isError).toBeUndefined();
    expect(all.structuredContent).toMatchObject({
      skipped: false,
      status: "partial",
      playersRefreshed: 1,
      playersSkipped: 1,
      playersFailed: 0,
      playerFailures: [],
      calendarFailures: [],
    });
    // The text part carries the same JSON (clients that read only text).
    expect(all.content[0]?.text).toContain('"status": "partial"');
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
        subject: "ScoreKeeps Baseball (Default) - Sat, July 18, 2026",
        html: "<h1>ScoreKeeps Baseball - Default List - Sat, July 18, 2026</h1>\n<p>No games in this window.</p>",
        text: "ScoreKeeps Baseball - Default List - Sat, July 18, 2026\n\nNo games in this window.\n",
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

  it("status reports refresh freshness null before any refresh has run", async () => {
    const result = await call("status");
    expect(result.structuredContent?.refresh).toBeNull();
  });

  it("status surfaces each refresh freshness state through the MCP tool (ADR 0043)", async () => {
    // The app clock is MID_SEASON (2026-07-19 Chicago), so "today" is 07-19.
    const cases: Array<{
      row: Parameters<typeof insertRefreshRun>[1];
      state: string;
    }> = [
      { row: { status: "ok", startedAt: "2026-07-19T07:00:00.000Z", finishedAt: "2026-07-19T07:20:00.000Z" }, state: "fresh" },
      { row: { status: "ok", startedAt: "2026-07-18T07:00:00.000Z", finishedAt: "2026-07-18T07:20:00.000Z" }, state: "stale" },
      { row: { status: "partial", startedAt: "2026-07-19T07:00:00.000Z", finishedAt: "2026-07-19T07:20:00.000Z" }, state: "partial" },
      { row: { status: "failed", startedAt: "2026-07-19T07:00:00.000Z", finishedAt: "2026-07-19T07:20:00.000Z" }, state: "failed" },
      { row: { status: "running", startedAt: "2026-07-19T16:59:00.000Z", claimedAt: "2026-07-19T16:59:00.000Z", finishedAt: null }, state: "running" },
      // A crashed run whose lease expired two hours before the clock: NOT running.
      { row: { status: "running", startedAt: "2026-07-19T15:00:00.000Z", claimedAt: "2026-07-19T15:00:00.000Z", finishedAt: null }, state: "stale" },
    ];

    for (const { row, state } of cases) {
      await opened.db.delete(refreshRuns);
      await insertRefreshRun(opened.db, row);
      const result = await call("status");
      const refresh = result.structuredContent?.refresh as Record<string, unknown> | null;
      expect(refresh?.state, JSON.stringify(row)).toBe(state);
    }
  });

  describe("named lists (#70 / ADR 0046)", () => {
    it("list_create / lists_list / list_add_players / list_members round-trip", async () => {
      const created = await call("list_create", { name: "Prospects" });
      expect(created.isError).toBeUndefined();
      expect(created.structuredContent).toMatchObject({ list: { name: "Prospects" } });

      await insertPlayer(opened.db, { externalId: 501, fullName: "Listed Guy" });
      const added = await call("list_add_players", {
        name: "Prospects",
        players: [{ personId: 501 }],
      });
      expect(added.structuredContent).toMatchObject({ added: 1 });

      const listed = await call("lists_list");
      const lists = listed.structuredContent?.lists as Array<{ name: string; memberCount: number }>;
      expect(lists).toEqual([{ ...lists[0], name: "Prospects", memberCount: 1 }]);

      const members = await call("list_members", { name: "Prospects" });
      const m = members.structuredContent?.members as Array<{ fullName: string }>;
      expect(m.map((x) => x.fullName)).toEqual(["Listed Guy"]);
    });

    it("list_rename and list_delete (name frees for reuse)", async () => {
      await call("list_create", { name: "Old" });
      const renamed = await call("list_rename", { name: "Old", newName: "New" });
      expect(renamed.structuredContent).toMatchObject({ list: { name: "New" } });
      const deleted = await call("list_delete", { name: "New" });
      expect(deleted.isError).toBeUndefined();
      // The freed name can be recreated.
      expect((await call("list_create", { name: "New" })).isError).toBeUndefined();
    });

    it("list_remove_players removes a member", async () => {
      await call("list_create", { name: "L" });
      await insertPlayer(opened.db, { externalId: 502 });
      await call("list_add_players", { name: "L", players: [{ personId: 502 }] });
      const removed = await call("list_remove_players", { name: "L", players: [{ personId: 502 }] });
      expect(removed.structuredContent).toMatchObject({ removed: 1 });
    });

    it("sad paths surface as isError: unknown list and duplicate name", async () => {
      const unknown = await call("list_members", { name: "ghost" });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]?.text).toContain('no list named "ghost"');

      await call("list_create", { name: "Dupes" });
      const dup = await call("list_create", { name: "Dupes" });
      expect(dup.isError).toBe(true);
      expect(dup.content[0]?.text).toContain("already exists");
    });

    it("list_create rejects a name with a control character (isError)", async () => {
      const bad = await call("list_create", { name: "a\nb" });
      expect(bad.isError).toBe(true);
    });

    it("digest_preview and stat_lines accept a list scope; unknown list isError", async () => {
      await call("list_create", { name: "L" });
      const member = await insertPlayer(opened.db, { externalId: 601 });
      await insertStatLine(opened.db, { playerId: member.id, gameId: 820001, gameDate: "2026-07-18" });
      const nonMember = await insertPlayer(opened.db, { externalId: 602 });
      await insertStatLine(opened.db, { playerId: nonMember.id, gameId: 820002, gameDate: "2026-07-18" });
      await call("list_add_players", { name: "L", players: [{ personId: 601 }] });

      const preview = await call("digest_preview", { window: "1d", list: "L" });
      expect(preview.structuredContent).toMatchObject({
        playerCount: 1,
        mail: { subject: "ScoreKeeps Baseball (L) - Sat, July 18, 2026" },
      });

      const stat = await call("stat_lines", { list: "L" });
      const lines = stat.structuredContent?.statLines as Array<{ playerId: number }>;
      expect(lines.map((l) => l.playerId)).toEqual([member.id]);

      const bad = await call("digest_preview", { window: "1d", list: "ghost" });
      expect(bad.isError).toBe(true);
    });
  });

  // --- Tag tools (Phase A of #29) ------------------------------------------

  it("player_tag_add/list/remove round-trips a manual tag", async () => {
    await call("watchlist_add", { personId: 691185 });

    const added = await call("player_tag_add", { personId: 691185, namespace: "status", value: "rostered" });
    expect(added.isError).toBeUndefined();
    expect(added.structuredContent?.tag).toMatchObject({
      namespace: "status",
      value: "rostered",
      source: "manual",
    });

    const listed = await call("player_tags_list", { personId: 691185 });
    const tags = (listed.structuredContent?.tags ?? []) as Array<Record<string, unknown>>;
    expect(tags.some((t) => t.namespace === "status" && t.value === "rostered")).toBe(true);
    // Derived tags surface too (a Triple-A shortstop).
    expect(tags.some((t) => t.namespace === "level" && t.value === "aaa")).toBe(true);

    const removed = await call("player_tag_remove", { personId: 691185, namespace: "status", value: "rostered" });
    expect(removed.structuredContent).toMatchObject({ removed: true });
  });

  it("watchlist_list filters by a tags selector", async () => {
    await call("watchlist_add", { personId: 691185 });
    await call("player_tag_add", { personId: 691185, namespace: "status", value: "rostered" });

    const filtered = await call("watchlist_list", { tags: "level:aaa,status:rostered" });
    const matched = (filtered.structuredContent?.players ?? []) as Array<Record<string, unknown>>;
    expect(matched).toHaveLength(1);
    expect(matched[0]?.externalId).toBe(691185);

    const none = await call("watchlist_list", { tags: "status:scouted" });
    expect((none.structuredContent?.players ?? []) as unknown[]).toHaveLength(0);
  });

  it("returns isError for a derived-namespace write and an unknown status value", async () => {
    await call("watchlist_add", { personId: 691185 });
    const derived = await call("player_tag_add", { personId: 691185, namespace: "level", value: "aaa" });
    expect(derived.isError).toBe(true);
    const unknown = await call("player_tag_add", { personId: 691185, namespace: "status", value: "bogus" });
    expect(unknown.isError).toBe(true);
  });

  it("returns isError (PlayerNotFoundError) for a tag op on an unknown player", async () => {
    const res = await call("player_tags_list", { personId: 424242 });
    expect(res.isError).toBe(true);
  });

  it("tag tools reject a coercion-prone personId ([123]/true/'123') instead of tagging player 123", async () => {
    // A real player 123 exists — a well-formed personId: 123 WOULD tag him. The
    // strict (non-coercing) MCP shape must reject a malformed personId over this
    // typed-JSON boundary rather than coerce [123]/true/"123" onto player 123.
    await insertPlayer(opened.db, { externalId: 123, milbLevel: "Triple-A", position: "SS" });
    for (const personId of [[123], true, "123"] as unknown[]) {
      const label = JSON.stringify(personId);
      const add = await call("player_tag_add", { personId, namespace: "status", value: "rostered" });
      expect(add.isError, `add ${label}`).toBe(true);
      const remove = await call("player_tag_remove", { personId, namespace: "status", value: "rostered" });
      expect(remove.isError, `remove ${label}`).toBe(true);
      const list = await call("player_tags_list", { personId });
      expect(list.isError, `list ${label}`).toBe(true);
    }
    // None of the malformed calls mutated player 123 (or anyone): no tag rows.
    expect(await opened.db.select().from(playerTags)).toHaveLength(0);
  });

  it("watchlist_list returns isError for a separators-only tags selector", async () => {
    await call("watchlist_add", { personId: 691185 });
    // `,,,` normalizes to zero tokens — a malformed selector, not an absent one.
    const res = await call("watchlist_list", { tags: ",,," });
    expect(res.isError).toBe(true);
  });
});
