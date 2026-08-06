import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT_CANNOT_RUN, EXIT_CHECK_FAILED, EXIT_OK, exitFor, runChecks } from "./gate.ts";
import type { CheckResult, CheckState } from "./gate.ts";
import type { CheckSpec } from "./declaration.ts";

const present = () => true;
const absent = () => false;
const passing = () => 0;
const failing = () => 1;

function spy() {
  const calls: string[][] = [];
  return { calls, exec: (argv: string[]) => (calls.push(argv), 0) };
}

const twoChecks: CheckSpec[] = [
  { name: "typecheck", command: "npm run typecheck", requires: "node_modules" },
  { name: "tests", command: "npm test" },
];

const threeChecks: CheckSpec[] = [
  { name: "one", command: "true" },
  { name: "two", command: "true" },
  { name: "three", command: "true" },
];

const stateOf = (r: { results: CheckResult[] }, name: string) =>
  r.results.find((c) => c.name === name)?.state;

// ---------------------------------------------------------------------------
// The invariant, asserted as a whole sequence.
//
// Its predecessor counted, and filtered `unmet` to entries containing "could
// not be executed" — which excluded exactly the branch that was broken. A
// count is a proxy for a set, and the filter is where a branch goes to hide.
// This compares the full ordered name list, so there is nothing to exclude.
// ---------------------------------------------------------------------------

const BRANCHES: [string, () => { results: CheckResult[] }][] = [
  ["all pass", () => runChecks(threeChecks, passing, present)],
  ["all fail", () => runChecks(threeChecks, failing, present)],
  ["execution stops midway", () => {
    let n = 0;
    return runChecks(threeChecks, () => { if (++n === 2) throw new Error("boom"); return 0; }, present);
  }],
  ["unmet prerequisite", () => runChecks(
    [{ name: "one", command: "true", requires: "nope" }, ...threeChecks.slice(1)], passing, absent,
  )],
  ["command refused", () => runChecks(
    [{ name: "one", command: "true && rm -rf /" }, ...threeChecks.slice(1)], passing, present,
  )],
];

for (const [label, run] of BRANCHES) {
  test(`every declared check appears exactly once, in order — ${label}`, () => {
    const { results } = run();
    assert.deepEqual(
      results.map((r) => r.name),
      ["one", "two", "three"],
      "results are not the declared checks, in the declared order, exactly once each",
    );
  });
}

test("no declared check is ever left without a state", () => {
  for (const [label, run] of BRANCHES) {
    for (const r of run().results) {
      assert.ok(r.state, `${label}: check '${r.name}' carries no state`);
    }
  }
});

// ---------------------------------------------------------------------------
// The exit code is one pure function of the states, tested directly. This is
// what makes the four-return-sites defect un-recreatable: the mapping lives in
// one place instead of being re-decided at each exit.
// ---------------------------------------------------------------------------

const r = (state: CheckState): CheckResult => ({ name: "x", command: "true", state });

test("exitFor maps states to exits, and a blocked gate outranks everything", () => {
  assert.equal(exitFor([r("passed"), r("passed")], null), EXIT_OK);
  assert.equal(exitFor([r("passed"), r("failed")], null), EXIT_CHECK_FAILED);
  assert.equal(exitFor([r("passed"), r("could-not-run")], null), EXIT_CANNOT_RUN);
  assert.equal(exitFor([r("passed"), r("not-attempted")], null), EXIT_CANNOT_RUN);
  assert.equal(exitFor([r("failed"), r("not-attempted")], null), EXIT_CANNOT_RUN);
  assert.equal(exitFor([], "no checks declared"), EXIT_CANNOT_RUN);
  assert.equal(exitFor([r("passed")], "something blocked the gate"), EXIT_CANNOT_RUN);
});

test("a gate that ran nothing never reports green", () => {
  assert.notEqual(exitFor([], null), EXIT_OK);
  assert.equal(runChecks([], passing, present).code, EXIT_CANNOT_RUN);
});

// ---------------------------------------------------------------------------
// States, each reachable and each measured.
// ---------------------------------------------------------------------------

test("every check passing is exit 0, and every check is reported passed", () => {
  const res = runChecks(twoChecks, passing, present);
  assert.equal(res.code, EXIT_OK);
  assert.deepEqual(res.results.map((c) => c.state), ["passed", "passed"]);
});

test("a failing check is exit 1, and only that check is failed", () => {
  const res = runChecks(twoChecks, (argv) => (argv.includes("test") ? 1 : 0), present);
  assert.equal(res.code, EXIT_CHECK_FAILED);
  assert.equal(stateOf(res, "typecheck"), "passed");
  assert.equal(stateOf(res, "tests"), "failed");
});

// The #40 lesson: "a check failed" and "the gate never ran" are different
// outcomes, and a caller cannot tell them apart from a bare non-zero.
test("an unmet prerequisite is exit 2, not exit 1 — it is not a failing check", () => {
  const res = runChecks(twoChecks, passing, absent);
  assert.equal(res.code, EXIT_CANNOT_RUN);
  assert.notEqual(res.code, EXIT_CHECK_FAILED);
});

// The double-count that ended the previous design: the check whose
// prerequisite is unmet is could-not-run, and it is NOT also reported as
// never attempted. One check, one state.
test("a check with an unmet prerequisite carries could-not-run and nothing else", () => {
  const res = runChecks(twoChecks, passing, absent);
  assert.equal(stateOf(res, "typecheck"), "could-not-run");
  assert.equal(stateOf(res, "tests"), "not-attempted");
  assert.equal(res.results.filter((c) => c.name === "typecheck").length, 1, "counted twice");
});

test("an unmet prerequisite names what is missing and how to fix it", () => {
  const res = runChecks(twoChecks, passing, absent);
  const blocked = res.results.find((c) => c.name === "typecheck");
  assert.ok(blocked?.detail?.includes("node_modules"), "the missing prerequisite is not named");
  assert.ok(blocked?.detail?.includes("bin/setup"), "the fix is not named");
});

// The gate reports its own unreadiness; it never repairs the tree it measures.
// Differential: "nothing ran" is an absence, and an absence passes against an
// implementation that never runs anything — which is how this test's ancestor
// passed against its own stub.
test("an unmet prerequisite runs nothing — while the same checks do run when it is met", () => {
  const blocked = spy();
  runChecks(twoChecks, blocked.exec, absent);
  assert.deepEqual(blocked.calls, [], "the gate executed something despite an unmet prerequisite");

  const ready = spy();
  runChecks(twoChecks, ready.exec, present);
  assert.equal(ready.calls.length, twoChecks.length, "the control arm ran nothing either");
});

test("a check that cannot be executed is could-not-run, and the rest are not-attempted", () => {
  let n = 0;
  const res = runChecks(threeChecks, () => { if (++n === 2) throw new Error("spawn ENOENT"); return 0; }, present);
  assert.equal(res.code, EXIT_CANNOT_RUN);
  assert.deepEqual(res.results.map((c) => c.state), ["passed", "could-not-run", "not-attempted"]);
});

test("a command carrying a shell metacharacter is refused, and nothing runs", () => {
  const s = spy();
  const res = runChecks([{ name: "sneaky", command: "npm test && rm -rf /" }], s.exec, present);
  assert.equal(res.code, EXIT_CANNOT_RUN);
  assert.equal(stateOf(res, "sneaky"), "could-not-run");
  assert.deepEqual(s.calls, []);
});

test("declared and executed are the same set, in both directions", () => {
  const s = spy();
  runChecks(twoChecks, s.exec, present);
  assert.deepEqual(
    s.calls.map((argv) => argv.join(" ")).sort(),
    twoChecks.map((c) => c.command).sort(),
  );
});

test("a check is executed as tokens, never through a shell", () => {
  const s = spy();
  runChecks([{ name: "tests", command: "npm test" }], s.exec, present);
  assert.deepEqual(s.calls, [["npm", "test"]]);
});

// Differential for the same reason as the unmet-prerequisite pair above.
test("the prerequisite probe is consulted only for a check that declares one", () => {
  let withoutRequires = false;
  runChecks([{ name: "tests", command: "npm test" }], passing, () => ((withoutRequires = true), true));
  assert.equal(withoutRequires, false, "a check declaring no prerequisite still probed for one");

  let withRequires = false;
  runChecks(
    [{ name: "typecheck", command: "npm run typecheck", requires: "node_modules" }],
    passing,
    () => ((withRequires = true), true),
  );
  assert.equal(withRequires, true, "a check declaring a prerequisite never probed for it");
});
