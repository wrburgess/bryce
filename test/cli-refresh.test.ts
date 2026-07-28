import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { RefreshCliDeps, RefreshTicker } from "../src/cli/refresh.js";
import { STALL_MS, parseQuiet, resolveRefreshScope, runRefreshCli } from "../src/cli/refresh.js";
import { playerLists, refreshRuns } from "../src/db/schema.js";
import { claimRefreshRun } from "../src/jobs/refresh-run.js";
import { normalizeDirect } from "../src/cli/router.js";
import { MlbClient } from "../src/mlb/client.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import {
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  enrollInDefaultLane,
  fakeClock,
  insertCalendars2026,
  insertLane,
  insertListMember,
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
 * stream (#146, ADR 0056), so three distinct risks live here:
 *   1. the WIRING (#23, MF6) — exit code and failure print — which #146 must not
 *      disturb, and
 *   2. the RENDERING — that a piped run stays control-free and greppable, that a
 *      TTY's cursor control is confined to the one in-flight line, that a stalled
 *      call becomes visible, and that `--quiet` prints exactly one terminal line;
 *   3. since #192, the LANE — that bare `sk refresh` resolves the default lane
 *      rather than sweeping everyone, that an unknown or missing lane refuses
 *      before anything is claimed, and that the lane appears on the output.
 * Every case drives `runRefreshCli` through injected deps and asserts the
 * OBSERVABLE effects; nothing captures global stdout or stderr.
 *
 * THE `--quiet` CONTRACT, restated for #192 — this is a sharpening, NOT a
 * loosening. The property those cases were written to defend (#146) is that the
 * liveness stream must not disturb the machine-readable summary. #192 changes
 * what the COMMAND DOES — bare `sk refresh` narrows from every active player to
 * the default lane — and a semantic narrowing with no output change is a
 * fail-quiet, so the terminal line legitimately gains `list=`. What survives, and
 * what these cases still assert with EXACT strings, is: **`--quiet` prints
 * exactly one terminal line and nothing else, and that line is byte-identical to
 * the verbose run's terminal line.**
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

  /**
   * A watched player, ENROLLED IN THE DEFAULT LANE. Since #192 a bare
   * `sk refresh` resolves the default lane rather than sweeping every active
   * player, and `insertPlayer` deliberately does not enroll — so a fixture that
   * only inserted a player would sweep NOBODY and every case below would pass
   * vacuously. Enrollment is stated here, once, rather than hidden in the
   * factory where it would ripple through every other suite.
   */
  const watchedPlayer = async (
    overrides: Parameters<typeof insertPlayer>[1] = {},
  ): Promise<Awaited<ReturnType<typeof insertPlayer>>> => {
    const player = await insertPlayer(opened.db, overrides);
    await enrollInDefaultLane(opened.db, [player]);
    return player;
  };

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
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=ok");
    expect(output.at(-1)).toContain("players=1");
    expect(errors).toEqual([]);
  });

  it("exits 0 on a safe `partial` run", async () => {
    await watchedPlayer({ externalId: 691185 });
    await watchedPlayer({ externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=partial");
    expect(output.at(-1)).toContain("skipped=1");
    expect(errors).toEqual([]);
  });

  it("exits 0 BUT prints the failure summary on a safe `partial` (a failure alongside a success)", async () => {
    await watchedPlayer({ externalId: 691185 });
    await watchedPlayer({ externalId: 660271 });
    expect(await runRefreshCli([], deps({ client: failing(/\/people\/660271\?/, "b down") }))).toBe(0);
    expect(output.at(-1)).toContain("status=partial");
    expect(output.at(-1)).toContain("failed=1");
    // The one-line failure summary is printed even though the exit code is 0.
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("b down");
  });

  it("exits 1 and prints the failure summary on a blocked `failed` run", async () => {
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli([], deps({ client: failing(/\/people\//, "all down") }))).toBe(1);
    expect(output.at(-1)).toContain("status=failed");
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
    expect(errors[0]).toContain("all down");
  });

  it("exits 0 and reports the reason on a skipped (Offseason Sleep) run", async () => {
    await watchedPlayer({ externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli([], deps())).toBe(0);
    expect(output).toEqual(["refresh skipped list=Watchlist reason=offseason-sleep"]);
    expect(errors).toEqual([]);
  });

  // --- `--quiet`: exactly ONE terminal line, and it is the verbose one --------

  it("--quiet prints EXACTLY the verbose run's terminal line and nothing else, on every shape", async () => {
    // Case 1: clean ok. Quiet prints ONE line and nothing else.
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(output).toEqual([
      "refresh done list=Watchlist status=ok players=1 skipped=0 failed=0 inserted=1 updated=0",
    ]);
    expect(errors).toEqual([]);
    expect(raw).toEqual([]);

    // Case 2: a failure alongside a success — exit 0, stderr summary intact.
    output = []; errors = []; raw = [];
    const failer = await watchedPlayer({ externalId: 660271 });
    expect(await runRefreshCli(["-q"], deps({ client: failing(/\/people\/660271\?/, "b down") }))).toBe(0);
    expect(output).toEqual([
      "refresh done list=Watchlist status=partial players=1 skipped=0 failed=1 inserted=0 updated=1",
    ]);
    expect(errors).toEqual([
      `refresh failures: 1 player(s), 0 calendar fetch(es); players: ${failer.id} (b down)`,
    ]);
  });

  it("--quiet on a Skipped Sweep prints only the pre-#146 skip line", async () => {
    await watchedPlayer({ externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(output).toEqual(["refresh skipped list=Watchlist reason=offseason-sleep"]);
    expect(errors).toEqual([]);
    expect(raw).toEqual([]);
  });

  it("--quiet keeps exit 1 on a blocked run, with the stderr summary", async () => {
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps({ client: failing(/\/people\//, "all down") }))).toBe(1);
    expect(output).toEqual([
      "refresh done list=Watchlist status=failed players=0 skipped=0 failed=1 inserted=0 updated=0",
    ]);
    expect(errors[0]).toContain("refresh failures: 1 player(s)");
  });

  it("--quiet still emits the three legacy notice lines, which are unconditional today", async () => {
    // 2027 has no bundled NCAA season, so refreshNcaaCalendar hits the notice path.
    clock.set("2027-07-19T17:00:00Z");
    await watchedPlayer({ externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(errors).toContain(
      "refresh: no bundled NCAA season lookup for year=2027; " +
        "NCAA treated as not In Season (update src/ncaa/seasons.ts)",
    );
    // Everything else is still suppressed.
    expect(output).toEqual([
      "refresh done list=Watchlist status=partial players=0 skipped=1 failed=0 inserted=0 updated=0",
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
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli(["--loud"], deps())).toBe(1);
    expect(errors[0]).toBe("error: unknown option '--loud'");
    expect(output).toEqual([]);
  });

  // --- Piped rendering --------------------------------------------------------

  it("a piped run is append-only, control-free ASCII on EVERY line", async () => {
    await watchedPlayer({ externalId: 691185 });
    await watchedPlayer({ externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
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
    await watchedPlayer({ externalId: 691185, fullName: hostile });
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
    await watchedPlayer({ externalId: 691185 });
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
    await watchedPlayer({ externalId: 691185 });
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
    await watchedPlayer({ externalId: 691185 });
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
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);
    // A surviving interval would hold the event loop open, and src/cli/refresh.ts
    // deliberately relies on natural drain rather than process.exit() (P2).
    expect(ticker.live()).toBe(0);
  });

  it("releases the timer on a skipped sweep too", async () => {
    await watchedPlayer({ externalId: 691185, level: "mlb", milbLevel: null });
    await insertCalendars2026(opened.db);
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);
    expect(ticker.live()).toBe(0);
  });

  // --- TTY rendering ----------------------------------------------------------

  it("on a TTY, cursor control appears ONLY on the in-flight line; settled lines stay plain", async () => {
    await watchedPlayer({ externalId: 691185 });
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
  });

  it("--quiet writes nothing raw even on a TTY", async () => {
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli(["--quiet"], deps({ isTty: true }))).toBe(0);
    expect(raw).toEqual([]);
    expect(output).toEqual([
      "refresh done list=Watchlist status=ok players=1 skipped=0 failed=0 inserted=1 updated=0",
    ]);
  });

  it("the quiet line IS the verbose run's terminal line, byte for byte", async () => {
    // The surviving half of the #146 contract, asserted directly rather than
    // inferred from two independently-maintained literals: whatever `list=` and
    // the counters render as, both modes must render the SAME bytes.
    //
    // No game log, deliberately: the Refresh is idempotent but its
    // inserted/updated SPLIT is not — a second run reports `updated` where the
    // first reported `inserted` — and that difference belongs to the sweep, not
    // to the rendering this case is comparing.
    api.options.gameLogs = {};
    await watchedPlayer({ externalId: 691185 });
    expect(await runRefreshCli([], deps())).toBe(0);
    const verboseTerminal = output.at(-1);
    expect(verboseTerminal).toContain("list=Watchlist");

    output = []; errors = []; raw = [];
    expect(await runRefreshCli(["--quiet"], deps())).toBe(0);
    expect(output).toEqual([verboseTerminal]);
  });

  // --- The lane (#192) --------------------------------------------------------

  it("bare `sk refresh` resolves the DEFAULT lane and sweeps only its members", async () => {
    const enrolled = await watchedPlayer({ externalId: 691185 });
    // Active, and in no lane at all — the pre-#192 sweep would have fetched him.
    await insertPlayer(opened.db, { externalId: 660271 });

    expect(await runRefreshCli([], deps({ isTty: false }))).toBe(0);

    expect(output.at(-1)).toBe(
      "refresh done list=Watchlist status=ok players=1 skipped=0 failed=0 inserted=1 updated=0",
    );
    expect(api.callsMatching(/\/people\/660271\?/)).toEqual([]);
    expect(api.callsMatching(/\/people\/691185\?/).length).toBe(1);
    expect(enrolled.externalId).toBe(691185);
  });

  it("`--list NAME` and `-l NAME` are the same flag and sweep the same lane", async () => {
    const listed = await insertPlayer(opened.db, { externalId: 691185 });
    // The DEFAULT lane holds someone else, so a run that ignored `--list` would
    // sweep a different player and this could not pass by accident.
    await watchedPlayer({ externalId: 660271 });
    await insertLane(opened.db, "Prospects", [listed]);

    for (const argv of [["--list", "Prospects"], ["-l", "Prospects"], ["--list=Prospects"]]) {
      output = []; errors = []; api.calls.length = 0;
      expect(await runRefreshCli(normalizeDirect(["refresh"], argv), deps()), argv.join(" ")).toBe(0);
      // The tail (`inserted=`/`updated=`) legitimately differs between the first
      // spelling and the two that re-run over the same rows, so this pins what
      // the case is about: the lane, and that exactly one player was swept.
      expect(output.at(-1), argv.join(" ")).toMatch(
        /^refresh done list=Prospects status=ok players=1 skipped=0 failed=0 /,
      );
      expect(api.callsMatching(/\/people\/660271\?/), argv.join(" ")).toEqual([]);
    }
  });

  it("an UNKNOWN lane refuses with exit 1, records no run, and fetches nothing", async () => {
    await watchedPlayer({ externalId: 691185 });

    expect(await runRefreshCli(["--list", "Nope"], deps())).toBe(1);

    expect(errors).toEqual(['error: no list named "Nope"']);
    expect(output).toEqual([]);
    // A typo must not widen a sweep, and it must not even take a claim.
    expect(opened.db.select().from(refreshRuns).all()).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("a blank or value-less `--list` refuses before anything is swept, exit 1", async () => {
    await watchedPlayer({ externalId: 691185 });
    // The ROUTER answers first, and its message is reported against exactly what
    // the operator typed — which is why preflight runs before normalization.
    // The presenter's own `--list requires a non-blank list name` (word for word
    // digest's) is the second layer behind it, exercised by `parseList`'s own
    // cases in test/cli-digest.test.ts: it is what keeps the three-state parser
    // total, so a future caller that skips preflight still fails closed instead
    // of resolving the default lane and quietly widening the sweep.
    for (const [argv, message] of [
      [["--list"], "error: option '--list' requires a value"],
      [["--list", "--quiet"], "error: option '--list' requires a value"],
      [["--list", "   "], "error: invalid value '   ' for '--list'; expected a non-blank value"],
      [["--list="], "error: invalid value '' for '--list'; expected a non-blank value"],
    ] as const) {
      output = []; errors = []; api.calls.length = 0;
      expect(await runRefreshCli([...argv], deps()), argv.join(" ")).toBe(1);
      expect(errors, argv.join(" ")).toEqual([message]);
      expect(output, argv.join(" ")).toEqual([]);
      expect(api.calls, argv.join(" ")).toEqual([]);
    }
    expect(opened.db.select().from(refreshRuns).all()).toEqual([]);
  });

  it("a database with NO default lane refuses rather than sweeping everyone", async () => {
    await watchedPlayer({ externalId: 691185 });
    // Clear the seeded default: the state in which "no --list" has no answer.
    opened.db.update(playerLists).set({ isDefault: false }).run();

    expect(await runRefreshCli([], deps())).toBe(1);

    expect(errors[0]).toContain("error:");
    expect(errors[0]).toContain("set-default");
    expect(output).toEqual([]);
    expect(opened.db.select().from(refreshRuns).all()).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("exit semantics (#23, MF6) are unchanged with a lane in play", async () => {
    const listed = await insertPlayer(opened.db, { externalId: 691185 });
    const lane = await insertLane(opened.db, "Prospects", [listed]);

    // `ok` -> 0.
    expect(await runRefreshCli(["--list", "Prospects"], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=ok");

    // `partial` (a passed-over member alongside the refreshed one) -> 0.
    output = []; errors = [];
    const passedOver = await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 700005, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Guy", schoolName: "State" });
    await insertListMember(opened.db, { listId: lane.id, playerId: passedOver.id });
    expect(await runRefreshCli(["--list", "Prospects"], deps())).toBe(0);
    expect(output.at(-1)).toContain("status=partial");

    // A Skipped Sweep -> 0. The runs above already cached the 2026 calendars from
    // the fake API, so moving the clock past the World Series end is enough —
    // seeding them again would collide on `season_calendar`'s own unique key.
    output = []; errors = [];
    clock.set("2026-12-05T18:00:00Z");
    expect(await runRefreshCli(["--list", "Prospects"], deps())).toBe(0);
    expect(output).toEqual(["refresh skipped list=Prospects reason=offseason-sleep"]);

    // `failed` (blocked: refreshed nobody) -> 1.
    output = []; errors = [];
    clock.set(MID_SEASON);
    expect(
      await runRefreshCli(["--list", "Prospects"], deps({ client: failing(/\/people\//, "all down") })),
    ).toBe(1);
    expect(output.at(-1)).toContain("status=failed");
  });

  it("a manual lane refresh behind a LIVE lease skips `already-running` and exits 0", async () => {
    const listed = await insertPlayer(opened.db, { externalId: 691185 });
    await insertLane(opened.db, "Prospects", [listed]);
    expect(claimRefreshRun(opened.db, { now: clock.now(), playersTotal: 1 }).claimed).toBe(true);

    expect(await runRefreshCli(["--list", "Prospects"], deps())).toBe(0);

    // `already-running`, NOT `whole-refresh-running`: this is the same whole-sweep
    // claim a lane run takes, so it refuses in the same vocabulary. The other
    // string belongs to the targeted single-player fence.
    expect(output).toEqual(["refresh skipped list=Prospects reason=already-running"]);
    expect(api.calls).toEqual([]);
  });

  it("resolveRefreshScope refuses a MALFORMED --list rather than falling back to the default lane", async () => {
    // The router refuses this spelling before a presenter ever runs (the case
    // above pins that), so this drives the presenter's own three-state handling
    // directly. It is what keeps a future caller that skips preflight — or a
    // loosened validator — from turning "present but blank" into "the default
    // lane" and quietly sweeping a cohort nobody asked for.
    await expect(resolveRefreshScope(opened.db, ["--list"])).resolves.toEqual({
      error: "--list requires a non-blank list name",
    });
    // ...and the happy path through the same seam still yields the default lane.
    const resolved = await resolveRefreshScope(opened.db, []);
    expect(resolved).toMatchObject({ scope: { includesDefaultLane: true } });
    expect("scope" in resolved && resolved.scope.lists.map((l) => l.name)).toEqual(["Watchlist"]);
  });

  it("re-throws a lane lookup I/O fault instead of reporting it as an unknown lane", async () => {
    await watchedPlayer({ externalId: 691185 });
    const boom = new Error("disk I/O error");
    // Only UnknownListError and NoDefaultListError are the operator's problem;
    // anything else is a broken database and must surface as a throw, not be
    // flattened into a greppable `error: no list named …` that sends the HC
    // looking for a typo. (The same shape src/cli/digest.ts uses.)
    const readsThrow = new Proxy(opened.db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop === "select") return () => { throw boom; };
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof opened.db;

    await expect(runRefreshCli([], deps({ db: readsThrow }))).rejects.toThrow("disk I/O error");
    expect(errors).toEqual([]);
    expect(output).toEqual([]);
  });

  it("a hostile LANE NAME cannot forge a token on the terminal line", async () => {
    // Mirrors the hostile-reason guard above, one field over. `list=` LEADS the
    // line, so an unfolded name would put forged counters AHEAD of the run's real
    // ones and the first `status=`/`players=` a script hit would be the
    // attacker's. Control bytes are refused earlier (the router's `controlFree`
    // validator and `requireName` both reject them), so the vector that actually
    // reaches this presenter is a bare SPACE — which still terminates a
    // `key=value` token. The accent is written as \uXXXX ESCAPES on purpose: a
    // typed accented character collapses NFD/NFC to one form and defeats the fold.
    const hostile = "Prospects status=ok players=999 Roch\u006e\u0303";
    const listed = await insertPlayer(opened.db, { externalId: 691185 });
    await insertLane(opened.db, hostile, [listed]);

    expect(await runRefreshCli(["--list", hostile], deps({ isTty: false }))).toBe(0);

    const terminal = output.at(-1)!;
    // Sized so the defect this guards would push it over the line: unfolded there
    // would be TWO ` status=` and TWO ` players=` tokens, and the FIRST of each —
    // the one a naive parser reads — would be the forged one.
    expect((terminal.match(/ status=/g) ?? []).length).toBe(1);
    expect((terminal.match(/ players=/g) ?? []).length).toBe(1);
    expect(terminal).toContain("list=Prospects_status=ok_players=999_Rochn ");
    // The run's OWN counters are the real ones, and they come last.
    expect(terminal).toMatch(/ status=ok players=1 skipped=0 failed=0 inserted=1 updated=0$/);
    for (const line of output) expect(line, line).toMatch(/^[\x20-\x7e]*$/);
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
    expect(lines.at(-1)).toMatch(/^refresh done list=Watchlist status=ok players=0/);
    for (const line of lines) expect(line, line).toMatch(/^[\x20-\x7e]*$/);

    const quiet = runCli("refresh.ts", ["--quiet"]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout.split("\n").filter((l) => l.length > 0)).toEqual([
      expect.stringMatching(/^refresh done list=Watchlist status=ok players=0/) as unknown as string,
    ]);
  }, 60_000);
});
