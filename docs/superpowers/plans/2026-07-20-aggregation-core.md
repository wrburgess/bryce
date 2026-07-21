# Aggregation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure functions that turn a set of per-game stat lines into a windowed aggregate — field classification, counter summing, outs-based innings, derived rates, and window resolution.

**Architecture:** Three new modules with no consumers yet, so this plan ships entirely behind the existing behavior. `fields.ts` is a data table classifying every stat key as counter / rate / innings / excluded. `aggregate.ts` sums counters and outs, and derives rates *from those sums on demand*. `window.ts` resolves a window spec to an inclusive date range anchored on the last completed host date.

**Tech Stack:** TypeScript, Vitest, `Intl.DateTimeFormat` for host-date math.

## Global Constraints

- **Rates are never summed and never averaged.** Every rate is recomputed from summed counters.
- **Innings are never added arithmetically.** `"6.1"` is 6⅓; all innings math goes through outs via the existing `ipToOuts` / `formatIp` in `src/digest/rates.ts`.
- **Unknown fields fail closed** — excluded from the aggregate and reported, never summed. Precedent: `src/mlb/gameTypes.ts` ("Allowlist, not blocklist").
- **Every window ends on the last completed host date** (`today - 1`), so output does not depend on run hour.
- All three modules are **pure** — no database, no clock, no I/O. `now` is injected.
- Quality gate: `npm run typecheck`, `npm run lint`, `npm test`, `ruby scripts/parity_check.rb`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Depends on:** `2026-07-20-timezone-config-key.md` for correct host dates. Tasks here inject `tz`
explicitly, so they can be written in parallel, but the windows are only *right* once that lands.

## File Structure

| File | Responsibility |
|---|---|
| `src/stats/fields.ts` | Classification tables. Data, no logic beyond lookup. |
| `src/stats/aggregate.ts` | Sum counters and outs; derive rates from the sums. |
| `src/domain/window.ts` | Resolve a window spec to `{ from, to, label, groupBy }`. |
| `test/stats-fields.test.ts` | Classification coverage, including exhaustiveness against real payloads. |
| `test/stats-aggregate.test.ts` | Summing, outs math, rate derivation. |
| `test/window.test.ts` | Anchor, boundaries, DST, run-hour independence. |

---

### Task 1: Field classification tables

**Files:**
- Create: `src/stats/fields.ts`
- Test: `test/stats-fields.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export type StatType = "batting" | "pitching" | "fielding";
  export type FieldClass = "counter" | "rate" | "innings" | "excluded";
  export function classifyField(statType: StatType, key: string): FieldClass | null;
  export function counterKeys(statType: StatType): readonly string[];
  export function rateKeys(statType: StatType): readonly string[];
  ```
  `classifyField` returns `null` for an unknown key — that is the fail-closed signal, not an error.

- [ ] **Step 1: Write the failing test**

Create `test/stats-fields.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyField, counterKeys, rateKeys } from "../src/stats/fields.js";

describe("classifyField", () => {
  it("classifies counting stats as counters", () => {
    expect(classifyField("batting", "hits")).toBe("counter");
    expect(classifyField("batting", "atBats")).toBe("counter");
    expect(classifyField("pitching", "earnedRuns")).toBe("counter");
    expect(classifyField("fielding", "putOuts")).toBe("counter");
  });

  it("classifies rate stats as rates, never counters", () => {
    for (const key of ["avg", "obp", "slg", "ops", "babip"]) {
      expect(classifyField("batting", key)).toBe("rate");
    }
    for (const key of ["era", "whip", "strikeoutsPer9Inn", "winPercentage"]) {
      expect(classifyField("pitching", key)).toBe("rate");
    }
    expect(classifyField("fielding", "fielding")).toBe("rate");
  });

  it("classifies baseball-notation innings separately from counters", () => {
    expect(classifyField("pitching", "inningsPitched")).toBe("innings");
    expect(classifyField("fielding", "innings")).toBe("innings");
  });

  it("excludes per-game text and position codes", () => {
    expect(classifyField("batting", "summary")).toBe("excluded");
    expect(classifyField("pitching", "summary")).toBe("excluded");
    expect(classifyField("fielding", "position")).toBe("excluded");
  });

  it("returns null for an unknown key so callers can fail closed", () => {
    expect(classifyField("batting", "warpDriveEfficiency")).toBeNull();
  });

  it("keeps strikeOuts a counter for pitchers as well as batters", () => {
    // Both sides record strikeOuts; it is a counter in both directions.
    expect(classifyField("batting", "strikeOuts")).toBe("counter");
    expect(classifyField("pitching", "strikeOuts")).toBe("counter");
  });
});

describe("classification is exhaustive against real gamelog payloads", () => {
  // This is the test that catches an MLB schema change instead of silently
  // dropping a stat. Fixtures are the real API responses already in the repo.
  const cases: Array<{ fixture: string; statType: "batting" | "pitching" }> = [
    { fixture: "test/fixtures/mlb/gamelog_hitting_aaa.json", statType: "batting" },
    { fixture: "test/fixtures/mlb/gamelog_pitching_mlb.json", statType: "pitching" },
  ];

  for (const { fixture, statType } of cases) {
    it(`classifies every ${statType} key in ${fixture}`, () => {
      const payload: unknown = JSON.parse(readFileSync(fixture, "utf8"));
      const splits = collectSplits(payload);
      expect(splits.length).toBeGreaterThan(0);

      const unclassified = new Set<string>();
      for (const split of splits) {
        for (const key of Object.keys(split)) {
          if (classifyField(statType, key) === null) unclassified.add(key);
        }
      }
      expect([...unclassified]).toEqual([]);
    });
  }
});

/** Pull every `stat` object out of a gameLog payload, whatever its nesting. */
function collectSplits(payload: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const stat = record.stat;
    if (typeof stat === "object" && stat !== null && !Array.isArray(stat)) {
      out.push(stat as Record<string, unknown>);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  return out;
}

describe("key accessors", () => {
  it("counterKeys and rateKeys are disjoint", () => {
    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const counters = new Set(counterKeys(statType));
      for (const rate of rateKeys(statType)) expect(counters.has(rate)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stats-fields.test.ts`
Expected: FAIL — `Cannot find module '../src/stats/fields.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/stats/fields.ts`:

```typescript
/**
 * Stat field classification (windowed Digest spec, 2026-07-20).
 *
 * Every key in a gamelog `stat` object belongs to exactly one class, and the
 * classification is what makes aggregation correct:
 *
 *   counter  — sum across games
 *   rate     — RECOMPUTE from summed counters; never sum, never average
 *   innings  — baseball notation ("6.1" is 6 1/3); sum via outs only
 *   excluded — not aggregatable (per-game prose, position codes)
 *
 * Unknown keys classify as `null` and callers exclude them. That is deliberate
 * and follows src/mlb/gameTypes.ts: allowlist, not blocklist. Summing anything
 * numeric would be the worst default available, because every rate field is
 * numeric and would silently produce garbage — a season `avg` in the tens, or
 * an averaged one that looks plausible and is simply wrong.
 */

export type StatType = "batting" | "pitching" | "fielding";
export type FieldClass = "counter" | "rate" | "innings" | "excluded";

const BATTING: Readonly<Record<string, FieldClass>> = {
  airOuts: "counter",
  atBats: "counter",
  atBatsPerHomeRun: "rate",
  avg: "rate",
  babip: "rate",
  baseOnBalls: "counter",
  catchersInterference: "counter",
  caughtStealing: "counter",
  caughtStealingPercentage: "rate",
  doubles: "counter",
  flyOuts: "counter",
  gamesPlayed: "counter",
  groundIntoDoublePlay: "counter",
  groundIntoTriplePlay: "counter",
  groundOuts: "counter",
  groundOutsToAirouts: "rate",
  hitByPitch: "counter",
  hits: "counter",
  homeRuns: "counter",
  intentionalWalks: "counter",
  leftOnBase: "counter",
  numberOfPitches: "counter",
  obp: "rate",
  ops: "rate",
  plateAppearances: "counter",
  rbi: "counter",
  runs: "counter",
  sacBunts: "counter",
  sacFlies: "counter",
  slg: "rate",
  stolenBasePercentage: "rate",
  stolenBases: "counter",
  strikeOuts: "counter",
  summary: "excluded",
  totalBases: "counter",
  triples: "counter",
  // Merged in from the same game's fielding row (ADR 0033).
  errors: "counter",
};

const PITCHING: Readonly<Record<string, FieldClass>> = {
  airOuts: "counter",
  atBats: "counter",
  avg: "rate",
  balks: "counter",
  baseOnBalls: "counter",
  battersFaced: "counter",
  blownSaves: "counter",
  catchersInterference: "counter",
  caughtStealing: "counter",
  caughtStealingPercentage: "rate",
  completeGames: "counter",
  doubles: "counter",
  earnedRuns: "counter",
  era: "rate",
  flyOuts: "counter",
  gamesFinished: "counter",
  gamesPitched: "counter",
  gamesPlayed: "counter",
  gamesStarted: "counter",
  groundIntoDoublePlay: "counter",
  groundOuts: "counter",
  groundOutsToAirouts: "rate",
  hitBatsmen: "counter",
  hitByPitch: "counter",
  hits: "counter",
  hitsPer9Inn: "rate",
  holds: "counter",
  homeRuns: "counter",
  homeRunsPer9: "rate",
  inheritedRunners: "counter",
  inheritedRunnersScored: "counter",
  inningsPitched: "innings",
  intentionalWalks: "counter",
  losses: "counter",
  numberOfPitches: "counter",
  obp: "rate",
  ops: "rate",
  outs: "counter",
  pickoffs: "counter",
  pitchesPerInning: "rate",
  runs: "counter",
  runsScoredPer9: "rate",
  sacBunts: "counter",
  sacFlies: "counter",
  saveOpportunities: "counter",
  saves: "counter",
  shutouts: "counter",
  slg: "rate",
  stolenBasePercentage: "rate",
  stolenBases: "counter",
  strikeOuts: "counter",
  strikePercentage: "rate",
  strikeoutWalkRatio: "rate",
  strikeoutsPer9Inn: "rate",
  strikes: "counter",
  summary: "excluded",
  totalBases: "counter",
  triples: "counter",
  walksPer9Inn: "rate",
  whip: "rate",
  wildPitches: "counter",
  winPercentage: "rate",
  wins: "counter",
};

const FIELDING: Readonly<Record<string, FieldClass>> = {
  assists: "counter",
  chances: "counter",
  doublePlays: "counter",
  errors: "counter",
  fielding: "rate",
  games: "counter",
  gamesPlayed: "counter",
  gamesStarted: "counter",
  innings: "innings",
  position: "excluded",
  putOuts: "counter",
  rangeFactorPer9Inn: "rate",
  rangeFactorPerGame: "rate",
  throwingErrors: "counter",
  triplePlays: "counter",
};

const TABLES: Readonly<Record<StatType, Readonly<Record<string, FieldClass>>>> = {
  batting: BATTING,
  pitching: PITCHING,
  fielding: FIELDING,
};

/** The field's class, or null when the key is unknown (caller excludes it). */
export function classifyField(statType: StatType, key: string): FieldClass | null {
  return TABLES[statType][key] ?? null;
}

function keysOfClass(statType: StatType, wanted: FieldClass): readonly string[] {
  return Object.entries(TABLES[statType])
    .filter(([, cls]) => cls === wanted)
    .map(([key]) => key);
}

export function counterKeys(statType: StatType): readonly string[] {
  return keysOfClass(statType, "counter");
}

export function rateKeys(statType: StatType): readonly string[] {
  return keysOfClass(statType, "rate");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stats-fields.test.ts`
Expected: PASS.

If the exhaustiveness test fails, it has found a real key the tables miss — add it with the right
class rather than loosening the test. That is the test doing its job.

- [ ] **Step 5: Commit**

```bash
git add src/stats/fields.ts test/stats-fields.test.ts
git commit -m "$(cat <<'EOF'
Add stat field classification tables

Every gamelog stat key classifies as counter, rate, baseball-notation
innings, or excluded. Unknown keys return null so callers fail closed —
summing anything numeric would silently corrupt every rate field.

The exhaustiveness test runs against the real gamelog fixtures, so an
upstream schema change fails the suite instead of dropping a stat.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Sum counters and innings

**Files:**
- Create: `src/stats/aggregate.ts`
- Test: `test/stats-aggregate.test.ts`

**Interfaces:**
- Consumes: `classifyField`, `StatType` from Task 1; `ipToOuts`, `formatIp` from `src/digest/rates.ts`.
- Produces:
  ```typescript
  export interface Aggregate {
    statType: StatType;
    games: number;
    counters: Record<string, number>;
    /** Summed outs; null when the stat type has no innings concept (batting). */
    outs: number | null;
    /** Unknown keys seen and excluded, deduped and sorted. */
    unknownFields: string[];
  }
  export function aggregate(
    statType: StatType,
    stats: ReadonlyArray<Record<string, unknown>>,
  ): Aggregate;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/stats-aggregate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { aggregate } from "../src/stats/aggregate.js";

describe("aggregate — counters", () => {
  it("sums counting stats across games and counts games", () => {
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4, homeRuns: 1, rbi: 2 },
      { hits: 0, atBats: 4, homeRuns: 0, rbi: 0 },
    ]);
    expect(agg.games).toBe(2);
    expect(agg.counters.hits).toBe(3);
    expect(agg.counters.atBats).toBe(8);
    expect(agg.counters.homeRuns).toBe(1);
    expect(agg.counters.rbi).toBe(2);
  });

  it("treats a missing or non-numeric counter as zero", () => {
    const agg = aggregate("batting", [{ hits: 2 }, { hits: "-", atBats: 3 }]);
    expect(agg.counters.hits).toBe(2);
    expect(agg.counters.atBats).toBe(3);
  });

  it("returns zeroed counters and zero games for an empty set", () => {
    const agg = aggregate("batting", []);
    expect(agg.games).toBe(0);
    expect(agg.counters.hits).toBe(0);
    expect(agg.counters.atBats).toBe(0);
  });

  it("never sums a rate field into counters", () => {
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4, avg: ".750" },
      { hits: 0, atBats: 4, avg: ".000" },
    ]);
    expect(agg.counters.avg).toBeUndefined();
  });

  it("excludes unknown fields and reports them", () => {
    const agg = aggregate("batting", [{ hits: 1, atBats: 3, warpDrive: 9 }]);
    expect(agg.counters.warpDrive).toBeUndefined();
    expect(agg.unknownFields).toEqual(["warpDrive"]);
  });
});

describe("aggregate — innings are outs-based", () => {
  it("sums baseball notation through outs, not arithmetic", () => {
    // 6.1 + 6.1 = 12.2 in baseball (19 + 19 = 38 outs = 12 2/3).
    const agg = aggregate("pitching", [{ inningsPitched: "6.1" }, { inningsPitched: "6.1" }]);
    expect(agg.outs).toBe(38);
  });

  it("sums thirds that carry into a whole inning", () => {
    // 0.2 + 0.2 = 1.1, not 0.4.
    const agg = aggregate("pitching", [{ inningsPitched: "0.2" }, { inningsPitched: "0.2" }]);
    expect(agg.outs).toBe(4);
  });

  it("treats unparseable innings as zero outs", () => {
    const agg = aggregate("pitching", [{ inningsPitched: "-" }, { inningsPitched: "1.0" }]);
    expect(agg.outs).toBe(3);
  });

  it("leaves outs null for batting, which has no innings concept", () => {
    expect(aggregate("batting", [{ hits: 1 }]).outs).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stats-aggregate.test.ts`
Expected: FAIL — `Cannot find module '../src/stats/aggregate.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/stats/aggregate.ts`:

```typescript
import { ipToOuts } from "../digest/rates.js";
import type { StatType } from "./fields.js";
import { classifyField, counterKeys } from "./fields.js";

/**
 * Windowed aggregation over per-game stat objects.
 *
 * Counters sum. Innings sum through OUTS — "6.1" is six innings and one out, so
 * 6.1 + 6.1 is 12.2, which arithmetic gets wrong. Rates are deliberately absent
 * from this structure: they are derived from the sums in deriveRate(), because
 * a stored aggregate rate is a rate someone can accidentally sum.
 */

export interface Aggregate {
  statType: StatType;
  games: number;
  counters: Record<string, number>;
  /** Summed outs; null for a stat type with no innings concept. */
  outs: number | null;
  /** Unknown keys seen and excluded, deduped and sorted. */
  unknownFields: string[];
}

const HAS_INNINGS: Readonly<Record<StatType, string | null>> = {
  batting: null,
  pitching: "inningsPitched",
  fielding: "innings",
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function aggregate(
  statType: StatType,
  stats: ReadonlyArray<Record<string, unknown>>,
): Aggregate {
  const counters: Record<string, number> = {};
  for (const key of counterKeys(statType)) counters[key] = 0;

  const inningsKey = HAS_INNINGS[statType];
  let outs = inningsKey === null ? null : 0;
  const unknown = new Set<string>();

  for (const split of stats) {
    for (const [key, value] of Object.entries(split)) {
      const cls = classifyField(statType, key);
      if (cls === null) {
        unknown.add(key);
        continue;
      }
      if (cls === "counter") {
        counters[key] = (counters[key] ?? 0) + numeric(value);
        continue;
      }
      if (cls === "innings" && outs !== null) {
        outs += ipToOuts(typeof value === "string" ? value : String(value)) ?? 0;
      }
      // "rate" and "excluded" are intentionally dropped: a rate is derived from
      // the sums below, never carried forward from a single game.
    }
  }

  return {
    statType,
    games: stats.length,
    counters,
    outs,
    unknownFields: [...unknown].sort(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stats-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stats/aggregate.ts test/stats-aggregate.test.ts
git commit -m "$(cat <<'EOF'
Sum counters and outs across a window

Counters sum; innings sum through outs so 6.1 + 6.1 is 12.2 rather than
whatever arithmetic produces. Rates are deliberately absent from the
Aggregate structure — a stored aggregate rate is one somebody can
accidentally sum later.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Derive rates from the sums

**Files:**
- Modify: `src/stats/aggregate.ts`
- Test: `test/stats-aggregate.test.ts`

**Interfaces:**
- Consumes: `Aggregate` from Task 2.
- Produces:
  ```typescript
  /** A formatted rate, or "-" when the denominator is zero. */
  export function deriveRate(agg: Aggregate, key: string): string;
  export function deriveAllRates(agg: Aggregate): Record<string, string>;
  ```
  Formatting matches the existing digest: slash-line rates render `.310` (three decimals, no leading
  zero); `era` / `whip` render two decimals; per-9 rates render two decimals. Zero denominator → `"-"`,
  matching `src/digest/rates.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/stats-aggregate.test.ts`:

```typescript
import { deriveAllRates, deriveRate } from "../src/stats/aggregate.js";

describe("deriveRate — derived from sums, never averaged", () => {
  it("computes avg from summed hits and at-bats", () => {
    // 3-for-4 then 0-for-1. Correct: 3/5 = .600.
    // Averaging game AVGs gives (.750 + .000)/2 = .375 — the bug this prevents.
    const agg = aggregate("batting", [
      { hits: 3, atBats: 4 },
      { hits: 0, atBats: 1 },
    ]);
    expect(deriveRate(agg, "avg")).toBe(".600");
  });

  it("computes obp including walks, hit-by-pitch and sac flies", () => {
    // (H 4 + BB 2 + HBP 1) / (AB 10 + BB 2 + HBP 1 + SF 1) = 7/14 = .500
    const agg = aggregate("batting", [
      { hits: 4, atBats: 10, baseOnBalls: 2, hitByPitch: 1, sacFlies: 1 },
    ]);
    expect(deriveRate(agg, "obp")).toBe(".500");
  });

  it("computes slg from total bases and ops as obp plus slg", () => {
    const agg = aggregate("batting", [{ hits: 4, atBats: 10, totalBases: 8 }]);
    expect(deriveRate(agg, "slg")).toBe(".800");
    expect(deriveRate(agg, "ops")).toBe("1.200"); // .400 obp + .800 slg
  });

  it("computes era and whip from summed outs, not per-game averages", () => {
    // 13 outs total (6.1 IP), 4 ER → 4 * 27 / 13 = 8.31
    const agg = aggregate("pitching", [
      { inningsPitched: "4.0", earnedRuns: 3, hits: 5, baseOnBalls: 1 },
      { inningsPitched: "2.1", earnedRuns: 1, hits: 2, baseOnBalls: 2 },
    ]);
    expect(agg.outs).toBe(19);
    expect(deriveRate(agg, "era")).toBe("5.68"); // 4 * 27 / 19
    expect(deriveRate(agg, "whip")).toBe("1.58"); // (7 + 3) * 3 / 19
  });

  it("computes strikeouts per nine from summed outs", () => {
    const agg = aggregate("pitching", [{ inningsPitched: "9.0", strikeOuts: 10 }]);
    expect(deriveRate(agg, "strikeoutsPer9Inn")).toBe("10.00");
  });

  it("returns '-' when the denominator is zero", () => {
    const empty = aggregate("batting", []);
    expect(deriveRate(empty, "avg")).toBe("-");
    expect(deriveRate(aggregate("pitching", []), "era")).toBe("-");
  });

  it("derives every rate key the classification declares", () => {
    const agg = aggregate("pitching", [
      { inningsPitched: "6.0", earnedRuns: 2, hits: 5, baseOnBalls: 1, strikeOuts: 7, wins: 1 },
    ]);
    const rates = deriveAllRates(agg);
    for (const key of ["era", "whip", "strikeoutsPer9Inn", "walksPer9Inn", "winPercentage"]) {
      expect(rates[key]).toBeDefined();
      expect(rates[key]).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stats-aggregate.test.ts -t "derived from sums"`
Expected: FAIL — `deriveRate` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/stats/aggregate.ts`:

```typescript
import { rateKeys } from "./fields.js";

/**
 * Rate derivation. Every formula reads SUMMED counters and SUMMED outs — that
 * is the whole point. A rate averaged across games over-weights low-denominator
 * games (a 1-for-1 pinch-hit appearance moving a season line as much as an
 * 0-for-5 start), and stays inside a plausible range while doing it, which is
 * what makes the mistake hard to see.
 *
 * A zero denominator renders "-", matching src/digest/rates.ts.
 */

/** Three decimals, leading zero stripped: 0.31 → ".310"; 1.2 → "1.200". */
function slash(value: number): string {
  const text = value.toFixed(3);
  return text.startsWith("0.") ? text.slice(1) : text;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** numerator per nine innings, from summed outs. */
function per9(numerator: number, outs: number | null): number | null {
  return outs === null || outs === 0 ? null : (numerator * 27) / outs;
}

type Formula = (agg: Aggregate) => string;

const fixed =
  (digits: number, compute: (agg: Aggregate) => number | null): Formula =>
  (agg) => {
    const value = compute(agg);
    return value === null ? "-" : value.toFixed(digits);
  };

const slashLine =
  (compute: (agg: Aggregate) => number | null): Formula =>
  (agg) => {
    const value = compute(agg);
    return value === null ? "-" : slash(value);
  };

const c = (agg: Aggregate, key: string): number => agg.counters[key] ?? 0;

const onBase = (agg: Aggregate): number | null =>
  ratio(
    c(agg, "hits") + c(agg, "baseOnBalls") + c(agg, "hitByPitch"),
    c(agg, "atBats") + c(agg, "baseOnBalls") + c(agg, "hitByPitch") + c(agg, "sacFlies"),
  );

const slugging = (agg: Aggregate): number | null => ratio(c(agg, "totalBases"), c(agg, "atBats"));

/** Formulas shared by batting and pitching (pitching's are "against" versions). */
const SHARED: Readonly<Record<string, Formula>> = {
  avg: slashLine((a) => ratio(c(a, "hits"), c(a, "atBats"))),
  obp: slashLine(onBase),
  slg: slashLine(slugging),
  ops: slashLine((a) => {
    const o = onBase(a);
    const s = slugging(a);
    return o === null || s === null ? null : o + s;
  }),
  stolenBasePercentage: slashLine((a) =>
    ratio(c(a, "stolenBases"), c(a, "stolenBases") + c(a, "caughtStealing")),
  ),
  caughtStealingPercentage: slashLine((a) =>
    ratio(c(a, "caughtStealing"), c(a, "stolenBases") + c(a, "caughtStealing")),
  ),
  groundOutsToAirouts: fixed(2, (a) => ratio(c(a, "groundOuts"), c(a, "airOuts"))),
};

const BATTING_RATES: Readonly<Record<string, Formula>> = {
  ...SHARED,
  babip: slashLine((a) =>
    ratio(
      c(a, "hits") - c(a, "homeRuns"),
      c(a, "atBats") - c(a, "strikeOuts") - c(a, "homeRuns") + c(a, "sacFlies"),
    ),
  ),
  atBatsPerHomeRun: fixed(2, (a) => ratio(c(a, "atBats"), c(a, "homeRuns"))),
};

const PITCHING_RATES: Readonly<Record<string, Formula>> = {
  ...SHARED,
  era: fixed(2, (a) => per9(c(a, "earnedRuns"), a.outs)),
  whip: fixed(2, (a) =>
    a.outs === null || a.outs === 0
      ? null
      : ((c(a, "baseOnBalls") + c(a, "hits")) * 3) / a.outs,
  ),
  hitsPer9Inn: fixed(2, (a) => per9(c(a, "hits"), a.outs)),
  homeRunsPer9: fixed(2, (a) => per9(c(a, "homeRuns"), a.outs)),
  runsScoredPer9: fixed(2, (a) => per9(c(a, "runs"), a.outs)),
  strikeoutsPer9Inn: fixed(2, (a) => per9(c(a, "strikeOuts"), a.outs)),
  walksPer9Inn: fixed(2, (a) => per9(c(a, "baseOnBalls"), a.outs)),
  pitchesPerInning: fixed(2, (a) => per9(c(a, "numberOfPitches"), a.outs)),
  strikePercentage: slashLine((a) => ratio(c(a, "strikes"), c(a, "numberOfPitches"))),
  strikeoutWalkRatio: fixed(2, (a) => ratio(c(a, "strikeOuts"), c(a, "baseOnBalls"))),
  winPercentage: slashLine((a) => ratio(c(a, "wins"), c(a, "wins") + c(a, "losses"))),
};

const FIELDING_RATES: Readonly<Record<string, Formula>> = {
  fielding: slashLine((a) =>
    ratio(c(a, "putOuts") + c(a, "assists"), c(a, "putOuts") + c(a, "assists") + c(a, "errors")),
  ),
  rangeFactorPer9Inn: fixed(2, (a) => per9(c(a, "putOuts") + c(a, "assists"), a.outs)),
  rangeFactorPerGame: fixed(2, (a) => ratio(c(a, "putOuts") + c(a, "assists"), a.games)),
};

const FORMULAS: Readonly<Record<StatType, Readonly<Record<string, Formula>>>> = {
  batting: BATTING_RATES,
  pitching: PITCHING_RATES,
  fielding: FIELDING_RATES,
};

/** A formatted rate, or "-" when the denominator is zero or the key is unknown. */
export function deriveRate(agg: Aggregate, key: string): string {
  const formula = FORMULAS[agg.statType][key];
  return formula === undefined ? "-" : formula(agg);
}

export function deriveAllRates(agg: Aggregate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of rateKeys(agg.statType)) out[key] = deriveRate(agg, key);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stats-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify every declared rate has a formula**

Add this guard to `test/stats-aggregate.test.ts` and run it:

```typescript
import { rateKeys } from "../src/stats/fields.js";

describe("every declared rate key has a formula", () => {
  it("derives a non-'-' value for each rate given non-zero denominators", () => {
    const inputs = {
      batting: { hits: 4, atBats: 10, totalBases: 8, baseOnBalls: 2, hitByPitch: 1, sacFlies: 1,
        homeRuns: 1, strikeOuts: 2, stolenBases: 2, caughtStealing: 1, groundOuts: 4, airOuts: 3 },
      pitching: { inningsPitched: "9.0", earnedRuns: 3, hits: 6, baseOnBalls: 2, strikeOuts: 9,
        homeRuns: 1, runs: 4, numberOfPitches: 100, strikes: 65, wins: 1, losses: 1, atBats: 30,
        totalBases: 9, hitByPitch: 1, sacFlies: 1, stolenBases: 1, caughtStealing: 1,
        groundOuts: 5, airOuts: 4 },
      fielding: { innings: "9.0", putOuts: 5, assists: 3, errors: 1 },
    } as const;

    for (const statType of ["batting", "pitching", "fielding"] as const) {
      const agg = aggregate(statType, [inputs[statType]]);
      for (const key of rateKeys(statType)) {
        expect(deriveRate(agg, key), `${statType}.${key}`).not.toBe("-");
      }
    }
  });
});
```

Run: `npx vitest run test/stats-aggregate.test.ts -t "has a formula"`
Expected: PASS. A failure names the rate key missing a formula.

- [ ] **Step 6: Commit**

```bash
git add src/stats/aggregate.ts test/stats-aggregate.test.ts
git commit -m "$(cat <<'EOF'
Derive window rates from summed counters

Every formula reads summed counters and summed outs. Averaging game-level
rates over-weights low-denominator games — a 1-for-1 pinch-hit appearance
moves a season line as much as an 0-for-5 start — and stays in a
plausible range while doing it, which is what makes it hard to catch.

A test asserts every rate key the classification declares has a formula,
so adding a rate to the table without a formula fails the suite.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Window resolution

**Files:**
- Create: `src/domain/window.ts`
- Test: `test/window.test.ts`

**Interfaces:**
- Consumes: `hostDate` from `src/domain/season.ts`.
- Produces:
  ```typescript
  export type WindowSpec = "1d" | "7d" | "14d" | "21d" | "ytd";
  export const WINDOW_SPECS: readonly WindowSpec[];
  export function parseWindowSpec(raw: string): WindowSpec | null;
  export interface ResolvedWindow {
    spec: WindowSpec;
    /** Inclusive host-timezone start date, YYYY-MM-DD. */
    from: string;
    /** Inclusive host-timezone end date — the last COMPLETED day. */
    to: string;
    /** Human label for the subject line, e.g. "Last 7 Days (Jul 13-19)". */
    label: string;
    groupBy: "game" | "player";
  }
  export function resolveWindow(
    spec: WindowSpec,
    now: Date,
    tz: string,
    seasonStart?: string | null,
  ): ResolvedWindow;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/window.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseWindowSpec, resolveWindow } from "../src/domain/window.js";

const CHICAGO = "America/Chicago";

describe("parseWindowSpec", () => {
  it("accepts every supported spec", () => {
    for (const spec of ["1d", "7d", "14d", "21d", "ytd"]) {
      expect(parseWindowSpec(spec)).toBe(spec);
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(parseWindowSpec("  YTD ")).toBe("ytd");
  });

  it("returns null for anything else so callers fail closed", () => {
    for (const bad of ["", "3d", "30d", "week", "1", "d1"]) {
      expect(parseWindowSpec(bad)).toBeNull();
    }
  });
});

describe("resolveWindow — anchored on the last completed day", () => {
  // 2026-07-20 14:00 UTC is 09:00 CDT on July 20, so "yesterday" is July 19.
  const morning = new Date("2026-07-20T14:00:00Z");

  it("1d covers yesterday only, grouped by game", () => {
    const w = resolveWindow("1d", morning, CHICAGO);
    expect(w.from).toBe("2026-07-19");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("game");
  });

  it("7d covers the seven days ending yesterday, grouped by player", () => {
    const w = resolveWindow("7d", morning, CHICAGO);
    expect(w.from).toBe("2026-07-13");
    expect(w.to).toBe("2026-07-19");
    expect(w.groupBy).toBe("player");
  });

  it("14d and 21d span their full inclusive ranges", () => {
    expect(resolveWindow("14d", morning, CHICAGO).from).toBe("2026-07-06");
    expect(resolveWindow("21d", morning, CHICAGO).from).toBe("2026-06-29");
  });

  it("ytd runs from the season start through yesterday", () => {
    const w = resolveWindow("ytd", morning, CHICAGO, "2026-03-25");
    expect(w.from).toBe("2026-03-25");
    expect(w.to).toBe("2026-07-19");
  });

  it("ytd falls back to January 1 when no season start is known", () => {
    expect(resolveWindow("ytd", morning, CHICAGO, null).from).toBe("2026-01-01");
  });
});

describe("resolveWindow — run hour must not shift the window", () => {
  it("resolves identically at 06:00 and 23:00 local on the same date", () => {
    // 11:00Z = 06:00 CDT; 04:00Z next day = 23:00 CDT the same local date.
    // Before the BRYCE_TZ fix the evening case silently advanced a day.
    const early = resolveWindow("7d", new Date("2026-07-20T11:00:00Z"), CHICAGO);
    const late = resolveWindow("7d", new Date("2026-07-21T04:00:00Z"), CHICAGO);
    expect(late).toEqual(early);
    expect(early.to).toBe("2026-07-19");
  });
});

describe("resolveWindow — calendar boundaries", () => {
  it("crosses a month boundary", () => {
    const w = resolveWindow("7d", new Date("2026-08-03T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2026-08-02");
    expect(w.from).toBe("2026-07-27");
  });

  it("crosses a year boundary", () => {
    const w = resolveWindow("7d", new Date("2027-01-03T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2027-01-02");
    expect(w.from).toBe("2026-12-27");
  });

  it("crosses the spring-forward DST transition without losing a day", () => {
    // US DST begins 2026-03-08. A 7-day window ending March 9 must start March 3.
    const w = resolveWindow("7d", new Date("2026-03-10T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2026-03-09");
    expect(w.from).toBe("2026-03-03");
  });

  it("crosses the fall-back DST transition without gaining a day", () => {
    // US DST ends 2026-11-01. A 7-day window ending November 2 must start Oct 27.
    const w = resolveWindow("7d", new Date("2026-11-03T14:00:00Z"), CHICAGO);
    expect(w.to).toBe("2026-11-02");
    expect(w.from).toBe("2026-10-27");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/window.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/window.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/window.ts`:

```typescript
import { hostDate } from "./season.js";

/**
 * Digest window resolution (windowed Digest spec, 2026-07-20).
 *
 * Every window ends on the LAST COMPLETED host date — yesterday, not today.
 * A digest run at 08:00 covering "today" would be empty every morning, and a
 * run at 23:00 would cover a partial day. Anchoring on yesterday makes the
 * report independent of run hour: 06:00 and 23:00 produce the same output.
 *
 * Date arithmetic runs on the calendar date, never on the Date object's UTC
 * clock — adding "minus six days" to a timestamp breaks across DST, where a
 * local day is 23 or 25 hours long.
 */

export type WindowSpec = "1d" | "7d" | "14d" | "21d" | "ytd";

export const WINDOW_SPECS: readonly WindowSpec[] = ["1d", "7d", "14d", "21d", "ytd"];

/** Inclusive day counts; `ytd` is anchored on the season start instead. */
const SPAN_DAYS: Readonly<Record<Exclude<WindowSpec, "ytd">, number>> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "21d": 21,
};

export interface ResolvedWindow {
  spec: WindowSpec;
  /** Inclusive host-timezone start date, YYYY-MM-DD. */
  from: string;
  /** Inclusive host-timezone end date — the last COMPLETED day. */
  to: string;
  label: string;
  groupBy: "game" | "player";
}

export function parseWindowSpec(raw: string): WindowSpec | null {
  const normalized = raw.trim().toLowerCase();
  return (WINDOW_SPECS as readonly string[]).includes(normalized)
    ? (normalized as WindowSpec)
    : null;
}

/** Calendar-date arithmetic: "2026-03-09" minus 6 days → "2026-03-03". */
function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Noon UTC keeps the arithmetic clear of any timezone's midnight.
  const anchor = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** "2026-07-13" → "Jul 13" */
function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(d);
}

function labelFor(spec: WindowSpec, from: string, to: string): string {
  if (spec === "1d") return shortDate(to);
  if (spec === "ytd") return `Season to Date (${shortDate(from)}-${shortDate(to)})`;
  const days = SPAN_DAYS[spec];
  return `Last ${days} Days (${shortDate(from)}-${shortDate(to)})`;
}

export function resolveWindow(
  spec: WindowSpec,
  now: Date,
  tz: string,
  seasonStart: string | null = null,
): ResolvedWindow {
  const to = shiftDate(hostDate(now, tz), -1);
  const from =
    spec === "ytd"
      ? (seasonStart ?? `${to.slice(0, 4)}-01-01`)
      : shiftDate(to, -(SPAN_DAYS[spec] - 1));

  return {
    spec,
    from,
    to,
    label: labelFor(spec, from, to),
    groupBy: spec === "1d" ? "game" : "player",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/window.test.ts`
Expected: PASS, including both DST cases.

- [ ] **Step 5: Run the quality gate**

Run: `npm run typecheck && npm run lint && npm test && ruby scripts/parity_check.rb`
Expected: all green. Nothing consumes these modules yet, so no existing suite should change.

- [ ] **Step 6: Commit**

```bash
git add src/domain/window.ts test/window.test.ts
git commit -m "$(cat <<'EOF'
Resolve digest windows anchored on the last completed day

Windows end yesterday, not today: a morning run covering "today" would
be empty every day and an evening run would cover a partial one.
Anchoring on the last completed date makes output independent of run
hour, which a test pins directly.

Date math runs on calendar dates rather than timestamp arithmetic, so
DST transitions — where a local day is 23 or 25 hours — cannot shift a
window boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage.** Implements spec steps 2 and 3 of 6: `src/stats/fields.ts`, `src/stats/aggregate.ts`,
`src/domain/window.ts`, with the spec's "Aggregation model", "Window semantics", and the aggregation
half of "Testing strategy". Steps 4-6 (assemble, render, wiring, migration) are the third plan.

**Placeholder scan.** No TBDs; every step carries literal code and an expected result.

**Type consistency.** `StatType` is defined once in `fields.ts` and imported by `aggregate.ts`.
`Aggregate` is defined in Task 2 and consumed unchanged in Task 3. `ResolvedWindow.groupBy` uses the
same `"game" | "player"` union the spec's row-grain section names, which Plan 3's `assemble.ts`
consumes.

**Deliberate gaps, deferred to Plan 3.**

- **`errors` on batting.** ADR 0033 merges a fielding row's error count into the batting line. The
  classification table declares `errors` a batting counter so the merged field aggregates, but the
  merge itself happens at assembly, which Plan 3 owns.
- **Aggregated `QS`.** The spec calls for quality starts as a *count* across the window. It is not a
  field in the source payload — `src/digest/rates.ts` computes it per game from outs and earned runs —
  so it cannot be a classified counter. Plan 3 computes it during assembly, where per-game rows are
  still in hand, and passes it to the renderer alongside the `Aggregate`.
- **Empty-window rows.** A player with no games yields `aggregate(statType, [])`, whose counters are
  all zero and whose rates all render `"-"`. The spec's zero row wants `.000/.000/.000` in the
  `Batting` column rather than `-`; that presentation choice belongs to the renderer, not here.
