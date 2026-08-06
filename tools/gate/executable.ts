// The prerequisite probe for a check's `requires` field.
//
// `requires` names the executable a check needs. Asking whether that path
// *exists* answers a different question: a directory, a non-executable file,
// and a real binary are all present. The gate then runs the check anyway, the
// command exits 126 or 127, and the run reports "a check failed" for a gate
// that could not run — which is the proxy defect the declaration says this
// field exists to avoid, surviving one level tighter.
//
// Two conditions, and both are needed. X_OK alone is not enough: on a
// directory it means "traversable" and succeeds, so the file check has to come
// first. statSync follows symlinks, which is required rather than incidental —
// every entry under node_modules/.bin is one.
//
// Raised by the contractor review of 4576409.
//
// ---------------------------------------------------------------------------
// Declared blind spot (Chapter 3, *Every check declares its blind spot*)
//
// This probe reaches: a missing path, a dangling symlink, a directory, and a
// present file without execute permission.
//
// It does not reach: a file that is executable and still cannot run — a 0755
// file of the wrong binary format, or a shebang naming an interpreter that is
// not installed. Nothing short of executing the file decides that, so no probe
// closes it; a deeper probe would only move the proxy, which is the trap
// ADR 0013 exists to name rather than to keep chasing.
//
// What the residue costs, exactly: such a prerequisite passes resolution, so
// checks declared before it may run first. It is not misclassified — spawnSync
// reports the failure, run.ts turns it into a throw, and gate.ts records that
// check `could-not-run` and the rest `not-attempted`, exiting 2. The loss is
// the resolve-everything-before-executing property for this one case, not the
// classification. gate.test.ts covers that path directly.
//
// Raised by the contractor review of ba62c8a, and dispositioned as a declared
// blind spot rather than a deeper probe. That disposition is the HC's to
// confirm — it is recorded as a stop on #52.
// ---------------------------------------------------------------------------

import { accessSync, constants, statSync } from "node:fs";

export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Missing, dangling, or unreadable — none of them is an executable, and
    // the gate's response to all three is the same.
    return false;
  }
}
