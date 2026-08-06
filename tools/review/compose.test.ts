import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composeSummons,
  extractSeverityFramework,
  parseAcceptedRegister,
  MAX_DIFF_BYTES,
  PERMANENT_LENS,
  type SummonsInput,
} from "./compose.ts";

const base: SummonsInput = {
  prNumber: 99,
  subject: "test subject",
  commit: "a".repeat(40),
  lenses: ["does the parser fail loudly on a reshaped table?"],
  severityFramework: "| must-fix | blocks shipping |",
  acceptedEntries: [],
  diff: "diff --git a/x b/x\n",
  reviewerName: "Codex CLI",
};

test("the summons carries all five standards, the commit, and the role pointer", () => {
  const s = composeSummons(base);
  for (const needle of [
    base.commit,
    "Severity framework",
    base.lenses[0]!,
    PERMANENT_LENS,
    "Required output shape",
    "AGENTS.md",
    "diff --git",
  ]) {
    assert.ok(s.includes(needle), `summons is missing: ${needle}`);
  }
});

test("the permanent lens is present even with an empty lens list", () => {
  const s = composeSummons({ ...base, lenses: [] });
  assert.ok(s.includes(PERMANENT_LENS));
});

test("an empty accepted register reads as none accepted to date", () => {
  const s = composeSummons({ ...base, acceptedEntries: [] });
  assert.match(s, /none accepted to date/i);
});

test("accepted entries are carried verbatim", () => {
  const s = composeSummons({
    ...base,
    acceptedEntries: ["- risk X, accepted on PR #9"],
  });
  assert.ok(s.includes("risk X, accepted on PR #9"));
});

test("an oversized diff is a loud error, never a silent truncation", () => {
  const big = "x".repeat(MAX_DIFF_BYTES + 1);
  assert.throws(() => composeSummons({ ...base, diff: big }), /diff/i);
});

test("extractSeverityFramework pulls the chapter's own section, whole", () => {
  const chapter = readFileSync(
    new URL("../../sds/02-review-and-findings.md", import.meta.url),
    "utf8",
  );
  const s = extractSeverityFramework(chapter);
  assert.ok(s.includes("must-fix"));
  assert.ok(s.includes("should-fix"));
  assert.ok(s.includes("note"));
  assert.ok(!s.includes("Fix-verification"), "ran past the section boundary");
});

test("the live register parses, and every entry is one whole line ending in its disposition link", () => {
  const md = readFileSync(
    new URL("../../findings/accepted.md", import.meta.url),
    "utf8",
  );
  const entries = parseAcceptedRegister(md);
  for (const e of entries) {
    assert.match(e, /^- /);
    assert.match(e, /https:\/\/github\.com\/.+>?$/, `entry lacks its disposition link: ${e}`);
  }
});

test("a register without its Entries section fails loudly, never as an empty list", () => {
  assert.throws(
    () => parseAcceptedRegister("# The accepted register\n\nreshaped file\n"),
    /Entries/,
  );
});

test("parseAcceptedRegister collects entry lines once entries exist", () => {
  const md = [
    "# The accepted register",
    "",
    "## Entries",
    "",
    "- one accepted risk — disposition: PR #7",
    "- another — disposition: PR #8",
    "",
  ].join("\n");
  assert.equal(parseAcceptedRegister(md).length, 2);
});

test("parseAcceptedRegister never reads past its own section", () => {
  const md = [
    "# The accepted register",
    "",
    "## Entries",
    "",
    "- the one real entry",
    "",
    "## Some later section",
    "",
    "- a bullet that is not an accepted finding",
    "",
  ].join("\n");
  assert.deepEqual(parseAcceptedRegister(md), ["- the one real entry"]);
});
