import { describe, expect, it } from "vitest";
import type { DigestAssembly, DigestRow } from "../src/digest/assemble.js";
import { renderDigest, renderHeartbeat } from "../src/digest/render.js";
import type { WindowSpec } from "../src/domain/window.js";
import { resolveWindow } from "../src/domain/window.js";
import { aggregate } from "../src/stats/aggregate.js";
import { TEST_TZ } from "./factories.js";

/** 2026-07-20 in America/Chicago, so 1d resolves to 07-19 and 7d to 07-13..07-19. */
const RUN_AT = new Date("2026-07-20T17:00:00Z");
const SEASON_START = "2026-03-25";

function row(
  fullName: string,
  statType: "batting" | "pitching",
  splits: Array<Record<string, unknown>>,
  overrides: Partial<DigestRow> = {},
): DigestRow {
  return {
    player: {
      fullName,
      level: "mlb",
      milbLevel: null,
      teamName: "Philadelphia Phillies",
      schoolName: null,
    },
    lvl: "MLB",
    lvlRank: 0,
    gameNumber: null,
    agg: aggregate(statType, splits),
    qualityStarts: 0,
    ...overrides,
  };
}

function assemblyWith(args: {
  spec: WindowSpec;
  batters?: DigestRow[];
  pitchers?: DigestRow[];
}): DigestAssembly {
  const batters = args.batters ?? [];
  const pitchers = args.pitchers ?? [];
  return {
    window: resolveWindow(args.spec, RUN_AT, TEST_TZ, SEASON_START),
    batters,
    pitchers,
    playerCount: batters.length + pitchers.length,
    statLineCount: [...batters, ...pitchers].reduce((n, r) => n + r.agg.games, 0),
  };
}

const harper7d = row("Bryce Harper", "batting", [
  { atBats: 4, hits: 2, doubles: 1, totalBases: 3, plateAppearances: 5, baseOnBalls: 1, rbi: 2 },
  { atBats: 4, hits: 1, homeRuns: 1, totalBases: 4, plateAppearances: 4, strikeOuts: 2, rbi: 1 },
]);

const wheeler7d = row(
  "Zack Wheeler",
  "pitching",
  [
    { inningsPitched: "6.1", earnedRuns: 2, strikeOuts: 8, baseOnBalls: 1, hits: 4 },
    { inningsPitched: "6.2", earnedRuns: 2, strikeOuts: 8, baseOnBalls: 2, hits: 5 },
  ],
  { qualityStarts: 2 },
);

const idleRow = row("Idle Player", "batting", []);

describe("renderDigest — tables", () => {
  it("renders a Batters table with a Lvl column and no level sections", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [harper7d] }));
    expect(mail.text).toContain("Batters");
    expect(mail.text).toMatch(/Player\s+Lvl\s+GP\s+Batting/);
    expect(mail.text).not.toContain("MiLB - Triple-A");
    expect(mail.text).toContain("MLB");
  });

  it("omits GP and adds Gm for a 1d window", () => {
    const penaGm1 = row("Yohandy Pena", "batting", [{ atBats: 3, plateAppearances: 3 }], {
      lvl: "DSL",
      gameNumber: 1,
    });
    const penaGm2 = row("Yohandy Pena", "batting", [{ atBats: 4, hits: 2, plateAppearances: 4 }], {
      lvl: "DSL",
      gameNumber: 2,
    });
    const mail = renderDigest(assemblyWith({ spec: "1d", batters: [penaGm1, penaGm2] }));
    expect(mail.text).toMatch(/Player\s+Lvl\s+Gm\s+PA/);
    expect(mail.text).not.toMatch(/\bGP\b/);
    // No Batting column either: a one-game slash line is noise beside the raw
    // counts already on the row.
    expect(mail.text).not.toContain("Batting");
  });

  it("leaves Gm blank for a player who played once in a 1d window", () => {
    const mail = renderDigest(
      assemblyWith({ spec: "1d", batters: [row("Bryce Harper", "batting", [{ atBats: 4 }])] }),
    );
    const dataLine = mail.text.split("\n").find((l) => l.includes("B Harper"));
    expect(dataLine).toMatch(/^B Harper\s+MLB\s+4\b/);
  });

  it("renders a zero row as .000/.000/.000 rather than a dash", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [idleRow] }));
    expect(mail.text).toContain(".000/.000/.000");
    const dataLine = mail.text.split("\n").find((l) => l.includes("I Player"));
    expect(dataLine).toContain(" 0 ");
  });

  it("derives the slash line from summed counters, never by averaging games", () => {
    // 3-for-4 then 0-for-1: summed is .600, averaged would be .375.
    const uneven = row("Sum Test", "batting", [
      { atBats: 4, hits: 3, totalBases: 3 },
      { atBats: 1, hits: 0, totalBases: 0 },
    ]);
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [uneven] }));
    expect(mail.text).toContain(".600/.600/.600");
    expect(mail.text).not.toContain(".375");
  });

  it("renders quality starts as a count", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", pitchers: [wheeler7d] }));
    expect(mail.text).toMatch(/\s2\s*$/m);
    const dataLine = mail.text.split("\n").find((l) => l.includes("Z Wheeler"));
    expect(dataLine?.trimEnd().endsWith("2")).toBe(true);
  });

  it("sums innings through outs and renders baseball notation", () => {
    // 6.1 + 6.2 is 13.0, not 12.3.
    const mail = renderDigest(assemblyWith({ spec: "7d", pitchers: [wheeler7d] }));
    const dataLine = mail.text.split("\n").find((l) => l.includes("Z Wheeler"));
    expect(dataLine).toContain("13.0");
  });

  it("derives ERA, WHIP and K/9 from the summed outs", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", pitchers: [wheeler7d] }));
    const dataLine = mail.text.split("\n").find((l) => l.includes("Z Wheeler"));
    // 4 ER over 39 outs => 2.77; (3 BB + 9 H) over 13 IP => 0.92; 16 K => 11.08.
    expect(dataLine).toContain("2.77");
    expect(dataLine).toContain("0.92");
    expect(dataLine).toContain("11.08");
  });

  it("puts the window label in the subject", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d" }));
    expect(mail.subject).toContain("Last 7 Days");
    expect(mail.subject).toContain("Jul 13-19");
  });

  it("puts the single date in the subject for a 1d window", () => {
    const mail = renderDigest(assemblyWith({ spec: "1d" }));
    expect(mail.subject).toContain("Jul 19");
    expect(mail.subject).not.toContain("Last");
  });

  it("emits an HTML table, not a list", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [harper7d] }));
    expect(mail.html).toContain("<table");
    expect(mail.html).not.toContain("<ul>");
    expect(mail.html).toContain("<th");
    expect(mail.html).toContain("Lvl");
  });

  it("escapes player names in HTML", () => {
    const mail = renderDigest(
      assemblyWith({ spec: "7d", batters: [row("A <b>Hack</b>", "batting", [{ atBats: 1 }])] }),
    );
    expect(mail.html).not.toContain("<b>Hack</b>");
    expect(mail.html).toContain("&lt;b&gt;");
  });

  it("abbreviates the first name and leaves a single-word name alone", () => {
    const mail = renderDigest(
      assemblyWith({
        spec: "7d",
        batters: [row("Bryce Harper", "batting", []), row("Ichiro", "batting", [])],
      }),
    );
    expect(mail.text).toContain("B Harper");
    expect(mail.text).toContain("Ichiro");
    expect(mail.text).not.toContain("Bryce Harper");
  });

  it("aligns every text column under its header", () => {
    const mail = renderDigest(
      assemblyWith({
        spec: "7d",
        batters: [harper7d, row("A Verylongsurname", "batting", [{ atBats: 4, hits: 1 }])],
      }),
    );
    const lines = mail.text.split("\n");
    const header = lines.find((l) => l.startsWith("Player"))!;
    const paIndex = header.indexOf("PA");
    for (const name of ["B Harper", "A Verylongsurname"]) {
      const dataLine = lines.find((l) => l.startsWith(name))!;
      // Right-aligned numerics end where their header ends.
      expect(dataLine.length).toBeGreaterThan(paIndex);
      expect(dataLine[paIndex + 1]).toMatch(/\d/);
    }
  });

  it("omits a table with no rows entirely", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [harper7d] }));
    expect(mail.text).not.toContain("Pitchers");
    expect(mail.html).not.toContain("Pitchers");
  });

  it("renders both tables when both have rows", () => {
    const mail = renderDigest(
      assemblyWith({ spec: "7d", batters: [harper7d], pitchers: [wheeler7d] }),
    );
    expect(mail.text).toContain("Batters");
    expect(mail.text).toContain("Pitchers");
    expect(mail.text.indexOf("Batters")).toBeLessThan(mail.text.indexOf("Pitchers"));
  });

  it("still renders a window with no rows at all", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d" }));
    expect(mail.text).toContain("No games in this window.");
    expect(mail.html).toContain("No games in this window.");
  });
});

describe("renderHeartbeat", () => {
  it("keeps its shape", () => {
    const mail = renderHeartbeat({
      date: "2026-12-05",
      playerCount: 3,
      nextOpeningDay: "2027-03-26",
    });
    expect(mail.subject).toBe("Bryce heartbeat - 2026-12-05");
    expect(mail.text).toBe("alive; 3 players watched; games resume ~2027-03-26\n");
    expect(mail.html).toBe("<p>alive; 3 players watched; games resume ~2027-03-26</p>");
  });

  it("renders TBD when the next opening day is unpublished", () => {
    const mail = renderHeartbeat({ date: "2026-12-05", playerCount: 0, nextOpeningDay: null });
    expect(mail.text).toContain("games resume ~TBD");
  });
});
