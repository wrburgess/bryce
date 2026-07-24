import { describe, expect, it, vi } from "vitest";
import { COMMANDS, type Command, preflight, renderHelp, resolve, runRouter } from "../src/cli/router.js";

describe("CLI router metadata", () => {
  it("exposes every operator group and leaf through metadata help", () => {
    for (const command of COMMANDS) {
      const help = renderHelp(command.path);
      expect(help).toContain(command.purpose);
      expect(help).toContain(`Usage: ${command.usage}`);
      expect(help).toContain(`Example: ${command.example}`);
    }
    const groups = new Map<string, string[]>();
    for (const command of COMMANDS) {
      for (let length = 0; length < command.path.length; length += 1) {
        const path = command.path.slice(0, length);
        groups.set(path.join("\0"), path);
      }
    }
    for (const path of groups.values()) expect(renderHelp(path)).toContain("Usage:");
  });

  it("keeps every table-driven help and invalid path loader-free", async () => {
    const loader = vi.fn(async () => ({ main: vi.fn(async () => 0) }));
    const commands = COMMANDS.map((command) => ({ ...command, load: loader }));
    const output = vi.fn();
    const groups = new Map<string, string[]>();
    for (const command of commands) {
      for (let length = 0; length < command.path.length; length += 1) groups.set(command.path.slice(0, length).join("\0"), command.path.slice(0, length));
      expect(await runRouter([...command.path, "--help"], output, commands)).toBe(0);
      expect(await runRouter([...command.path, "--not-an-option"], output, commands)).toBe(1);
    }
    for (const group of groups.values()) expect(await runRouter([...group, "--help"], output, commands)).toBe(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it("resolves nested routes and keeps leaf arguments intact", () => {
    const nested = resolve(["players", "lists", "create", "--name", "Prospects"]);
    expect(nested.command?.path).toEqual(["players", "lists", "create"]);
    expect(nested.argv).toEqual(["--name", "Prospects"]);
    const digest = resolve(["digest", "-w", "7d", "--list", "Prospects"]);
    expect(digest.argv).toEqual(["-w", "7d", "--list", "Prospects"]);
  });

  it("rejects malformed numeric leaf arguments before a loader can run", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    expect(preflight(digest, ["--window", "30d"])).toContain("invalid value");
    expect(preflight(digest, ["--window"])).toContain("requires a value");
    expect(preflight(digest, ["--bogus"])).toContain("unknown option");
    expect(preflight(digest, ["operand"])).toContain("unexpected argument");
    const probe = COMMANDS.find((command) => command.path.join(" ") === "ncaa probe")!;
    expect(preflight(probe, ["--seq", "not-a-number"])).toContain("positive integer");
    expect(preflight(probe, ["--season", "twenty"])).toContain("four-digit year");
  });

  it("injects loaders to prove argv forwarding and status propagation for every leaf", async () => {
    const seen: string[][] = [];
    const commands: Command[] = COMMANDS.map((command) => ({
      ...command,
      load: async () => ({ main: async (argv) => { seen.push(argv); return 23; } }),
    }));
    for (const command of commands) expect(await runRouter([...command.path], vi.fn(), commands)).toBe(23);
    expect(seen).toHaveLength(COMMANDS.length);

    const digestSeen: string[][] = [];
    const digest = commands.find((command) => command.path[0] === "digest")!;
    const digestOnly = [{ ...digest, load: async () => ({ main: async (argv: string[]) => { digestSeen.push(argv); return 29; } }) }];
    expect(await runRouter(["digest", "-w", "7d"], vi.fn(), digestOnly)).toBe(29);
    expect(digestSeen).toEqual([["-w", "7d"]]);
  });

  it("reports unknown and incomplete commands without loading a leaf", async () => {
    const output = vi.fn();
    expect(await runRouter(["unknown"], output)).toBe(1);
    expect(await runRouter(["players", "lists"], output)).toBe(1);
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("error:");
  });
});
