import { describe, expect, it } from "vitest";
import {
  DEFAULT_CARD_WIDTH,
  NO_GAMES_LINE,
  renderPlayerCardHtml,
  renderPlayerCardText,
} from "../src/reports/player-card-render.js";
import type { PlayerCard, PlayerCardPlayer, PlayerCardRow, PlayerCardWindow, PlayerCardWindowSpec } from "../src/reports/player-card.js";
import { aggregate, deriveAllRates } from "../src/stats/aggregate.js";

/**
 * Player Card Presentations (#141 / ADR 0055): pure renderers, so these are pure
 * unit tests over hand-built cards — the `test/render.test.ts` style.
 *
 * A LOCAL builder rather than a shared factory: no fixture Card exists anywhere
 * in the suite, and `test/render.test.ts`'s `row()` is not reusable (a
 * `PlayerCardRow` has `aggregate`, not `agg`, and carries no `player`). Built
 * programmatically from real `aggregate` / `deriveAllRates` output, never a
 * static literal, so a change to the stat model reaches these tests
 * (rules/testing.md).
 */

function row(
  lvl: string,
  lvlRank: number,
  statType: "batting" | "pitching",
  splits: Array<Record<string, unknown>>,
  counts: Partial<Pick<PlayerCardRow, "qualityStarts" | "reliefWins" | "reliefLosses">> = {},
): PlayerCardRow {
  const agg = aggregate(statType, splits);
  return {
    lvl,
    lvlRank,
    aggregate: agg,
    rates: deriveAllRates(agg),
    qualityStarts: counts.qualityStarts ?? 0,
    reliefWins: counts.reliefWins ?? 0,
    reliefLosses: counts.reliefLosses ?? 0,
  };
}

function window(
  spec: PlayerCardWindowSpec,
  batters: PlayerCardRow[],
  pitchers: PlayerCardRow[],
  overrides: Partial<PlayerCardWindow> = {},
): PlayerCardWindow {
  const empty = batters.length === 0 && pitchers.length === 0;
  return {
    spec,
    requestedGames: spec === "last10" ? 10 : spec === "last30" ? 30 : null,
    actualGames: empty ? 0 : 4,
    from: empty ? null : "2026-07-14",
    to: empty ? null : "2026-07-18",
    empty,
    batters,
    pitchers,
    ...overrides,
  };
}

function card(windows: PlayerCardWindow[], player: Partial<PlayerCardPlayer> = {}): PlayerCard {
  return {
    player: {
      id: 42,
      fullName: "Maximo Acosta",
      level: "mlb",
      milbLevel: null,
      teamName: "Philadelphia Phillies",
      schoolName: null,
      ...player,
    },
    windows,
  };
}

/**
 * A TABLE DATA line for a level, anchored on "<Lvl> <digit>" so it can never
 * match the header meta line ("MLB - Philadelphia Phillies"), which also starts
 * with the level abbreviation and would otherwise pass these assertions for the
 * wrong reason.
 */
function dataLine(text: string, lvl: string): string {
  return text.split("\n").find((line) => new RegExp(`^${lvl}\\s+\\d`).test(line))!;
}

const BATTING_SPLIT = { atBats: 4, hits: 2, doubles: 1, homeRuns: 1, baseOnBalls: 1, strikeOuts: 1, rbi: 3, runs: 2, errors: 1 };
const PITCHING_SPLIT = { inningsPitched: "6.0", earnedRuns: 2, strikeOuts: 7, baseOnBalls: 1, hits: 4, homeRuns: 1 };

describe("Player Card console rendering", () => {
  it("renders a batter's card: header, window heading, one Batting table, no Pitching section", () => {
    const text = renderPlayerCardText(card([window("last10", [row("MLB", 0, "batting", [BATTING_SPLIT])], [])]));
    expect(text).toContain("Maximo Acosta");
    expect(text).toContain("MLB - Philadelphia Phillies");
    expect(text).toContain("Last 10 games - 4 games (Jul 14-18)");
    expect(text).toContain("Batting");
    // The absent section is OMITTED, not rendered as an empty headed table.
    expect(text).not.toContain("Pitching");
    // Content, not merely a heading: the counters actually reach the row.
    const headers = text.split("\n").find((line) => line.startsWith("Lvl"))!.split(/\s+/);
    const values = dataLine(text, "MLB").split(/\s+/);
    expect(values[headers.indexOf("H")]).toBe("2");
    expect(values[headers.indexOf("HR")]).toBe("1");
    expect(values[headers.indexOf("GP")]).toBe("1");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renders a pitcher's card with QS/RW/RL, and a two-way card with both sections", () => {
    const pitcher = renderPlayerCardText(
      card([window("last10", [], [row("MLB", 0, "pitching", [PITCHING_SPLIT], { qualityStarts: 1, reliefWins: 2, reliefLosses: 3 })])]),
    );
    expect(pitcher).toContain("Pitching");
    expect(pitcher).not.toContain("Batting");
    const headers = pitcher.split("\n").find((line) => line.includes("WHIP"))!.split(/\s+/);
    const values = dataLine(pitcher, "MLB").split(/\s+/);
    // Positional read-through: QS/RW/RL land under their OWN headers, so a
    // mis-ordered column set fails rather than passing on a substring match.
    expect(values[headers.indexOf("QS")]).toBe("1");
    expect(values[headers.indexOf("RW")]).toBe("2");
    expect(values[headers.indexOf("RL")]).toBe("3");
    expect(values[headers.indexOf("IP")]).toBe("6.0");

    const twoWay = renderPlayerCardText(
      card([window("last10", [row("MLB", 0, "batting", [BATTING_SPLIT])], [row("MLB", 0, "pitching", [PITCHING_SPLIT])])]),
    );
    expect(twoWay).toContain("Batting");
    expect(twoWay).toContain("Pitching");
    expect(twoWay.indexOf("Batting")).toBeLessThan(twoWay.indexOf("Pitching"));
  });

  it("renders a multi-level window in lvlRank order with a level break", () => {
    const rows = [row("MLB", 0, "batting", [BATTING_SPLIT]), row("AAA", 1, "batting", [BATTING_SPLIT])];
    const text = renderPlayerCardText(card([window("last10", rows, [])]));
    expect(text.indexOf(dataLine(text, "MLB"))).toBeLessThan(text.indexOf(dataLine(text, "AAA")));
    // The MLB/other-levels rule is drawn between them (mlbDividerIndex).
    const lines = text.split("\n");
    const mlbAt = lines.indexOf(dataLine(text, "MLB"));
    const aaaAt = lines.indexOf(dataLine(text, "AAA"));
    expect(lines.slice(mlbAt + 1, aaaAt).some((line) => /^-{3,}$/.test(line))).toBe(true);
  });

  it("renders an empty window as an explicit line, never a blank table", () => {
    const text = renderPlayerCardText(card([window("last10", [], [])]));
    expect(text).toContain("Last 10 games - 0 games");
    expect(text).toContain(NO_GAMES_LINE);
    expect(text).not.toContain("Batting");
    expect(text).not.toContain("Pitching");
    expect(text).not.toContain("Lvl");
  });

  it("shows BB%/K% on last30 and ytd, and withholds them on last10", () => {
    const batting = [row("MLB", 0, "batting", [BATTING_SPLIT])];
    expect(renderPlayerCardText(card([window("last10", batting, [])]))).not.toContain("BB%");
    for (const spec of ["last30", "ytd"] as const) {
      const text = renderPlayerCardText(card([window(spec, batting, [])]));
      expect(text, spec).toContain("BB%");
      expect(text, spec).toContain("K%");
    }
  });

  it("leaves hostile and non-ASCII text literal in the console rendering", () => {
    // \uXXXX escapes, so the SOURCE cannot silently collapse NFD/NFC and defeat
    // the assertion (the accented name is composed NFC: Acun~a -> Acuña).
    const hostile = card([window("last10", [row("MLB", 0, "batting", [BATTING_SPLIT])], [])], {
      fullName: "Ronald Acu\u00F1a <b>Jr.</b>",
      teamName: 'Braves & "Co"',
    });
    const text = renderPlayerCardText(hostile);
    expect(text).toContain("Ronald Acu\u00F1a <b>Jr.</b>");
    expect(text).toContain('Braves & "Co"');
    // NOT ASCII-folded, and NOT HTML-escaped: this is a terminal, not a document.
    expect(text).not.toContain("Acuna");
    expect(text).not.toContain("&amp;");
  });

  it("survives an unknown width and a narrow width without corrupting table alignment", () => {
    const rows = [row("MLB", 0, "batting", [BATTING_SPLIT]), row("AAA", 1, "batting", [BATTING_SPLIT])];
    const wide = renderPlayerCardText(card([window("last10", rows, [])]));
    const narrow = renderPlayerCardText(card([window("last10", rows, [])]), { width: 12 });
    const tableLines = (text: string): string[] => [dataLine(text, "MLB"), dataLine(text, "AAA")];
    // Width sizes the header rule ONLY; every data line is byte-identical.
    expect(tableLines(narrow)).toEqual(tableLines(wide));
    const ruleOf = (text: string): string => text.split("\n").find((line) => /^={2,}$/.test(line))!;
    expect(ruleOf(narrow).length).toBe(12);
    expect(ruleOf(wide).length).toBeLessThanOrEqual(DEFAULT_CARD_WIDTH);
    // A redirected pipe passes `undefined` explicitly; that must not throw or
    // produce a zero-width rule.
    expect(ruleOf(renderPlayerCardText(card([window("last10", rows, [])]), { width: undefined })).length).toBeGreaterThan(0);
  });
});

describe("Player Card HTML rendering", () => {
  const twoWindow = card([
    window("last10", [row("MLB", 0, "batting", [BATTING_SPLIT])], []),
    window("ytd", [], [row("AAA", 1, "pitching", [PITCHING_SPLIT], { qualityStarts: 2 })]),
  ]);

  it("renders a standalone document with a title, one section per window, and the right tables", () => {
    const html = renderPlayerCardHtml(twoWindow);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>Maximo Acosta - Player Card</title>");
    expect(html).toContain("<h1>Maximo Acosta</h1>");
    expect(html).toContain('<p class="player-meta">MLB - Philadelphia Phillies</p>');
    expect(html.match(/<section class="card-window">/g)).toHaveLength(2);
    expect(html).toContain("<h2>Last 10 games - 4 games (Jul 14-18)</h2>");
    expect(html).toContain("<h2>Year to date - 4 games (Jul 14-18)</h2>");
    expect(html).toContain("<h3>Batting</h3>");
    expect(html).toContain("<h3>Pitching</h3>");
    // ytd is a long window, so its batting section would carry BB%/K% — but it
    // has no batting rows, so the section is omitted rather than empty.
    expect(html.match(/<h3>Batting<\/h3>/g)).toHaveLength(1);
  });

  it("carries NO inline style attributes — classes plus one <style> block", () => {
    const html = renderPlayerCardHtml(twoWindow);
    // The rule this asserts (rules/frontend.md) applies to a standalone
    // document; the Digest's email body is the documented exception, asserted
    // in the opposite direction below.
    expect(html).not.toContain("style=");
    expect(html).toContain('class="ta-left"');
    expect(html).toContain('class="ta-right"');
    expect(html).toContain("<style>");
    expect(html).toContain(".ta-right{text-align:right}");
  });

  it("carries a @media print block with page breaks and repeating headers", () => {
    const html = renderPlayerCardHtml(twoWindow);
    expect(html).toContain("@media print{");
    // The three properties ADR 0055 names as the PDF replacement.
    expect(html).toContain("page-break-after:always");
    expect(html).toContain("thead{display:table-header-group}");
    expect(html).toContain("body{margin:0;color:#000;background:#fff}");
  });

  it("escapes every dynamic value — name, team, and the <title> — not only the name", () => {
    const hostile = card([window("last10", [row("MLB", 0, "batting", [BATTING_SPLIT])], [])], {
      fullName: 'Ronald Acu\u00F1a <script>alert("x")</script>',
      teamName: 'Braves & "Co" <b>',
      milbLevel: "A+ <hr>",
    });
    const html = renderPlayerCardHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<hr>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    // The <title> is interpolated OUTSIDE htmlTable, so it escapes nothing by
    // construction unless htmlDocument owns it — this is that assertion.
    expect(html).toContain("<title>Ronald Acu\u00F1a &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; - Player Card</title>");
    // Accents survive unfolded: this is a UTF-8 document (ADR 0041 / 0047).
    expect(html).toContain("Acu\u00F1a");
    expect(html).not.toContain("Acuna");
  });

  it("renders an empty window as an explicit paragraph, never a blank table", () => {
    const html = renderPlayerCardHtml(card([window("last10", [], [])]));
    expect(html).toContain(`<p class="empty-window">${NO_GAMES_LINE}</p>`);
    expect(html).not.toContain("<table");
  });

  it("draws a class-based level divider between MLB and non-MLB rows", () => {
    const rows = [row("MLB", 0, "batting", [BATTING_SPLIT]), row("AAA", 1, "batting", [BATTING_SPLIT])];
    const html = renderPlayerCardHtml(card([window("last10", rows, [])]));
    expect(html).toContain('class="level-divider"');
    expect(html).toContain("<hr />");
    expect(html).toContain("td.level-divider hr{border:none");
  });

  it("shows BB%/K% headers per window, exactly as the console rendering does", () => {
    const batting = [row("MLB", 0, "batting", [BATTING_SPLIT])];
    expect(renderPlayerCardHtml(card([window("last10", batting, [])]))).not.toContain("BB%");
    expect(renderPlayerCardHtml(card([window("last30", batting, [])]))).toContain("BB%");
    expect(renderPlayerCardHtml(card([window("ytd", batting, [])]))).toContain("K%");
  });
});
