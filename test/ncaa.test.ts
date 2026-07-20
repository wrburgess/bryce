import { describe, expect, it, vi } from "vitest";
import {
  NcaaApiError,
  NcaaClient,
  UnsupportedNcaaSeasonError,
  buildGameLogUrl,
} from "../src/ncaa/client.js";
import { fnv1a31, normalizeGameLog } from "../src/ncaa/normalize.js";
import { parseGameLogPage } from "../src/ncaa/parse.js";
import { ncaaSeasonFor } from "../src/ncaa/seasons.js";
import {
  FakeNcaaApi,
  fakeNcaaClient,
  loadNcaaFixture,
  makeNcaaGameLogHtml,
} from "./factories.js";

describe("NCAA parser (constructed fixtures, faithful to the reference table)", () => {
  it("extracts batting rows with contest ids and header-keyed stats", () => {
    const page = parseGameLogPage(loadNcaaFixture("gamelog_batting.html"));
    expect(page.fullName).toBe("Wyatt Langford");
    expect(page.schoolName).toBe("Florida");
    // Three game rows; the season-totals row is excluded.
    expect(page.rows).toHaveLength(3);

    const first = page.rows[0];
    expect(first?.date).toBe("2025-03-14");
    expect(first?.opponentName).toBe("Georgia");
    expect(first?.isHome).toBe(true);
    expect(first?.contestId).toBe(5101);
    expect(first?.stats).toMatchObject({ AB: 4, H: 2, HR: 1, RBI: 3 });
  });

  it("extracts pitching rows with IP kept as a string", () => {
    const page = parseGameLogPage(loadNcaaFixture("gamelog_pitching.html"));
    expect(page.fullName).toBe("Paul Skenes");
    expect(page.schoolName).toBe("LSU");
    expect(page.rows).toHaveLength(2);
    const first = page.rows[0];
    expect(first?.stats.IP).toBe("6.0"); // non-integer stays a string
    expect(first?.stats).toMatchObject({ H: 4, ER: 1, SO: 8, W: 1 });
    expect(first?.isHome).toBe(true);
    const second = page.rows[1];
    expect(second?.isHome).toBe(false); // "@" away
    expect(second?.opponentName).toBe("Alabama");
  });

  it("reads a doubleheader as two rows, same date, distinct contest ids", () => {
    const page = parseGameLogPage(loadNcaaFixture("gamelog_batting.html"));
    const march15 = page.rows.filter((r) => r.date === "2025-03-15");
    expect(march15).toHaveLength(2);
    expect(new Set(march15.map((r) => r.contestId)).size).toBe(2);
  });

  it("excludes the season-totals row", () => {
    const page = parseGameLogPage(loadNcaaFixture("gamelog_batting.html"));
    expect(page.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))).toBe(true);
    expect(page.rows.some((r) => r.opponentName === "")).toBe(false);
  });

  it("throws loudly on a malformed/shifted table (missing expected columns)", () => {
    const broken =
      "<html><head><title>Guy</title></head><body>" +
      '<div class="card-header"><a href="/teams/1">School</a></div>' +
      "<table><thead><tr><th>Foo</th><th>Bar</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table></body></html>";
    expect(() => parseGameLogPage(broken)).toThrow(/game-log table/);
  });

  it("throws when the school cannot be extracted", () => {
    const noSchool =
      "<html><head><title>Guy</title></head><body>" +
      '<table id="game_by_game"><thead><tr><th>Date</th><th>Opponent</th><th>Result</th></tr>' +
      "</thead><tbody></tbody></table></body></html>";
    expect(() => parseGameLogPage(noSchool)).toThrow(/school/);
  });

  it("yields a null contest id when the row has no box-score/contest anchor", () => {
    const html = makeNcaaGameLogHtml({
      fullName: "Zed Zero",
      schoolName: "Tech",
      rows: [{ date: "2025-03-14", opponentName: "Rival", isHome: true, contestId: null, stats: { AB: 3, H: 1 } }],
    });
    const page = parseGameLogPage(html);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.contestId).toBeNull();
    expect(page.rows[0]?.opponentName).toBe("Rival");
  });
});

describe("NCAA normalizer", () => {
  it("maps rows to Stat Line rows (sportId 22, statType, raw)", () => {
    const rows = parseGameLogPage(loadNcaaFixture("gamelog_batting.html")).rows;
    const normalized = normalizeGameLog({
      playerId: 7,
      seq: 2649785,
      category: "batting",
      rows,
      timestamp: "2025-03-16T00:00:00.000Z",
    });
    expect(normalized).toHaveLength(3);
    const first = normalized[0];
    expect(first?.playerId).toBe(7);
    expect(first?.sportId).toBe(22);
    expect(first?.statType).toBe("batting");
    expect(first?.gameId).toBe(5101); // contest id preferred
    expect(first?.teamName).toBeNull();
    expect(first?.leagueName).toBeNull();
    expect((first?.raw as { gameIdSource: string }).gameIdSource).toBe("contest");
  });

  it("assigns 1-based game numbers within a date (doubleheader)", () => {
    const rows = parseGameLogPage(loadNcaaFixture("gamelog_batting.html")).rows;
    const normalized = normalizeGameLog({
      playerId: 7,
      seq: 2649785,
      category: "batting",
      rows,
      timestamp: "t",
    });
    const march15 = normalized.filter((r) => r.gameDate === "2025-03-15");
    expect(march15.map((r) => r.gameNumber).sort()).toEqual([1, 2]);
  });

  it("canonicalizes batting headers to the renderer's stat keys", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: true,
        contestId: 6001,
        result: "W",
        stats: { AB: 4, H: 2, HR: 1, "2B": 1, "3B": 0, RBI: 3, BB: 1, K: 2, SB: 1, Pos: "SS", CS: "-" },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    expect(line?.stats).toMatchObject({
      atBats: 4,
      hits: 2,
      homeRuns: 1,
      doubles: 1,
      triples: 0,
      rbi: 3,
      baseOnBalls: 1,
      strikeOuts: 2,
      stolenBases: 1,
    });
    // Unmapped headers pass through under their page name; non-numeric cells
    // produce no canonical entry (renderer reads 0, not NaN).
    expect(line?.stats).toMatchObject({ Pos: "SS" });
    expect(line?.stats).not.toHaveProperty("caughtStealing");
    // The page's original header-keyed cells stay available in raw.
    expect((line?.raw as { stats: Record<string, unknown> }).stats).toMatchObject({ AB: 4, K: 2 });
  });

  it("canonicalizes pitching headers, keeping inningsPitched a string (SO and K both map)", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: false,
        contestId: 6002,
        result: "W",
        stats: { IP: "6.1", H: 4, ER: 2, BB: 1, SO: 8, W: 1, L: 0, SV: 0 },
      },
      {
        date: "2025-03-21",
        opponentName: "Rival",
        isHome: false,
        contestId: 6003,
        result: "L",
        stats: { IP: 7, H: 5, ER: 3, BB: 2, K: 6 },
      },
    ];
    const normalized = normalizeGameLog({ playerId: 1, seq: 42, category: "pitching", rows, timestamp: "t" });
    expect(normalized[0]?.stats).toMatchObject({
      inningsPitched: "6.1",
      hits: 4,
      earnedRuns: 2,
      baseOnBalls: 1,
      strikeOuts: 8,
      wins: 1,
      losses: 0,
      saves: 0,
    });
    // An integer-coerced IP cell is stringified; the K header is the SO alias.
    expect(normalized[1]?.stats).toMatchObject({ inningsPitched: "7", strikeOuts: 6 });
  });

  it("drops non-numeric IP and empty cells instead of leaking '-' or coercing '' to 0", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: null,
        contestId: 6004,
        result: "W",
        stats: { IP: "-", H: "", ER: "  ", BB: 1, SO: 3 },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "pitching", rows, timestamp: "t" });
    // "-" IP gets no entry → the renderer falls back to "0.0 IP", never "- IP".
    expect(line?.stats).not.toHaveProperty("inningsPitched");
    // Empty / whitespace cells get no entry (never Number("") === 0).
    expect(line?.stats).not.toHaveProperty("hits");
    expect(line?.stats).not.toHaveProperty("earnedRuns");
    expect(line?.stats).toMatchObject({ baseOnBalls: 1, strikeOuts: 3 });
  });

  it("canonicalizes fielding headers: E becomes errors, PO/A pass through", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: true,
        contestId: 6005,
        result: "W",
        stats: { PO: 2, A: 3, E: 1, "FLD%": ".833" },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "fielding", rows, timestamp: "t" });
    expect(line?.statType).toBe("fielding");
    expect(line?.stats).toMatchObject({ errors: 1, PO: 2, A: 3 });
    expect(line?.stats).not.toHaveProperty("E");
  });

  it("derives PA from AB + BB + HBP + SF + SH when the page has no PA column", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: true,
        contestId: 6006,
        result: "W",
        stats: { AB: 4, BB: 1, HBP: 1, SF: 1, H: 2 },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    expect(line?.stats).toMatchObject({ plateAppearances: 7 });
  });

  it("derives PA from only the components present (AB + BB)", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: false,
        contestId: 6007,
        result: "L",
        stats: { AB: 3, BB: 1, H: 1 },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    expect(line?.stats).toMatchObject({ plateAppearances: 4 });
  });

  it("maps a PA header directly and never overrides it with the derived sum", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: true,
        contestId: 6008,
        result: "W",
        stats: { PA: 5, AB: 3, BB: 1 },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    expect(line?.stats).toMatchObject({ plateAppearances: 5 });
  });

  it("derives no PA when a batting row carries none of the components", () => {
    const rows = [
      {
        date: "2025-03-14",
        opponentName: "Rival",
        isHome: true,
        contestId: 6009,
        result: "W",
        stats: { Pos: "SS" },
      },
    ];
    const [line] = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    expect(line?.stats).not.toHaveProperty("plateAppearances");
  });

  it("uses a stable hash fallback when the contest id is missing", () => {
    const rows = [
      { date: "2025-03-14", opponentName: "Rival", isHome: true, contestId: null, result: "W", stats: { AB: 3 } },
      { date: "2025-03-14", opponentName: "Rival", isHome: true, contestId: null, result: "L", stats: { AB: 4 } },
    ];
    const a = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t" });
    const b = normalizeGameLog({ playerId: 1, seq: 42, category: "batting", rows, timestamp: "t2" });
    // Deterministic: same input → same ids across runs.
    expect(a.map((r) => r.gameId)).toEqual(b.map((r) => r.gameId));
    // The two same-date games get DIFFERENT ids (row index folds into the hash).
    expect(a[0]?.gameId).not.toBe(a[1]?.gameId);
    expect((a[0]?.raw as { gameIdSource: string }).gameIdSource).toBe("hash");
  });

  it("fnv1a31 is deterministic and stays a positive 31-bit integer", () => {
    const h = fnv1a31("42|2025-03-14|Rival|0");
    expect(h).toBe(fnv1a31("42|2025-03-14|Rival|0"));
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(0x7fffffff);
    expect(fnv1a31("a")).not.toBe(fnv1a31("b"));
  });
});

describe("NCAA client", () => {
  it("builds the legacy game_by_game URL with the season/category ids", () => {
    const season = ncaaSeasonFor("2025");
    expect(season).not.toBeNull();
    const url = buildGameLogUrl({ seq: 2649785, season: season!, category: "batting" });
    expect(url).toContain("https://stats.ncaa.org/player/game_by_game?");
    expect(url).toContain("game_sport_year_ctl_id=16840");
    expect(url).toContain("stats_player_seq=2649785");
    expect(url).toContain("year_stat_category_id=15687");
    // org_id omitted when the school is unknown.
    expect(url).not.toContain("org_id");
  });

  it("builds the fielding game-log URL with the bundled fielding category id", () => {
    const season = ncaaSeasonFor("2025");
    expect(season).not.toBeNull();
    const url = buildGameLogUrl({ seq: 2649785, season: season!, category: "fielding" });
    expect(url).toContain("year_stat_category_id=15689");
    expect(url).toContain("game_sport_year_ctl_id=16840");
  });

  it("sends the full browser header set on the request", async () => {
    const api = new FakeNcaaApi({
      pages: { "2649785:batting": makeNcaaGameLogHtml({ fullName: "A", schoolName: "B", rows: [] }) },
    });
    await fakeNcaaClient(api).getGameLogPage(2649785, "2025", "batting");
    const sent = api.headers[0] ?? {};
    expect(sent["User-Agent"]).toContain("Mozilla/5.0");
    expect(sent["Accept-Language"]).toBe("en-US,en;q=0.9");
    expect(sent["Sec-Fetch-Mode"]).toBe("navigate");
  });

  it("applies the polite delay between consecutive calls (fake clock)", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const client = new NcaaClient({
        fetchImpl: (url) => {
          calls.push(url);
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<html></html>") });
        },
        delayMs: 3000,
      });

      await client.getGameLogPage(2649785, "2025", "batting").catch(() => undefined);
      expect(calls).toHaveLength(1);

      let done = false;
      const second = client.getGameLogPage(2649785, "2025", "pitching").catch(() => undefined).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(done).toBe(false);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws NcaaApiError on a non-200 response", async () => {
    const api = new FakeNcaaApi({ status: 403 });
    const promise = fakeNcaaClient(api).getGameLogPage(2649785, "2025", "batting");
    await expect(promise).rejects.toBeInstanceOf(NcaaApiError);
    await promise.catch((err: unknown) => expect((err as NcaaApiError).status).toBe(403));
  });

  it("throws UnsupportedNcaaSeasonError for a year with no bundled lookup", async () => {
    const api = new FakeNcaaApi();
    await expect(
      fakeNcaaClient(api).getGameLogPage(2649785, "2099", "batting"),
    ).rejects.toBeInstanceOf(UnsupportedNcaaSeasonError);
  });
});
