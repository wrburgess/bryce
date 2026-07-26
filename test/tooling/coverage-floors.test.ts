import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageConfigDefaults } from "vitest/config";
import vitestConfig from "../../vitest.config.js";
import { FLOORS, METRICS, evaluate, main, relativeKey, type Floors, type Summary } from "../../scripts/coverage-floors.js";

// Tests for the per-file coverage floor gate (scripts/coverage-floors.ts, issue #28).
//
// Two jobs here. First, pin the manifest itself: the gate is only as strong as the
// numbers in FLOORS, and silently deleting or weakening an entry must fail by name.
// Second, prove the checker fails on every shape of "the floor stopped being enforced"
// -- a path missing from the summary, an empty manifest, a summary that was never
// written -- because each of those is a silent pass in Vitest's own thresholds.
//
// Summaries are built programmatically (rules/testing.md: no schema-coupled static
// fixture), matching the json-summary reporter's shape.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The measured baseline this manifest was rounded down from, recorded so a future
// edit can tell an intentional floor change from an accidental one.
const EXPECTED_FLOORS: Floors = {
  "src/cli/main.ts": { statements: 42, branches: 50 },
  "src/cli/seed.ts": { statements: 53, branches: 61 },
  "src/server.ts": { statements: 56, branches: 76 },
  "src/cli/batch-add.ts": { statements: 66, branches: 54 },
  "src/cli/migrate.ts": { statements: 70, branches: 33 },
  "src/cli/restore.ts": { statements: 78, branches: 61 },
  "src/watchlist/service.ts": { statements: 86, branches: 79 },
};

// Build a summary entry at the given percentages, in the reporter's real shape.
function entry(statements: number, branches: number) {
  return {
    lines: { total: 100, covered: statements, skipped: 0, pct: statements },
    statements: { total: 100, covered: statements, skipped: 0, pct: statements },
    functions: { total: 10, covered: 10, skipped: 0, pct: 100 },
    branches: { total: 100, covered: branches, skipped: 0, pct: branches },
  };
}

// A summary in which every floored path sits comfortably above its floor.
function passingSummary(floors: Floors = FLOORS, prefix = ""): Summary {
  const summary: Summary = { total: entry(100, 100) };
  for (const [path, floor] of Object.entries(floors)) {
    summary[`${prefix}${path}`] = entry(floor.statements + 5, floor.branches + 5);
  }
  return summary;
}

describe("FLOORS manifest", () => {
  // Case 1 -- the manifest is the gate. Weakening or dropping an entry fails HERE,
  // by name, instead of quietly widening what the checker will accept.
  it("holds exactly the seven expected paths with the expected floors", () => {
    expect(FLOORS).toEqual(EXPECTED_FLOORS);
    expect(Object.keys(FLOORS).sort()).toEqual(Object.keys(EXPECTED_FLOORS).sort());
    expect(Object.keys(FLOORS)).toHaveLength(7);
  });

  it("declares both metrics as whole-number percentages in range for every entry", () => {
    for (const [path, floor] of Object.entries(FLOORS)) {
      for (const metric of METRICS) {
        const value = floor[metric];
        expect(Number.isInteger(value), `${path} ${metric} must be a whole number`).toBe(true);
        expect(value, `${path} ${metric} out of range`).toBeGreaterThan(0);
        expect(value, `${path} ${metric} out of range`).toBeLessThanOrEqual(100);
      }
    }
  });

  // Case 2 -- a rename that forgot the manifest fails with a pointed message, rather
  // than waiting for the next full coverage run to surface as an "absent" violation.
  it("names only paths that exist on disk", () => {
    for (const path of Object.keys(FLOORS)) {
      expect(existsSync(resolve(REPO_ROOT, path)), `floored path not found on disk: ${path}`).toBe(true);
    }
  });
});

describe("relativeKey", () => {
  it("folds an absolute in-repo key to its repo-relative path", () => {
    expect(relativeKey("/repo/root/src/cli/main.ts", "/repo/root")).toBe("src/cli/main.ts");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(relativeKey("/repo/root/src/cli/main.ts", "/repo/root/")).toBe("src/cli/main.ts");
  });

  it("leaves an already-relative key alone and strips a leading ./", () => {
    expect(relativeKey("src/cli/main.ts", "/repo/root")).toBe("src/cli/main.ts");
    expect(relativeKey("./src/cli/main.ts", "/repo/root")).toBe("src/cli/main.ts");
  });

  it("does not rewrite an absolute key from outside the repo", () => {
    expect(relativeKey("/elsewhere/src/cli/main.ts", "/repo/root")).toBe("/elsewhere/src/cli/main.ts");
  });

  it("does not treat a sibling directory with a shared prefix as inside the root", () => {
    expect(relativeKey("/repo/root-other/src/a.ts", "/repo/root")).toBe("/repo/root-other/src/a.ts");
  });
});

describe("evaluate", () => {
  it("reports no violation when every floored file is above its floor", () => {
    expect(evaluate(passingSummary(), FLOORS, REPO_ROOT)).toEqual([]);
  });

  // Case 3 -- the hole Vitest's own thresholds leave open. A floored file that is
  // renamed, newly excluded, or dropped by a narrowed `include` stops being measured;
  // Vitest passes silently, this must not.
  it("reports a floored path that is absent from the summary", () => {
    const summary = passingSummary();
    delete summary["src/cli/migrate.ts"];

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/cli/migrate.ts");
    expect(violations[0]).toContain("absent from coverage summary");
  });

  it("reports every absent path, not just the first", () => {
    const violations = evaluate({ total: entry(100, 100) }, FLOORS, REPO_ROOT);

    expect(violations).toHaveLength(Object.keys(FLOORS).length);
    for (const path of Object.keys(FLOORS)) {
      expect(violations.some((v) => v.startsWith(`${path} ->`)), `no violation for ${path}`).toBe(true);
    }
  });

  // Case 4 -- a statements regression names the file, metric, measured value, and floor.
  it("reports statements below the floor with file, metric, measured, and floor", () => {
    const summary = passingSummary();
    summary["src/watchlist/service.ts"] = entry(80.12, 90);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toEqual(["src/watchlist/service.ts statements -> 80.12 is below floor 86"]);
  });

  // Case 5 -- both metrics are checked independently; a branches-only regression with
  // healthy statements must not slip through.
  it("reports branches below the floor even when statements are fine", () => {
    const summary = passingSummary();
    summary["src/server.ts"] = entry(99, 70);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toEqual(["src/server.ts branches -> 70 is below floor 76"]);
  });

  it("reports both metrics when both regress on the same file", () => {
    const summary = passingSummary();
    summary["src/cli/seed.ts"] = entry(10, 20);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toEqual([
      "src/cli/seed.ts statements -> 10 is below floor 53",
      "src/cli/seed.ts branches -> 20 is below floor 61",
    ]);
  });

  // Case 6 -- a floor is a minimum, not an exclusive bound.
  it("passes when a measurement is exactly equal to its floor", () => {
    const summary: Summary = { total: entry(100, 100) };
    for (const [path, floor] of Object.entries(FLOORS)) {
      summary[path] = entry(floor.statements, floor.branches);
    }

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([]);
  });

  // Case 7 -- the boundary is real, not rounded away.
  it("fails when a measurement is 0.01 below its floor", () => {
    const summary = passingSummary();
    summary["src/cli/restore.ts"] = entry(77.99, 100);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toEqual(["src/cli/restore.ts statements -> 77.99 is below floor 78"]);
  });

  // Case 8 -- deleting the floors is itself the failure. A checker that iterates an
  // empty manifest and returns [] is the exact hollow gate this script exists to avoid.
  it("fails loudly on an empty manifest instead of passing vacuously", () => {
    const violations = evaluate(passingSummary(), {}, REPO_ROOT);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("empty floor manifest");
  });

  // Case 9 -- unfloored files are simply not this gate's business.
  it("ignores summary entries that carry no floor", () => {
    const summary = passingSummary();
    summary["src/db/schema.ts"] = entry(3, 2);
    summary["src/export/csv.ts"] = entry(0, 0);

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([]);
  });

  // Case 10 -- the real reporter keys files by absolute path; matching must survive that.
  it("matches floors against absolute summary keys", () => {
    const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([]);
  });

  it("still detects a regression when summary keys are absolute", () => {
    const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);
    summary[`${REPO_ROOT}/src/cli/main.ts`] = entry(1, 1);

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([
      "src/cli/main.ts statements -> 1 is below floor 42",
      "src/cli/main.ts branches -> 1 is below floor 50",
    ]);
  });

  it("does not mistake the aggregate `total` row for a file", () => {
    const summary = passingSummary();
    summary["total"] = entry(0, 0);

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([]);
  });

  it("reports a floored entry whose metric has no percentage", () => {
    const summary = passingSummary();
    summary["src/cli/migrate.ts"] = { statements: {}, branches: { pct: 99 } };

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toEqual(["src/cli/migrate.ts statements -> no percentage in coverage summary entry"]);
  });
});

describe("main (CLI)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Capture both streams so the assertions are on what an operator or CI actually sees.
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    return { out: () => out.join(""), err: () => err.join("") };
  }

  function summaryFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cov-floors-"));
    dirs.push(dir);
    const path = join(dir, "coverage-summary.json");
    writeFileSync(path, body);
    return path;
  }

  it("exits 0 and prints an OK line for a passing summary", () => {
    const path = summaryFile(JSON.stringify(passingSummary(FLOORS, `${REPO_ROOT}/`)));
    const io = capture();

    expect(main(["--summary", path])).toBe(0);
    expect(io.out()).toContain("coverage_floors: OK - all 7 floored file(s) present and at or above floor.");
    expect(io.err()).toBe("");
  });

  it("exits 1 and prints each violation for a failing summary", () => {
    const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);
    summary[`${REPO_ROOT}/src/cli/migrate.ts`] = entry(90, 10);
    const path = summaryFile(JSON.stringify(summary));
    const io = capture();

    expect(main([`--summary=${path}`])).toBe(1);
    expect(io.out()).toContain("coverage_floors: FAIL - 1 violation(s)");
    expect(io.out()).toContain("src/cli/migrate.ts branches -> 10 is below floor 33");
  });

  // Case 11 -- absence of evidence is never a pass. If the report was not written the
  // gate must go red, not shrug and exit 0.
  it("exits 1 when the summary file is missing", () => {
    const io = capture();

    expect(main(["--summary", join(tmpdir(), "cov-floors-does-not-exist", "coverage-summary.json")])).toBe(1);
    expect(io.err()).toContain("coverage_floors: FAIL - cannot read coverage summary");
    expect(io.err()).toContain("not_run");
    expect(io.out()).toBe("");
  });

  it("exits 1 when the summary is not valid JSON", () => {
    const path = summaryFile("{ not json");
    const io = capture();

    expect(main(["--summary", path])).toBe(1);
    expect(io.err()).toContain("coverage summary is not valid JSON");
  });

  it("exits 1 when the summary is a JSON array rather than an object", () => {
    const path = summaryFile("[]");
    const io = capture();

    expect(main(["--summary", path])).toBe(1);
    expect(io.err()).toContain("coverage summary is not a JSON object");
  });

  it("exits 2 on an unknown flag instead of silently checking the default summary", () => {
    const io = capture();

    expect(main(["--nope"])).toBe(2);
    expect(io.err()).toContain("coverage_floors: usage error - invalid option: --nope");
    expect(io.out()).toBe("");
  });

  it("exits 2 when --summary is given no value", () => {
    const io = capture();

    expect(main(["--summary"])).toBe(2);
    expect(io.err()).toContain("coverage_floors: usage error - missing argument: --summary");
  });

  it("emits ASCII-only output on both streams", () => {
    const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);
    summary[`${REPO_ROOT}/src/server.ts`] = entry(1, 1);
    const path = summaryFile(JSON.stringify(summary));
    const io = capture();

    main(["--summary", path]);

    // rules/scripting.md / ADR 0011: a non-UTF-8 CI locale must be able to read this.
    // eslint-disable-next-line no-control-regex
    expect(io.out() + io.err()).toMatch(/^[\x00-\x7F]*$/);
  });
});

// Case 12 -- each of these is one word away from disabling the diagnostic silently, and
// nothing else in the suite would notice.
describe("vitest.config.ts coverage block", () => {
  const coverage = (vitestConfig.test?.coverage ?? {}) as Record<string, unknown>;

  it("uses the v8 provider", () => {
    expect(coverage["provider"]).toBe("v8");
  });

  it("scopes collection to application source", () => {
    expect(coverage["include"]).toEqual(["src/**/*.ts"]);
  });

  it("keeps reportOnFailure on, so a red suite still leaves a summary to check", () => {
    // Vitest defaults this to false: without it, one failing test suppresses the whole
    // report and the floor check has nothing to read.
    expect(coverage["reportOnFailure"]).toBe(true);
  });

  it("emits json-summary as well as text", () => {
    expect(coverage["reporter"]).toContain("json-summary");
    expect(coverage["reporter"]).toContain("text");
  });

  it("excludes the type-only modules on top of the provider defaults, not instead of them", () => {
    const exclude = coverage["exclude"] as string[];

    expect(exclude).toContain("src/mailer/types.ts");
    expect(exclude).toContain("src/server/deps.ts");
    // Assigning `exclude` replaces the defaults outright; the spread is what keeps
    // node_modules, dist, config files, and friends out of the report.
    for (const preset of coverageConfigDefaults.exclude) {
      expect(exclude, `provider default dropped from coverage.exclude: ${preset}`).toContain(preset);
    }
  });

  it("declares no thresholds, so enforcement is not split across two mechanisms", () => {
    // Vitest's resolveThresholds passes silently when a glob matches zero files, which
    // is exactly the failure mode scripts/coverage-floors.ts exists to close.
    expect(coverage["thresholds"]).toBeUndefined();
  });

  it("does not exclude any floored path from collection", () => {
    const exclude = coverage["exclude"] as string[];
    for (const path of Object.keys(FLOORS)) {
      expect(exclude, `floored path is excluded from coverage: ${path}`).not.toContain(path);
    }
  });
});
