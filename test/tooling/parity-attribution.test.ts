import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runParityCheck } from "../../scripts/parity-check.js";
import { withBundleCopy } from "./parity-fixture.js";

describe("parity check attribution integration", () => {
  it("reports an attribution-specific error for a malformed copied Project Config", () => {
    withBundleCopy((root) => {
      const project = join(root, "PROJECT.md");
      writeFileSync(project, readFileSync(project, "utf-8").replace(
        "| Agent (harness) | Identity email |",
        "| Agent (harness) | Declared model | Identity email |",
      ));
      const result = runParityCheck(root);
      expect(result.status).toBe(1);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("Attribution configuration table must have exactly two columns"),
      ]));
    });
  });
});
