import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runParityCheck } from "../../scripts/parity-check.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("parity check attribution integration", () => {
  it("reports an attribution-specific error for a malformed copied Project Config", () => {
    const root = mkdtempSync(join(tmpdir(), "parity-attribution-"));
    try {
      cpSync(REPO_ROOT, root, {
        recursive: true,
        filter: (source) => !source.includes("node_modules") && !source.includes(".git") && !source.includes(".claude/worktrees"),
      });
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
