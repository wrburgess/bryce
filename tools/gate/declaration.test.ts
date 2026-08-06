import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDeclaration } from "./declaration.ts";

const wellFormed = [
  "---",
  "date: 2026-08-03",
  "source: the Direction gate on #52",
  "checks:",
  "  - name: typecheck",
  "    command: npm run typecheck",
  "    requires: node_modules",
  "  - name: tests",
  "    command: npm test",
  "---",
  "",
  "# prose body",
  "",
].join("\n");

test("a well-formed declaration parses into date, source, and ordered checks", () => {
  const d = parseDeclaration(wellFormed);
  assert.equal(d.date, "2026-08-03");
  assert.equal(d.source, "the Direction gate on #52");
  assert.deepEqual(d.checks, [
    { name: "typecheck", command: "npm run typecheck", requires: "node_modules" },
    { name: "tests", command: "npm test" },
  ]);
});

// The vacuous case, and it is the whole reason this parser rejects rather than
// returns. A gate handed zero checks reports green having run nothing — the
// most-produced defect class in findings/classes.md (ADR 0014).
test("a checks key with no entries is refused, not returned empty", () => {
  const md = ["---", "date: 2026-08-03", "source: s", "checks:", "---", ""].join("\n");
  assert.throws(() => parseDeclaration(md), /zero checks/i);
});

// Distinct from the empty list on purpose: a missing key must never read as
// "declared nothing", because the two have different fixes.
test("a missing checks key is refused, and distinguishably from an empty one", () => {
  const md = ["---", "date: 2026-08-03", "source: s", "---", ""].join("\n");
  assert.throws(() => parseDeclaration(md), /no 'checks' key/i);
});

test("a file with no frontmatter block is refused", () => {
  assert.throws(() => parseDeclaration("# just prose\n"), /frontmatter/i);
});

test("an unclosed frontmatter block is refused", () => {
  const md = ["---", "date: 2026-08-03", "source: s", "checks:", "  - name: a"].join("\n");
  assert.throws(() => parseDeclaration(md), /closed/i);
});

// A parser that skips what it cannot read is a parser that fails open. The
// subset is small on purpose; anything outside it stops the gate.
test("syntax outside the declared subset is refused, and the line is named", () => {
  const md = [
    "---",
    "date: 2026-08-03",
    "source: s",
    "nested:",
    "  deep:",
    "    thing: 1",
    "checks:",
    "  - name: a",
    "    command: true",
    "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /deep:/);
});

test("a check without a command is refused, by name", () => {
  const md = [
    "---", "date: 2026-08-03", "source: s", "checks:", "  - name: lonely", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /lonely.*command|command.*lonely/i);
});

test("a check without a name is refused", () => {
  const md = [
    "---", "date: 2026-08-03", "source: s", "checks:", "  - command: npm test", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /name/i);
});

test("a declaration with no date is refused", () => {
  const md = [
    "---", "source: s", "checks:", "  - name: a", "    command: true", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /date/i);
});

test("a declaration with no source is refused", () => {
  const md = [
    "---", "date: 2026-08-03", "checks:", "  - name: a", "    command: true", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /source/i);
});

// Raised by the contractor review of cafb202, lens: does any guard fail open?
// The entry-level vocabulary was guarded and the top level was not — the same
// asymmetry, one scope up.
test("an unrecognized top-level key is refused, not silently discarded", () => {
  const md = [
    "---", "date: 2026-08-03", "source: s", "ignored: future-value",
    "checks:", "  - name: a", "    command: true", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /ignored/);
});

// Raised by the adversarial pass on cafb202. Scalars and lists were separate
// namespaces and each duplicate guard checked only its own, so one key could
// be declared twice in two shapes and both were kept.
test("a key used as both a scalar and a list is refused", () => {
  const md = [
    "---", "date: 2026-08-03", "source: s",
    "date:", "  - name: a", "    command: true",
    "checks:", "  - name: b", "    command: true", "---",
  ].join("\n");
  assert.throws(() => parseDeclaration(md), /date/);
});

test("the live declaration parses, and declares at least one check", () => {
  const live = readFileSync(new URL("../../config/checks.md", import.meta.url), "utf8");
  const d = parseDeclaration(live);
  assert.ok(d.checks.length > 0, "the live gate declares no checks");
  assert.ok(d.date.length > 0 && d.source.length > 0);
});
