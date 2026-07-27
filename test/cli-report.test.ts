import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { ReportCliDeps } from "../src/cli/report.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCommand, main, parseReportPlayerArgs, runReportCli } from "../src/cli/report.js";
import { renderPlayerCardHtml, renderPlayerCardText } from "../src/reports/player-card-render.js";
import { assemblePlayerCard } from "../src/reports/player-card.js";
import { MID_SEASON, TEST_TZ, fakeClock, insertCalendars2026, insertPlayer, insertStatLine, testDb } from "./factories.js";

/**
 * `sk report player` (#141 / ADR 0055). The OUTPUT path is exercised through
 * injected deps — a fake `write`, `writeFile`, and `launch` — so the command is
 * asserted end to end without touching the disk or spawning a process, and the
 * documented `--out` / `--open` contract is pinned rather than described.
 */
describe("report player CLI", () => {
  let opened: OpenedDb;
  let out: string[];
  let err: string[];
  let playerId: number;
  const clock = fakeClock(MID_SEASON);

  const deps = (overrides: Partial<ReportCliDeps> = {}): ReportCliDeps => ({
    db: opened.db,
    now: clock.now,
    tz: TEST_TZ,
    write: (line, error = false) => (error ? err : out).push(line),
    ...overrides,
  });

  beforeEach(async () => {
    opened = testDb();
    out = [];
    err = [];
    await insertCalendars2026(opened.db);
    const player = await insertPlayer(opened.db, { fullName: "Report Cliguy", position: "SS" });
    playerId = player.id;
    await insertStatLine(opened.db, { playerId, gameDate: "2026-07-18", stats: { hits: 2, atBats: 4 } });
  });

  afterEach(() => {
    opened.close();
  });

  const card = () => assemblePlayerCard(opened.db, { id: playerId, windows: ["last10"], now: clock.now, tz: TEST_TZ });

  it("parses canonical selectors and game-window grammar", () => {
    expect(parseReportPlayerArgs(["--id", "12", "--windows", " LAST10 , ytd "])).toEqual({ id: 12, windows: ["last10", "ytd"], format: "console", open: false });
    expect(parseReportPlayerArgs(["--name=Jos\u00E9 Test"])).toEqual({ name: "Jos\u00E9 Test", windows: ["last10", "last30", "ytd"], format: "console", open: false });
  });

  // Pure-parser cases. The "before opening the database" CLAIM is asserted by
  // side effect in its own test below — this one only pins the parse rules.
  it("rejects ambiguous, malformed, and duplicate arguments", () => {
    expect(parseReportPlayerArgs([])).toContain("exactly one");
    expect(parseReportPlayerArgs(["--id", "01"])).toContain("canonical");
    expect(parseReportPlayerArgs(["--id", "1", "--name", "Name"])).toContain("exactly one");
    expect(parseReportPlayerArgs(["--id", "1", "--windows", "last10,last10"])).toContain("unique");
  });

  it("defaults to the console rendering — the SAME bytes the pure renderer produces", async () => {
    const code = await runReportCli(["--id", String(playerId), "--windows", "last10"], deps());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    // Equality, not a substring: the CLI cannot drift into its own layout. The
    // renderer's own trailing newline is dropped because the writer adds one.
    expect(out).toEqual([renderPlayerCardText(card()).replace(/\n$/, "")]);
    // Asserting it is not JSON is what would catch a default that never flipped.
    expect(() => JSON.parse(out[0]!)).toThrow();
  });

  it("renders json and html on request", async () => {
    expect(await runReportCli(["--id", String(playerId), "--windows", "last10", "--format", "json"], deps())).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual(JSON.parse(JSON.stringify(card())));

    out = [];
    expect(await runReportCli(["--id", String(playerId), "--windows", "last10", "--format", "html"], deps())).toBe(0);
    expect(out).toEqual([renderPlayerCardHtml(card()).replace(/\n$/, "")]);
  });

  /**
   * stdout and `--out` must deliver the SAME bytes. Both Presentations end with
   * a newline and the production writer appends its own, so without the strip
   * the piped card carried a trailing blank line the saved file did not.
   */
  it.each(["console", "html", "json"])("emits identical bytes on stdout and to --out (%s)", async (format) => {
    const written: string[] = [];
    await runReportCli(["--id", String(playerId), "--windows", "last10", "--format", format], deps());
    await runReportCli(
      ["--id", String(playerId), "--windows", "last10", "--format", format, "--out", "/tmp/card.out"],
      deps({ writeFile: (_p, contents) => void written.push(contents) }),
    );
    // EXACT bytes, no normalization on either side. Stripping trailing newlines
    // before comparing is precisely how the first version of this test passed
    // while `--format json` still differed by one byte: a normalizing assertion
    // cannot see the difference it exists to catch. `${out[0]}\n` reconstructs
    // what the production writer emits.
    expect(`${out[0]!}\n`).toBe(written[0]!);
    expect(out[0]!.endsWith("\n"), `${format} would double-space stdout`).toBe(false);
    expect(written[0]!.endsWith("\n"), `${format} file should end in exactly one newline`).toBe(true);
    expect(written[0]!.endsWith("\n\n"), `${format} file has a trailing blank line`).toBe(false);
  });

  it("rejects an unsupported or empty --format loudly, and never silently defaults", async () => {
    for (const bad of [["--format", "pdf"], ["--format="], ["--format", "JSON"]]) {
      out = [];
      err = [];
      const code = await runReportCli(["--id", String(playerId), ...bad], deps());
      expect(code, bad.join(" ")).toBe(1);
      expect(out, bad.join(" ")).toEqual([]);
      expect(err.join("\n"), bad.join(" ")).toContain("error:");
    }
  });

  it("--out writes the payload to the path and prints nothing on stdout", async () => {
    const writeFile = vi.fn();
    const code = await runReportCli(["--id", String(playerId), "--windows", "last10", "--format", "html", "--out", "/tmp/card.html"], deps({ writeFile }));
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(writeFile).toHaveBeenCalledWith("/tmp/card.html", renderPlayerCardHtml(card()));
  });

  it("--out is valid with EVERY format, including console and json", async () => {
    for (const format of ["console", "json", "html"] as const) {
      const writeFile = vi.fn();
      out = [];
      err = [];
      expect(await runReportCli(["--id", String(playerId), "--windows", "last10", "--format", format, "--out", "/tmp/card.out"], deps({ writeFile })), format).toBe(0);
      expect(writeFile, format).toHaveBeenCalledTimes(1);
      expect(out, format).toEqual([]);
    }
  });

  it("--out accepts a path containing spaces and non-ASCII characters, unfolded", async () => {
    // \uXXXX escapes so the SOURCE cannot collapse NFD/NFC and defeat the check.
    const path = "/tmp/my cards/Ronald Acu\u00F1a.html";
    const writeFile = vi.fn();
    expect(await runReportCli(["--id", String(playerId), "--format", "html", "--out", path], deps({ writeFile }))).toBe(0);
    expect(writeFile.mock.calls[0]?.[0]).toBe(path);
  });

  it("--open implies html, writes to a temp path, then launches it", async () => {
    const writeFile = vi.fn();
    const launch = vi.fn();
    const tempPath = vi.fn((filename: string) => `/tmp/${filename}`);
    const code = await runReportCli(["--id", String(playerId), "--windows", "last10", "--open"], deps({ writeFile, launch, tempPath }));
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(tempPath).toHaveBeenCalledWith(`bryce-player-card-${playerId}.html`);
    expect(writeFile).toHaveBeenCalledWith(`/tmp/bryce-player-card-${playerId}.html`, renderPlayerCardHtml(card()));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(`/tmp/bryce-player-card-${playerId}.html`);
  });

  it("--open with --out launches the requested path, not a temp one", async () => {
    const writeFile = vi.fn();
    const launch = vi.fn();
    const tempPath = vi.fn((filename: string) => `/tmp/${filename}`);
    expect(await runReportCli(["--id", String(playerId), "--open", "--format", "html", "--out", "/tmp/chosen.html"], deps({ writeFile, launch, tempPath }))).toBe(0);
    expect(tempPath).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith("/tmp/chosen.html", expect.any(String));
    expect(launch).toHaveBeenCalledWith("/tmp/chosen.html");
  });

  it("refuses --open with a non-browser format rather than silently upgrading it", async () => {
    for (const format of ["console", "json"] as const) {
      out = [];
      err = [];
      const launch = vi.fn();
      const writeFile = vi.fn();
      expect(await runReportCli(["--id", String(playerId), "--open", "--format", format], deps({ launch, writeFile })), format).toBe(1);
      expect(err.join("\n"), format).toContain("--open requires --format html");
      expect(launch, format).not.toHaveBeenCalled();
      expect(writeFile, format).not.toHaveBeenCalled();
    }
  });

  it("a failed write exits non-zero and NEVER invokes the launcher", async () => {
    const launch = vi.fn();
    const writeFile = vi.fn(() => { throw new Error("EACCES: permission denied"); });
    const code = await runReportCli(["--id", String(playerId), "--open", "--out", "/nope/card.html"], deps({ writeFile, launch }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("could not write /nope/card.html");
    expect(err.join("\n")).toContain("EACCES");
    // The whole point of ordering the write first: a browser must never be
    // pointed at a path nothing was written to.
    expect(launch).not.toHaveBeenCalled();
  });

  it("a failed launch exits non-zero and names the path, so the written file is still usable", async () => {
    const writeFile = vi.fn();
    const launch = vi.fn(() => { throw new Error("xdg-open not found"); });
    const code = await runReportCli(["--id", String(playerId), "--open", "--out", "/tmp/card.html"], deps({ writeFile, launch }));
    expect(code).toBe(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(err.join("\n")).toContain("could not open /tmp/card.html");
  });

  /**
   * The case above passes even against a launcher that can NEVER report failure
   * synchronously, so on its own it is a false green: the production opener
   * learns of a missing `open`/`xdg-open` from an async `error` event, after it
   * has already returned. `runReportCli` therefore has to AWAIT the launcher, or
   * `--open` exits 0 on every machine without one while promising otherwise.
   */
  it("a launcher that REJECTS asynchronously still exits non-zero", async () => {
    const writeFile = vi.fn();
    const launch = vi.fn(() => Promise.reject(new Error("spawn xdg-open ENOENT")));
    const code = await runReportCli(["--id", String(playerId), "--open", "--out", "/tmp/card.html"], deps({ writeFile, launch }));
    expect(code).toBe(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(err.join("\n")).toContain("could not open /tmp/card.html");
    expect(err.join("\n")).toContain("ENOENT");
  });

  it("waits for an async launcher to settle before reporting success", async () => {
    const order: string[] = [];
    const launch = vi.fn(async () => { await Promise.resolve(); order.push("launched"); });
    const code = await runReportCli(["--id", String(playerId), "--open", "--out", "/tmp/card.html"], deps({ writeFile: vi.fn(), launch }));
    order.push("returned");
    expect(code).toBe(0);
    expect(order).toEqual(["launched", "returned"]);
  });

  /**
   * Per-platform argv is asserted as DATA, so Windows and Linux are covered on
   * the macOS/ubuntu runners that never execute those branches.
   */
  it("builds a correct opener invocation for every platform", () => {
    expect(launchCommand("darwin", "/tmp/a card.html")).toEqual({ command: "open", args: ["/tmp/a card.html"] });
    expect(launchCommand("linux", "/tmp/a card.html")).toEqual({ command: "xdg-open", args: ["/tmp/a card.html"] });
    // `start` is a cmd builtin whose first quoted argument is the WINDOW TITLE:
    // without the empty title the path becomes the title and nothing opens, and
    // a shell-splatted unquoted path breaks on the space this fixture carries.
    expect(launchCommand("win32", "C:\\Users\\me\\a card.html")).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", "C:\\Users\\me\\a card.html"],
    });
  });

  /**
   * `main()` must reject a malformed invocation BEFORE `startupDb`, which
   * acquires the open-lock and can snapshot + migrate on its way in. Router
   * preflight alone does not cover this class: `--windows` is declared with no
   * `values` list and no validator (router.ts), so `--windows bogus` passes
   * preflight and is caught only by `parseReportPlayerArgs`.
   *
   * Asserted by SIDE EFFECT — no database file may appear — because that is the
   * thing the ordering exists to prevent, not a proxy for it.
   */
  it("rejects a preflight-passing but malformed invocation without ever opening the database", async () => {
    const work = mkdtempSync(join(tmpdir(), "bryce-report-order-"));
    const dbPath = join(work, "should-never-exist.sqlite");
    // MAILER_PROVIDER is pinned so a VALID config is loadable: this test is
    // about ordering, and must not pass merely because loadConfig threw. (That
    // it throws at all on a usage error is the same defect's other symptom —
    // the operator gets a mailer-config error instead of "invalid --windows".)
    const keys = ["DATABASE_PATH", "BACKUP_DIR", "MAILER_PROVIDER"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.DATABASE_PATH = dbPath;
    process.env.BACKUP_DIR = join(work, "backups");
    process.env.MAILER_PROVIDER = "console";
    try {
      await expect(main(["--id", "1", "--windows", "bogus"])).resolves.toBe(1);
      expect(existsSync(dbPath), "startupDb ran before the usage error was reported").toBe(false);
    } finally {
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reports an unknown player through the injected writer with a non-zero exit", async () => {
    const code = await runReportCli(["--id", "999999"], deps());
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no player with id=999999");
  });

  it("passes the terminal width through to the console rendering", async () => {
    await runReportCli(["--id", String(playerId), "--windows", "last10"], deps({ terminalWidth: 15 }));
    expect(out[0]).toBe(renderPlayerCardText(card(), { width: 15 }).replace(/\n$/, ""));
    expect(out[0]).not.toBe(renderPlayerCardText(card()).replace(/\n$/, ""));
  });
});
