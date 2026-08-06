import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReview } from "./validate.ts";

const COMMIT = "b".repeat(40);
const LENS = "what class is not on this list?";

const conforming = [
  "## Review",
  "",
  `- **Lens:** ${LENS}`,
  "- **Type:** defect",
  "- **Severity:** should-fix",
  "- **Location:** tools/review/roster.ts:10",
  "- **Defect:** the parser ignores a second roster row silently",
  "",
  `**Commit reviewed:** ${COMMIT}`,
  "**Signed:** Codex CLI gpt-5.2-codex",
  "",
].join("\n");

test("a conforming review with findings passes", () => {
  const v = validateReview(conforming, COMMIT, [LENS]);
  assert.equal(v.conforming, true);
  assert.deepEqual(v.missing, []);
});

test("a zero-findings review answers every lens explicitly and passes", () => {
  const review = [
    `- **Lens:** ${LENS} — no findings`,
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, true);
});

test("a review that never answers a summoned lens is nonconforming — the lens is named", () => {
  const v = validateReview(conforming, COMMIT, [
    LENS,
    "does any guard fail open?",
  ]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => m.includes("does any guard fail open?")));
});

test("a review with no lens answers at all is nonconforming even when signed and bound", () => {
  const review = [
    "Looks fine to me.",
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => m.includes(LENS)));
});

test("a no-findings lens answer does not break the finding field parity check", () => {
  const review = [
    `- **Lens:** ${LENS}`,
    "- **Type:** defect",
    "- **Severity:** note",
    "- **Location:** x.ts:1",
    "- **Defect:** concrete enough",
    "",
    "- **Lens:** does any guard fail open? — no findings",
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS, "does any guard fail open?"]);
  assert.equal(v.conforming, true);
  assert.deepEqual(v.missing, []);
});

test("two findings collapsed into one block cannot balance their way to conforming", () => {
  // The wave-2 exploit: two consecutive Lens lines, then two of each remaining
  // field — aggregate counts balance, but neither finding is whole.
  const review = [
    `- **Lens:** ${LENS}`,
    `- **Lens:** ${LENS}`,
    "- **Type:** defect",
    "- **Type:** defect",
    "- **Severity:** note",
    "- **Severity:** note",
    "- **Location:** a.ts:1",
    "- **Location:** b.ts:2",
    "- **Defect:** first",
    "- **Defect:** second",
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /finding/i.test(m)));
});

test("a field repeated inside one finding block is nonconforming", () => {
  const review = conforming.replace(
    "- **Severity:** should-fix",
    "- **Severity:** should-fix\n- **Severity:** note",
  );
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
});

test("a reviewer-invented severity is nonconforming and named", () => {
  const review = conforming.replace("should-fix", "critical");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => m.includes("critical")));
});

test("a review that does not name the bound commit is nonconforming", () => {
  const review = conforming.replace(`**Commit reviewed:** ${COMMIT}`, "");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /commit/i.test(m)));
});

test("a review naming a different commit is nonconforming", () => {
  const v = validateReview(conforming, "c".repeat(40), [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /commit/i.test(m)));
});

test("an answer that merely quotes the lens inside another question does not cover it", () => {
  const review = [
    "- **Lens:** unrelated question that quotes: what class is not on this list?",
    "- **Type:** defect",
    "- **Severity:** note",
    "- **Location:** x.ts:1",
    "- **Defect:** concrete enough",
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => m.includes(LENS)));
});

test("harmless lens-answer variants still cover: case, no-findings suffix, permanent-lens suffix", () => {
  const review = [
    "- **Lens:** What class is not on this list? (the permanent lens) — no findings",
    "",
    `**Commit reviewed:** ${COMMIT}`,
    "**Signed:** Codex CLI gpt-5.2-codex",
  ].join("\n");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, true);
  assert.deepEqual(v.missing, []);
});

test("a signature without both tool and model is nonconforming", () => {
  const review = conforming.replace(
    "**Signed:** Codex CLI gpt-5.2-codex",
    "**Signed:** x",
  );
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /tool and model/i.test(m)));
});

test("an unsigned review is nonconforming", () => {
  const review = conforming.replace(/\*\*Signed:\*\*.*\n?/, "");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /sign/i.test(m)));
});

test("a finding missing a required field is nonconforming and the field is named", () => {
  const review = conforming.replace(
    "- **Location:** tools/review/roster.ts:10\n",
    "",
  );
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /Location/.test(m)));
});

test("a type outside the findings vocabulary is nonconforming", () => {
  const review = conforming.replace("**Type:** defect", "**Type:** bug");
  const v = validateReview(review, COMMIT, [LENS]);
  assert.equal(v.conforming, false);
  assert.ok(v.missing.some((m) => /type/i.test(m)));
});
