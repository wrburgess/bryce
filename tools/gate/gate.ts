// The gate's decision logic, kept free of the filesystem and the process table
// so every branch can be measured (ADR 0014). tools/gate/run.ts is the
// executable that wires this to spawnSync and existsSync.
//
// Exit codes are classified, and the distinction that matters is between 1 and
// 2: a check that ran and failed is not the same outcome as a gate that could
// not run, and a caller cannot tell them apart from a bare non-zero. #40 is the
// receipt — a failed post exiting unclassified was a defect, not a detail.
//
// ---------------------------------------------------------------------------
// Why the shape below, rather than the obvious one
//
// The first design kept three parallel arrays — what ran, what was blocked,
// what was skipped — and the property *every declared check is accounted for
// exactly once* had to be re-established by hand at four return sites. Two of
// the four were wrong, each found by a separate review round: one dropped the
// half that had already run, and the next counted a blocked check twice. The
// defect was never in any single return. It was in a representation that made
// the invariant something a person maintains.
//
// So: `results` is built from the declared checks before anything runs, every
// entry seeded `not-attempted`, and execution only ever *mutates* a state.
// Nothing appends. Length and membership therefore cannot drift from the
// declaration, and the exit code is derived once by exitFor rather than being
// decided again at each way out.
// ---------------------------------------------------------------------------

import { argvFromCommand } from "../review/dispatch.ts";
import type { CheckSpec } from "./declaration.ts";

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_CANNOT_RUN = 2;

/**
 * What became of one declared check. `could-not-run` means this check was
 * reached and could not be executed; `not-attempted` means it was never
 * reached. They are deliberately distinct — collapsing them re-creates the
 * defect this representation exists to remove.
 */
export type CheckState = "passed" | "failed" | "could-not-run" | "not-attempted";

export interface CheckResult {
  name: string;
  command: string;
  state: CheckState;
  /** The check's own exit code, for `passed` and `failed`. */
  code?: number;
  /** Why it could not run, for `could-not-run`. */
  detail?: string;
}

export interface GateResult {
  /** One entry per declared check, in declared order, always. */
  results: CheckResult[];
  /** A gate-level reason nothing could run at all. A scalar, not a list. */
  blocked: string | null;
  /** Derived from the states by exitFor; never assigned at a return site. */
  code: number;
}

export function exitFor(results: CheckResult[], blocked: string | null): number {
  if (blocked !== null) return EXIT_CANNOT_RUN;
  // A gate with nothing to run has not passed; it has not run.
  if (results.length === 0) return EXIT_CANNOT_RUN;
  if (results.some((r) => r.state === "could-not-run" || r.state === "not-attempted")) {
    return EXIT_CANNOT_RUN;
  }
  if (results.some((r) => r.state === "failed")) return EXIT_CHECK_FAILED;
  return EXIT_OK;
}

export function runChecks(
  checks: CheckSpec[],
  exec: (argv: string[]) => number,
  present: (path: string) => boolean,
): GateResult {
  // Seeded from the declaration, once. Nothing below appends to this array.
  const results: CheckResult[] = checks.map((c) => ({
    name: c.name,
    command: c.command,
    state: "not-attempted",
  }));

  if (checks.length === 0) {
    const blocked = "no checks to run — a gate that ran nothing must never report green";
    return { results, blocked, code: exitFor(results, blocked) };
  }

  // Everything is resolved before anything is executed, so a malformed command
  // or a missing prerequisite stops the gate rather than leaving it half-run.
  const argvs: (string[] | null)[] = [];
  let resolutionFailed = false;
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const result = results[i]!;
    try {
      argvs.push(argvFromCommand(check.command));
    } catch (err) {
      argvs.push(null);
      result.state = "could-not-run";
      result.detail = (err as Error).message;
      resolutionFailed = true;
      continue;
    }
    if (check.requires !== undefined && !present(check.requires)) {
      result.state = "could-not-run";
      result.detail =
        `requires '${check.requires}', which is missing — run \`bash bin/setup\`. ` +
        "The gate reports its own unreadiness and never installs: a gate that " +
        "repairs the tree it measures is measuring something else.";
      resolutionFailed = true;
    }
  }
  // The rest keep the state they were seeded with — not-attempted — which is
  // the truth, and is set in exactly one place.
  if (resolutionFailed) {
    return { results, blocked: null, code: exitFor(results, null) };
  }

  for (let i = 0; i < checks.length; i++) {
    const result = results[i]!;
    try {
      const code = exec(argvs[i]!);
      result.state = code === EXIT_OK ? "passed" : "failed";
      result.code = code;
    } catch (err) {
      result.state = "could-not-run";
      result.detail = (err as Error).message;
      break;
    }
  }

  return { results, blocked: null, code: exitFor(results, null) };
}
