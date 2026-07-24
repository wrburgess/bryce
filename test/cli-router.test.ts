import { describe, expect, it, vi } from "vitest";
import { COMMANDS, preflight, renderHelp, resolve, runRouter } from "../src/cli/router.js";

describe("CLI router metadata", () => {
  it("exposes every operator group and leaf through scoped help", () => {
    for (const command of COMMANDS) {
      const help = renderHelp(command.path);
      expect(help).toContain(command.purpose);
      expect(help).toContain(`Usage: ${command.usage}`);
      expect(help).toContain(`Example: ${command.example}`);
    }
    expect(renderHelp()).toContain("players");
    expect(renderHelp(["players", "lists"])).toContain("create");
  });

  it("treats all help forms as pure router operations", async () => {
    const output = vi.fn();
    for (const args of [[], ["help"], ["--help"], ["-h"], ["players", "lists", "--help"], ["digest", "--help"]]) {
      expect(await runRouter(args, output)).toBe(0);
    }
    expect(output).toHaveBeenCalled();
  });

  it("resolves nested routes and keeps leaf arguments intact", () => {
    const nested = resolve(["players", "lists", "create", "--name", "Prospects"]);
    expect(nested.command?.path).toEqual(["players", "lists", "create"]);
    expect(nested.argv).toEqual(["--name", "Prospects"]);
    const digest = resolve(["digest", "-w", "7d", "--list", "Prospects"]);
    expect(digest.argv).toEqual(["-w", "7d", "--list", "Prospects"]);
  });

  it("rejects malformed leaf arguments before a loader can run", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    expect(preflight(digest, ["--window", "30d"])).toContain("invalid value");
    expect(preflight(digest, ["--window"])).toContain("requires a value");
    expect(preflight(digest, ["--bogus"])).toContain("unknown option");
    expect(preflight(digest, ["operand"])).toContain("unexpected argument");
  });

  it("reports unknown and incomplete commands without loading a leaf", async () => {
    const output = vi.fn();
    expect(await runRouter(["unknown"], output)).toBe(1);
    expect(await runRouter(["players", "lists"], output)).toBe(1);
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("error:");
  });
});
