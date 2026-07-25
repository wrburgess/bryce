import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("locally linked bryce executable", () => {
  it("uses the package-local runtime from an unrelated prefix", () => {
    const prefix = mkdtempSync(join(tmpdir(), "bryce-link-"));
    try {
      // npm's --prefix link layout is global-style; create it explicitly so this
      // test neither touches the user's global prefix nor requires the network.
      mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(npm, ["link", process.cwd(), "--prefix", prefix, "--ignore-scripts"], { stdio: "pipe" });
      const executable = join(prefix, "bin", "bryce");
      expect(existsSync(executable)).toBe(true);
      expect(execFileSync(executable, ["help"], { encoding: "utf8" })).toContain("Usage: bryce");
      const invalid = spawnSync(executable, ["not-a-command"], { encoding: "utf8", cwd: tmpdir() });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("unknown command");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
