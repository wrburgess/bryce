import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import type { OpenedDb } from "../src/db/client.js";
import { playerLists } from "../src/db/schema.js";
import type { TickCliDeps } from "../src/cli/tick.js";
import { runTickCli } from "../src/cli/tick.js";
import { COMMANDS, normalizeDirect, preflightDirect } from "../src/cli/router.js";
import { configureList, resolveDefaultList } from "../src/lists/service.js";
import { MlbClient } from "../src/mlb/client.js";
import {
  CapturingMailer,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  enrollInDefaultLane,
  fakeClock,
  insertCalendars2026,
  insertLane,
  insertPlayer,
  insertStatLine,
  makeSeasonBody,
  testDb,
} from "./factories.js";

/**
 * `npm run tick [-- --quiet]` — the presenter for the one scheduled job (#193 /
 * ADR 0062). Driven end to end through its injected deps, because the risk is
 * never the parse: a flag that parsed and was then dropped on the way to
 * `runTick` would be silently dead with the suite green (rules/testing.md).
 *
 * The load-bearing contract here is `--quiet` printing EXACTLY ONE LINE. The
 * scheduled agent runs ~96 times a day into an unrotated `logs/tick.log`, and
 * three separate streams can leak around that line — the refresh liveness
 * stream, the refresh job's legacy notice lines, and the digest's
 * unclassified-field warnings. Each is asserted against a fixture that actually
 * PRODUCES one, never against a quiet no-op that would pass either way.
 */
describe("tick CLI", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let clock: ReturnType<typeof fakeClock>;
  let output: string[];
  let errors: string[];

  const deps = (overrides: Partial<TickCliDeps> = {}): TickCliDeps => ({
    db: opened.db,
    client: new MlbClient({
      fetchImpl: new FakeStatsApi({ seasons: { 1: makeSeasonBody() } }).fetch,
      delayMs: 0,
    }),
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
    ...overrides,
  });

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    clock = fakeClock(MID_SEASON);
    output = [];
    errors = [];
    await insertCalendars2026(opened.db);
    // Clear the migration's seeded cadence so each case declares its own.
    await opened.db.update(playerLists).set({ refreshIntervalMinutes: null, digestHour: null });
  });

  afterEach(() => {
    opened.close();
  });

  /** The default lane, holding one player with a line in yesterday's window. */
  async function scheduledDefaultLane(digestHour = 0): Promise<void> {
    const player = await insertPlayer(opened.db, { fullName: "Any Player" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await enrollInDefaultLane(opened.db, [player]);
    const lane = await resolveDefaultList(opened.db);
    await configureList(opened.db, lane.name, { digestHour }, clock.now());
  }

  it("prints EXACTLY ONE line for a tick with nothing due, and exits 0", async () => {
    // The steady state: 96 ticks a day, almost all of them no-ops. One line each
    // is the difference between a few kilobytes a day and a log nobody rotates.
    expect(await runTickCli([], deps())).toBe(0);
    expect(output).toEqual(["tick done refreshed=0 digests=0 ok=true"]);
    expect(errors).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
  });

  it("reports each stage on its own greppable line when work IS due", async () => {
    await scheduledDefaultLane();

    expect(await runTickCli([], deps())).toBe(0);
    expect(output).toHaveLength(2);
    expect(output[0]).toBe(
      "tick digest list=Watchlist kind=digest action=sent statLines=1 players=1",
    );
    expect(output[1]).toBe("tick done refreshed=0 digests=1 ok=true");
    // ASCII only, and `key=value` throughout — the same greppability contract
    // the refresh stream holds itself to (ADR 0047).
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
  });

  it("--quiet prints ONLY the terminal line, with a warning-producing fixture in play", async () => {
    // The fixture matters: an unclassified stat field makes `runDigest` emit a
    // warning, so a build that let digest warnings through would print two
    // lines here. A clean fixture would pass whether or not the plumbing works.
    const player = await insertPlayer(opened.db, { fullName: "Any Player" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 1, atBats: 3, unclassifiedNewField: 4 },
    });
    await enrollInDefaultLane(opened.db, [player]);
    const lane = await resolveDefaultList(opened.db);
    await configureList(
      opened.db,
      lane.name,
      { digestHour: 0, refreshIntervalMinutes: 30 },
      clock.now(),
    );

    expect(await runTickCli(["--quiet"], deps())).toBe(1); // the offline sweep fails
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^tick done refreshed=1 digests=1 ok=false$/);
    // Nothing leaked to stderr either — not the refresh notice lines, not the
    // collected digest warning.
    expect(errors).toEqual([]);
    // ...and the work really happened, so this is not a vacuous quiet pass.
    expect(mailer.sent).toHaveLength(1);
  });

  it("-q is the same flag as --quiet through the router's normalization", async () => {
    await scheduledDefaultLane();
    // Routed, not hand-written: an alias dropped on the way to the parser would
    // print the verbose stream from the scheduled agent.
    expect(await runTickCli(normalizeDirect(["tick"], ["-q"]), deps())).toBe(0);
    expect(output).toEqual(["tick done refreshed=0 digests=1 ok=true"]);
  });

  it("verbose mode replays a collected digest warning to stderr, after the stream", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Any Player" });
    await insertStatLine(opened.db, {
      playerId: player.id,
      gameDate: "2026-07-18",
      stats: { hits: 1, atBats: 3, unclassifiedNewField: 4 },
    });
    await enrollInDefaultLane(opened.db, [player]);
    const lane = await resolveDefaultList(opened.db);
    await configureList(opened.db, lane.name, { digestHour: 0 }, clock.now());

    expect(await runTickCli([], deps())).toBe(0);
    // Collected and replayed, never written mid-stream: a warning landing
    // between two `key=value` lines would break a reader parsing them in order.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unclassifiedNewField");
    expect(output.at(-1)).toContain("tick done");
  });

  it("exits 1 on a failed send, AFTER attempting every due lane", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Any Player" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertLane(opened.db, "A", [player]);
    await insertLane(opened.db, "B", [player]);
    await configureList(opened.db, "A", { digestHour: 0 }, clock.now());
    await configureList(opened.db, "B", { digestHour: 0 }, clock.now());

    let sends = 0;
    const flaky = {
      send: (...args: Parameters<CapturingMailer["send"]>) => {
        sends += 1;
        if (sends === 1) return Promise.reject(new Error("postmark down"));
        return mailer.send(...args);
      },
    };

    expect(await runTickCli([], deps({ mailer: flaky }))).toBe(1);
    // Both lanes reported, in order, and the exit code came after both.
    expect(output[0]).toContain("list=A kind=digest action=failed");
    expect(output[0]).toContain("reason=postmark_down"); // token-folded
    expect(output[1]).toContain("list=B kind=digest action=sent");
    expect(output[2]).toBe("tick done refreshed=0 digests=2 ok=false");
  });

  it("folds a lane name so it can never forge a token or a second lane", async () => {
    // ADR 0047, as amended for #146: a lane name is operator-supplied free text
    // that lands in a `key=value` line, so a lane called `x ok=true` must not be
    // able to plant a counter ahead of the real one.
    const player = await insertPlayer(opened.db, { fullName: "Any Player" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    await insertLane(opened.db, "x ok=true,B", [player]);
    await configureList(opened.db, "x ok=true,B", { digestHour: 0 }, clock.now());

    expect(await runTickCli([], deps())).toBe(0);
    expect(output[0]).toContain("list=x_ok=true_B");
    // The comma is neutralised too, or one lane would read as two.
    expect(output[0]).not.toContain("list=x ok=true,B");
    expect(output.at(-1)).toBe("tick done refreshed=0 digests=1 ok=true");
  });

  it("refuses an unknown flag with a usage error, exit 1, BEFORE any side effect", async () => {
    // rules/scripting.md: a malformed invocation fails loudly and does nothing.
    // Asserted against a fixture that WOULD have sent — otherwise "nothing was
    // mailed" is true for the wrong reason.
    await scheduledDefaultLane();

    expect(await runTickCli(["--nope"], deps())).toBe(1);
    expect(errors).toEqual(["error: unknown option '--nope'"]);
    expect(output).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses `--quiet VALUE`: a boolean flag takes no value", async () => {
    await scheduledDefaultLane();
    expect(await runTickCli(["--quiet", "yes"], deps())).toBe(1);
    expect(errors[0]).toContain("unexpected argument 'yes'");
    expect(mailer.sent).toHaveLength(0);
  });

  describe("router table", () => {
    it("declares `tick` with the quiet flag and its short alias", () => {
      const tick = COMMANDS.find((command) => command.path.join(" ") === "tick");
      expect(tick).toBeDefined();
      expect(preflightDirect(["tick"], [])).toBeNull();
      expect(preflightDirect(["tick"], ["--quiet"])).toBeNull();
      expect(preflightDirect(["tick"], ["-q"])).toBeNull();
      expect(preflightDirect(["tick"], ["--list", "L"])).toContain("unknown option '--list'");
    });
  });
});

/**
 * The REAL entry point, in a REAL process — the exact invocation
 * `ops/templates/com.sk.tick.plist` runs (`npm run tick -- --quiet`), minus npm.
 *
 * Two properties can only be proven here. The `--quiet` contract is what the
 * scheduled agent depends on, and `runTickCli`'s injected sinks cannot show that
 * `main()` wires the real ones the same way; and the drain contract (P2) —
 * `process.exitCode` and RETURN, never `process.exit()` — is only observable
 * when stdout is a genuine backpressured pipe.
 */
describe("tick CLI real subprocess", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  const offlineFetch = join(repoRoot, "test", "helpers", "offline-fetch.mjs");
  let work: TempDir;

  beforeEach(() => { work = makeTempDir(); });
  afterEach(() => { work.cleanup(); });

  /**
   * Run one CLI against its OWN database file. Separate databases matter here:
   * a sweep advances the lane's refresh clock, so a second tick over the same
   * database has nothing due and would compare quiet mode against an empty run.
   */
  const runCli = (dbName: string, script: string, args: string[]) =>
    spawnSync(tsxBin, [join(repoRoot, "src", "cli", script), ...args], {
      encoding: "utf8",
      cwd: work.path,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MAILER_PROVIDER: "console",
        DATABASE_PATH: join(work.path, dbName),
        BACKUP_DIR: join(work.path, "snapshots"),
        BRYCE_TZ: "America/Chicago",
        NODE_OPTIONS: `--import=${offlineFetch}`,
      },
    });

  /**
   * A migrated database whose seeded lane keeps its 1440-minute refresh interval
   * but has its digest hour CLEARED, through the real operator command.
   *
   * Clearing it is not convenience. The `console` mailer PRINTS the message it
   * would have sent — the provider's output, not the tick's — so leaving a
   * digest due would put a rendered email on stdout and make "exactly one line"
   * untestable here. The digest side's quiet plumbing is proven in-process
   * above with a warning-producing fixture; what only a real process can show is
   * that `main()` wires the sinks the way `runTickCli` does, and that the
   * REFRESH liveness stream — the bulk of the volume — is really suppressed.
   */
  const migratedDb = (dbName: string): void => {
    expect(runCli(dbName, "migrate.ts", []).status, dbName).toBe(0);
    const cleared = runCli(dbName, "lists.ts", [
      "configure", "--name", "Watchlist", "--digest-hour", "none",
    ]);
    expect(cleared.status, cleared.stderr).toBe(0);
  };

  // One test, six spawns: process startup dominates the cost here, and the
  // quiet/verbose pair has to run against two databases (see `runCli`).
  it("runs the plist's own invocation quietly, and fails a bad flag before any work", () => {
    migratedDb("quiet.db");
    migratedDb("verbose.db");

    // Each database's lane has a 1440-minute refresh interval and no covering
    // run, so both ticks have REAL work: a sweep runs, and under --quiet its
    // whole liveness stream must stay off stdout.
    const quiet = runCli("quiet.db", "tick.ts", ["--quiet"]);
    const lines = quiet.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^tick done refreshed=1 digests=0 ok=(true|false)$/);
    // ASCII only, so the line stays greppable out of an unrotated log.
    expect(lines[0]).toMatch(/^[\x20-\x7e]*$/);

    // The VERBOSE run over an IDENTICAL database prints more, which is what
    // makes the assertion above a property of `--quiet` rather than of a tick
    // that happened to have nothing to say.
    const verbose = runCli("verbose.db", "tick.ts", []);
    const verboseLines = verbose.stdout.split("\n").filter((line) => line.length > 0);
    expect(verboseLines.length).toBeGreaterThan(1);
    expect(verboseLines.at(-1)).toMatch(/^tick done /);

    // A malformed invocation exits 1 with a usage error and does NOTHING —
    // asserted on stdout being empty, because the tick's terminal line is what
    // a completed run always prints.
    const bad = runCli("quiet.db", "tick.ts", ["--nope"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("error: unknown option '--nope'");
    expect(bad.stdout.trim()).toBe("");
  }, 90_000);
});
