import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env.js";

describe("loadDotEnv", () => {
  const cleanupKeys = ["BRYCE_ENV_TEST_FILE_ONLY", "BRYCE_ENV_TEST_PRESET"];
  let dir: string | null = null;

  afterEach(() => {
    for (const key of cleanupKeys) delete process.env[key];
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns false and loads nothing when the file does not exist", () => {
    expect(loadDotEnv("/nonexistent/.env")).toBe(false);
    expect(process.env.BRYCE_ENV_TEST_FILE_ONLY).toBeUndefined();
  });

  it("fills missing variables from the file but never overrides real env", () => {
    dir = mkdtempSync(join(tmpdir(), "bryce-env-"));
    const path = join(dir, ".env");
    writeFileSync(
      path,
      "BRYCE_ENV_TEST_FILE_ONLY=from_file\nBRYCE_ENV_TEST_PRESET=from_file\n",
    );
    process.env.BRYCE_ENV_TEST_PRESET = "from_real_env";

    expect(loadDotEnv(path)).toBe(true);
    expect(process.env.BRYCE_ENV_TEST_FILE_ONLY).toBe("from_file");
    expect(process.env.BRYCE_ENV_TEST_PRESET).toBe("from_real_env");
  });
});
