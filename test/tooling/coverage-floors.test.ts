import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageConfigDefaults } from "vitest/config";
import vitestConfig from "../../vitest.config.js";
import { FLOORS, METRICS, evaluate, main, relativeKey, type Floors, type Summary } from "../../scripts/coverage-floors.js";

// Tests for the per-file coverage floor gate (scripts/coverage-floors.ts, issue #28).
//
// Three jobs here. First, pin the manifest itself: the gate is only as strong as the
// numbers in FLOORS, and silently deleting or weakening an entry must fail by name.
// Second, prove the checker fails on every shape of "the floor stopped being enforced"
// -- a path missing from the summary, an empty manifest, a summary that was never
// written -- because each of those is a silent pass in Vitest's own thresholds.
// Third, pin the gate's CALLERS. A checker nothing invokes is not a gate: deleting
// `&& tsx scripts/coverage-floors.ts` from package.json, or swapping the CI Test step
// back to plain `npm test`, would leave every check in this repo green with zero floors
// enforced. Those two invocations are asserted against the real files.
//
// Summaries are built programmatically (rules/testing.md: no schema-coupled static
// fixture), matching the json-summary reporter's shape.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The measured baseline this manifest was rounded down from, recorded so a future
// edit can tell an intentional floor change from an accidental one.
const EXPECTED_FLOORS: Floors = {
  "src/cli/main.ts": { statements: 42, branches: 50 },
  "src/cli/seed.ts": { statements: 54, branches: 61 },
  "src/server.ts": { statements: 56, branches: 76 },
  "src/cli/migrate.ts": { statements: 70, branches: 33 },
  "src/cli/restore.ts": { statements: 78, branches: 61 },
  "src/cli/tick.ts": { statements: 82, branches: 78 },
  "src/cli/batch-add.ts": { statements: 85, branches: 73 },
  "src/watchlist/service.ts": { statements: 86, branches: 79 },
  "src/cli/refresh.ts": { statements: 90, branches: 87 },
  "src/jobs/refresh.ts": { statements: 97, branches: 88 },
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
  it("holds exactly the ten expected paths with the expected floors", () => {
    expect(FLOORS).toEqual(EXPECTED_FLOORS);
    expect(Object.keys(FLOORS).sort()).toEqual(Object.keys(EXPECTED_FLOORS).sort());
    expect(Object.keys(FLOORS)).toHaveLength(10);
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

  // Normalization must not depend on the separator of the machine READING the summary.
  // Keying off the runtime `sep` leaves backslashes intact on POSIX, so a Windows-shaped
  // key stops matching its floor and the gate blames a file that never regressed.
  it("folds backslash separators even when the runtime separator is /", () => {
    expect(relativeKey("src\\cli\\main.ts", "/repo/root")).toBe("src/cli/main.ts");
    expect(relativeKey(".\\src\\cli\\main.ts", "/repo/root")).toBe("src/cli/main.ts");
  });

  it("folds a backslash-spelled root when matching an absolute key", () => {
    expect(relativeKey("/repo/root/src/cli/main.ts", "\\repo\\root")).toBe("src/cli/main.ts");
  });

  // Reviewer finding (PR #138): absoluteness was decided by `isAbsolute`, which is bound to
  // the READING platform. On POSIX it calls a drive-letter path relative, so the root was
  // never stripped and EVERY floored file came back "absent from coverage summary" —
  // precisely the false diagnosis the cross-platform handling above exists to prevent.
  it("strips a Windows drive-letter root when read on POSIX", () => {
    expect(relativeKey("C:\\repo\\root\\src\\cli\\main.ts", "C:\\repo\\root")).toBe("src/cli/main.ts");
    expect(relativeKey("C:/repo/root/src/cli/main.ts", "C:/repo/root/")).toBe("src/cli/main.ts");
  });

  it("treats a drive letter as case-insensitive, as Windows does", () => {
    expect(relativeKey("C:\\repo\\root\\src\\cli\\main.ts", "c:\\repo\\root")).toBe("src/cli/main.ts");
  });

  // Reviewer follow-up (PR #138): Windows compares the WHOLE path case-insensitively, not
  // just the drive. Folding only the drive left a root whose directory casing differed
  // unstripped, so the file was again falsely reported absent.
  it("matches a Windows root whose directory casing differs", () => {
    expect(relativeKey("C:\\Repo\\Root\\src\\cli\\main.ts", "c:\\repo\\root")).toBe("src/cli/main.ts");
    expect(relativeKey("C:/repo/root/src/cli/main.ts", "C:/REPO/ROOT")).toBe("src/cli/main.ts");
  });

  // The counterpart that must NOT change: POSIX paths are case-sensitive, so /repo/Root
  // and /repo/root are genuinely different directories and must not be folded together.
  it("keeps POSIX root matching case-sensitive", () => {
    expect(relativeKey("/repo/Root/src/cli/main.ts", "/repo/root")).toBe("/repo/Root/src/cli/main.ts");
  });

  // Reviewer follow-up (PR #138): a UNC root's forward-slash spelling is indistinguishable
  // from a POSIX path with two leading slashes, so case-folding it would silently make
  // those POSIX paths case-insensitive — stripping a root that does not match and letting a
  // WRONG entry satisfy a floor. UNC is therefore compared case-sensitively like any other
  // path; a case-differing UNC root simply fails to match, which is the safe direction.
  it("keeps a two-leading-slash path case-sensitive rather than treating it as UNC", () => {
    expect(relativeKey("//repo/Root/src/cli/main.ts", "//repo/root")).toBe("//repo/Root/src/cli/main.ts");
  });

  it("still strips a UNC root spelled in matching case", () => {
    expect(relativeKey("\\\\server\\share\\src\\cli\\main.ts", "\\\\server\\share")).toBe("src/cli/main.ts");
  });

  it("does not rewrite a drive-letter key from outside the root", () => {
    expect(relativeKey("D:\\other\\src\\cli\\main.ts", "C:\\repo\\root")).toBe("D:/other/src/cli/main.ts");
    // A sibling sharing a textual prefix is still outside the root.
    expect(relativeKey("C:\\repo\\root-other\\src\\a.ts", "C:\\repo\\root")).toBe("C:/repo/root-other/src/a.ts");
  });

  it("treats a UNC-style key as absolute rather than relative", () => {
    expect(relativeKey("\\\\server\\share\\src\\a.ts", "/repo/root")).toBe("//server/share/src/a.ts");
  });

  // The guard must not swallow genuinely relative keys that merely contain a colon.
  it("still treats a colon-bearing relative key as relative", () => {
    expect(relativeKey("src/cli/main:copy.ts", "/repo/root")).toBe("src/cli/main:copy.ts");
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
      "src/cli/seed.ts statements -> 10 is below floor 54",
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
    // A weak aggregate with every floored file healthy. `total` carries no floor and is
    // not a path, so it must contribute nothing -- note it is 1% covered, not 0%: an
    // all-zero aggregate is the partial-run signal asserted separately below.
    summary["total"] = entry(1, 1);

    expect(evaluate(summary, FLOORS, REPO_ROOT)).toEqual([]);
  });

  // Case 13 -- a partial/filtered run must be diagnosed as such. With `coverage.all`,
  // `vitest run --coverage <one-file>` still enumerates every src/ file, at 0%. Without
  // this sentinel the gate goes red naming seven files that never regressed, which is a
  // FALSE diagnosis handed to whoever is iterating -- worse than no gate at all.
  it("names a partial or filtered run instead of blaming every floored file", () => {
    const summary: Summary = {
      total: { ...entry(0, 0), statements: { total: 9529, covered: 0, pct: 0 } },
    };
    for (const path of Object.keys(FLOORS)) summary[path] = entry(0, 0);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("0 of 9529 statements covered overall");
    expect(violations[0]).toContain("partial, filtered, or failed run");
    expect(violations[0]).toContain("npm run test:coverage");
    // The whole point: no per-file line, because no per-file number here is meaningful.
    for (const path of Object.keys(FLOORS)) {
      expect(violations[0], `partial run should not blame ${path}`).not.toContain(path);
    }
  });

  // The sentinel must not become an escape hatch: a run that genuinely covered almost
  // nothing, but covered SOMETHING, is a real regression and gets the per-file report.
  it("does not fire the partial-run sentinel for a legitimately low but nonzero run", () => {
    const summary: Summary = {
      total: { ...entry(1, 1), statements: { total: 9529, covered: 1, pct: 0.01 } },
    };
    for (const path of Object.keys(FLOORS)) summary[path] = entry(0.5, 0.5);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations.some((v) => v.includes("partial, filtered, or failed run"))).toBe(false);
    expect(violations).toContain("src/cli/seed.ts statements -> 0.5 is below floor 54");
    expect(violations).toHaveLength(Object.keys(FLOORS).length * METRICS.length);
  });

  it("does not fire the partial-run sentinel when the summary carries no total row", () => {
    expect(evaluate(passingSummary(), FLOORS, REPO_ROOT)).toEqual([]);
  });

  // Case 14 -- two summary keys folding to one relative path would last-write-wins, and
  // the survivor may be the healthy spelling while the real, lower measurement vanishes.
  it("reports two summary keys that fold to the same relative path", () => {
    const summary = passingSummary();
    // Same file, two spellings the reporter could plausibly emit across runs.
    summary[`${REPO_ROOT}/src/cli/restore.ts`] = entry(2, 2);

    const violations = evaluate(summary, FLOORS, REPO_ROOT);

    expect(violations.some((v) => v.startsWith("src/cli/restore.ts -> duplicate key"))).toBe(true);
    expect(violations[0]).toContain("one measurement is masked");
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
    expect(io.out()).toContain(`coverage_floors: OK - all ${Object.keys(FLOORS).length} floored file(s) present and at or above floor.`);
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

  // A partial run gets its own headline and its own remedy: "raise the covering tests"
  // would point the reader at code that is not broken.
  it("exits 1 with the partial-run headline, not the floor-regression remedy", () => {
    const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);
    summary["total"] = { ...entry(0, 0), statements: { total: 9529, covered: 0, pct: 0 } };
    const path = summaryFile(JSON.stringify(summary));
    const io = capture();

    expect(main(["--summary", path])).toBe(1);
    expect(io.out()).toContain("coverage_floors: FAIL - coverage report is not from a full-suite run");
    expect(io.out()).toContain("partial, filtered, or failed run");
    expect(io.out()).not.toContain("Raise the covering tests");
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

  // Case 15 -- a mis-invocation must land on the usage channel, not masquerade as a
  // coverage failure. `--summary --nope` swallowing the next flag as a path exits 1
  // with "cannot read coverage summary", which sends the reader hunting a report that
  // was never the problem.
  it("exits 2 rather than 1 when --summary swallows a following flag", () => {
    const io = capture();

    expect(main(["--summary", "--nope"])).toBe(2);
    expect(io.err()).toContain("coverage_floors: usage error - --summary requires a path, got an option: --nope");
    expect(io.err()).not.toContain("cannot read coverage summary");
    expect(io.out()).toBe("");
  });

  // An empty value resolves to the repo root and dies on EISDIR -- again exit 1 for what
  // is plainly a typo.
  it("exits 2 on an empty --summary= value instead of resolving to the repo root", () => {
    const io = capture();

    expect(main(["--summary="])).toBe(2);
    expect(io.err()).toContain("coverage_floors: usage error - --summary= requires a non-empty path");
    expect(io.err()).not.toContain("cannot read coverage summary");
    expect(io.out()).toBe("");
  });

  it("exits 2 on an option-shaped --summary= value", () => {
    const io = capture();

    expect(main(["--summary=--nope"])).toBe(2);
    expect(io.err()).toContain("coverage_floors: usage error - --summary= requires a path, got an option: --nope");
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

// Case 16 -- every test above calls the exported main(), which BYPASSES the
// `import.meta.url === resolve(process.argv[1])` guard at the foot of the script. That
// guard is what makes the file an executable gate: if the comparison ever goes false
// (a path-resolution change, a loader that rewrites argv, a move of the file), the
// script runs, does nothing, and exits 0 -- green CI, zero enforcement. One real
// subprocess proves the wiring end to end. Bounded, offline, and cleaned up.
describe("direct invocation (real subprocess)", () => {
  const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const SCRIPT = join(REPO_ROOT, "scripts", "coverage-floors.ts");
  const SPAWN_TIMEOUT_MS = 60_000;

  it(
    "exits non-zero and prints the greppable prefix when run as a script",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cov-floors-spawn-"));
      try {
        const summary = passingSummary(FLOORS, `${REPO_ROOT}/`);
        summary[`${REPO_ROOT}/src/watchlist/service.ts`] = entry(1, 1);
        const path = join(dir, "coverage-summary.json");
        writeFileSync(path, JSON.stringify(summary));

        const res = spawnSync(TSX_BIN, [SCRIPT, "--summary", path], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: SPAWN_TIMEOUT_MS,
          // No network, no inherited app config: PATH only (SystemRoot for Windows spawn).
          env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
        });

        // A sandbox that forbids process-spawn is surfaced, never silently skipped.
        if (res.error) throw res.error;
        expect(res.status, `unexpected exit\nstdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
        expect(res.stdout).toContain("coverage_floors: FAIL -");
        expect(res.stdout).toContain("src/watchlist/service.ts statements -> 1 is below floor 86");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// Case 17 -- the gate's CALLERS. Nothing else in this repo runs the checker, so deleting
// `&& tsx scripts/coverage-floors.ts` from package.json, or reverting the CI Test step to
// plain `npm test`, is a silently-green edit: tests, lint, typecheck and CI all stay green
// with zero floors enforced. Assert the real files, so that edit fails here by name.
describe("gate invocation", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  it("wires scripts/coverage-floors.ts into the test:coverage npm script", () => {
    const script = pkg.scripts?.["test:coverage"];

    expect(script, "package.json has no `test:coverage` script; the floor gate has no caller").toBeTypeOf("string");
    expect(
      script,
      "`test:coverage` no longer invokes scripts/coverage-floors.ts: the floors are declared but never checked, and every check in this repo stays green",
    ).toContain("scripts/coverage-floors.ts");
    // The checker reads the report that run produced, so the run must produce one.
    expect(script, "`test:coverage` must produce the coverage report the checker reads").toContain("--coverage");
  });

  it("runs the checker through the project's own tsx, not a bare PATH lookup", () => {
    // rules/scripting.md: a dev-dependency binary is not on PATH in a fresh CI shell.
    // npm run puts node_modules/.bin on PATH, which is why the bare name is safe HERE
    // and only here -- pin that it stays inside an npm script rather than drifting into
    // a raw CI `run:` line.
    expect(pkg.scripts?.["test:coverage"]).toMatch(/tsx\s+scripts\/coverage-floors\.ts/);
  });

  it("runs npm run test:coverage as the CI Test step", () => {
    // Targeted line scan, not a YAML parser: this repo adds no dependency for one assertion
    // (rules/scripting.md), and check-action-pins.ts scans these workflows the same way.
    const lines = readFileSync(join(REPO_ROOT, ".github/workflows/app.yml"), "utf8").split("\n");
    const stepIndex = lines.findIndex((line) => /^\s*-\s+name:\s+Test\s*$/.test(line));

    expect(stepIndex, "no `- name: Test` step in .github/workflows/app.yml").toBeGreaterThan(-1);

    // The step's own `run:`, stopping at the next list item so a later step cannot satisfy this.
    let command: string | undefined;
    for (let i = stepIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*-\s/.test(line)) break;
      const match = /^\s*run:\s*(.+?)\s*$/.exec(line);
      if (match) {
        command = match[1];
        break;
      }
    }

    expect(
      command,
      "the CI Test step must run `npm run test:coverage`; plain `npm test` runs the same suite with the coverage report and the per-file floor check silently dropped",
    ).toBe("npm run test:coverage");
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

  it("keeps reportOnFailure on, so a failing run still leaves a report to diagnose from", () => {
    // Vitest defaults this to false: without it, one failing test suppresses the whole
    // report. This does NOT keep the gate running through a red suite -- `test:coverage`
    // chains with `&&`, so vitest failing short-circuits before the checker is reached,
    // and a floor regression alongside an unrelated failure goes unreported until that
    // failure is fixed. What it buys is the `text` output and the on-disk coverage/
    // artifact surviving a failing run, so the numbers are there while debugging.
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
