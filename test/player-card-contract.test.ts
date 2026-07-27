import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { runReportCli } from "../src/cli/report.js";
import type { AppDeps } from "../src/server.js";
import { createApp } from "../src/server.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  testAppDeps,
  testDb,
} from "./factories.js";

/**
 * The Player Card JSON contract, pinned across ALL FOUR JSON surfaces.
 *
 * #141's acceptance criterion is that the Card payload changes ADDITIVELY only:
 * every field present today keeps its NAME, its POSITION, and its VALUE
 * (ADR 0055 consequence 2). Nothing pinned that before this file existed, so a
 * renamed or reordered key could have shipped through four surfaces silently.
 *
 * Key ORDER is asserted, not merely the key SET: `JSON.stringify` preserves
 * insertion order, so a scripted caller that diffs two runs' raw JSON — or a
 * fixture recorded from one — sees a reordering as a change. Asserting order is
 * what makes "position" in the criterion enforceable.
 *
 * The four surfaces are asserted against ONE expectation, so a surface cannot
 * drift alone: a key added to the assembler reaches all four or the diff shows
 * exactly which one it missed.
 */

const AUTH = { Authorization: `Bearer ${TEST_API_TOKEN}` };

const CARD_KEYS = ["player", "windows"];
const PLAYER_KEYS = ["id", "fullName", "level", "milbLevel", "teamName", "schoolName"];
const WINDOW_KEYS = ["spec", "requestedGames", "actualGames", "from", "to", "empty", "batters", "pitchers"];
// The three trailing keys are #141's ONLY payload change (ADR 0055 consequence 2):
// APPENDED, so every key above them keeps its name, position, and value. The diff
// on this line is the additive-only proof.
const ROW_KEYS = ["lvl", "lvlRank", "aggregate", "rates", "qualityStarts", "reliefWins", "reliefLosses"];
const AGGREGATE_KEYS = ["statType", "games", "counters", "outs", "unknownFields"];

interface JsonCard {
  player: Record<string, unknown>;
  windows: Array<Record<string, unknown> & { batters: Array<Record<string, unknown>>; pitchers: Array<Record<string, unknown>> }>;
}

/**
 * Assert the exact key set AND order of every object in one card. Applied to
 * each surface's payload, so a surface that re-serializes (dropping undefined,
 * reordering, or wrapping) is caught rather than assumed identical.
 */
function assertCardShape(card: JsonCard, label: string): void {
  expect(Object.keys(card), `${label}: card`).toEqual(CARD_KEYS);
  expect(Object.keys(card.player), `${label}: player`).toEqual(PLAYER_KEYS);
  expect(card.windows.length, `${label}: window count`).toBeGreaterThan(0);
  for (const window of card.windows) {
    expect(Object.keys(window), `${label}: window ${String(window.spec)}`).toEqual(WINDOW_KEYS);
    const rows = [...window.batters, ...window.pitchers];
    // A window with no rows would satisfy the loop below vacuously, so the
    // fixture below guarantees both a batting and a pitching row per window.
    expect(rows.length, `${label}: rows in ${String(window.spec)}`).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row), `${label}: row in ${String(window.spec)}`).toEqual(ROW_KEYS);
      expect(Object.keys(row.aggregate as Record<string, unknown>), `${label}: aggregate`).toEqual(AGGREGATE_KEYS);
    }
  }
}

async function connectMcp(deps: AppDeps): Promise<Client> {
  const app = createApp(deps);
  const client = new Client({ name: "bryce-card-contract-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://bryce.local/mcp"), {
    fetch: async (url, init) => app.request(url.toString(), init),
    requestInit: { headers: AUTH },
  });
  await client.connect(transport);
  return client;
}

describe("Player Card JSON contract", () => {
  let opened: OpenedDb;
  let deps: AppDeps;
  let clock: ReturnType<typeof fakeClock>;
  let playerId: number;

  beforeEach(async () => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    deps = testAppDeps(opened, { mailer: new CapturingMailer(), now: clock.now, tz: TEST_TZ });
    await insertCalendars2026(opened.db);
    // A TWO-WAY player across TWO levels: every window therefore carries both a
    // batting and a pitching row, so the per-row assertions above are never vacuous.
    const player = await insertPlayer(opened.db, { fullName: "Contract Twoway", position: "P" });
    playerId = player.id;
    for (const [gameId, sportId, date] of [[701, 1, "2026-07-18"], [702, 11, "2026-07-17"]] as const) {
      await insertStatLine(opened.db, { playerId, source: "mlb_stats_api", gameId, gameDate: date, sportId, stats: { hits: 1, atBats: 3 } });
      await insertStatLine(opened.db, {
        playerId, source: "mlb_stats_api", gameId, gameDate: date, sportId, statType: "pitching",
        stats: { inningsPitched: "6.0", earnedRuns: 2, strikeOuts: 7, gamesStarted: 1, wins: 1 },
      });
    }
  });

  afterEach(() => {
    opened.close();
  });

  it("pins the same key set and key order on all four JSON surfaces", async () => {
    const lines: string[] = [];
    // `--format json` is EXPLICIT here: the CLI's default flipped to `console`
    // (ADR 0055), and `json` remains the machine contract on every surface.
    const cliCode = await runReportCli(["--id", String(playerId), "--windows", "last10,ytd", "--format", "json"], {
      db: opened.db,
      now: clock.now,
      tz: TEST_TZ,
      write: (line) => lines.push(line),
    });
    expect(cliCode).toBe(0);
    const cli = JSON.parse(lines[0]!) as JsonCard;
    assertCardShape(cli, "CLI stdout");

    const client = await connectMcp(deps);
    try {
      const mcp = await client.callTool({ name: "report_player", arguments: { id: playerId, windows: ["last10", "ytd"], format: "json" } }) as { structuredContent?: JsonCard };
      assertCardShape(mcp.structuredContent!, "MCP structuredContent");
      // Byte-for-byte across the two surfaces: a key added to only one of them
      // would pass both shape assertions above and still be a divergence.
      expect(JSON.stringify(mcp.structuredContent)).toBe(JSON.stringify(cli));
    } finally {
      await client.close();
    }

    const byId = await createApp(deps).request(`/api/reports/player/${playerId}?windows=last10,ytd`, { headers: AUTH });
    expect(byId.status).toBe(200);
    const restById = (await byId.json()) as JsonCard;
    assertCardShape(restById, "REST /reports/player/:id");
    expect(JSON.stringify(restById)).toBe(JSON.stringify(cli));

    const byName = await createApp(deps).request("/api/reports/player?name=Contract%20Twoway&windows=last10,ytd", { headers: AUTH });
    expect(byName.status).toBe(200);
    const restByName = (await byName.json()) as JsonCard;
    assertCardShape(restByName, "REST /reports/player?name=");
    expect(JSON.stringify(restByName)).toBe(JSON.stringify(cli));
  });
});
