import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "./roster.ts";

test("parses the live declaration's roster row", () => {
  const md = readFileSync(new URL("../../config/review.md", import.meta.url), "utf8");
  const r = parseRoster(md);
  assert.equal(r.name, "Codex CLI");
  assert.equal(r.mechanismCommand, "codex exec");
  assert.equal(r.readinessCommand, "codex login status");
  assert.match(r.responseKind, /output it returns/i);
});

test("a file without a roster section fails loudly", () => {
  assert.throws(() => parseRoster("# nothing here\n"), /roster/i);
});

test("a multi-row roster fails loudly until reviewer selection exists", () => {
  const md = [
    "## Reviewer roster",
    "",
    "| Reviewer | Mechanism | Response | Readiness check |",
    "|---|---|---|---|",
    "| **A** | `a exec` | output | `a status` |",
    "| **B** | `b exec` | output | `b status` |",
    "",
  ].join("\n");
  assert.throws(() => parseRoster(md), /row/i);
});

test("a roster row missing a backticked command fails loudly", () => {
  const md = [
    "## Reviewer roster",
    "",
    "| Reviewer | Mechanism | Response | Readiness check |",
    "|---|---|---|---|",
    "| **X** | prose only | output | prose only |",
    "",
  ].join("\n");
  assert.throws(() => parseRoster(md), /command/i);
});
