import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * Backup configuration validation (ADR 0042): BACKUP_DIR and BACKUP_KEEP_LAST.
 * A mis-set keep-last must fail closed — never silently widen retention.
 */
const base = { MAILER_PROVIDER: "console" as const };

describe("loadConfig backup settings", () => {
  it("defaults BACKUP_DIR and BACKUP_KEEP_LAST", () => {
    const config = loadConfig({ ...base }, () => {});
    expect(config.backupDir).toBe("backups");
    expect(config.backupKeepLast).toBe(10);
  });

  it("reads custom values", () => {
    const config = loadConfig({ ...base, BACKUP_DIR: "/var/bryce/snaps", BACKUP_KEEP_LAST: "25" }, () => {});
    expect(config.backupDir).toBe("/var/bryce/snaps");
    expect(config.backupKeepLast).toBe(25);
  });

  it("normalizes the optional Highlightly API key without requiring it for MLB-only operation", () => {
    expect(loadConfig({ ...base }, () => {}).highlightlyApiKey).toBeNull();
    expect(loadConfig({ ...base, HIGHLIGHTLY_API_KEY: "  provider-key  " }, () => {}).highlightlyApiKey).toBe("provider-key");
  });

  it("rejects a non-positive or non-integer BACKUP_KEEP_LAST (fail closed)", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => loadConfig({ ...base, BACKUP_KEEP_LAST: bad }, () => {}), bad).toThrow();
    }
  });

  it("rejects a blank BACKUP_DIR", () => {
    expect(() => loadConfig({ ...base, BACKUP_DIR: "   " }, () => {})).toThrow();
  });

  it("rejects a server port outside Node's valid range", () => {
    for (const bad of ["0", "-1", "65536", "70000", "1.5", "abc"]) {
      expect(() => loadConfig({ ...base, SERVER_PORT: bad }, () => {}), bad).toThrow();
    }
  });

  it("rejects an SMTP port outside Node's valid range", () => {
    for (const bad of ["0", "-1", "65536", "70000", "1.5", "abc"]) {
      expect(() => loadConfig({ ...base, SMTP_PORT: bad }, () => {}), bad).toThrow();
    }
  });
});
