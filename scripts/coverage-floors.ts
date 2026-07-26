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
//
// The summary MUST come from a full-suite run. A filtered run still reports every src/
// file (because `coverage.all` is on), just at 0% -- so the gate detects that case
// explicitly and names it, rather than blaming seven files that never regressed.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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

// `total`/`covered` are carried alongside `pct` because the aggregate `total` row's raw
// counts are what distinguish a partial run from a real collapse (see evaluate below).
export type SummaryEntry = Partial<
  Record<Metric | "lines" | "functions", { pct?: number; total?: number; covered?: number }>
>;

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
  "src/cli/seed.ts": { statements: 54, branches: 61 },
  "src/server.ts": { statements: 56, branches: 76 },
  "src/cli/batch-add.ts": { statements: 66, branches: 54 },
  "src/cli/migrate.ts": { statements: 70, branches: 33 },
  "src/cli/restore.ts": { statements: 78, branches: 61 },
  "src/watchlist/service.ts": { statements: 86, branches: 79 },
};

// Both path separators, folded to the POSIX one the manifest is written in.
function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

// A Windows drive-letter root ("C:/..."), already separator-normalized. This is the ONLY
// shape treated as Windows, because it is the only one a POSIX path can never take: no
// POSIX absolute path begins with a letter and a colon.
const DRIVE_ABSOLUTE = /^[A-Za-z]:\//;

// Absoluteness must be decided from the path's OWN shape, not the host's. `isAbsolute` is
// platform-bound: on POSIX it calls "C:\\repo\\src\\cli\\main.ts" relative, so the
// root-stripping below would be skipped and every floored file reported absent despite
// being measured -- the exact bogus diagnosis this normalization exists to prevent.
function looksAbsolute(original: string, posix: string): boolean {
  return isAbsolute(original) || posix.startsWith("/") || DRIVE_ABSOLUTE.test(posix);
}

// Windows compares paths case-insensitively for their whole length, so "C:/Repo/Root" and
// "c:/repo/root" name one location; without folding, the root goes unstripped and the file
// is falsely reported absent. Applied to drive-letter paths ONLY, deliberately:
//
//   - POSIX is case-SENSITIVE. "/repo/Root" and "/repo/root" are different directories, so
//     folding them together could strip a root that does not match and let a WRONG entry
//     satisfy a floor -- a false green, the one outcome this file exists to prevent.
//   - UNC ("//server/share") is intentionally NOT folded. Its forward-slash spelling is
//     indistinguishable from a POSIX path with two leading slashes, so folding it would
//     silently make those POSIX paths case-insensitive too. A UNC root spelled in a
//     different case therefore just fails to match, which surfaces as a loud "absent"
//     violation -- the safe direction to be wrong in.
//
// Only the comparison is folded; the returned slice keeps the summary's own spelling.
function comparable(posix: string): string {
  return DRIVE_ABSOLUTE.test(posix) ? posix.toLowerCase() : posix;
}

// The json-summary reporter keys files by ABSOLUTE path. Fold a key to the repo-relative,
// forward-slash form the manifest uses so the two can be matched. A key that is already
// relative, or absolute but outside the repo, is returned normalized but unrewritten —
// it then simply fails to match a floor, which surfaces as a loud "absent" violation.
export function relativeKey(key: string, root: string): string {
  // Normalize BOTH separators explicitly rather than the RUNTIME `sep`. A summary can be
  // produced on one platform and read on another (a CI artifact, a container mount, a
  // cached coverage/ directory), and `split(sep).join("/")` is a no-op for backslashes on
  // POSIX -- a Windows-shaped key would then never match a floor and would surface as a
  // bogus "absent" violation naming a file that is perfectly well covered.
  const posix = toPosix(key).replace(/^\.\//, "");
  if (!looksAbsolute(key, posix)) return posix;
  const base = toPosix(root).replace(/\/+$/, "");
  if (base !== "" && comparable(posix).startsWith(`${comparable(base)}/`)) {
    return posix.slice(base.length + 1);
  }
  return posix;
}

// Marks the one violation that is NOT a floor problem, so the CLI can print the remedy that
// actually applies (re-run the full suite) instead of "raise the covering tests".
export const PARTIAL_RUN_PREFIX = "(summary) ->";

// Pure: compare a coverage summary against a floor manifest and return every violation as
// an ASCII, greppable line. An empty result means the gate passed.
export function evaluate(summary: Summary, floors: Floors, root: string = REPO_ROOT): string[] {
  const entries = Object.entries(floors);
  if (entries.length === 0) {
    // Closes the "delete the floors, get a green gate" hole: an empty manifest is the
    // failure, not a vacuous pass over zero files.
    return ["(manifest) -> empty floor manifest: no per-file floor is being enforced"];
  }

  // Sentinel BEFORE the per-file loop: `coverage.all` enumerates every src/ file even on a
  // filtered run (`vitest run --coverage test/one.test.ts`), so all seven floored paths land
  // in the summary at 0% and the loop below would print seven violations blaming files that
  // never regressed -- a red gate with a FALSE diagnosis, which is worse than no gate.
  // PROJECT.md's Tests row is `npm run test:coverage`, so an agent iterating on a subset hits
  // this constantly. The aggregate tells the two apart: zero covered statements out of
  // thousands is not a regression anyone could author, it is a run that did not execute the
  // suite. Name THAT, and stop -- per-file numbers from a partial report are noise.
  const totalStatements = summary["total"]?.statements;
  if (typeof totalStatements?.total === "number" && totalStatements.total > 0 && totalStatements.covered === 0) {
    return [
      `${PARTIAL_RUN_PREFIX} 0 of ${totalStatements.total} statements covered overall: a partial, filtered, or failed run, not a floor regression; re-run the full suite via 'npm run test:coverage'`,
    ];
  }

  const measured = new Map<string, SummaryEntry>();
  const duplicates = new Set<string>();
  for (const [key, entry] of Object.entries(summary)) {
    if (key === "total") continue; // the aggregate row, not a file
    const rel = relativeKey(key, root);
    // Two distinct summary keys folding to one relative path (an absolute and a relative
    // spelling of the same file, say) would otherwise last-write-wins, and the surviving
    // entry could be the healthy one while the real, lower measurement is silently dropped.
    // A summary that ambiguous cannot be trusted to clear a floor, so say so.
    if (measured.has(rel)) duplicates.add(rel);
    measured.set(rel, entry);
  }

  const violations: string[] = [];
  for (const dup of [...duplicates].sort()) {
    violations.push(`${dup} -> duplicate key in coverage summary: two entries fold to this path, so one measurement is masked`);
  }
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
  // A partial run is a different diagnosis with a different fix, so it gets its own headline
  // and remedy -- telling someone to "raise the covering tests" after a filtered run would
  // point them straight at code that is not broken.
  const partial = violations.length === 1 && violations[0]?.startsWith(PARTIAL_RUN_PREFIX) === true;
  if (partial) {
    process.stdout.write(`coverage_floors: FAIL - coverage report is not from a full-suite run; floors not checked:\n`);
  } else {
    process.stdout.write(`coverage_floors: FAIL - ${violations.length} violation(s) across ${count} floored file(s):\n`);
  }
  for (const v of violations) process.stdout.write(`  ${v}\n`);
  if (!partial) {
    process.stdout.write("Raise the covering tests, or change the floor deliberately in scripts/coverage-floors.ts.\n");
  }
  return 1;
}

// A `--summary` value must be a real path, never a flag and never empty. Writes the usage
// error itself so both spellings (`--summary X` and `--summary=X`) report identically.
function validSummaryValue(val: string, flag: string): boolean {
  if (val === "") {
    process.stderr.write(`coverage_floors: usage error - ${flag} requires a non-empty path\n`);
    return false;
  }
  if (val.startsWith("--")) {
    process.stderr.write(`coverage_floors: usage error - ${flag} requires a path, got an option: ${val}\n`);
    return false;
  }
  return true;
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
      // Swallowing the NEXT FLAG as the path (`--summary --nope`) would turn a typo into an
      // exit-1 "cannot read coverage summary", which reads as a real coverage failure and
      // sends the operator hunting a report that was never the problem. An empty value
      // (`--summary=`) is worse: it resolves to the repo root and dies on EISDIR. Both are
      // mis-invocations, so both get the exit-2 usage channel.
      if (!validSummaryValue(val, "--summary")) return 2;
      summary = resolve(REPO_ROOT, val);
    } else if (arg !== undefined && arg.startsWith("--summary=")) {
      const val = arg.slice("--summary=".length);
      if (!validSummaryValue(val, "--summary=")) return 2;
      summary = resolve(REPO_ROOT, val);
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
