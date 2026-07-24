import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, type Command, preflight, renderHelp, resolve, runRouter } from "../src/cli/router.js";

const validArgs: Record<string, string[]> = {
  "players lists create": ["--name", "Prospects"],
  "players lists rename": ["--name", "Prospects", "--to", "Top 30"],
  "players lists delete": ["--name", "Prospects"],
  "players lists add": ["--name", "Prospects", "--person-ids", "1"],
  "players lists remove": ["--name", "Prospects", "--person-ids", "1"],
  "players backup": ["--out", "players.json"],
  "players restore": ["--in", "players.json"],
  "players batch-add": ["--person-ids", "1"],
  "db restore": ["--from", "snapshot.db"],
  "ncaa probe": ["--seq", "1"],
  "seed add": ["--person-id", "1"],
  "seed deactivate": ["--person-id", "1"],
  "seed tag add": ["--person-id", "1", "--tag", "status:rostered"],
  "seed tag remove": ["--person-id", "1", "--tag", "status:rostered"],
  "seed tag list": ["--person-id", "1"],
};

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

  it("rejects table-driven semantic invalid invocations before loader initialization", async () => {
    const loader = vi.fn(async () => ({ main: vi.fn(async () => 0) }));
    const commands = COMMANDS.map((command) => ({ ...command, load: loader }));
    const invalidCases = [
      ["players", "lists", "create"],
      ["players", "lists", "create", "--name=Prospects"],
      ["players", "backup"],
      ["db", "restore"],
      ["ncaa", "probe"],
      ["seed", "add"],
      ["seed", "add", "--person-id", "1", "--ncaa-seq", "2"],
      ["seed", "tag", "add", "--tag", "status:rostered"],
    ];
    for (const args of invalidCases) expect(await runRouter(args, vi.fn(), commands)).toBe(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it("accepts canonical space and supported digest inline forms", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    expect(preflight(digest, ["--window", "7d", "--list", "Prospects"])).toBeNull();
    expect(preflight(digest, ["--window=7d", "--list=Prospects"])).toBeNull();
  });

  it("injects loaders to prove argv forwarding and status propagation for every leaf", async () => {
    const seen: string[][] = [];
    const commands: Command[] = COMMANDS.map((command) => ({
      ...command,
      load: async () => ({ main: async (argv) => { seen.push(argv); return 23; } }),
    }));
    for (const command of commands) {
      expect(await runRouter([...command.path, ...(validArgs[command.path.join(" ")] ?? [])], vi.fn(), commands)).toBe(23);
    }
    expect(seen).toHaveLength(COMMANDS.length);

    const digestSeen: string[][] = [];
    const digest = commands.find((command) => command.path[0] === "digest")!;
    const digestOnly = [{ ...digest, load: async () => ({ main: async (argv: string[]) => { digestSeen.push(argv); return 29; } }) }];
    expect(await runRouter(["digest", "-w", "7d"], vi.fn(), digestOnly)).toBe(29);
    expect(digestSeen).toEqual([["-w", "7d"]]);
  });

  it("keeps a direct compatibility entry point on its default process argv", () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-compat-"));
    try {
      const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [join(process.cwd(), "src", "cli", "backup.ts")], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, MAILER_PROVIDER: "console", DATABASE_PATH: join(work, "bryce.db"), BACKUP_DIR: join(work, "snapshots") },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("snapshot created");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reports unknown and incomplete commands without loading a leaf", async () => {
    const output = vi.fn();
    expect(await runRouter(["unknown"], output)).toBe(1);
    expect(await runRouter(["players", "lists"], output)).toBe(1);
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("error:");
  });
});
