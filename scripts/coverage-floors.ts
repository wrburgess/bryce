// coverage-floors.ts — per-file coverage floors, enforced against the report the run
// actually produced (issue #28).
//
// Why this is a post-run script and not `coverage.thresholds` in vitest.config.ts:
// Vitest builds each threshold comparison from the files its glob matched
// (`resolveThresholds`, node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js ~:4102),
// so a threshold whose glob matches ZERO files passes silently. A floored file that
// is renamed, added to `coverage.exclude`, or dropped by a narrowed `coverage.include`
// therefore stops being enforced with no warning at all — the floor becomes a no-op
// while the gate still prints green. The invariant that actually holds is:
//
//   every floored path appears in the summary this run produced, at or above its floor.
//
// That can only be checked after the report is written, which is why enforcement lives
// here rather than in the suite or in the Vitest config. Deleting the manifest is itself
// a failure, so the gate cannot be emptied into a vacuous pass.
//
// Runs on the app's own Node/TS toolchain via `tsx` (ADR 0039). Output is ASCII-only
// and greppable (rules/scripting.md, ADR 0011).
//
// Usage:
//   npx tsx scripts/coverage-floors.ts [--summary PATH]
//     --summary PATH   coverage-summary.json to read
//                      (default: coverage/coverage-summary.json, relative to the repo root)
//
// Exit status: 0 when every floored path is present and at or above its floor;
// 1 when any floor is violated or the summary is missing/unreadable/malformed
// (absence of evidence is never a pass); 2 on a usage error.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_SUMMARY = "coverage/coverage-summary.json";

// The metrics a floor constrains. Lines track statements almost exactly under the v8
// provider, and functions are a weaker signal than branches, so these two are the pair
// that catch a real regression.
export const METRICS = ["statements", "branches"] as const;

export type Metric = (typeof METRICS)[number];

export type Floor = Record<Metric, number>;

export type Floors = Record<string, Floor>;

export type SummaryEntry = Partial<Record<Metric | "lines" | "functions", { pct?: number }>>;

export type Summary = Record<string, SummaryEntry>;

// Per-file floors, keyed by exact repo-relative path, ordered by ascending statement
// coverage. Each value is the measured percentage at the baseline rounded DOWN to a whole
// number, so ordinary churn does not trip the gate but a real regression does.
//
// Baseline command (run at 99e3c15, whose src/ tree matches origin/main d8dbb13):
//   npx vitest run --coverage --coverage.all --coverage.reportOnFailure \
//     --coverage.include='src/**/*.ts' --coverage.reporter=text
//
// Raising a floor is welcome. LOWERING or DELETING one is a deliberate, reviewable act:
// test/tooling/coverage-floors.test.ts pins this table entry by entry and fails by name.
export const FLOORS: Floors = {
  "src/cli/main.ts": { statements: 42, branches: 50 },
  "src/cli/seed.ts": { statements: 53, branches: 61 },
  "src/server.ts": { statements: 56, branches: 76 },
  "src/cli/batch-add.ts": { statements: 66, branches: 54 },
  "src/cli/migrate.ts": { statements: 70, branches: 33 },
  "src/cli/restore.ts": { statements: 78, branches: 61 },
  "src/watchlist/service.ts": { statements: 86, branches: 79 },
};

// The json-summary reporter keys files by ABSOLUTE path. Fold a key to the repo-relative,
// forward-slash form the manifest uses so the two can be matched. A key that is already
// relative, or absolute but outside the repo, is returned normalized but unrewritten —
// it then simply fails to match a floor, which surfaces as a loud "absent" violation.
export function relativeKey(key: string, root: string): string {
  const posix = key.split(sep).join("/").replace(/^\.\//, "");
  if (!isAbsolute(key)) return posix;
  const base = root.split(sep).join("/").replace(/\/+$/, "");
  if (base !== "" && posix.startsWith(`${base}/`)) return posix.slice(base.length + 1);
  return posix;
}

// Pure: compare a coverage summary against a floor manifest and return every violation as
// an ASCII, greppable line. An empty result means the gate passed.
export function evaluate(summary: Summary, floors: Floors, root: string = REPO_ROOT): string[] {
  const entries = Object.entries(floors);
  if (entries.length === 0) {
    // Closes the "delete the floors, get a green gate" hole: an empty manifest is the
    // failure, not a vacuous pass over zero files.
    return ["(manifest) -> empty floor manifest: no per-file floor is being enforced"];
  }

  const measured = new Map<string, SummaryEntry>();
  for (const [key, entry] of Object.entries(summary)) {
    if (key === "total") continue; // the aggregate row, not a file
    measured.set(relativeKey(key, root), entry);
  }

  const violations: string[] = [];
  for (const [path, floor] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entry = measured.get(path);
    if (entry === undefined) {
      // Renamed, newly excluded, or dropped by a narrowed include -- one failure, because
      // an unmeasured floor is indistinguishable from an unenforced one.
      violations.push(`${path} -> absent from coverage summary (renamed, excluded, or no longer collected)`);
      continue;
    }
    for (const metric of METRICS) {
      const pct = entry[metric]?.pct;
      if (typeof pct !== "number" || Number.isNaN(pct)) {
        violations.push(`${path} ${metric} -> no percentage in coverage summary entry`);
        continue;
      }
      if (pct < floor[metric]) {
        violations.push(`${path} ${metric} -> ${pct} is below floor ${floor[metric]}`);
      }
    }
  }
  return violations;
}

function run(summaryPath: string): number {
  let raw: string;
  try {
    raw = readFileSync(summaryPath, "utf-8");
  } catch {
    process.stderr.write(`coverage_floors: FAIL - cannot read coverage summary: ${summaryPath}\n`);
    process.stderr.write("Coverage was not_run or the report was not written; absence of evidence is not a pass.\n");
    process.stderr.write("Run `npm run test:coverage` so vitest writes coverage/coverage-summary.json first.\n");
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`coverage_floors: FAIL - coverage summary is not valid JSON: ${summaryPath} - ${reason}\n`);
    return 1;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`coverage_floors: FAIL - coverage summary is not a JSON object: ${summaryPath}\n`);
    return 1;
  }

  const violations = evaluate(parsed as Summary, FLOORS);
  const count = Object.keys(FLOORS).length;

  if (violations.length === 0) {
    process.stdout.write(`coverage_floors: OK - all ${count} floored file(s) present and at or above floor.\n`);
    return 0;
  }
  process.stdout.write(`coverage_floors: FAIL - ${violations.length} violation(s) across ${count} floored file(s):\n`);
  for (const v of violations) process.stdout.write(`  ${v}\n`);
  process.stdout.write("Raise the covering tests, or change the floor deliberately in scripts/coverage-floors.ts.\n");
  return 1;
}

// The CLI entry point, exported so the self-test can exercise the exit codes and the
// failure messages without spawning a subprocess.
export function main(args: string[]): number {
  let summary = resolve(REPO_ROOT, DEFAULT_SUMMARY);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--summary") {
      const val = args[++i];
      if (val === undefined) {
        process.stderr.write("coverage_floors: usage error - missing argument: --summary\n");
        return 2;
      }
      summary = resolve(REPO_ROOT, val);
    } else if (arg !== undefined && arg.startsWith("--summary=")) {
      summary = resolve(REPO_ROOT, arg.slice("--summary=".length));
    } else {
      // Reject unknown flags / stray positionals rather than silently checking the default
      // summary -- a mis-invocation must fail loudly, never print a false green.
      process.stderr.write(`coverage_floors: usage error - invalid option: ${arg}\n`);
      return 2;
    }
  }
  return run(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Set exitCode (don't process.exit) so buffered stdout drains before exit.
  process.exitCode = main(argv.slice(2));
}
