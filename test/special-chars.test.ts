import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { AppDeps } from "../src/server.js";
import { createApp } from "../src/server.js";
import { statLinesToCsv } from "../src/export/tabular.js";
import type { StatLineView } from "../src/queries/statLines.js";
import { insertPlayer, TEST_API_TOKEN, testAppDeps, testDb } from "./factories.js";

/*
 * #65 / ADR 0039 — the executable fidelity spec. A name carrying non-ASCII
 * letters or punctuation must round-trip byte-for-byte through every surface
 * that echoes a stored name. Fixtures are forced to NFC (the canonical stored
 * form) so they do not depend on the source literal's byte form (Reviewer SC4),
 * and the accent sits in a RETAINED token so the digest's by-design first-name
 * abbreviation does not drop it (Reviewer MF1).
 */
const ACUNA = "Ronald Acuña Jr.".normalize("NFC");
const PENA = "Wily Peña".normalize("NFC");
const OREILLY = "Shane O'Reilly"; // apostrophe, pure ASCII otherwise
const KANA = "Ichiro 鈴木".normalize("NFC"); // East-Asian wide glyphs
const FIXTURES = [ACUNA, PENA, OREILLY, KANA];

const AUTH = { Authorization: `Bearer ${TEST_API_TOKEN}` };

describe("special characters in player names round-trip intact (#65 / ADR 0039)", () => {
  let opened: OpenedDb;
  let deps: AppDeps;
  const app = () => createApp(deps);

  beforeEach(async () => {
    opened = testDb();
    deps = testAppDeps(opened);
    for (const fullName of FIXTURES) {
      await insertPlayer(opened.db, { fullName, level: "mlb", milbLevel: null });
    }
  });

  afterEach(() => {
    opened.close();
  });

  it("REST GET /api/players returns every name byte-identical", async () => {
    const res = await app().request("/api/players", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { players: Array<{ fullName: string }> };
    const names = body.players.map((p) => p.fullName);
    for (const fixture of FIXTURES) {
      expect(names).toContain(fixture);
    }
  });

  it("MCP watchlist_list returns every name byte-identical", async () => {
    const client = new Client({ name: "special-chars-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://bryce.local/mcp"), {
      fetch: async (url, init) => app().request(url.toString(), init),
      requestInit: { headers: { Authorization: `Bearer ${TEST_API_TOKEN}` } },
    });
    await client.connect(transport);
    try {
      const result = (await client.callTool({ name: "watchlist_list", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      // The tool returns its payload as a JSON text part; a byte-identical name
      // appears verbatim in it (JSON.stringify does not escape non-ASCII).
      const text = result.content.map((c) => c.text).join("");
      for (const fixture of FIXTURES) {
        expect(text).toContain(fixture);
      }
    } finally {
      await client.close();
    }
  });

  it("CSV export preserves every name (RFC-4180 quoting, no formula-guard corruption)", () => {
    const rows: StatLineView[] = FIXTURES.map((playerName, i) => ({
      id: i + 1,
      playerId: i + 1,
      playerName,
      level: "mlb",
      milbLevel: null,
      gameId: 900000 + i,
      statType: "batting",
      gameDate: "2026-07-18",
      gameNumber: 1,
      gameType: "R",
      isHome: true,
      opponentName: "Rivals",
      teamName: "Team",
      sportId: 1,
      leagueName: "MLB",
      stats: { hits: 1, atBats: 4 },
    }));
    const csv = statLinesToCsv(rows);
    for (const fixture of FIXTURES) {
      expect(csv).toContain(fixture);
    }
    // None of these names is a formula lead, so none is prefixed with a guard "'".
    expect(csv).not.toContain("'Ronald");
    expect(csv).not.toContain("'Shane");
  });
});
