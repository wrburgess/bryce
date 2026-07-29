import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { DigestCliDeps } from "../src/cli/digest.js";
import { parseForce, parseTags, parseWindow, runDigestCli } from "../src/cli/digest.js";
// `parseList` moved to the shared CLI module when `sk refresh` became its second
// caller (#192); these cases are unchanged and still cover digest's use of it.
import { parseList } from "../src/cli/flags.js";
import { digestDeliveries, playerLists } from "../src/db/schema.js";
import { addToList, createList } from "../src/lists/service.js";
import { normalizeDirect, preflightDirect } from "../src/cli/router.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertLanePlayer,
  insertPlayer,
  onFirstReadComplete,
  insertPlayerTag,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * `npm run digest -- --window 7d --force`. Each parse is covered directly, but
 * the parse is not the risk: a flag that parsed correctly and was then dropped
 * on the way to `runDigest` would be silently dead with the suite green. So the
 * CLI is exercised end to end through its injected deps, and the assertions are
 * the OBSERVABLE effects — a second mail for one day, a different window's
 * content, and no mail at all for a window that fails closed.
 */
describe("digest CLI", () => {
  /**
   * Every parser below is fed the argv the ROUTER would hand the presenter, not
   * a hand-written one (#191). `-w`, `-l`, and the `=` forms are rewritten by
   * `normalizeOptions` before any parser runs, which is why the hand-rolled
   * alias branches could be deleted rather than left as a second, drifting
   * implementation of the same grammar. Driving the tests through the real
   * normalization is what makes that deletion safe: if normalization stopped
   * rewriting `-w`, these cases go red instead of the parsers quietly
   * defaulting.
   */
  const routed = (argv: string[]): string[] => normalizeDirect(["digest"], argv);

  describe("parseForce", () => {
    it("is true only when the flag is present, in either spelling", () => {
      expect(parseForce(["--force"])).toBe(true);
      expect(parseForce(routed(["-f"]))).toBe(true);
      // A boolean has no value to mis-attach, so this parser keeps recognizing
      // the raw alias too — deliberately, unlike the VALUE parsers below.
      expect(parseForce(["-f"])).toBe(true);
      expect(parseForce([])).toBe(false);
    });

    it("ignores unrelated flags and never matches a lookalike", () => {
      expect(parseForce(["--verbose", "--dry-run"])).toBe(false);
      expect(parseForce(["--verbose", "--force", "--dry-run"])).toBe(true);
      // Substring lookalikes are not the flag: `includes` matches whole args.
      expect(parseForce(["--force-send"])).toBe(false);
      expect(parseForce(["force"])).toBe(false);
      expect(parseForce(["--no-force"])).toBe(false);
    });
  });

  describe("parseWindow", () => {
    it("defaults to 1d when the flag is absent", () => {
      expect(parseWindow([])).toBe("1d");
      expect(parseWindow(routed(["--force"]))).toBe("1d");
    });

    it("accepts every routed spelling of --window: long, alias, and inline", () => {
      // All three forms are ONE flag. Asserted through the router's own
      // normalization, so this pins the whole path an operator actually uses
      // rather than a parser branch that has since been deleted.
      for (const argv of [["--window", "7d"], ["-w", "7d"], ["--window=7d"]]) {
        expect(parseWindow(routed(argv)), argv.join(" ")).toBe("7d");
      }
      expect(parseWindow(routed(["--window=ytd"]))).toBe("ytd");
      expect(parseWindow(routed(["--force", "--window", "21d"]))).toBe("21d");
      expect(parseWindow(routed(["-f", "-w", "21d"]))).toBe("21d");
    });

    it("accepts the new long windows", () => {
      expect(parseWindow(routed(["--window", "28d"]))).toBe("28d");
      expect(parseWindow(routed(["--window=35d"]))).toBe("35d");
      expect(parseWindow(routed(["--window", "60d"]))).toBe("60d");
    });

    it("accepts the per-player game-count windows (issue #153)", () => {
      expect(parseWindow(routed(["--window", "last10games"]))).toBe("last10games");
      expect(parseWindow(routed(["--window=last30games"]))).toBe("last30games");
      expect(parseWindow(routed(["-w", "LAST10GAMES"]))).toBe("last10games");
    });

    it("returns null for an unsupported window so the CLI fails closed", () => {
      // Null is distinct from the 1d default: "you asked for something I do not
      // support" must not silently become "here is the daily report".
      expect(parseWindow(routed(["--window", "30d"]))).toBeNull();
      expect(parseWindow(routed(["--window"]))).toBeNull();
      expect(parseWindow(routed(["-w"]))).toBeNull();
      expect(parseWindow(routed(["--window", "--force"]))).toBeNull();
    });

    it("normalizes case and surrounding whitespace", () => {
      expect(parseWindow(routed(["--window", "7D"]))).toBe("7d");
      expect(parseWindow(routed(["--window", " ytd "]))).toBe("ytd");
    });
  });

  describe("parseTags (#140)", () => {
    it("is undefined when the flag is absent", () => {
      expect(parseTags([])).toBeUndefined();
      expect(parseTags(routed(["--force"]))).toBeUndefined();
      expect(parseTags(routed(["--list", "L"]))).toBeUndefined();
      expect(parseTags(routed(["-l", "L"]))).toBeUndefined();
    });

    it("accepts --tags <selector> and --tags=<selector>, trimming", () => {
      expect(parseTags(routed(["--tags", "level:aaa"]))).toBe("level:aaa");
      expect(parseTags(routed(["--tags=level:aaa,status:rostered"]))).toBe("level:aaa,status:rostered");
      expect(parseTags(routed(["--tags", "  prospect  "]))).toBe("prospect");
    });

    it("is null (fail closed) when the flag is present but its value is missing", () => {
      expect(parseTags(routed(["--tags"]))).toBeNull();
      expect(parseTags(routed(["--tags="]))).toBeNull();
      expect(parseTags(routed(["--tags", "--force"]))).toBeNull();
    });
  });

  describe("parseList (#70)", () => {
    it("is undefined when absent (unscoped)", () => {
      expect(parseList([])).toBeUndefined();
      expect(parseList(routed(["--force"]))).toBeUndefined();
      expect(parseList(routed(["-f"]))).toBeUndefined();
    });

    it("reads --list NAME, --list=NAME, and -l NAME as the SAME flag (#191)", () => {
      // The bug this alias could have shipped: `-l` reaching `parseList`
      // unrewritten returns undefined, which means UNSCOPED — the whole Watch
      // List mailed under a line that reads like a scoped send.
      for (const argv of [["--list", "Prospects"], ["--list=Prospects"], ["-l", "Prospects"]]) {
        expect(parseList(routed(argv)), argv.join(" ")).toBe("Prospects");
      }
      expect(parseList(routed(["--list=Top 30"]))).toBe("Top 30");
      expect(parseList(routed(["-l", "  Spaced  "]))).toBe("Spaced");
    });

    it("is null when the flag is present but blank, so the CLI fails closed", () => {
      expect(parseList(routed(["--list"]))).toBeNull();
      expect(parseList(routed(["-l"]))).toBeNull();
      expect(parseList(routed(["--list", "--force"]))).toBeNull();
    });
  });

  describe("runDigestCli", () => {
    let opened: OpenedDb;
    let mailer: CapturingMailer;
    let output: string[];
    let errors: string[];

    const deps = (): DigestCliDeps => ({
      db: opened.db,
      mailer,
      now: fakeClock(MID_SEASON).now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
      write: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    });

    beforeEach(async () => {
      opened = testDb();
      mailer = new CapturingMailer();
      output = [];
      errors = [];
      await insertCalendars2026(opened.db);
      const player = await insertLanePlayer(opened.db, { fullName: "Maximo Acosta" });
      await insertStatLine(opened.db, {
        playerId: player.id,
        gameDate: "2026-07-18",
        stats: { hits: 2, atBats: 4, homeRuns: 1, rbi: 3 },
      });
    });

    afterEach(() => {
      opened.close();
    });

    it("sends today's digest and reports what it sent", async () => {
      expect(await runDigestCli([], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(output).toEqual([
        "digest kind=digest action=sent statLines=1 players=1 window=Jul 18",
      ]);
    });

    it("--window reaches runDigest: the window changes the content that is sent", async () => {
      // A line outside the 1d window but inside the 7d one. If --window were
      // parsed and then dropped, both runs would report the same count.
      const player = await insertPlayer(opened.db, { fullName: "Window Guy" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-14" });

      expect(await runDigestCli(["--window", "7d"], deps())).toBe(0);
      expect(output[0]).toContain("statLines=2");
      expect(output[0]).toContain("window=Last 7 Days (Jul 12-18)");
      expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (Default) - Prev 7 Days");

      expect(await runDigestCli(["--force"], deps())).toBe(0);
      expect(output[1]).toContain("statLines=1");
      expect(output[1]).toContain("window=Jul 18");
    });

    it("--window last10games reaches runDigest as an on-demand game-count report (issue #153)", async () => {
      // The seeded player has a 2026-07-18 game; a game-count window reports it
      // as a "Last 10 Games" report and, being on-demand, writes no delivery row.
      expect(await runDigestCli(["--window", "last10games"], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(output[0]).toContain("window=Last 10 Games");
      expect(output[0]).toContain("statLines=1");
      const deliveries = (opened.sqlite.prepare("SELECT count(*) AS c FROM digest_deliveries").get() as { c: number }).c;
      expect(deliveries).toBe(0); // on-demand: no slot claimed, no delivery row
    });

    it("exits non-zero and sends nothing on an unsupported window", async () => {
      expect(await runDigestCli(["--window", "30d"], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      // Nothing was claimed either: it failed closed before touching anything.
      expect(output).toEqual([]);
      expect(errors).toEqual([
        "error: invalid value '30d' for '--window'; expected 1d, 7d, 14d, 21d, 28d, 35d, 60d, ytd, last10games, last30games",
      ]);
    });

    it("rejects malformed and duplicate options before list lookup or mailer work", async () => {
      expect(await runDigestCli(["--force", "-f"], deps())).toBe(1);
      expect(await runDigestCli(["--list", "ghost", "--list", "other"], deps())).toBe(1);
      expect(await runDigestCli(["--force-send"], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      expect(output).toEqual([]);
      expect(errors).toEqual([
        "error: option '--force' may not be repeated",
        "error: option '--list' may not be repeated",
        "error: unknown option '--force-send'",
      ]);
    });

    it("--force reaches runDigest: a same-day re-send mails a second time", async () => {
      expect(await runDigestCli([], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(1);

      // Without the flag the day is closed — this is the control that makes the
      // forced case below meaningful rather than trivially true.
      expect(await runDigestCli([], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(output[1]).toBe(
        "digest kind=digest action=skipped statLines=0 players=0 reason=already-sent-today",
      );

      expect(await runDigestCli(["--force"], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(2);
      expect(output[2]).toBe(
        "digest kind=digest action=sent statLines=1 players=1 window=Jul 18 reason=forced",
      );
      // The replay's CONTENT is the day's digest, not an empty one.
      expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
    });

    it("exits non-zero and reports the reason when the provider rejects the send", async () => {
      mailer.failWith = new Error("postmark down");
      expect(await runDigestCli([], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      expect(output).toEqual([
        "digest kind=digest action=failed statLines=1 players=1 window=Jul 18 reason=postmark down",
      ]);
    });

    it("--list reaches runDigest: only the list's members are sent (#70)", async () => {
      // beforeEach seeded "Maximo Acosta" (NOT a member). Add a second, listed
      // player; the scoped send must cover only him.
      const listed = await insertPlayer(opened.db, { fullName: "Listed Guy" });
      await insertStatLine(opened.db, { playerId: listed.id, gameDate: "2026-07-18" });
      const clock = fakeClock(MID_SEASON);
      await createList(opened.db, "L", clock.now());
      await addToList(opened.db, "L", [listed.externalId!], clock.now());

      expect(await runDigestCli(["--list", "L"], deps())).toBe(0);
      expect(output[0]).toContain("players=1");
      expect(mailer.sent).toHaveLength(1);
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      expect(body).toContain("Listed Guy".split(" ")[1]); // surname (renderer abbreviates)
      expect(body).not.toContain("Acosta");
      expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (L) - Sat, July 18, 2026");
      expect(mailer.sent[0]?.text).toContain("ScoreKeeps Baseball - L List - Sat, July 18, 2026");
    });

    it("-l, --list=, and --list NAME scope the SEND identically (#191)", async () => {
      // The end-to-end anchor for the alias. Asserted on what was MAILED, not on
      // a parse: an alias silently dropped on the way to `runDigest` produces a
      // green parse test and a wrong-recipient email. Each spelling must cover
      // exactly the listed player and exclude the unlisted one.
      const listed = await insertPlayer(opened.db, { fullName: "Listed Guy" });
      await insertStatLine(opened.db, { playerId: listed.id, gameDate: "2026-07-18" });
      const clock = fakeClock(MID_SEASON);
      await createList(opened.db, "L", clock.now());
      await addToList(opened.db, "L", [listed.externalId!], clock.now());

      const subjects: string[] = [];
      // `--force` on EVERY spelling, and it is what makes the loop constructable
      // at all since #193: a tag-free 1d named-lane send now CLAIMS lane L's
      // daily slot, so the second spelling would otherwise be refused
      // `already-sent-today` and prove nothing about its scoping. Forced, the
      // first is an ordinary claim and the other two are write-free replays —
      // and a replay assembles exactly what an ordinary run would, which is
      // precisely the content this case is comparing.
      for (const argv of [["--list", "L"], ["--list=L"], ["-l", "L"]]) {
        mailer = new CapturingMailer();
        output = [];
        expect(await runDigestCli([...argv, "--force"], deps()), argv.join(" ")).toBe(0);
        expect(output[0], argv.join(" ")).toContain("players=1");
        const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
        expect(body, argv.join(" ")).toContain("Guy");
        expect(body, argv.join(" ")).not.toContain("Acosta"); // the UNLISTED player
        subjects.push(mailer.sent[0]?.subject ?? "");
      }
      // One scope, three spellings: byte-identical subjects prove it.
      expect(new Set(subjects).size).toBe(1);
      expect(subjects[0]).toBe("ScoreKeeps Baseball (L) - Sat, July 18, 2026");

      // And the three sends left ONE delivery row on lane L's slot, not three:
      // the replays wrote nothing, which is the claimed path's own contract now
      // that a named lane takes one.
      const rows = await opened.db.select().from(digestDeliveries);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "digest", dateCovered: "2026-07-19", attemptCount: 1 });
    });

    it("reports a lane DELETED after resolution as a clean error line, not a stack trace (#193)", async () => {
      // Reviewer must-fix 4, on the CLI seam. The claimed path re-reads the lane
      // by id inside `runDigest`, so a `lists delete` landing between this
      // command's name lookup and that read raises UnknownListError from a
      // second place. The identical error from the name lookup already prints a
      // clean `error:` line; without the matching arm around `runDigest` the
      // race would surface as an unhandled rejection instead.
      const listed = await insertPlayer(opened.db, { fullName: "Listed Guy" });
      await insertStatLine(opened.db, { playerId: listed.id, gameDate: "2026-07-18" });
      const clock = fakeClock(MID_SEASON);
      await createList(opened.db, "L", clock.now());
      await addToList(opened.db, "L", [listed.externalId!], clock.now());

      // Delete the lane the instant the CLI's own name resolution completes —
      // after it has an id in hand, before `runDigest` re-reads the row.
      const racing = onFirstReadComplete(opened.db, () => {
        opened.sqlite
          .prepare("update player_lists set deleted_at = ? where name = ?")
          .run("2026-07-19T00:00:00.000Z", "L");
      });

      expect(await runDigestCli(["--list", "L"], { ...deps(), db: racing })).toBe(1);
      expect(errors[0]).toContain('no list named "L"');
      expect(mailer.sent).toHaveLength(0);
    });

    it("--list fails closed on an unknown list: exits 1 and sends nothing (#70)", async () => {
      expect(await runDigestCli(["--list", "ghost"], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      expect(errors[0]).toContain('no list named "ghost"');
    });

    it("--tags reaches runDigest: only the cohort is sent (#140)", async () => {
      // beforeEach seeded "Maximo Acosta" (untagged). Add a tagged player; the
      // scoped send must cover only him — the parse is not the risk, the WIRING is.
      const tagged = await insertPlayer(opened.db, { fullName: "Tagged Guy" });
      await insertStatLine(opened.db, { playerId: tagged.id, gameDate: "2026-07-18" });
      await insertPlayerTag(opened.db, { playerId: tagged.id, namespace: "status", value: "rostered" });

      expect(await runDigestCli(["--tags", "status:rostered"], deps())).toBe(0);
      expect(output[0]).toContain("players=1");
      expect(mailer.sent).toHaveLength(1);
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      expect(body).toContain("Guy"); // surname (renderer abbreviates the first name)
      expect(body).not.toContain("Acosta");
      expect(mailer.sent[0]?.subject).toBe(
        "ScoreKeeps Baseball (Tags: status:rostered) - Sat, July 18, 2026",
      );
    });

    it("--tags and --list INTERSECT through the CLI (#140)", async () => {
      const clock = fakeClock(MID_SEASON);
      // Listed AND tagged -> the only content.
      const both = await insertPlayer(opened.db, { fullName: "Both Qualified" });
      await insertStatLine(opened.db, { playerId: both.id, gameDate: "2026-07-18" });
      await insertPlayerTag(opened.db, { playerId: both.id, namespace: "status", value: "rostered" });
      // Listed but untagged -> excluded by the tag half.
      const listedOnly = await insertPlayer(opened.db, { fullName: "Listedonly Untagged" });
      await insertStatLine(opened.db, { playerId: listedOnly.id, gameDate: "2026-07-18" });
      await createList(opened.db, "L", clock.now());
      await addToList(opened.db, "L", [both.externalId!, listedOnly.externalId!], clock.now());

      expect(await runDigestCli(["--list", "L", "--tags", "status:rostered"], deps())).toBe(0);
      expect(output[0]).toContain("players=1");
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      expect(body).toContain("Qualified");
      expect(body).not.toContain("Untagged");
      expect(mailer.sent[0]?.subject).toBe(
        "ScoreKeeps Baseball (L + Tags: status:rostered) - Sat, July 18, 2026",
      );
    });

    it("--tags is rejected by router PREFLIGHT, before any leaf module loads (#140)", () => {
      // The router's contract is loader-free validation: a leaf is imported only
      // after preflight succeeds. Without a validator on this option, `sk digest
      // --tags level:AAA` would load digest.main and run startupDb — snapshot,
      // migrate, and re-derive tags — before resolveTagScope rejected it, so an
      // invalid command could MUTATE STATE on its way to exit 1. Preflight shares
      // the one grammar via the dependency-free src/tags/selector.ts.
      for (const bad of ["level:AAA", "foo:bar:baz", ":foo", ",,,", "level:<script>"]) {
        expect(preflightDirect(["digest"], ["--tags", bad])).toMatch(/tag selector|control characters/);
      }
      // A well-formed selector passes preflight untouched.
      expect(preflightDirect(["digest"], ["--tags", "level:aaa,status:rostered"])).toBeNull();
      expect(preflightDirect(["digest"], ["--tags", "prospect"])).toBeNull();
    });

    it("--tags fails closed on a malformed selector: exits 1 BEFORE the mailer is touched (#140)", async () => {
      expect(await runDigestCli(["--tags", "level:AAA"], deps())).toBe(1);
      expect(await runDigestCli(["--tags", ":foo"], deps())).toBe(1);
      expect(await runDigestCli(["--tags", "level:a\r\nBcc: x@y"], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      expect(errors[0]).toContain("malformed tag token");
    });

    it("--tags requires a value: every missing/blank form exits 1 and sends nothing (#140)", async () => {
      // Router preflight rejects these before `parseTags` is reached (the same
      // layering `--list` has); `runDigestCli` keeps its own null guard as the
      // fail-closed backstop for a caller that bypasses preflight. What matters
      // to the operator is the contract asserted here: exit 1, nothing sent.
      for (const argv of [["--tags"], ["--tags="], ["--tags", "--force"], ["--tags", "  "]]) {
        errors.length = 0;
        expect(await runDigestCli(argv, deps())).toBe(1);
        expect(errors[0]).toContain("--tags");
      }
      expect(mailer.sent).toHaveLength(0);
    });

    it("a selector matching NOBODY is an empty report, not a failure (#140)", async () => {
      // The seeded player has stats but no tags: exit 0, a mail, and zero players.
      expect(await runDigestCli(["--tags", "status:scouted"], deps())).toBe(0);
      expect(output[0]).toContain("players=0");
      expect(mailer.sent).toHaveLength(1);
    });

    it("refuses the scheduled send with no default lane: error line, exit 1, nothing sent (#190)", async () => {
      await opened.db.update(playerLists).set({ isDefault: false });

      expect(await runDigestCli([], deps())).toBe(1);
      expect(errors[0]).toContain("no default list is set");
      // The refusal names the command that fixes it, so the operator is not
      // left to work out what a lane is from an exit code.
      expect(errors[0]).toContain("sk players lists set-default --name NAME");
      expect(mailer.sent).toHaveLength(0);
      expect(output).toEqual([]);
    });

    it("still runs an EXPLICITLY windowed report with no default lane (#190)", async () => {
      // An on-demand report takes no daily slot, so it needs no lane — the
      // boundary #193 moves.
      await opened.db.update(playerLists).set({ isDefault: false });
      expect(await runDigestCli(["--window", "7d"], deps())).toBe(0);
      expect(mailer.sent).toHaveLength(1);
    });
  });
});
