// The quality gate, as one command: `npm run gate`.
//
// This file is the wiring only — read the declaration, run what it declares,
// report. Every decision lives in gate.ts and declaration.ts, where it can be
// measured without spawning anything (ADR 0014). It is kept separate from
// gate.ts so that importing the logic in a test does not run the gate.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseDeclaration } from "./declaration.ts";
import { isExecutable } from "./executable.ts";
import { EXIT_CANNOT_RUN, EXIT_CHECK_FAILED, EXIT_OK, runChecks } from "./gate.ts";

const DECLARATION = "config/checks.md";

// An asynchronous EPIPE arrives after the write returns, so no try/catch
// reaches it, and it would replace a classified exit with a crash. Installed
// once, before anything writes — the same fix PR #46 landed for summon.ts.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function main(): void {
  let checks;
  try {
    checks = parseDeclaration(readFileSync(DECLARATION, "utf8")).checks;
  } catch (err) {
    console.error(`the gate could not run — ${DECLARATION}: ${(err as Error).message}`);
    process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  // A binary that is not there is the gate failing to run, not a check
  // failing. Thrown, and caught inside runChecks, so the outcomes already
  // collected survive alongside the classification.
  const result = runChecks(
    checks,
    (argv) => {
      const run = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
      if (run.error) {
        throw new Error(`could not execute \`${argv.join(" ")}\`: ${run.error.message}`);
      }
      // status is null only when a signal killed the child. That is a check
      // that did not pass, so it is reported as a non-zero check result —
      // never as EXIT_CANNOT_RUN, which is the gate's own classification and
      // means something else.
      return run.status ?? EXIT_CHECK_FAILED;
    },
    isExecutable,
  );

  if (result.blocked !== null) console.error(result.blocked);

  // Every declared check gets a line, in declared order, whatever became of
  // it. Reporting only what ran lets a short run read as a whole one.
  const LABEL: Record<string, string> = {
    passed: "pass",
    failed: "FAIL",
    "could-not-run": "STOP",
    "not-attempted": "skip",
  };
  for (const check of result.results) {
    const detail = check.detail ? ` — ${check.detail}` : "";
    console.log(`${LABEL[check.state]}  ${check.name}  (${check.command})${detail}`);
  }

  if (result.code === EXIT_OK) {
    console.log(`gate green — ${result.results.length} checks, declared in ${DECLARATION}`);
  }
  process.exitCode = result.code;
}

main();
