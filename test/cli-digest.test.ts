import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { DigestCliDeps } from "../src/cli/digest.js";
import { parseForce, parseList, parseTags, parseWindow, runDigestCli } from "../src/cli/digest.js";
import { addToList, createList } from "../src/lists/service.js";
import { preflightDirect } from "../src/cli/router.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
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
  describe("parseForce", () => {
    it("is true only when the flag is present", () => {
      expect(parseForce(["--force"])).toBe(true);
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
      expect(parseWindow(["--force"])).toBe("1d");
    });

    it("accepts --window <spec> and --window=<spec>", () => {
      expect(parseWindow(["--window", "7d"])).toBe("7d");
      expect(parseWindow(["--window=ytd"])).toBe("ytd");
      expect(parseWindow(["--force", "--window", "21d"])).toBe("21d");
    });

    it("accepts the new long windows", () => {
      expect(parseWindow(["--window", "28d"])).toBe("28d");
      expect(parseWindow(["--window=35d"])).toBe("35d");
      expect(parseWindow(["--window", "60d"])).toBe("60d");
    });

    it("returns null for an unsupported window so the CLI fails closed", () => {
      // Null is distinct from the 1d default: "you asked for something I do not
      // support" must not silently become "here is the daily report".
      expect(parseWindow(["--window", "30d"])).toBeNull();
      expect(parseWindow(["--window"])).toBeNull();
      expect(parseWindow(["--window="])).toBeNull();
      expect(parseWindow(["--window", "--force"])).toBeNull();
    });

    it("normalizes case and surrounding whitespace", () => {
      expect(parseWindow(["--window", "7D"])).toBe("7d");
      expect(parseWindow(["--window", " ytd "])).toBe("ytd");
    });
  });

  describe("parseTags (#140)", () => {
    it("is undefined when the flag is absent", () => {
      expect(parseTags([])).toBeUndefined();
      expect(parseTags(["--force"])).toBeUndefined();
      expect(parseTags(["--list", "L"])).toBeUndefined();
    });

    it("accepts --tags <selector> and --tags=<selector>, trimming", () => {
      expect(parseTags(["--tags", "level:aaa"])).toBe("level:aaa");
      expect(parseTags(["--tags=level:aaa,status:rostered"])).toBe("level:aaa,status:rostered");
      expect(parseTags(["--tags", "  prospect  "])).toBe("prospect");
    });

    it("is null (fail closed) when the flag is present but its value is missing", () => {
      expect(parseTags(["--tags"])).toBeNull();
      expect(parseTags(["--tags="])).toBeNull();
      expect(parseTags(["--tags", "--force"])).toBeNull();
    });
  });

  describe("parseList (#70)", () => {
    it("is undefined when absent (unscoped)", () => {
      expect(parseList([])).toBeUndefined();
      expect(parseList(["--force"])).toBeUndefined();
    });

    it("accepts --list <name> and --list=<name>, trimmed", () => {
      expect(parseList(["--list", "Prospects"])).toBe("Prospects");
      expect(parseList(["--list=Top 30"])).toBe("Top 30");
      expect(parseList(["--list", "  Spaced  "])).toBe("Spaced");
    });

    it("is null when the flag is present but blank, so the CLI fails closed", () => {
      expect(parseList(["--list"])).toBeNull();
      expect(parseList(["--list="])).toBeNull();
      expect(parseList(["--list", "--force"])).toBeNull();
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
      const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
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

    it("exits non-zero and sends nothing on an unsupported window", async () => {
      expect(await runDigestCli(["--window", "30d"], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      // Nothing was claimed either: it failed closed before touching anything.
      expect(output).toEqual([]);
      expect(errors).toEqual([
        "error: invalid value '30d' for '--window'; expected 1d, 7d, 14d, 21d, 28d, 35d, 60d, ytd",
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
  });
});
