import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, type Command, preflight, preflightDirect, renderHelp, resolve, runRouter } from "../src/cli/router.js";

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
  "seed add": ["--person-id", "1"],
  "seed promote": ["--highlightly-player-id", "1", "--person-id", "2"],
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
      expect(help).toContain(`Usage: ${command.usage.replaceAll("bryce", "sk")}`);
      expect(help).toContain(`Example: ${command.example.replaceAll("bryce", "sk")}`);
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
    expect(resolve(["players", "lists", "help", "create"]).help).toEqual(["players", "lists", "create"]);
    expect(renderHelp(["players", "lists"])).toContain("Usage: sk players lists create");
  });

  it("rejects malformed numeric leaf arguments before a loader can run", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    expect(preflight(digest, ["--window", "30d"])).toContain("invalid value");
    expect(preflight(digest, ["--window"])).toContain("requires a value");
    expect(preflight(digest, ["--window=7d=x"])).toContain("extra '='");
    expect(preflight(digest, ["--bogus"])).toContain("unknown option");
    expect(preflight(digest, ["operand"])).toContain("unexpected argument");
    const add = COMMANDS.find((command) => command.path.join(" ") === "seed add")!;
    expect(preflight(add, ["--person-id", "1", "--pick", "2"])).toContain("requires '--search'");
    expect(preflight(add, ["--search", "Acosta", "--pick", "01"])).toContain("canonical positive integer");
    expect(preflight(add, ["--ncaa", "--name", "Roch Cholowsky"])).toBeNull();
    expect(preflight(add, ["--ncaa"])).toContain("requires both '--ncaa' and '--name'");
    expect(preflight(add, ["--name", "Roch Cholowsky"])).toContain("requires both '--ncaa' and '--name'");
  });

  it("runs valid real adapters and propagates their statuses", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-router-adapters-"));
    const previous = { cwd: process.cwd(), database: process.env.DATABASE_PATH, backup: process.env.BACKUP_DIR, mailer: process.env.MAILER_PROVIDER, token: process.env.API_TOKEN };
    try {
      process.chdir(work);
      process.env.DATABASE_PATH = join(work, "bryce.db");
      process.env.BACKUP_DIR = join(work, "backups");
      process.env.MAILER_PROVIDER = "console";
      process.env.API_TOKEN = "test-token";
      expect(await runRouter(["db", "migrate"], vi.fn())).toBe(0);
      expect(await runRouter(["db", "backup"], vi.fn())).toBe(0);
      expect(await runRouter(["seed", "list"], vi.fn())).toBe(0);
      expect(await runRouter(["players", "lists", "show"], vi.fn())).toBe(0);
      expect(await runRouter(["players", "backup", "--out", join(work, "players.json")], vi.fn())).toBe(0);
      expect(await runRouter(["digest", "--window", "7d"], vi.fn())).toBe(0);
    } finally {
      process.chdir(previous.cwd);
      for (const [key, value] of Object.entries({ DATABASE_PATH: previous.database, BACKUP_DIR: previous.backup, MAILER_PROVIDER: previous.mailer, API_TOKEN: previous.token })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects table-driven semantic invalid invocations before loader initialization", async () => {
    const loader = vi.fn(async () => ({ main: vi.fn(async () => 0) }));
    const commands = COMMANDS.map((command) => ({ ...command, load: loader }));
    const invalidCases = [
      ["players", "lists", "create"],
      ["players", "lists", "create", "--name=Prospects"],
      ["players", "backup"],
      ["db", "restore"],
      ["seed", "add"],
      ["seed", "add", "--person-id", "1", "--highlightly-player-id", "2"],
      ["seed", "tag", "add", "--tag", "status:rostered"],
      ["players", "lists", "create", "--name", "   "],
      ["players", "backup", "--out", ""],
      ["digest", "--list", ""],
      ["seed", "add", "--search", "   "],
      ["digest", "--window=7d\nforged"],
      ["players", "batch-add", "--person-ids", "1,1"],
      ["players", "batch-add", "--person-ids", ",,"],
      ["players", "batch-add", "--highlightly-player-id", ""],
      ["players", "batch-add", "--person-ids", Array.from({ length: 26 }, (_, i) => String(i + 1)).join(",")],
      ["players", "batch-add", "--names", "Acosta", "--names", "acosta"],
      ["players", "batch-add", "--names", "x".repeat(121)],
      ["seed", "list", "--tags", ",, ,"],
      ["seed", "list", "--tags", "pos:ss:extra"],
      ["seed", "tag", "add", "--person-id", "1", "--tag", "level:aaa"],
      ["seed", "tag", "add", "--person-id", "1", "--tag", "status:unknown"],
      ["players", "lists", "create", "--name", "line\nforged"],
    ];
    for (const args of invalidCases) expect(await runRouter(args, vi.fn(), commands)).toBe(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects blank/comment-only and malformed batch files before loading", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-batch-preflight-"));
    const blank = join(work, "blank.txt");
    const malformed = join(work, "malformed.txt");
    const exact = join(work, "exact.txt");
    writeFileSync(blank, "# comment\n\n");
    writeFileSync(exact, `name:${"a ".repeat(59)}aa\n`);
    writeFileSync(malformed, `name:${"x".repeat(121)}\n`);
    const loader = vi.fn(async () => ({ main: vi.fn(async () => 0) }));
    const commands = COMMANDS.map((command) => ({ ...command, load: loader }));
    expect(await runRouter(["players", "batch-add", "--file", blank], vi.fn(), commands)).toBe(1);
    expect(loader).not.toHaveBeenCalled();
    loader.mockClear();
    expect(await runRouter(["players", "batch-add", "--file", blank, "--person-ids", "1"], vi.fn(), commands)).toBe(0);
    loader.mockClear();
    expect(await runRouter(["players", "batch-add", "--file", exact], vi.fn(), commands)).toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);
    loader.mockClear();
    expect(await runRouter(["players", "batch-add", "--file", malformed], vi.fn(), commands)).toBe(1);
    expect(loader).not.toHaveBeenCalled();
    rmSync(work, { recursive: true, force: true });
  });

  it("serves health through the routed server and shuts down cleanly", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-server-"));
    const blocker = createServer();
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    const waitForExit = (candidate: ReturnType<typeof spawn>, ms: number) => new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      candidate.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    const stopChild = async (candidate: ReturnType<typeof spawn>): Promise<void> => {
      if (candidate.exitCode !== null) return;
      candidate.kill("SIGTERM");
      if (await waitForExit(candidate, 5_000) === null) {
        candidate.kill("SIGKILL");
        await waitForExit(candidate, 5_000);
      }
    };
    try {
      // Start with a port that is definitely occupied, then retry with a
      // distinct ephemeral port. This proves the operational smoke neither
      // treats a failed bind as ready nor retries the rejected port.
      await new Promise<void>((resolve, reject) => blocker.listen(0, resolve).once("error", reject));
      const blockedAddress = blocker.address();
      if (blockedAddress === null || typeof blockedAddress === "string") throw new Error("test blocker has no TCP port");
      const finder = createServer();
      await new Promise<void>((resolve, reject) => finder.listen(0, resolve).once("error", reject));
      const retryAddress = finder.address();
      if (retryAddress === null || typeof retryAddress === "string") throw new Error("test retry listener has no TCP port");
      await new Promise<void>((resolve) => finder.close(() => resolve()));
      const attemptedPorts = [blockedAddress.port, retryAddress.port];

      for (const port of attemptedPorts) {
        output = "";
        const candidate = spawn(join(process.cwd(), "bin", "bryce"), ["server"], {
          cwd: work,
          env: { PATH: process.env.PATH, API_TOKEN: "test-token", MAILER_PROVIDER: "console", BRYCE_TZ: "America/Chicago", DATABASE_PATH: join(work, "bryce.db"), BACKUP_DIR: join(work, "backups"), SERVER_PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        // Keep ownership immediately: every rejected collision/timeout child is
        // terminated and reaped before the next retry can begin.
        child = candidate;
        candidate.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        candidate.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        const ready = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error(`server did not start: ${output}`)); }, 15_000);
          const poll = setInterval(() => {
            if (output.includes(`server listening port=${port}`)) { cleanup(); resolve(true); }
            else if (output.includes("EADDRINUSE")) { cleanup(); resolve(false); }
          }, 25);
          const onError = (error: Error) => { cleanup(); reject(error); };
          const cleanup = () => { clearTimeout(timer); clearInterval(poll); candidate.removeListener("error", onError); };
          candidate.once("error", onError);
        });
        if (!ready) {
          expect(output).toContain("EADDRINUSE");
          await stopChild(candidate);
          expect(candidate.exitCode).toBe(1);
          child = undefined;
          continue;
        }
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, players: 0, statLines: 0, lastDelivery: null, refresh: null });
        break;
      }
      expect(attemptedPorts[1]).not.toBe(attemptedPorts[0]);
      expect(child, `server could not acquire a port: ${output}`).toBeDefined();
      expect(child!.exitCode).toBeNull();
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGTERM");
        const status = await waitForExit(child, 5_000);
        if (status === null) { child.kill("SIGKILL"); await waitForExit(child, 5_000); }
        else expect(status).toBe(0);
      }
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("exercises the server EADDRINUSE path and reaps the rejected process", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-server-collision-"));
    const blocker = createServer();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      // Match Hono's unspecified-host listen behavior. A 127.0.0.1-only
      // blocker can coexist with an IPv6 wildcard listener on macOS and would
      // not actually exercise EADDRINUSE.
      await new Promise<void>((resolve, reject) => blocker.listen(0, () => resolve()).once("error", reject));
      const address = blocker.address();
      if (address === null || typeof address === "string") throw new Error("test blocker has no TCP port");
      child = spawn(join(process.cwd(), "bin", "bryce"), ["server"], {
        cwd: work,
        env: { PATH: process.env.PATH, API_TOKEN: "test-token", MAILER_PROVIDER: "console", BRYCE_TZ: "America/Chicago", DATABASE_PATH: join(work, "bryce.db"), BACKUP_DIR: join(work, "backups"), SERVER_PORT: String(address.port) },
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 10_000);
        child!.once("exit", (status) => { clearTimeout(timer); resolve(status); });
      });
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);
      expect(child.exitCode).not.toBeNull();
    } finally {
      if (child?.exitCode === null) { child.kill("SIGKILL"); await new Promise<void>((resolve) => child!.once("exit", () => resolve())); }
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts canonical space and supported digest inline forms", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    expect(preflight(digest, ["--window", "7d", "--list", "Prospects"])).toBeNull();
    expect(preflight(digest, ["--window=7d", "--list=Prospects"])).toBeNull();
  });

  it("rejects duplicate non-repeatable options while retaining ordered batch repetition", () => {
    const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
    const batch = COMMANDS.find((command) => command.path.join(" ") === "players batch-add")!;
    expect(preflight(digest, ["-f", "--force"])).toContain("may not be repeated");
    expect(preflight(digest, ["-w", "7d", "--window", "14d"])).toContain("may not be repeated");
    expect(preflight(digest, ["--list", "A", "--list=B"])).toContain("may not be repeated");
    expect(preflight(batch, ["--names", "First", "--names", "Second"])).toBeNull();
    expect(preflight(batch, ["--person-ids", "1", "--person-ids", "2"])).toBeNull();
  });

  it("uses the router schema before direct compatibility entry-point initialization", () => {
    expect(preflightDirect(["digest"], ["-f", "--force"])).toContain("may not be repeated");
    expect(preflightDirect(["digest"], ["--window=7d"])).toBeNull();
    expect(preflightDirect(["players", "lists", "create"], ["create", "--name", "Prospects"], ["create"])).toBeNull();
    expect(preflightDirect(["seed", "tag", "add"], ["tag", "add", "--person-id", "1", "--tag", "status:rostered"], ["tag", "add"])).toBeNull();
    expect(preflightDirect(["connector", "smoke"], ["--mutate=1"])).toContain("does not support '=' syntax");
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

  it("runs a generated real-adapter matrix for every routed leaf", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-router-matrix-"));
    const previous = { cwd: process.cwd(), database: process.env.DATABASE_PATH, backup: process.env.BACKUP_DIR, mailer: process.env.MAILER_PROVIDER, token: process.env.API_TOKEN, mcp: process.env.MCP_URL };
    try {
      process.chdir(work);
      process.env.DATABASE_PATH = join(work, "bryce.db");
      process.env.BACKUP_DIR = join(work, "backups");
      process.env.MAILER_PROVIDER = "console";
      process.env.API_TOKEN = "test-token";
      process.env.MCP_URL = "not-a-url"; // connector adapter returns its config status without network
      vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("statsapi")) {
          const body = url.includes("/people") ? { people: [] } : url.includes("/stats") ? { stats: [] } : { seasons: [] };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }));
      for (const command of COMMANDS) {
        if (command.path[0] === "server") continue; // starting the long-lived listener is covered separately
        const args = validArgs[command.path.join(" ")] ?? [];
        const result = await runRouter([...command.path, ...args], vi.fn());
        expect(result, command.path.join(" ")).toBeGreaterThanOrEqual(0);
        expect(result, command.path.join(" ")).toBeLessThanOrEqual(2);
      }
    } finally {
      vi.unstubAllGlobals();
      process.chdir(previous.cwd);
      for (const [key, value] of Object.entries({ DATABASE_PATH: previous.database, BACKUP_DIR: previous.backup, MAILER_PROVIDER: previous.mailer, API_TOKEN: previous.token, MCP_URL: previous.mcp })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps every direct compatibility entry point bounded and exit-draining on default argv", () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-compat-"));
    try {
      const entrypoints = [
        "src/cli/backup.ts", "src/cli/batch-add.ts", "src/cli/connector-smoke.ts", "src/cli/digest.ts",
        "src/cli/lists.ts", "src/cli/migrate.ts", "src/cli/players-backup.ts",
        "src/cli/players-restore.ts", "src/cli/refresh.ts", "src/cli/restore.ts", "src/cli/seed.ts", "src/server.ts",
      ];
      for (const entrypoint of entrypoints) {
        const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [join(process.cwd(), entrypoint)], {
          cwd: work,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBeNull();
        expect(`${result.stderr}`).toMatch(/error[=:]/);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports unknown and incomplete commands without loading a leaf", async () => {
    const output = vi.fn();
    expect(await runRouter(["unknown"], output)).toBe(1);
    expect(await runRouter(["players", "lists"], output)).toBe(1);
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("error:");
  });
});
