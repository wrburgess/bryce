import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import {
  digestDeliveries,
  highlightlyBoxScoreCache,
  highlightlyMatchCache,
  highlightlyPlayerCursors,
  players,
  refreshRuns,
  seasonCalendar,
  statLines,
} from "../src/db/schema.js";
import { HighlightlyClient } from "../src/highlightly/client.js";
import { MlbClient } from "../src/mlb/client.js";
import type { AppDeps } from "../src/server.js";
import { createApp } from "../src/server.js";
import {
  CapturingMailer,
  FakeStatsApi,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  makeGameLogBody,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testAppDeps,
  testDb,
} from "./factories.js";

const AUTH = { Authorization: `Bearer ${TEST_API_TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

type McpResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

type Snapshot = {
  players: unknown[];
  statLines: unknown[];
  refreshRuns: unknown[];
  seasonCalendar: unknown[];
  highlightlyPlayerCursors: unknown[];
  highlightlyMatchCache: unknown[];
  highlightlyBoxScoreCache: unknown[];
  digestDeliveries: unknown[];
  mailerSent: unknown[];
  mlbCalls: number;
  highlightlyCalls: number;
};

type Fixture = {
  opened: OpenedDb;
  deps: AppDeps;
  api: FakeStatsApi;
  mailer: CapturingMailer;
  highlightlyCalls: () => number;
  close: () => void;
};

type HighlightlyMode = "configured" | "not-configured" | "absent";

async function makeFixture(options: { highlightlyMode?: HighlightlyMode } = {}): Promise<Fixture> {
  const opened = testDb();
  const clock = fakeClock(MID_SEASON);
  const api = new FakeStatsApi({
    person: makePerson(),
    teams: { 564: makeTeam() },
    seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
    gameLogs: {
      "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]),
    },
  });
  const mailer = new CapturingMailer();
  let highlightlyCallCount = 0;
  const highlightlyClient = options.highlightlyMode === "absent"
    ? undefined
    : new HighlightlyClient({
      apiKey: options.highlightlyMode === "not-configured" ? null : "test-highlightly-key",
      fetchImpl: async () => {
        highlightlyCallCount += 1;
        throw new Error("unexpected Highlightly fetch");
      },
    });
  await insertCalendars2026(opened.db);
  const deps = testAppDeps(opened, {
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    highlightlyClient,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
  });
  return { opened, deps, api, mailer, highlightlyCalls: () => highlightlyCallCount, close: () => opened.close() };
}

async function snapshot(fixture: Fixture): Promise<Snapshot> {
  const { db } = fixture.deps;
  return {
    players: await db.select().from(players),
    statLines: await db.select().from(statLines),
    refreshRuns: await db.select().from(refreshRuns),
    seasonCalendar: await db.select().from(seasonCalendar),
    highlightlyPlayerCursors: await db.select().from(highlightlyPlayerCursors),
    highlightlyMatchCache: await db.select().from(highlightlyMatchCache),
    highlightlyBoxScoreCache: await db.select().from(highlightlyBoxScoreCache),
    digestDeliveries: await db.select().from(digestDeliveries),
    mailerSent: [...fixture.mailer.sent],
    mlbCalls: fixture.api.calls.length,
    highlightlyCalls: fixture.highlightlyCalls(),
  };
}

async function connect(deps: AppDeps): Promise<Client> {
  const app = createApp(deps);
  const client = new Client({ name: "bryce-conformance-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://bryce.local/mcp"), {
    fetch: async (url, init) => app.request(url.toString(), init),
    requestInit: { headers: AUTH },
  });
  await client.connect(transport);
  return client;
}

describe("REST/MCP semantic conformance", () => {
  /**
   * The Player Card is the ONE place REST and MCP intentionally disagree, and
   * only about their DEFAULT (#141 / ADR 0055): REST's audience is the
   * programmatic caller, so it keeps `json`; MCP's is an agent, which should
   * receive a finished artifact to display rather than ~315 key/value pairs.
   *
   * This is asserted as an INTENT, not waved through as an "expected
   * divergence": for an EXPLICIT format the two surfaces must still produce the
   * same bytes. A bare "they differ" assertion would be indistinguishable from
   * papering over a real regression, so both halves are pinned — the defaults
   * differ, AND the explicit formats are identical.
   */
  it("differs ONLY in the player-card default, and is byte-identical for an explicit format", async () => {
    const fixture = await makeFixture();
    try {
      const player = await insertPlayer(fixture.opened.db, { fullName: "Conformance Cardguy" });
      await insertStatLine(fixture.opened.db, { playerId: player.id, gameDate: "2026-07-18", stats: { hits: 2, atBats: 4 } });
      const before = await snapshot(fixture);
      const client = await connect(fixture.deps);
      try {
        const restJson = async (query: string): Promise<Response> =>
          createApp(fixture.deps).request(`/api/reports/player/${player.id}?windows=last10${query}`, { headers: AUTH });
        const mcp = async (format?: string): Promise<McpResult & { structuredContent?: unknown }> =>
          client.callTool({
            name: "report_player",
            arguments: { id: player.id, windows: ["last10"], ...(format === undefined ? {} : { format }) },
          }) as Promise<McpResult & { structuredContent?: unknown }>;

        // THE DEFAULTS DIVERGE, deliberately.
        const restDefault = await restJson("");
        expect(restDefault.headers.get("content-type")).toContain("application/json");
        const mcpDefault = await mcp();
        expect(mcpDefault.structuredContent, "MCP defaults to the console Presentation").toBeUndefined();
        expect(mcpDefault.content[0]?.text).toContain("Conformance Cardguy");

        // EVERY EXPLICIT FORMAT IS IDENTICAL across the two surfaces.
        expect(JSON.stringify((await mcp("json")).structuredContent)).toBe(JSON.stringify(await restDefault.clone().json()));
        expect((await mcp("console")).content[0]?.text).toBe(await (await restJson("&format=console")).text());
        expect((await mcp("html")).content[0]?.text).toBe(await (await restJson("&format=html")).text());

        // And both still reject an unsupported format rather than defaulting.
        expect((await restJson("&format=pdf")).status).toBe(400);
        expect((await mcp("pdf")).isError).toBe(true);

        // A card is read-only on both surfaces, in every format.
        expect(await snapshot(fixture)).toEqual(before);
      } finally {
        await client.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("projects the four shared rejection contracts without mutation or provider fetches", async () => {
    type Variant = {
      name: string;
      fixtureOptions?: { highlightlyMode?: HighlightlyMode };
      restStatus?: number;
      restError?: string;
      mcpMessage?: string;
    };
    const cases: Array<{
      name: string;
      setup: (fixture: Fixture) => Promise<void>;
      rest: (fixture: Fixture) => Response | Promise<Response>;
      mcp: (client: Client) => Promise<McpResult>;
      assertRest: (response: Response, variant: Variant) => Promise<void>;
      assertMcp: (result: McpResult, variant: Variant) => void;
      variants?: Variant[];
    }> = [
      {
        name: "Refresh dual identity",
        setup: async () => {},
        rest: (fixture) => createApp(fixture.deps).request("/api/refresh", {
          method: "POST", headers: JSON_AUTH, body: JSON.stringify({ personId: 691185, highlightlyPlayerId: 123 }),
        }),
        mcp: async (client) => client.callTool({ name: "run_refresh", arguments: { personId: 691185, highlightlyPlayerId: 123 } }) as Promise<McpResult>,
        assertRest: async (response) => {
          expect(response.status).toBe(400);
          expect((await response.json()) as { error: string }).toMatchObject({ error: "invalid-input" });
        },
        assertMcp: (result) => {
          expect(result.isError).toBe(true);
          expect(result.content[0]?.text).toContain("provide personId or highlightlyPlayerId, not both");
        },
      },
      {
        name: "Unsupported digest window",
        setup: async () => {},
        rest: (fixture) => createApp(fixture.deps).request("/api/digest/send", {
          method: "POST", headers: JSON_AUTH, body: JSON.stringify({ window: "30d" }),
        }),
        mcp: async (client) => client.callTool({ name: "send_digest", arguments: { window: "30d" } }) as Promise<McpResult>,
        assertRest: async (response) => {
          expect(response.status).toBe(400);
          expect((await response.json()) as { error: string }).toMatchObject({ error: "invalid-input" });
        },
        assertMcp: (result) => {
          expect(result.isError).toBe(true);
          expect(result.content[0]?.text).toContain("Invalid option");
          expect(result.content[0]?.text).toContain("window");
        },
      },
      {
        name: "Unknown targeted Refresh player",
        setup: async () => {},
        rest: (fixture) => createApp(fixture.deps).request("/api/refresh", {
          method: "POST", headers: JSON_AUTH, body: JSON.stringify({ personId: 424242 }),
        }),
        mcp: async (client) => client.callTool({ name: "run_refresh", arguments: { personId: 424242 } }) as Promise<McpResult>,
        assertRest: async (response) => {
          expect(response.status).toBe(404);
          expect((await response.json()) as { error: string }).toMatchObject({ error: "no player with personId=424242" });
        },
        assertMcp: (result) => {
          expect(result.isError).toBe(true);
          expect(result.content[0]?.text).toContain("no player with personId=424242");
        },
      },
      {
        name: "Current Highlightly configuration failures",
        variants: [
          {
            name: "not-configured",
            fixtureOptions: { highlightlyMode: "not-configured" },
            restStatus: 503,
            restError: "highlightly_not_configured",
            mcpMessage: "HIGHLIGHTLY_API_KEY is required for NCAA refresh",
          },
          {
            name: "absent-client",
            fixtureOptions: { highlightlyMode: "absent" },
            restStatus: 409,
            restError: "highlightly_migration_required",
            mcpMessage: "attach and backfill this legacy NCAA player first",
          },
        ],
        setup: async (fixture) => {
          await insertPlayer(fixture.opened.db, {
            externalId: null,
            highlightlyPlayerId: 501,
            highlightlyTeamId: 10,
            ncaaSourceState: "highlightly_active",
            level: "ncaa",
            milbLevel: null,
            teamName: null,
          });
        },
        rest: (fixture) => createApp(fixture.deps).request("/api/refresh", {
          method: "POST", headers: JSON_AUTH, body: JSON.stringify({ highlightlyPlayerId: 501 }),
        }),
        mcp: async (client) => client.callTool({ name: "run_refresh", arguments: { highlightlyPlayerId: 501 } }) as Promise<McpResult>,
        assertRest: async (response, variant) => {
          expect(response.status).toBe(variant.restStatus!);
          expect((await response.json()) as { error: string }).toMatchObject({ error: variant.restError! });
        },
        assertMcp: (result, variant) => {
          expect(result.isError).toBe(true);
          expect(result.content[0]?.text).toContain(variant.mcpMessage!);
        },
      },
    ];

    for (const testCase of cases) {
      for (const variant of testCase.variants ?? [{ name: "default" }]) {
        const restFixture = await makeFixture(variant.fixtureOptions);
        try {
          await testCase.setup(restFixture);
          const before = await snapshot(restFixture);
          const rest = await testCase.rest(restFixture);
          await testCase.assertRest(rest, variant);
          expect(await snapshot(restFixture), `${testCase.name} REST ${variant.name}`).toEqual(before);
        } finally {
          restFixture.close();
        }

        const mcpFixture = await makeFixture(variant.fixtureOptions);
        try {
          await testCase.setup(mcpFixture);
          const client = await connect(mcpFixture.deps);
          const before = await snapshot(mcpFixture);
          try {
            const mcp = await testCase.mcp(client);
            testCase.assertMcp(mcp, variant);
            expect(await snapshot(mcpFixture), `${testCase.name} MCP ${variant.name}`).toEqual(before);
          } finally {
            await client.close();
          }
        } finally {
          mcpFixture.close();
        }
      }
    }
  });
});
