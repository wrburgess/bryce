import { test } from "node:test";
import assert from "node:assert/strict";
import { argvFromCommand, dispatch, runReadiness } from "./dispatch.ts";

test("a passing readiness command reports reachable", () => {
  const r = runReadiness("true");
  assert.equal(r.ok, true);
});

test("a failing readiness command reports unreachable, with detail", () => {
  const r = runReadiness("false");
  assert.equal(r.ok, false);
  assert.ok(r.detail.length > 0);
});

test("shell metacharacters in a configured command are refused, never executed", () => {
  assert.throws(() => argvFromCommand("codex exec; rm -rf /"), /metacharacter/i);
  assert.throws(() => runReadiness("echo owned > /tmp/x"), /metacharacter/i);
});

test("a plain multi-word command tokenizes to argv", () => {
  assert.deepEqual(argvFromCommand("codex login status"), [
    "codex",
    "login",
    "status",
  ]);
});

test("a failing readiness check is 'unreachable now' — nothing is dispatched", () => {
  const outcome = dispatch({
    readinessCommand: "false",
    buildArgv: (out) => ["sh", "-c", `printf 'should never run' > '${out}'`],
    summons: "s",
  });
  assert.equal(outcome.kind, "unreachable");
});

test("a mechanism that returns a review yields it", () => {
  const outcome = dispatch({
    readinessCommand: "true",
    buildArgv: (out) => ["sh", "-c", `cat > /dev/null; printf 'the review' > '${out}'`],
    summons: "the summons",
  });
  assert.equal(outcome.kind, "review");
  assert.equal(outcome.kind === "review" && outcome.output, "the review");
});

test("a mechanism that writes nothing is unresponsive — a different outcome", () => {
  const outcome = dispatch({
    readinessCommand: "true",
    buildArgv: () => ["sh", "-c", "cat > /dev/null"],
    summons: "s",
  });
  assert.equal(outcome.kind, "unresponsive");
});
