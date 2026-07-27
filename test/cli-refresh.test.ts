import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { RefreshCliDeps, RefreshTicker } from "../src/cli/refresh.js";
import { STALL_MS, parseQuiet, runRefreshCli } from "../src/cli/refresh.js";
import { MlbClient } from "../src/mlb/client.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  makeGameLogBody,
  makeMlbTeam,
  makePerson,
  makeSeasonBody,
  makeSplit,
  makeTeam,
  testDb,
} from "./factories.js";

/**
 * `npm run refresh`. The CLI is the ONLY presenter of the Refresh Liveness
 * stream (#146, ADR 0056), so two distinct risks live here:
 *   1. the WIRING (#23, MF6) — exit code and failure print — which #146 must not
 *      disturb, and
 *   2. the RENDERING — that a piped run stays control-free and greppable, that a
 *      TTY's cursor control is confined to the one in-flight line, that a stalled
 *      call becomes visible, and that `--quiet` reproduces today's output exactly.
 * Every case drives `runRefreshCli` through injected deps and asserts the
 * OBSERVABLE effects; nothing captures global stdout or stderr.
 */

/**
 * A ticker whose interval never really elapses. A test FIRES it explicitly (from
 * inside a pending fetch), so a stall is exercised without a wall-clock wait —
 * rules/testing.md forbids a real sleep.
 */
function fakeTicker(): RefreshTicker & { live: () => number; fire: () => void } {
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    start: (tick) => { const handle = next++; live.set(handle, tick); return handle; },
    stop: (handle) => { live.delete(handle as number); },
    live: () => live.size,
    fire: () => { for (const tick of [...live.values()]) tick(); },
  };
}

describe("refresh CLI (#23 MF6 wiring, #146 presenter)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let clock: ReturnType<typeof fakeClock>;
  let output: string[];
  let errors: string[];
  let raw: string[];
  let ticker: ReturnType<typeof fakeTicker>;

  const deps = (overrides: Partial<RefreshCliDeps> = {}): RefreshCliDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    now: clock.now,
    tz: TEST_TZ,
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
    writeRaw: (text) => raw.push(text),
    ticker,
    ...overrides,
  });

  const failing = (pattern: RegExp, message: string): MlbClient =>
    new MlbClient({
      fetchImpl: (url: string) =>
        pattern.test(url) ? Promise.reject(new Error(message)) : api.fetch(url),
      delayMs: 0,
    });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({
      person: makePerson(),
      teams: { 564: makeTeam(), 146: makeMlbTeam() },
      seasons: { 1: makeSeasonBody(), 11: makeSeasonBody({ regularSeasonStartDate: "2026-03-27" }) },
      gameLogs: { "11:hitting": makeGameLogBody("hitting", [makeSplit({ game: { gamePk: 900001, gameNumber: 1 } })]) },
    });
    output = [];
    errors = [];
    raw = [];
    ticker = fakeTicker();
  });

  afterEach(() => {
    opened.close();
  });

  // --- Exit semantics and the failure print: UNCHANGED by #146 ---------------
  // The terminal line is asserted as the LAST line, not the first, because the
  // live stream now precedes it. Its content and the exit code are untouched.

  it("exits 0 and prints no failures on a clean `ok` run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=ok");
    expect(output.at(-1)).toContain("players=1");
    expect(errors).toEqual([]);
  });

  it("exits 0 on a safe `partial` run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=partial");
    expect(output.at(-1)).toContain("skipped=1");
    expect(errors).toEqual([]);
  });

  it("exits 0 BUT prints the failure summary on a safe `partial` (a failure alongside a success)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: 660271 });
    expect(await runRefreshCli([], deps({ client: failing(/\/people\/660271\?/, "b down") }))).toBe(0);
    expect(output.at(-1)).toContain("status=partial");
    expect(output.at(-1)).toContain("failed=1");
    // The one-line failure summary is printed even though the exit code is 0.
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("b down");
  });

  it("exits 1 and prints the failure summary on a blocked `failed` run", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli([], deps({ client: failing(/\/people\//, "all down") }))).toBe(1);
    expect(output.at(-1)).toContain("status=failed");
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("all down");
  });

  it("exits 0 and reports the reason on a skipped (Offseason Sleep) run", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output).toEqual(["refresh skipped reason=offseason-sleep"]);
    expect(errors).toEqual([]);
  });

  // --- `--quiet`: exactly today's output --------------------------------------

  it("--quiet reproduces the pre-#146 output BYTE-IDENTICALLY on every terminal shape", async () => {
    // Case 1: clean ok. Quiet prints ONE line and nothing else.
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(output).toEqual([
      "refresh done status=ok players=1 skipped=0 failed=0 inserted=1 updated=0",
    ]);
    expect(errors).toEqual([]);
    expect(raw).toEqual([]);

    // Case 2: a failure alongside a success — exit 0, stderr summary intact.
    output = []; errors = []; raw = [];
    const failer = await insertPlayer(opened.db, { externalId: 660271 });
    expect(await runRefreshCli(["-q"], deps({ client: failing(/\/people\/660271\?/, "b down") }))).toBe(0);
    expect(output).toEqual([
      "refresh done status=partial players=1 skipped=0 failed=1 inserted=0 updated=1",
    ]);
    expect(errors).toEqual([
      `refresh failures: 1 player(s), 0 calendar fetch(es); players: ${failer.id} (b down)`,
    ]);
  });

  it("--quiet on a Skipped Sweep prints only the pre-#146 skip line", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(output).toEqual(["refresh skipped reason=offseason-sleep"]);
    expect(errors).toEqual([]);
    expect(raw).toEqual([]);
  });

  it("--quiet keeps exit 1 on a blocked run, with the stderr summary", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps({ client: failing(/\/people\//, "all down") }))).toBe(1);
    expect(output).toEqual([
      "refresh done status=failed players=0 skipped=0 failed=1 inserted=0 updated=0",
    ]);
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
  });

  it("--quiet still emits the three legacy notice lines, which are unconditional today", async () => {
    // 2027 has no bundled NCAA season, so refreshNcaaCalendar hits the notice path.
    clock.set("2027-07-19T17:00:00Z");
    await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(errors).toContain(
      "refresh: no bundled NCAA season lookup for year=2027; " +
        "NCAA treated as not In Season (update src/ncaa/seasons.ts)",
    );
    // Everything else is still suppressed.
    expect(output).toEqual([
      "refresh done status=partial players=0 skipped=1 failed=0 inserted=0 updated=0",
    ]);
  });

  it("parseQuiet accepts both spellings and rejects the lookalikes", () => {
    expect(parseQuiet(["--quiet"])).toBe(true);
    expect(parseQuiet(["-q"])).toBe(true);
    expect(parseQuiet([])).toBe(false);
    expect(parseQuiet(["--quietly"])).toBe(false);
    expect(parseQuiet(["--no-quiet"])).toBe(false);
  });

  it("rejects an unknown option before doing any work, exiting 1", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(["--loud"], deps())).toBe(1);
    expect(errors[0]).toBe("error: unknown option '--loud'");
    expect(output).toEqual([]);
  });

  // --- Piped rendering --------------------------------------------------------

  it("a piped run is append-only, control-free ASCII on EVERY line", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);

    // Sized so a SINGLE stray escape anywhere in the stream fails this.
    expect(output.length).toBeGreaterThan(20);
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
    // No cursor control was even attempted on the non-TTY path.
    expect(raw).toEqual([]);

    // The grammar is greppable: every line starts with the same token, and the
    // per-player lines carry an advancing index/total.
    expect(output.every((l) => l.startsWith("refresh"))).toBe(true);
    expect(output).toContain("refresh start players=2 season=2026 run=1");
    expect(output.filter((l) => / player=\d+\/2 /.test(l)).length).toBeGreaterThan(0);
    expect(output.some((l) => l.includes("done outcome=refreshed"))).toBe(true);
    expect(output.some((l) => l.includes("done outcome=passed-over"))).toBe(true);
    // Every elapsed value uses ONE unit — integer milliseconds with an `ms` suffix.
    for (const line of output.filter((l) => l.includes("elapsed="))) {
      expect(line, line).toMatch(/elapsed=\d+ms(\s|$)/);
    }
  });

  it("folds an identity that carries an ANSI escape and an accent into one safe ASCII token", async () => {
    // Written as \uXXXX ESCAPES on purpose: a typed accented character collapses
    // NFD/NFC to one form and defeats the fold, and rules/backend.md forbids a
    // literal control byte in a source file.
    // "Roch" + n + COMBINING TILDE (the NFD spelling of \u00f1), a bare ESC that
    // would otherwise clear the screen mid-render, and a newline that would forge
    // a second record. Every code point is written as an escape.
    const hostile = "Roch\u006e\u0303 \u001b[2JCholowsky\nSECOND LINE";
    await insertPlayer(opened.db, { externalId: 691185, fullName: hostile });
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);

    const started = output.find((l) => l.includes("name="));
    expect(started).toBeDefined();
    // The escape is gone, the accents are folded, the forged second line is
    // collapsed into the same record, and spaces became `_` so `key=value` holds.
    expect(started).toBe("refresh player=1/1 id=1 name=Rochn_?[2JCholowsky_SECOND_LINE start");
    expect(started).not.toContain("\u001b");
    expect(started).not.toContain("\u00f1");
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
  });

  it("folds a hostile FAILURE REASON so upstream text cannot forge a trailing token", async () => {
    // A `reason` is `err.message` from a provider adapter, and a zod failure
    // embeds the API's own payload text — so it is exactly as upstream-influenced
    // as a name, and on `player-settled` it is FOLLOWED by elapsed/refreshed/
    // passedOver/failed. Folding accents and control bytes is not enough: a bare
    // SPACE still terminates a token, so a crafted message could append counters
    // that read as this run's real ones.
    await insertPlayer(opened.db, { externalId: 691185 });
    const hostile = "boom refreshed=999 passedOver=999 failed=0";
    // The sole player failed, so the sweep refreshed nobody: `failed` -> exit 1
    // (#23, MF6). The exit contract is asserted here too so this case cannot
    // quietly become a `partial` if the status rule is ever loosened.
    expect(
      await runRefreshCli([], deps({ client: failing(/\/people\/691185\?/, hostile), isTty: false })),
    ).toBe(1);

    const settled = output.find((l) => l.includes("done outcome=failed"));
    expect(settled).toBeDefined();
    // Sized so the defect this guards would push it over the line: without the
    // fold there would be FOUR `refreshed=`-style tokens on the line, three of
    // them forged, and the first one a reader hit would be the attacker's.
    expect((settled!.match(/ refreshed=/g) ?? []).length).toBe(1);
    expect((settled!.match(/ passedOver=/g) ?? []).length).toBe(1);
    expect(settled).toContain("reason=boom_refreshed=999_passedOver=999_failed=0");
    // The run's OWN counters are the real ones, and they come last.
    expect(settled).toMatch(/ refreshed=0 passedOver=0 failed=1$/);
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
  });

  // --- Stall visibility -------------------------------------------------------

  it("a piped run reports a stalled call once per interval, and never for a fast one", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    // Fire the interval from INSIDE the pending identity fetch, advancing only
    // the injected clock — no wall-clock wait anywhere.
    const stallingClient = new MlbClient({
      fetchImpl: (url: string) => {
        if (url.includes("/people/691185?")) {
          clock.set("2026-07-19T17:00:31Z"); // 31s in
          ticker.fire();
          clock.set("2026-07-19T17:01:02Z"); // 62s in
          ticker.fire();
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    expect(await runRefreshCli([], deps({ isTty: false, client: stallingClient }))).toBe(0);
    const waiting = output.filter((l) => l.includes(" waiting "));
    expect(waiting).toEqual([
      "refresh player=1/1 id=1 waiting call=getPerson personId=691185 elapsed=31000ms",
      "refresh player=1/1 id=1 waiting call=getPerson personId=691185 elapsed=62000ms",
    ]);
    expect(STALL_MS).toBe(30_000);
  });

  it("a call that completes inside the threshold produces no waiting line at all", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const briefClient = new MlbClient({
      fetchImpl: (url: string) => {
        if (url.includes("/people/691185?")) {
          clock.set("2026-07-19T17:00:05Z"); // 5s — well inside the threshold
          ticker.fire();
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    expect(await runRefreshCli([], deps({ isTty: false, client: briefClient }))).toBe(0);
    expect(output.filter((l) => l.includes(" waiting "))).toEqual([]);
    // The call itself is still reported, with its elapsed time.
    expect(output.some((l) => l.includes("call=getPerson personId=691185 outcome=ok"))).toBe(true);
  });

  it("leaves no live timer behind once the run has finished", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);
    // A surviving interval would hold the event loop open, and src/cli/refresh.ts
    // deliberately relies on natural drain rather than process.exit() (P2).
    expect(ticker.live()).toBe(0);
  });

  it("releases the timer on a skipped sweep too", async () => {
    await insertPlayer(opened.db, { externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);
    expect(ticker.live()).toBe(0);
  });

  // --- TTY rendering ----------------------------------------------------------

  it("on a TTY, cursor control appears ONLY on the in-flight line; settled lines stay plain", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const tickingClient = new MlbClient({
      fetchImpl: (url: string) => {
        if (url.includes("/people/691185?")) {
          clock.set("2026-07-19T17:00:01Z");
          ticker.fire();
        }
        return api.fetch(url);
      },
      delayMs: 0,
    });

    expect(await runRefreshCli([], deps({ isTty: true, client: tickingClient }))).toBe(0);

    // Every APPEND-ONLY line — including the terminal summary — is plain text.
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
    // The in-place line redrew, carrying the escape and the ticking elapsed time.
    const redraws = raw.filter((t) => t.includes("elapsed="));
    expect(redraws.length).toBeGreaterThan(0);
    expect(redraws[0]).toBe(
      `\rrefresh player=1/1 id=1 name=Maximo_Acosta call=getPerson personId=691185 elapsed=1000ms\u001b[K`,
    );
    // ...and it was erased before the next append-only line was written.
    expect(raw).toContain("\r\u001b[K");
    expect(await runRefreshCli(["--quiet"], deps({ isTty: true }))).toBe(0);
  });

  it("--quiet writes nothing raw even on a TTY", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps({ isTty: true }))).toBe(0);
    expect(raw).toEqual([]);
    expect(output).toEqual([
      "refresh done status=ok players=1 skipped=0 failed=0 inserted=1 updated=0",
    ]);
  });
});

/**
 * The drain contract (P2), re-verified rather than assumed: `src/cli/refresh.ts`
 * sets `process.exitCode` and returns instead of calling `process.exit()`, so a
 * backpressured pipe finishes flushing. The verbose stream makes that a real
 * question again — it writes far more than the single line the rule was written
 * for — so this runs the REAL entrypoint in a REAL process with stdout piped and
 * asserts the LAST line survived.
 */
describe("refresh CLI real subprocess drain", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  const offlineFetch = join(repoRoot, "test", "helpers", "offline-fetch.mjs");
  let work: TempDir;

  beforeEach(() => { work = makeTempDir(); });
  afterEach(() => { work.cleanup(); });

  const runCli = (script: string, args: string[]) =>
    spawnSync(tsxBin, [join(repoRoot, "src", "cli", script), ...args], {
      encoding: "utf8",
      cwd: work.path,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MAILER_PROVIDER: "console",
        DATABASE_PATH: join(work.path, "bryce.db"),
        BACKUP_DIR: join(work.path, "snapshots"),
        BRYCE_TZ: "America/Chicago",
        NODE_OPTIONS: `--import=${offlineFetch}`,
      },
    });

  // One test, three spawns: process startup dominates the cost here, and both
  // modes share the same migrated database.
  it("pipes a verbose run without truncating the terminal line, and --quiet prints only it", () => {
    expect(runCli("migrate.ts", []).status).toBe(0);

    const verbose = runCli("refresh.ts", []);
    expect(verbose.status).toBe(0);
    const lines = verbose.stdout.split("\n").filter((l) => l.length > 0);
    // The live stream really did run (the offline fixture fails every calendar
    // fetch, so each one reports itself), and the terminal line is still last —
    // nothing was lost to a truncated pipe.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.startsWith("refresh call=getSeason"))).toBe(true);
    expect(lines.at(-1)).toMatch(/^refresh done status=ok players=0/);
    for (const line of lines) expect(line, line).toMatch(/^[\x20-\x7e]*$/);

    const quiet = runCli("refresh.ts", ["--quiet"]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout.split("\n").filter((l) => l.length > 0)).toEqual([
      expect.stringMatching(/^refresh done status=ok players=0/) as unknown as string,
    ]);
  }, 60_000);
});
