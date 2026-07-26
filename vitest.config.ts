import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live tier (test/**/*.live.test.ts) is the ONLY sanctioned network path;
    // it never loads in the default suite. Preserve Vitest's node_modules defaults.
    exclude: [...configDefaults.exclude, "test/**/*.live.test.ts"],
    environment: "node",
    // A fail-closed network-egress guard (test/support/network-guard.ts, issue #25)
    // enforces the "tests must never hit the network" invariant: every in-process,
    // non-loopback fetch + TCP/TLS socket egress fails immediately and is recorded.
    // NOTE: `test.concurrent` is unsupported with the guard — its attempts buffer is
    // process-global and would cross-contaminate concurrent tests in one file.
    setupFiles: ["./test/support/network-setup.ts"],
    testTimeout: 10_000,
    // Coverage lives HERE, in the default-suite config, so the network guard above
    // and the live-tier exclusion are inherited by construction — a separate
    // coverage config would silently drop both (issue #28).
    coverage: {
      provider: "v8",
      // Default is ['**']; narrow to application source so scripts/ and test/ do
      // not dilute the measured numbers the floors are calibrated against.
      include: ["src/**/*.ts"],
      // SPREAD, do not replace: assigning `exclude` overrides the provider defaults
      // outright (node_modules, dist, config files, ...). The two named modules are
      // type-only — interfaces and a union type, zero runtime statements — so v8
      // reports them as 0% forever and they would drag the aggregate down for no signal.
      exclude: [...coverageConfigDefaults.exclude, "src/mailer/types.ts", "src/server/deps.ts"],
      // Default is false: a single failing test would otherwise suppress the whole
      // report. This is for DIAGNOSIS, not for the gate -- `test:coverage` chains with
      // `&&`, so a red suite short-circuits and scripts/coverage-floors.ts never runs.
      // What the setting actually buys is that the human-readable `text` report still
      // prints and coverage/coverage-summary.json still lands on disk after a failing
      // run, so the numbers are there to inspect while fixing it. The honest cost: a
      // floor regression that lands alongside an unrelated test failure is not reported
      // until that failure is fixed and the suite is green enough to reach the check.
      reportOnFailure: true,
      // `text` is the human-readable CI log view; `json-summary` writes
      // coverage/coverage-summary.json for scripts/coverage-floors.ts to consume.
      reporter: ["text", "json-summary"],
      // NO `thresholds` key, deliberately. Vitest's resolveThresholds
      // (node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js ~:4102) builds its
      // comparison from the files a glob actually matched, so a threshold whose
      // glob matches ZERO files silently passes — a renamed, excluded, or
      // no-longer-collected file turns its floor into a no-op with no warning.
      // Per-file floors are enforced instead by scripts/coverage-floors.ts, which
      // reads the summary this run produced and fails when a floored path is
      // missing from it. One enforcement path, not two with different failure modes.
    },
  },
});
