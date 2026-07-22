# Windowed Digest Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the Digest from novelty selection to window selection, render it as Batters/Pitchers tables, and expose `--window` on the CLI, REST, and MCP surfaces.

**Architecture:** `assembleDigest` stops asking "which lines are unreported?" and starts asking "which lines fall in this window?", grouping by `(player, level)` or by game. `renderDigest` becomes a table renderer. `runDigest` keeps its whole claim → send → settle flow but stops stamping lines and loses the replay plumbing that existed only to protect that stamping. `stat_lines.digest_delivery_id` is dropped.

**Tech Stack:** TypeScript, drizzle-orm, drizzle-kit (migrations), Hono (REST), MCP SDK, Vitest.

## Global Constraints

- **Depends on both prior plans.** `2026-07-20-timezone-config-key.md` must land first (host dates are now the content), and `2026-07-20-aggregation-core.md` supplies `aggregate`, `deriveRate`, `resolveWindow`.
- **Regular season only.** Every window filters `game_type` to `"R"`.
- **A report writes nothing to `stat_lines`.** Window selection consumes nothing; re-running a window is always safe.
- **`digest_deliveries` behavior is unchanged** — mutual exclusion, the lease, stale-claim recovery, provider reconciliation, and the offseason heartbeat all stay (ADR 0034).
- Level comes from `stat_lines.sport_id`, never `players.level`.
- Quality gate: `npm run typecheck`, `npm run lint`, `npm test`, `ruby scripts/parity_check.rb`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Change |
|---|---|
| `src/mlb/levels.ts` | Add `levelAbbrev` and `levelRank` |
| `src/digest/assemble.ts` | Window selection, `(player, level)` grouping, error merge, quality-start count |
| `src/digest/render.ts` | Batters/Pitchers tables in text and HTML |
| `src/jobs/digest.ts` | Accept a window spec; drop line stamping and replay plumbing |
| `src/jobs/delivery-claim.ts` | Drop `replayOfDeliveryId` and `reportedIds` |
| `src/db/schema.ts` + `drizzle/` | Drop `stat_lines.digest_delivery_id` |
| `src/cli/digest.ts` | Parse `--window` |
| `src/api/schemas.ts`, `src/api/routes.ts` | `window` query/body parameter |
| `src/mcp/server.ts` | `window` input on `digest_preview` and `send_digest` |
| `CONTEXT.md`, `docs/adr/` | Record the redefinition; supersede ADR 0030 |

---

### Task 1: Level abbreviation and sort rank

**Files:**
- Modify: `src/mlb/levels.ts`
- Test: `test/levels.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export function levelAbbrev(sportId: number, leagueName: string | null): string;
  export function levelRank(sportId: number): number;
  ```
  `levelAbbrev` returns `"MLB" | "AAA" | "AA" | "A+" | "A" | "DSL" | "R" | "NCAA" | "?"`.
  `levelRank` orders MLB first (0) through NCAA last; unknown sport ids sort last.

- [ ] **Step 1: Write the failing test**

Create `test/levels.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { levelAbbrev, levelRank } from "../src/mlb/levels.js";

describe("levelAbbrev", () => {
  it("abbreviates each rung of the ladder", () => {
    expect(levelAbbrev(1, "National League")).toBe("MLB");
    expect(levelAbbrev(11, "International League")).toBe("AAA");
    expect(levelAbbrev(12, "Southern League")).toBe("AA");
    expect(levelAbbrev(13, "South Atlantic League")).toBe("A+");
    expect(levelAbbrev(14, "Florida State League")).toBe("A");
    expect(levelAbbrev(22, null)).toBe("NCAA");
  });

  it("separates the Dominican Summer League from domestic complex leagues", () => {
    // sportId 16 covers every rookie/complex league, so only league_name tells
    // DSL apart from the ACL/FCL.
    expect(levelAbbrev(16, "Dominican Summer League")).toBe("DSL");
    expect(levelAbbrev(16, "Arizona Complex League")).toBe("R");
    expect(levelAbbrev(16, null)).toBe("R");
  });

  it("renders an unknown sport id without throwing", () => {
    expect(levelAbbrev(999, null)).toBe("?");
  });
});

describe("levelRank", () => {
  it("orders MLB first and NCAA last", () => {
    const ladder = [1, 11, 12, 13, 14, 16, 22];
    const ranks = ladder.map(levelRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(levelRank(1)).toBeLessThan(levelRank(11));
    expect(levelRank(16)).toBeLessThan(levelRank(22));
  });

  it("sorts an unknown sport id last", () => {
    expect(levelRank(999)).toBeGreaterThan(levelRank(22));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/levels.test.ts`
Expected: FAIL — `levelAbbrev is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/mlb/levels.ts`:

```typescript
/**
 * Display abbreviation for the level a GAME was played at (windowed Digest
 * spec). Derived from the stat line's sportId, never from players.level —
 * a player's level is where he is today, and a window can span a promotion.
 *
 * sportId 16 covers every rookie/complex league, so league_name is the only
 * thing separating the Dominican Summer League from the domestic complexes.
 */
const SPORT_ID_ABBREV: Record<number, string> = {
  1: "MLB",
  11: "AAA",
  12: "AA",
  13: "A+",
  14: "A",
  16: "R",
  [NCAA_SPORT_ID]: "NCAA",
};

const LADDER: readonly number[] = [1, 11, 12, 13, 14, 16, NCAA_SPORT_ID];

export function levelAbbrev(sportId: number, leagueName: string | null): string {
  if (sportId === 16 && leagueName === "Dominican Summer League") return "DSL";
  return SPORT_ID_ABBREV[sportId] ?? "?";
}

/** Sort rank: MLB first, NCAA last, unknown ids after everything. */
export function levelRank(sportId: number): number {
  const index = LADDER.indexOf(sportId);
  return index === -1 ? LADDER.length : index;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/levels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mlb/levels.ts test/levels.test.ts
git commit -m "$(cat <<'EOF'
Add level abbreviation and sort rank

Derived from the stat line's sportId, not players.level: a window can
span a promotion, and the row must say where the games were played.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Window-selected assembly

**Files:**
- Modify: `src/digest/assemble.ts` (full rewrite of `assembleDigest`; delete `previewDeliveryId`)
- Test: `test/digest-preview.test.ts` (rewrite)

**Interfaces:**
- Consumes: `aggregate` / `Aggregate` (`src/stats/aggregate.ts`), `resolveWindow` / `WindowSpec`
  (`src/domain/window.ts`), `levelAbbrev` / `levelRank` (Task 1), `qualityStart` / `ipToOuts`
  (`src/digest/rates.ts`).
- Produces:
  ```typescript
  export interface DigestRow {
    player: RenderPlayer;
    /** "MLB" | "AAA" | ... — from the stat line's sportId. */
    lvl: string;
    lvlRank: number;
    /** Game number for a 1d doubleheader row; null otherwise. */
    gameNumber: number | null;
    agg: Aggregate;
    /** Count of quality starts in the window; always 0 for batters. */
    qualityStarts: number;
  }
  export interface DigestAssembly {
    window: ResolvedWindow;
    batters: DigestRow[];
    pitchers: DigestRow[];
    playerCount: number;
    statLineCount: number;
  }
  export function assembleDigest(
    db: Db,
    deps: { now: () => Date; tz: string; spec: WindowSpec },
  ): Promise<DigestAssembly>;
  ```

**Three things this task must get right:**

1. **Regular season only** — `eq(statLines.gameType, "R")`.
2. **Fielding merges into batting** (ADR 0033). A fielding row's `errors` is added to the same
   `(player, game)` batting split before aggregation; a fielding row with no batting counterpart
   synthesizes an all-zero batting split carrying only `errors`. Fielding rows never form their own
   table.
3. **Quality starts are counted, not classified.** `QS` is not a source field — `qualityStart(outs,
   earnedRuns)` computes it per game. Count it here, while per-game rows are still in hand.

- [ ] **Step 1: Write the failing test**

Rewrite `test/digest-preview.test.ts` around this shape (keep the file's existing `testDb` /
`TEST_TZ` / clock helpers from `test/factories.ts`):

```typescript
describe("assembleDigest — window selection", () => {
  it("includes only lines inside the window", async () => {
    // Seed lines on 2026-07-12 (outside a 7d window ending 07-19) and 2026-07-15.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    expect(a.window.from).toBe("2026-07-13");
    expect(a.window.to).toBe("2026-07-19");
    expect(a.statLineCount).toBe(1);
  });

  it("excludes postseason games from every window", async () => {
    // Seed one gameType "R" and one gameType "D" on the same date.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    expect(a.statLineCount).toBe(1);
  });

  it("splits a promoted player into one row per level", async () => {
    // Seed the same player with sportId 11 and sportId 13 lines in one window.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "21d" });
    const rows = a.batters.filter((r) => r.player.fullName === "Walker Jenkins");
    expect(rows.map((r) => r.lvl).sort()).toEqual(["A+", "AAA"]);
  });

  it("renders a doubleheader as two rows in a 1d window", async () => {
    // Seed two games, same player, same date, gameNumber 1 and 2.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "1d" });
    expect(a.batters.map((r) => r.gameNumber)).toEqual([1, 2]);
  });

  it("folds a doubleheader into one row in a 7d window", async () => {
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    expect(a.batters).toHaveLength(1);
    expect(a.batters[0]?.agg.games).toBe(2);
    expect(a.batters[0]?.gameNumber).toBeNull();
  });

  it("merges fielding errors into the batting row and never makes a fielding table", async () => {
    // Seed a batting split and a fielding split for the same player and game.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    expect(a.batters[0]?.agg.counters.errors).toBe(1);
  });

  it("counts quality starts across the window", async () => {
    // Seed two 7.0 IP / 2 ER starts.
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    expect(a.pitchers[0]?.qualityStarts).toBe(2);
  });

  it("emits a zero row for an active player with no games in the window", async () => {
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    const idle = a.batters.find((r) => r.player.fullName === "Idle Player");
    expect(idle?.agg.games).toBe(0);
    expect(idle?.agg.counters.atBats).toBe(0);
  });

  it("sorts rows by level ladder then player name", async () => {
    const a = await assembleDigest(db, { now: clock.now, tz: TEST_TZ, spec: "7d" });
    const ranks = a.batters.map((r) => r.lvlRank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/digest-preview.test.ts`
Expected: FAIL — `assembleDigest` still takes `includeDeliveryId` and returns `lines` / `noNewStats`.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/digest/assemble.ts`:

```typescript
import { and, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow, StatLineRow } from "../db/schema.js";
import { players, statLines } from "../db/schema.js";
import { levelAbbrev, levelRank } from "../mlb/levels.js";
import type { Aggregate } from "../stats/aggregate.js";
import { aggregate } from "../stats/aggregate.js";
import type { ResolvedWindow, WindowSpec } from "../domain/window.js";
import { resolveWindow } from "../domain/window.js";
import { ipToOuts, qualityStart } from "./rates.js";
import type { RenderPlayer } from "./render.js";
import { loadActivePlayers, loadCalendars } from "../jobs/refresh.js";

/**
 * Windowed Digest assembly. Selection is BY DATE WINDOW, not by novelty — the
 * report consumes nothing and stamps nothing, so re-running a window is always
 * safe (supersedes ADR 0030's novelty model).
 *
 * Rows group by (player, LEVEL), because a window can span a promotion and a
 * blended slash line across levels describes nobody (src/mlb/levels.ts: "Level
 * is a mutable location, never identity"). A 1d window groups by game instead,
 * so a doubleheader stays two rows.
 */

export interface DigestRow {
  player: RenderPlayer;
  lvl: string;
  lvlRank: number;
  gameNumber: number | null;
  agg: Aggregate;
  qualityStarts: number;
}

export interface DigestAssembly {
  window: ResolvedWindow;
  batters: DigestRow[];
  pitchers: DigestRow[];
  playerCount: number;
  statLineCount: number;
}

interface Split {
  line: StatLineRow;
  player: PlayerRow;
  stats: Record<string, unknown>;
}

export async function assembleDigest(
  db: Db,
  deps: { now: () => Date; tz: string; spec: WindowSpec },
): Promise<DigestAssembly> {
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const seasonStart = seasonStartFor(calendars, deps.now(), deps.tz);
  const window = resolveWindow(deps.spec, deps.now(), deps.tz, seasonStart);

  const rows = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(
      and(
        eq(players.active, true),
        // Regular season only: ingestion also allows postseason types, and a
        // YTD line blending playoff and regular-season stats is not a season line.
        eq(statLines.gameType, "R"),
        gte(statLines.gameDate, window.from),
        lte(statLines.gameDate, window.to),
      ),
    );

  const splits: Split[] = rows.map(({ line, player }) => ({
    line,
    player,
    stats: asRecord(line.stats),
  }));

  const batting = mergeFieldingIntoBatting(splits);
  const pitching = splits.filter((s) => s.line.statType === "pitching");

  const batters = buildRows(batting, window, activePlayers, "batting");
  const pitchers = buildRows(pitching, window, activePlayers, "pitching");

  return {
    window,
    batters,
    pitchers,
    playerCount: new Set(splits.map((s) => s.player.id)).size,
    statLineCount: splits.length,
  };
}
```

Then the three helpers, in the same file:

```typescript
/**
 * ADR 0033: a fielding row never renders standalone. Its error count merges
 * into the same (player, game) batting split, synthesizing an all-zero batting
 * split when the player has no batting row for that game.
 */
function mergeFieldingIntoBatting(splits: Split[]): Split[] {
  const batting = splits.filter((s) => s.line.statType === "batting");
  const byGame = new Map<string, Split>();
  for (const split of batting) {
    byGame.set(`${split.line.playerId}:${split.line.gameId}`, split);
  }
  for (const split of splits) {
    if (split.line.statType !== "fielding") continue;
    const key = `${split.line.playerId}:${split.line.gameId}`;
    const errors = numberOr0(split.stats.errors);
    const target = byGame.get(key);
    if (target !== undefined) {
      target.stats = { ...target.stats, errors };
      continue;
    }
    const synthesized: Split = { ...split, stats: { errors } };
    byGame.set(key, synthesized);
    batting.push(synthesized);
  }
  return batting;
}

function buildRows(
  splits: Split[],
  window: ResolvedWindow,
  activePlayers: PlayerRow[],
  statType: "batting" | "pitching",
): DigestRow[] {
  const groups = new Map<string, Split[]>();
  for (const split of splits) {
    const key =
      window.groupBy === "game"
        ? `${split.line.playerId}:${split.line.gameId}`
        : `${split.line.playerId}:${split.line.sportId}`;
    const bucket = groups.get(key) ?? [];
    groups.set(key, bucket);
    bucket.push(split);
  }

  const rows: DigestRow[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    const doubleheader =
      window.groupBy === "game" &&
      splits.some(
        (s) => s.line.playerId === first.line.playerId && s.line.gameId !== first.line.gameId,
      );
    rows.push({
      player: toRenderPlayer(first.player),
      lvl: levelAbbrev(first.line.sportId, first.line.leagueName),
      lvlRank: levelRank(first.line.sportId),
      gameNumber: doubleheader ? first.line.gameNumber : null,
      agg: aggregate(statType, bucket.map((s) => s.stats)),
      qualityStarts: statType === "pitching" ? countQualityStarts(bucket) : 0,
    });
  }

  // Batters only: an active player with no games in the window still gets a
  // zero row, which replaces the old "no new stats" tail.
  if (statType === "batting") {
    const seen = new Set(rows.map((r) => r.player.fullName));
    for (const player of activePlayers) {
      if (seen.has(player.fullName)) continue;
      rows.push({
        player: toRenderPlayer(player),
        lvl: levelAbbrev(sportIdForPlayerRow(player), null),
        lvlRank: levelRank(sportIdForPlayerRow(player)),
        gameNumber: null,
        agg: aggregate("batting", []),
        qualityStarts: 0,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      a.lvlRank - b.lvlRank ||
      a.player.fullName.localeCompare(b.player.fullName) ||
      (a.gameNumber ?? 0) - (b.gameNumber ?? 0),
  );
}

/** QS is not a source field — it is computed per game and counted here. */
function countQualityStarts(bucket: Split[]): number {
  return bucket.filter((s) => {
    const outs = ipToOuts(String(s.stats.inningsPitched ?? ""));
    return qualityStart(outs, numberOr0(s.stats.earnedRuns)) === 1;
  }).length;
}
```

Keep the existing `toRenderPlayer` and `asRecord` helpers. Add `numberOr0` and
`sportIdForPlayerRow` (the latter wraps the existing `sportIdForLevel`), and `seasonStartFor`, which
reads the current season's `regularSeasonStart` for sportId 1 from the cached calendars.

**Delete `previewDeliveryId` entirely** — nothing selects by delivery id any more.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/digest-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm `qualityStart`'s return shape**

Run: `grep -n "export function qualityStart" -A 6 src/digest/rates.ts`
If it returns a boolean rather than `1 | 0`, adjust `countQualityStarts` to match. Do not change
`rates.ts` — `formatPitchingLine` depends on its current shape.

- [ ] **Step 6: Commit**

```bash
git add src/digest/assemble.ts test/digest-preview.test.ts
git commit -m "$(cat <<'EOF'
Select digest content by date window, grouped by player and level

Supersedes novelty selection: the report consumes nothing and stamps
nothing, so re-running a window is always safe.

Rows group by (player, level) because a window can span a promotion, and
a slash line blending Triple-A and Single-A describes nobody. Level comes
from the stat line's sportId, never from players.level.

Quality starts are counted here, while per-game rows are still in hand —
QS is not a source field.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Table rendering

**Files:**
- Modify: `src/digest/render.ts`
- Test: `test/render.test.ts` (rewrite)

**Interfaces:**
- Consumes: `DigestAssembly`, `DigestRow` (Task 2); `deriveRate` (`src/stats/aggregate.ts`).
- Produces:
  ```typescript
  export function renderDigest(assembly: DigestAssembly): RenderedMail;
  ```
  `RenderedMail` and `renderHeartbeat` keep their current shapes. `formatBattingLine` and
  `formatPitchingLine` are deleted — the table replaces the comma-joined text.

**Column sets** (spec, *Rendering*):

```
1d batters:   Player Lvl Gm PA H BB K 2B 3B HR RBI R SB CS E
nd batters:   Player Lvl GP Batting PA H BB K 2B 3B HR RBI R SB CS E
1d pitchers:  Player Lvl Gm IP ER K K/9 BB HA HRA ERA WHIP S HLD QS
nd pitchers:  Player Lvl GP IP ER K K/9 BB HA HRA ERA WHIP S HLD QS
```

`Batting` is `deriveRate(agg, "avg") + "/" + obp + "/" + slg`. `IP` is `formatOuts(agg.outs)`.
`ERA`, `WHIP`, `K/9` are `deriveRate` calls. `QS` is `row.qualityStarts`. A zero row renders
`.000/.000/.000` rather than `-`.

- [ ] **Step 1: Write the failing test**

Rewrite `test/render.test.ts`:

```typescript
describe("renderDigest — tables", () => {
  it("renders a Batters table with a Lvl column and no level sections", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [harper7d] }));
    expect(mail.text).toContain("Batters");
    expect(mail.text).toMatch(/Player\s+Lvl\s+GP\s+Batting/);
    expect(mail.text).not.toContain("MiLB - Triple-A");
    expect(mail.text).toContain("MLB");
  });

  it("omits GP and adds Gm for a 1d window", () => {
    const mail = renderDigest(assemblyWith({ spec: "1d", batters: [penaGm1, penaGm2] }));
    expect(mail.text).toMatch(/Player\s+Lvl\s+Gm\s+PA/);
    expect(mail.text).not.toMatch(/\bGP\b/);
  });

  it("renders a zero row as .000/.000/.000 rather than a dash", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [idleRow] }));
    expect(mail.text).toContain(".000/.000/.000");
  });

  it("renders quality starts as a count", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", pitchers: [wheeler7d] }));
    expect(mail.text).toMatch(/\s2\s*$/m);
  });

  it("puts the window label in the subject", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d" }));
    expect(mail.subject).toContain("Last 7 Days");
  });

  it("emits an HTML table, not a list", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [harper7d] }));
    expect(mail.html).toContain("<table");
    expect(mail.html).not.toContain("<ul>");
  });

  it("escapes player names in HTML", () => {
    const mail = renderDigest(assemblyWith({ spec: "7d", batters: [rowNamed("A <b>Hack</b>")] }));
    expect(mail.html).not.toContain("<b>Hack</b>");
    expect(mail.html).toContain("&lt;b&gt;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/render.test.ts`
Expected: FAIL — `renderDigest` still takes `{ date, lines, noNewStats }`.

- [ ] **Step 3: Write the implementation**

Rewrite the rendering half of `src/digest/render.ts`. Core structure:

```typescript
interface Column {
  header: string;
  /** Right-aligned for numbers, left for names. */
  align: "left" | "right";
  value: (row: DigestRow) => string;
}

const abbreviate = (fullName: string): string => {
  const parts = fullName.trim().split(/\s+/);
  return parts.length < 2 ? fullName : `${parts[0]![0]} ${parts.slice(1).join(" ")}`;
};

const counter = (key: string): Column["value"] => (row) => String(row.agg.counters[key] ?? 0);

const slashLine: Column["value"] = (row) =>
  row.agg.games === 0
    ? ".000/.000/.000"
    : `${deriveRate(row.agg, "avg")}/${deriveRate(row.agg, "obp")}/${deriveRate(row.agg, "slg")}`;

function battingColumns(window: ResolvedWindow): Column[] {
  const lead: Column[] =
    window.groupBy === "game"
      ? [{ header: "Gm", align: "right", value: (r) => (r.gameNumber === null ? "" : String(r.gameNumber)) }]
      : [
          { header: "GP", align: "right", value: (r) => String(r.agg.games) },
          { header: "Batting", align: "right", value: slashLine },
        ];
  return [
    { header: "Player", align: "left", value: (r) => abbreviate(r.player.fullName) },
    { header: "Lvl", align: "left", value: (r) => r.lvl },
    ...lead,
    { header: "PA", align: "right", value: counter("plateAppearances") },
    { header: "H", align: "right", value: counter("hits") },
    { header: "BB", align: "right", value: counter("baseOnBalls") },
    { header: "K", align: "right", value: counter("strikeOuts") },
    { header: "2B", align: "right", value: counter("doubles") },
    { header: "3B", align: "right", value: counter("triples") },
    { header: "HR", align: "right", value: counter("homeRuns") },
    { header: "RBI", align: "right", value: counter("rbi") },
    { header: "R", align: "right", value: counter("runs") },
    { header: "SB", align: "right", value: counter("stolenBases") },
    { header: "CS", align: "right", value: counter("caughtStealing") },
    { header: "E", align: "right", value: counter("errors") },
  ];
}
```

`pitchingColumns` follows the same pattern with `IP` (`formatOuts(row.agg.outs)`), `ER`, `K`,
`K/9` (`deriveRate(row.agg, "strikeoutsPer9Inn")`), `BB`, `HA` (`hits`), `HRA` (`homeRuns`),
`ERA`, `WHIP`, `S` (`saves`), `HLD` (`holds`), `QS` (`row.qualityStarts`).

Add `formatOuts(outs: number | null): string` — the inverse of `ipToOuts`: `19 → "6.1"`,
`null → "0.0"`.

Then two small emitters over `Column[]` and `DigestRow[]`: `textTable` (pad each cell to the widest
value in its column) and `htmlTable` (`<table>` / `<th>` / `<td>`, every cell through `escapeHtml`).
`renderDigest` composes subject + both tables from the assembly's window label.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Eyeball the real output**

Run: `npx tsx src/cli/digest.ts --window 7d --dry-run` if a dry-run flag exists; otherwise preview
via `GET /api/digest/preview?window=7d` after Task 6. Confirm columns align and no row wraps in a
narrow terminal.

- [ ] **Step 6: Commit**

```bash
git add src/digest/render.ts test/render.test.ts
git commit -m "$(cat <<'EOF'
Render the digest as Batters and Pitchers tables

Replaces per-game prose lines and level-section grouping with two tables
and a Lvl column. 1d carries Gm for doubleheaders and drops GP, which
would always be 1; longer windows carry GP and a derived slash line.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Job flow — accept a window, stop stamping lines

**Files:**
- Modify: `src/jobs/digest.ts`, `src/jobs/delivery-claim.ts`
- Test: `test/digest.test.ts` (update)

**Interfaces:**
- Consumes: `assembleDigest` (Task 2), `renderDigest` (Task 3), `WindowSpec`.
- Produces: `DigestDeps` gains `spec: WindowSpec`. `DigestResult` keeps its shape and gains
  `window: string` (the resolved label). `ClaimResult`'s replay variant becomes
  `{ claimed: true; replay: true }` — `replayOfDeliveryId` is gone. `settleSent` loses `reportedIds`.

**What must NOT change:** the claim → send → settle flow, the lease, stale-claim recovery,
reconciliation, the offseason heartbeat, and the rule that a replay settles nothing. Those are
ADR 0034 and survive intact. Only line stamping and the replay's delivery-id plumbing go.

- [ ] **Step 1: Write the failing test**

Update `test/digest.test.ts`. Keep every existing delivery-semantics test — they should still pass
unchanged — and add:

```typescript
it("never writes digest_delivery_id, because a window consumes nothing", async () => {
  await runDigest({ ...deps, spec: "1d" });
  const lines = db.select().from(statLines).all();
  expect(lines.every((l) => !("digestDeliveryId" in l))).toBe(true);
});

it("re-running the same window sends the same content", async () => {
  const first = await runDigest({ ...deps, spec: "7d", force: true });
  const second = await runDigest({ ...deps, spec: "7d", force: true });
  expect(second.statLineCount).toBe(first.statLineCount);
});
```

The second test is the point of the redesign: under novelty selection the second run reported
nothing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/digest.test.ts`
Expected: FAIL — `runDigest` does not accept `spec`.

- [ ] **Step 3: Write the implementation**

In `src/jobs/digest.ts`:
- Add `spec: WindowSpec` to `DigestDeps`; pass it to `assembleDigest`.
- Replace the `renderDigest({ date, lines, noNewStats })` call with `renderDigest(assembly)`.
- Delete the `includeDeliveryId` / `claim.replay ? claim.replayOfDeliveryId : null` block and its
  long comment — there is no novelty predicate left to widen.
- Delete `reportedIds` from `settleSent`; pass `statLineCount: assembly.statLineCount`.
- Keep every `if (!claim.replay)` guard exactly as-is.

In `src/jobs/delivery-claim.ts`:
- Change the replay variant to `{ claimed: true; replay: true }`.
- Delete the `replayOf` computation in the precondition branch and the `existing.id` in the
  `sent` branch.
- Delete `reportedIds` from `settleSent`'s args and its `stat_lines` update.

Keep the type-level barrier comment: the replay variant still must not reach `settleSent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/digest.test.ts`
Expected: PASS, including every pre-existing delivery test.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/digest.ts src/jobs/delivery-claim.ts test/digest.test.ts
git commit -m "$(cat <<'EOF'
Run the digest over a window and stop stamping stat lines

Window selection consumes nothing, so there is no line state a forced run
could corrupt — which retires replayOfDeliveryId and the novelty-widening
plumbing that existed only to protect it.

Everything ADR 0034 guarantees stays: the claim, the lease, stale-claim
recovery, reconciliation, and a replay settling nothing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Drop `stat_lines.digest_delivery_id`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/<generated>.sql`
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: Task 4 (nothing reads or writes the column by this point).
- Produces: `StatLineRow` no longer has `digestDeliveryId`.

- [ ] **Step 1: Confirm nothing references the column**

Run: `grep -rn "digestDeliveryId\|digest_delivery_id" src test`
Expected: matches only in `src/db/schema.ts`. Any other hit means Task 4 is incomplete — fix that
first rather than dropping the column out from under a reader.

- [ ] **Step 2: Remove the column from the schema**

Delete these lines from `src/db/schema.ts`:

```typescript
    /** Set when a Digest reports this line; a correction never clears it (ADR 0030). */
    digestDeliveryId: integer("digest_delivery_id").references(() => digestDeliveries.id),
```

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new file in `drizzle/`. SQLite cannot `DROP COLUMN` on a table with a foreign key in all
versions, so **read the generated SQL**. If drizzle emits a table rebuild (create-new / copy /
drop-old / rename), confirm it preserves the `stat_lines_player_game_type_uq` unique index — that
index is the ADR 0029 identity guarantee and must survive.

- [ ] **Step 4: Apply and verify against a scratch database**

```bash
DATABASE_PATH=/tmp/bryce-migrate-check.db npx tsx src/cli/migrate.ts
sqlite3 /tmp/bryce-migrate-check.db ".schema stat_lines"
```

Expected: no `digest_delivery_id` column; `stat_lines_player_game_type_uq` still present.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ test/schema.test.ts
git commit -m "$(cat <<'EOF'
Drop stat_lines.digest_delivery_id

The column existed to make novelty selection work. Window selection has
no consumer for it, and keeping it would mean keeping the guard rails
that protected it. Delivery auditing lives in digest_deliveries, at the
right grain.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Expose `--window` on the CLI, REST, and MCP

**Files:**
- Modify: `src/cli/digest.ts`, `src/api/schemas.ts`, `src/api/routes.ts`, `src/mcp/server.ts`
- Test: `test/cli-digest.test.ts`, `test/api.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `parseWindowSpec`, `WINDOW_SPECS` (`src/domain/window.ts`); `spec` on `DigestDeps`.
- Produces: `parseWindow(argv: string[]): WindowSpec | null` exported from `src/cli/digest.ts` —
  `null` means an invalid value was supplied, which is a fail-closed error, distinct from the `1d`
  default when the flag is absent.

- [ ] **Step 1: Write the failing tests**

`test/cli-digest.test.ts`:

```typescript
describe("parseWindow", () => {
  it("defaults to 1d when the flag is absent", () => {
    expect(parseWindow([])).toBe("1d");
    expect(parseWindow(["--force"])).toBe("1d");
  });

  it("accepts --window <spec> and --window=<spec>", () => {
    expect(parseWindow(["--window", "7d"])).toBe("7d");
    expect(parseWindow(["--window=ytd"])).toBe("ytd");
  });

  it("returns null for an unsupported window so the CLI fails closed", () => {
    expect(parseWindow(["--window", "30d"])).toBeNull();
    expect(parseWindow(["--window"])).toBeNull();
  });
});

it("exits non-zero and sends nothing on an invalid window", async () => {
  const code = await runDigestCli(["--window", "30d"], deps);
  expect(code).toBe(1);
  expect(mailer.sent).toHaveLength(0);
});
```

`test/api.test.ts`: `GET /api/digest/preview?window=7d` returns a 7-day window; an invalid
`window` returns 400; absent `window` defaults to `1d`.

`test/mcp.test.ts`: `digest_preview` accepts `window` and rejects an invalid one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli-digest.test.ts test/api.test.ts test/mcp.test.ts`
Expected: FAIL — `parseWindow` is not exported; `window` is not in the schemas.

- [ ] **Step 3: Write the implementation**

`src/cli/digest.ts`:

```typescript
/**
 * `--window <spec>` / `--window=<spec>`, default `1d`. Returns null for an
 * unsupported value so the caller can fail closed — a typo'd window must not
 * silently send a different report than the operator asked for.
 */
export function parseWindow(argv: string[]): WindowSpec | null {
  const inline = argv.find((a) => a.startsWith("--window="));
  if (inline !== undefined) return parseWindowSpec(inline.slice("--window=".length));
  const at = argv.indexOf("--window");
  if (at === -1) return "1d";
  const value = argv[at + 1];
  return value === undefined ? null : parseWindowSpec(value);
}
```

In `runDigestCli`, return `1` and write an error naming the supported specs when `parseWindow`
returns `null`, before touching the mailer.

`src/api/schemas.ts`: add `window: z.enum(WINDOW_SPECS).default("1d")` to `DigestQueryInputSchema`
and `DigestInputSchema`. Zod rejects an unsupported value, which the existing `onError` renders 400.

`src/api/routes.ts`: pass `spec: query.window` into `assembleDigest`; delete the `previewDeliveryId`
call and the `includeDeliveryId` argument; return the assembly's window and rows instead of
`lines` / `noNewStats`. Pass `spec: body.window` into `runDigest`.

`src/mcp/server.ts`: add `window` to both tool input schemas and rewrite the two descriptions —
they currently describe novelty selection ("unreported stat lines plus the in-season no-new-stats
tail", "mark reported lines") which is no longer what the tools do. A stale tool description is a
correctness bug for an MCP client.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli-digest.test.ts test/api.test.ts test/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Full quality gate**

Run: `npm run typecheck && npm run lint && npm test && ruby scripts/parity_check.rb`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/digest.ts src/api/schemas.ts src/api/routes.ts src/mcp/server.ts test/
git commit -m "$(cat <<'EOF'
Expose --window on the CLI, REST and MCP surfaces

An unsupported window fails closed on every surface rather than silently
sending a different report than the operator asked for.

MCP tool descriptions are rewritten: they described novelty selection and
line marking, neither of which the tools still do, and a stale tool
description is a correctness bug for a client.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Record the redefinition

**Files:**
- Create: `docs/adr/0035-window-selected-digest.md`
- Modify: `CONTEXT.md`, `docs/adr/0030-*.md` (status line only)

**Interfaces:** none — documentation.

- [ ] **Step 1: Read the ADR conventions**

Run: `ls docs/adr && sed -n '1,25p' docs/adr/0034-*.md`
Match the existing status/context/decision/consequences structure and numbering exactly.

- [ ] **Step 2: Write ADR 0035**

Cover: window selection replacing novelty; the yesterday anchor and why it is run-hour independent;
`(player, level)` grouping and why a blended slash line is wrong; regular-season-only; dropping
`digest_delivery_id` and the replay plumbing that went with it; what ADR 0034 retains.

State plainly what is lost: novelty selection caught late-arriving corrections whenever they landed,
and a fixed window does not. The mitigation is that windows recompute from the gamelog every time, so
a correction missing one day's 1d email still appears in every subsequent 7d/14d/21d/ytd report.

- [ ] **Step 3: Mark ADR 0030 superseded**

Update its status line to `Superseded by ADR 0035`. Do not delete or rewrite its body — the record of
why novelty was chosen is the context for why it changed.

- [ ] **Step 4: Update `CONTEXT.md`**

Redefine **Digest** as window-selected, and add **Window**, **Level** (as a row grouping key), and
**Roll-up** to the glossary.

- [ ] **Step 5: Run the parity check**

Run: `ruby scripts/parity_check.rb`
Expected: `OK` — it verifies ADR links resolve.

- [ ] **Step 6: Commit**

```bash
git add docs/adr CONTEXT.md
git commit -m "$(cat <<'EOF'
Record window-selected digest in ADR 0035, superseding ADR 0030

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage.** Implements spec steps 4-6: assembly, rendering, job flow, the migration, surface
wiring, and the ADR. Combined with the two prior plans, every section of the spec has a task.

**Placeholder scan.** No TBDs. Two deliberate exceptions to "complete code in every step", both
flagged in-place rather than hidden:

- **Task 2, Step 3** names three helpers (`numberOr0`, `sportIdForPlayerRow`, `seasonStartFor`) by
  signature and behavior rather than body. They are three-line wrappers over functions that already
  exist in `src/mlb/levels.ts` and `src/domain/season.ts`.
- **Task 3, Step 3** describes `textTable` / `htmlTable` structurally and gives the full `Column`
  model and `battingColumns` verbatim. `pitchingColumns` follows the same shape from the stated
  column list.

**Type consistency.** `DigestRow` / `DigestAssembly` are defined in Task 2 and consumed unchanged in
Tasks 3 and 4. `WindowSpec` and `ResolvedWindow` come from Plan 2 and are not redefined.
`RenderedMail` and `renderHeartbeat` keep their existing shapes, so the heartbeat path needs no edits.

**Known risks.**

1. **Task 5's migration is the only irreversible step.** SQLite column drops often become table
   rebuilds; the plan requires reading the generated SQL and verifying the ADR 0029 unique index
   survives against a scratch database before it touches the real one.
2. **Task 2 and Task 3 rewrite two large existing test files** (`digest-preview.test.ts`,
   `render.test.ts`). The tests here are written as intent plus concrete assertions rather than
   complete files, because both depend on `test/factories.ts` helpers whose current signatures the
   implementer should read first. Every assertion is concrete; the fixtures are not.
3. **Two-way players** appear in both tables, once as a batter and once as a pitcher. That falls out
   of the design and is correct, but no test pins it. Worth adding one if a two-way player is ever
   watched.
