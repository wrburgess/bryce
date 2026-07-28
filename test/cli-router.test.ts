import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, type Command, normalizeDirect, normalizeOptions, preflight, preflightDirect, renderHelp, resolve, runRouter } from "../src/cli/router.js";

// How long any ONE compatibility entry point may take to bail on a bare environment, and how many may
// be in flight at once. The case below derives its own test budget from both, so the budget and the
// bounds it must accommodate cannot drift apart again (issue #176).
//
// The concurrency cap is not a politeness knob. Running all thirteen at once makes each child contend
// for CPU, so per-child wall clock grows WITH the fleet size: the whole case took ~9.5s with all
// thirteen in flight — an upper bound on any one child of them, against the 10s per-spawn kill —
// versus ~4s for a single uncontended spawn. Capping the fleet keeps each child near its uncontended
// cost and leaves the per-spawn bound meaning what it says.
//
// So the cap is DERIVED from the machine rather than picked for the author's, which was a delta-review
// finding on this PR: a hardcoded 4 is comfortable on the 8-core box this was written on and 2x
// oversubscription on a 2-vCPU CI runner, where four cold `tsx` starts could push a legitimately slow
// child past the 10s kill — reintroducing contention-driven flakiness one level below where it was
// fixed. `availableParallelism()` rather than `cpus().length` because it honors container and cgroup
// limits, which is exactly the CI case. The budget below follows the cap automatically, so a smaller
// runner simply gets more waves and a correspondingly larger budget.
//
// It goes down to 1, and an earlier floor of 2 was a third delta-review finding: a single-CPU container
// reports 1, and forcing two cold `tsx` processes onto it is the same oversubscription this derivation
// exists to prevent, just at the smallest size. Sequential IS the correct plan on one core, and because
// the budget is derived it expands to cover that (1 wide -> 13 waves -> 135s) instead of timing out.
// `Math.max(1, ...)` only guards a pathological 0; Node documents a minimum of 1.
const SPAWN_TIMEOUT_MS = 10_000;
const SPAWN_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

// Module scope, not test-body scope, because the test's TIMEOUT argument is evaluated at collection
// time and must derive from this length. Holding the list here is what lets adding a fourteenth entry
// point widen the budget automatically instead of quietly spending its headroom.
const COMPAT_ENTRYPOINTS = [
  "src/cli/backup.ts", "src/cli/batch-add.ts", "src/cli/connector-smoke.ts", "src/cli/digest.ts", "src/cli/report.ts",
  "src/cli/lists.ts", "src/cli/migrate.ts", "src/cli/players-backup.ts",
  "src/cli/players-restore.ts", "src/cli/refresh.ts", "src/cli/restore.ts", "src/cli/seed.ts", "src/server.ts",
];

// Worst case is one full per-spawn bound per wave, so the budget is waves x bound. Derived, never
// picked: the original case bounded thirteen sequential ~4s spawns at 30s and passed only on a fast,
// warm machine (issue #176).
//
// The slack is not padding, and leaving it out was a delta-review finding on this very PR. `timeout`
// KILLS a child at SPAWN_TIMEOUT_MS; its `close` event, the worker promises settling, and the `finally`
// cleanup all happen AFTER that. So a budget of exactly waves x bound expires at the same instant the
// last wave's children are killed, and Vitest reports a timeout even though every child honored its
// own bound — the failure mode this case was rewritten to remove, reintroduced one layer up.
const SPAWN_CLEANUP_SLACK_MS = 5_000;
const COMPAT_TEST_TIMEOUT_MS =
  Math.ceil(COMPAT_ENTRYPOINTS.length / SPAWN_CONCURRENCY) * SPAWN_TIMEOUT_MS + SPAWN_CLEANUP_SLACK_MS;

const validArgs: Record<string, string[]> = {
  "report player": ["--id", "1"],
  "players lists create": ["--name", "Prospects"],
  "players lists rename": ["--name", "Prospects", "--to", "Top 30"],
  "players lists delete": ["--name", "Prospects"],
  "players lists set-default": ["--name", "Prospects"],
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
  "players add": ["--name", "Acosta"],
  "players lists configure": ["--name", "Prospects", "--digest-hour", "5"],
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
      // signalCode covers a child already terminated by a signal, whose
      // exitCode stays null — signalling that process again would burn both
      // 5s waits below on an exit event that has already fired.
      if (candidate.exitCode !== null || candidate.signalCode !== null) return;
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
          // Let the rejected child exit on its own. src/server.ts registers the
          // SIGINT/SIGTERM handlers only AFTER a successful bind, so on this
          // path Node's default terminate-on-signal still applies: a SIGTERM
          // sent the instant EADDRINUSE reaches stderr races the self-exit and
          // kills the process by signal (exitCode null, signalCode SIGTERM)
          // instead of letting it settle at 1. Only escalate if it hangs.
          const collided = candidate.exitCode ?? await waitForExit(candidate, 10_000);
          if (collided === null) await stopChild(candidate);
          expect(collided).toBe(1);
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

  // #146: `refresh` gained its first option. It is declared in the router's
  // table, so BOTH entrypoints (`sk refresh` and `npm run refresh --`) validate
  // it from one definition — and no such guard existed before, because the leaf
  // had no options at all.
  it("accepts --quiet/-q on refresh and refuses every malformed spelling", () => {
    const refresh = COMMANDS.find((command) => command.path.join(" ") === "refresh")!;
    expect(preflight(refresh, [])).toBeNull();
    expect(preflight(refresh, ["--quiet"])).toBeNull();
    expect(preflight(refresh, ["-q"])).toBeNull();
    // It is a FLAG, not a value option: the `=` form must not silently pass.
    expect(preflight(refresh, ["--quiet=1"])).toContain("does not support '=' syntax");
    expect(preflight(refresh, ["--quiet", "--quiet"])).toContain("may not be repeated");
    expect(preflight(refresh, ["--loud"])).toContain("unknown option '--loud'");
    expect(preflight(refresh, ["surprise"])).toContain("unexpected argument");
    // The same rules through the direct npm-script entry point.
    expect(preflightDirect(["refresh"], ["--quiet"])).toBeNull();
    expect(preflightDirect(["refresh"], ["-q"])).toBeNull();
    expect(preflightDirect(["refresh"], ["--quiet=1"])).toContain("does not support '=' syntax");
    // Usage and example advertise the flags, so `sk refresh --help` is not a lie.
    // `--list` joined the leaf in #192; the alias-parity property test below
    // covers `-l` for the whole table, so it is not re-enumerated here.
    expect(refresh.usage).toBe("sk refresh [--quiet|-q] [--list NAME|-l NAME]");
    expect(refresh.example).toBe("sk refresh --quiet");
    expect(renderHelp(["refresh"])).toContain("--quiet, -q");
    expect(renderHelp(["refresh"])).toContain("--list, -l");
    expect(renderHelp(["refresh"])).toContain("Suppress live progress; print only the terminal summary.");
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

    // The presenter is handed the NORMALIZED argv, not the raw one (#191): the
    // router owns the option grammar, so a leaf never has to re-implement it and
    // can never disagree with preflight about what `-w` meant.
    const digestSeen: string[][] = [];
    const digest = commands.find((command) => command.path[0] === "digest")!;
    const digestOnly = [{ ...digest, load: async () => ({ main: async (argv: string[]) => { digestSeen.push(argv); return 29; } }) }];
    expect(await runRouter(["digest", "-w", "7d"], vi.fn(), digestOnly)).toBe(29);
    expect(digestSeen).toEqual([["--window", "7d"]]);

    digestSeen.length = 0;
    expect(await runRouter(["digest", "-l", "Prospects", "-f"], vi.fn(), digestOnly)).toBe(29);
    expect(digestSeen).toEqual([["--list", "Prospects", "--force"]]);
  });

  // #191. The defect this whole mechanism exists to prevent: `runRouter` hands
  // the ORIGINAL argv to each presenter, and each presenter re-implements flag
  // parsing. digest's `parseWindow` handled `-w`; `parseList` handled no alias at
  // all — so naively adding an `l` alias would have let `sk digest -l Prospects`
  // pass preflight, parse to `undefined`, and mail the WHOLE Watch List under a
  // line that reads like a scoped send.
  describe("normalizeOptions (#191)", () => {
    it("rewrites EVERY declared alias and inline form to one canonical spelling", () => {
      // A PROPERTY over the whole table, not an enumeration of today's commands:
      // a command added tomorrow with an alias is covered without editing this.
      for (const command of COMMANDS) {
        for (const option of command.options ?? []) {
          const long = `--${option.name}`;
          for (const alias of option.aliases ?? []) {
            const expected = option.value === false ? [long] : [long, "VALUE"];
            const short = option.value === false ? [`-${alias}`] : [`-${alias}`, "VALUE"];
            expect(normalizeOptions(command, short), `${command.path.join(" ")} -${alias}`).toEqual(expected);
            // Idempotent: the long form is already canonical and must not move.
            expect(normalizeOptions(command, expected), `${command.path.join(" ")} ${long}`).toEqual(expected);
          }
          if (option.inline === true && option.value !== false) {
            expect(normalizeOptions(command, [`${long}=VALUE`]), `${command.path.join(" ")} ${long}=`).toEqual([long, "VALUE"]);
          }
        }
      }
    });

    it("never rewrites a VALUE that looks like a flag, and leaves unknown tokens alone", () => {
      const digest = COMMANDS.find((command) => command.path.join(" ") === "digest")!;
      // `-l` here is the VALUE of --list, not a second option. Consuming the
      // following token is what keeps it from being re-read as one.
      expect(normalizeOptions(digest, ["--list", "-l"])).toEqual(["--list", "-l"]);
      expect(normalizeOptions(digest, ["-l", "-w"])).toEqual(["--list", "-w"]);
      // Pure: an option this command does not declare passes through untouched
      // (preflight already rejected it — normalization is not a second gate).
      expect(normalizeOptions(digest, ["--bogus", "x"])).toEqual(["--bogus", "x"]);
      expect(normalizeOptions(digest, [])).toEqual([]);
    });

    it("normalizes the DIRECT npm entry point too, prefix and all", () => {
      // The direct `npm run …` path bypasses runRouter entirely, so normalizing
      // in only one place would leave `npm run digest -- -l X` broken.
      expect(normalizeDirect(["digest"], ["-l", "Prospects"])).toEqual(["--list", "Prospects"]);
      expect(normalizeDirect(["digest"], ["--window=7d"])).toEqual(["--window", "7d"]);
      // The grouped verb the lists/seed scripts own is carried through verbatim.
      expect(normalizeDirect(["players", "lists", "create"], ["create", "--name", "P"], ["create"]))
        .toEqual(["create", "--name", "P"]);
      // An unresolvable path is preflight's business, not normalization's.
      expect(normalizeDirect(["nope"], ["-l", "X"])).toEqual(["-l", "X"]);
    });
  });

  it("gives EVERY --list option the short `l` alias (#191)", () => {
    // A property, not a list: the alias is declared once by `listOption()`, so a
    // command that grew its own `--list` without the alias fails here by name.
    const withList = COMMANDS.filter((command) => (command.options ?? []).some((option) => option.name === "list"));
    expect(withList.length, "no command declares --list — this guard would be vacuous").toBeGreaterThan(0);
    for (const command of withList) {
      const option = (command.options ?? []).find((candidate) => candidate.name === "list")!;
      expect(option.aliases, command.path.join(" ")).toContain("l");
    }
  });

  it("refuses `players add --ncaa --pick` at preflight (#191)", () => {
    const add = COMMANDS.find((command) => command.path.join(" ") === "players add")!;
    expect(preflight(add, ["--name", "Roch Cholowsky", "--ncaa"])).toBeNull();
    expect(preflight(add, ["--name", "smith", "--pick", "2"])).toBeNull();
    expect(preflight(add, ["--name", "Roch", "--ncaa", "--pick", "2"])).toContain("cannot be combined with '--ncaa'");
    // `--pick` is search-only and `--name` is required, exactly as on `seed add`.
    expect(preflight(add, ["--pick", "2"])).toContain("missing required option '--name'");
    expect(preflight(add, ["--name", "smith", "--pick", "01"])).toContain("canonical positive integer");
    expect(preflight(add, ["--name", "smith", "-l", "Prospects"])).toBeNull();
    expect(preflight(add, ["--name", "smith", "--list="])).toContain("invalid value");
  });

  it("validates `players lists configure` bounds at the router, midnight included (#191)", () => {
    const configure = COMMANDS.find((command) => command.path.join(" ") === "players lists configure")!;
    // Hour 0 is a valid MIDNIGHT digest — the DB CHECK allows it, so reusing the
    // positive-integer rule here would refuse a lane the database accepts.
    expect(preflight(configure, ["--name", "P", "--digest-hour", "0"])).toBeNull();
    expect(preflight(configure, ["--name", "P", "--digest-hour", "23"])).toBeNull();
    expect(preflight(configure, ["--name", "P", "--digest-hour", "24"])).toContain("hour 0-23");
    expect(preflight(configure, ["--name", "P", "--refresh-every", "0"])).toContain("positive integer");
    expect(preflight(configure, ["--name", "P", "--refresh-every", "1440"])).toBeNull();
    // `none` is the RESERVED clear token on all three.
    for (const flag of ["--digest-hour", "--refresh-every", "--digest-to"]) {
      expect(preflight(configure, ["--name", "P", flag, "none"]), flag).toBeNull();
    }
    // `-` is RESERVED as the DISPLAY sentinel (Reviewer P2, delta 1). It is
    // rejected at the input so a configured recipient can never render
    // identically to a cleared column — an operator, or a script parsing the
    // line, would otherwise read a live lane as unconfigured. The two numeric
    // flags already refuse it by taking only a canonical integer or `none`.
    // A BARE `-` never reaches the validator: preflight's generic rule already
    // refuses any value starting with `-`, so this was never the open door the
    // finding described. The PADDED form is, because it does not start with `-`
    // and only trims to the sentinel later — that is what the new validator
    // closes, and the service closes it again for non-CLI callers.
    expect(preflight(configure, ["--name", "P", "--digest-to", "-"])).toContain("requires a value");
    expect(preflight(configure, ["--name", "P", "--digest-to", "  -  "])).toContain("reserved");
    // A recipient that merely CONTAINS the sentinel is still perfectly valid.
    expect(preflight(configure, ["--name", "P", "--digest-to", "a-b@example.com"])).toBeNull();
    // Non-canonical spellings are usage errors, never coerced numbers.
    for (const bad of ["07", "1e2", "+5", "3.0", "-1"]) {
      expect(preflight(configure, ["--name", "P", "--digest-hour", bad]), bad).not.toBeNull();
      expect(preflight(configure, ["--name", "P", "--refresh-every", bad]), bad).not.toBeNull();
    }
    // A no-op invocation fails loudly rather than succeeding as a nothing.
    expect(preflight(configure, ["--name", "P"])).toContain("one of --refresh-every, --digest-hour, --digest-to");
  });

  // The CLI twin of the MCP tool-documentation guard #190 shipped
  // (test/mcp.test.ts). A command that exists but is undocumented is invisible
  // to the only reader who needs it, and nothing else in the repo checks it —
  // `connector smoke` had been shipping undocumented in this file since #37.
  it("documents every routed command path in docs/cli/README.md", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
    const doc = readFileSync(join(repo, "docs", "cli", "README.md"), "utf8");
    // Matched as the invocation an operator would actually type (`sk <path>`),
    // not as a bare word: "digest" appears in prose constantly, so a substring
    // check on the path alone would pass for a command nobody documented.
    const undocumented = COMMANDS.map((command) => `sk ${command.path.join(" ")}`).filter((invocation) => !doc.includes(invocation));
    expect(undocumented).toEqual([]);
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

  // Issue #176. This case spawns a real `tsx` per entry point, and a cold `tsx` start costs ~4s on the
  // HC's machine — so thirteen of them RUN SEQUENTIALLY took ~52s against a 30s test budget, and the
  // case passed only when every spawn happened to come in under ~2.3s. Worse, the per-spawn bound is
  // 10s each: 13 x 10s = 130s worst case, so the test's own timeout could never accommodate its own
  // per-spawn timeouts. The arithmetic was never right; a fast, warm machine just usually won.
  //
  // The fix is concurrency, not a bigger number. Raising the budget until the flake stops is how a
  // wall-clock-sensitive assertion gets re-tuned forever; running the spawns concurrently makes the
  // wall clock ~one spawn instead of thirteen, so a budget that clears a single SPAWN_TIMEOUT_MS is
  // provably sufficient rather than empirically lucky.
  //
  // Each entry point also gets its OWN working directory. Sharing one was harmless while the spawns
  // were sequential; running them at the same time in a shared cwd would couple thirteen processes
  // through the filesystem and reintroduce flakiness by a different route.
  it("keeps every direct compatibility entry point bounded and exit-draining on default argv", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-compat-"));
    try {
      const entrypoints = COMPAT_ENTRYPOINTS;

      const runEntrypoint = async (entrypoint: string) => {
        const cwd = join(work, entrypoint.replace(/[/.]/g, "_"));
        mkdirSync(cwd, { recursive: true });
        const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), [join(process.cwd(), entrypoint)], {
          cwd,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: SPAWN_TIMEOUT_MS,
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        // `status` is null exactly when the child was KILLED rather than exiting on its own — which is
        // what `timeout` above does when it fires. So resolving with the exit status preserves the
        // original `expect(result.status).not.toBeNull()` as the real boundedness assertion, rather
        // than degrading it into "the promise settled".
        return await new Promise<{ entrypoint: string; error?: Error; status: number | null; stderr: string }>((resolve) => {
          child.once("error", (error: Error) => resolve({ entrypoint, error, status: null, stderr }));
          child.once("close", (status) => resolve({ entrypoint, status, stderr }));
        });
      };

      // A shared index each worker pulls from, so a slow entry point delays only itself rather than a
      // whole fixed slice — with thirteen items over four workers, static chunking would idle three of
      // them behind the chunk that happens to hold the slowest spawn.
      let next = 0;
      const results: Awaited<ReturnType<typeof runEntrypoint>>[] = [];
      await Promise.all(Array.from({ length: SPAWN_CONCURRENCY }, async () => {
        for (let i = next++; i < entrypoints.length; i = next++) {
          results.push(await runEntrypoint(entrypoints[i] as string));
        }
      }));

      expect(results).toHaveLength(entrypoints.length);
      for (const result of results) {
        expect(result.error, result.entrypoint).toBeUndefined();
        expect(result.status, result.entrypoint).not.toBeNull();
        expect(result.stderr, result.entrypoint).toMatch(/error[=:]/);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, COMPAT_TEST_TIMEOUT_MS);

  it("validates the report-player Presentation flags at the ROUTER layer, before the leaf loads", async () => {
    const command = COMMANDS.find((c) => c.path.join(" ") === "report player")!;
    // Declared in BOTH layers on purpose: preflight must reject a bad --format
    // BEFORE ./report.js (and `startupDb`) is ever imported, and report.ts
    // re-checks because its parser is also reachable directly.
    expect(preflight(command, ["--id", "1", "--format", "console"])).toBeNull();
    expect(preflight(command, ["--id", "1", "--format=html"])).toBeNull();
    expect(preflight(command, ["--id", "1", "--out", "card.html"])).toBeNull();
    expect(preflight(command, ["--id", "1", "--open"])).toBeNull();
    expect(preflight(command, ["--id", "1", "--format", "pdf"])).toContain("invalid value 'pdf'");
    // The rejection ENUMERATES the accepted values rather than saying "invalid".
    expect(preflight(command, ["--id", "1", "--format", "pdf"])).toContain("console, json, html");
    expect(preflight(command, ["--id", "1", "--out"])).toContain("requires a value");
    // --open is a boolean flag, so a value is a usage error either way it is
    // spelled — never a silent accept that leaves the operator guessing.
    expect(preflight(command, ["--id", "1", "--open=true"])).toContain("does not support '=' syntax");
    expect(preflight(command, ["--id", "1", "--open", "true"])).toContain("unexpected argument");

    // Reachable through the real entry point with no leaf loaded.
    const loader = vi.fn(async () => ({ main: vi.fn(async () => 0) }));
    const commands = COMMANDS.map((c) => (c.path.join(" ") === "report player" ? { ...c, load: loader } : c));
    const output = vi.fn();
    expect(await runRouter(["report", "player", "--id", "1", "--format", "pdf"], output, commands)).toBe(1);
    expect(loader).not.toHaveBeenCalled();

    // The help text advertises all three flags and the accepted format values.
    const help = renderHelp(["report", "player"]);
    for (const fragment of ["--format", "--out", "--open", "console | json | html"]) {
      expect(help, fragment).toContain(fragment);
    }
  });

  it("reports unknown and incomplete commands without loading a leaf", async () => {
    const output = vi.fn();
    expect(await runRouter(["unknown"], output)).toBe(1);
    expect(await runRouter(["players", "lists"], output)).toBe(1);
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("error:");
  });
});
