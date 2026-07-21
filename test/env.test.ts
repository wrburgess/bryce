import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { createApp } from "../src/server.js";
import { testAppDeps, testDb } from "./factories.js";

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

describe("API_TOKEN config (rules/security.md: normalize before guarding)", () => {
  const base = { MAILER_PROVIDER: "console" };

  it("trims a real token and nulls absent or whitespace-only values", () => {
    expect(loadConfig({ ...base, API_TOKEN: "  sekret-token  " }).apiToken).toBe("sekret-token");
    expect(loadConfig(base).apiToken).toBeNull();
    expect(loadConfig({ ...base, API_TOKEN: "" }).apiToken).toBeNull();
    expect(loadConfig({ ...base, API_TOKEN: "   " }).apiToken).toBeNull();
  });
});

describe("createApp fail-closed auth (rules/security.md: deny by default)", () => {
  it("throws at construction when no token is configured", () => {
    const opened = testDb();
    try {
      for (const apiToken of [null, "", "   "]) {
        expect(
          () => createApp(testAppDeps(opened, { apiToken })),
          JSON.stringify(apiToken),
        ).toThrow(/API_TOKEN/);
      }
      // And constructs fine with one — the sad path is the config, not the app.
      expect(() => createApp(testAppDeps(opened))).not.toThrow();
    } finally {
      opened.close();
    }
  });
});

describe("BRYCE_TZ config (ambient TZ must never win)", () => {
  const base = { MAILER_PROVIDER: "console" };

  it("reads the host timezone from BRYCE_TZ", () => {
    expect(loadConfig({ ...base, BRYCE_TZ: "America/New_York" }).tz).toBe("America/New_York");
  });

  it("defaults to America/Chicago when BRYCE_TZ is absent", () => {
    expect(loadConfig(base).tz).toBe("America/Chicago");
  });

  it("ignores TZ entirely — an ambient TZ=UTC must not become the host timezone", () => {
    // The 2026-07-20 production bug: a terminal exporting TZ=UTC defeated
    // .env's TZ=America/Chicago, and every host date shifted after 19:00 CDT.
    expect(loadConfig({ ...base, TZ: "UTC" }).tz).toBe("America/Chicago");
    expect(loadConfig({ ...base, TZ: "UTC", BRYCE_TZ: "America/Chicago" }).tz).toBe(
      "America/Chicago",
    );
  });
});
