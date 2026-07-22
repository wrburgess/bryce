import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { DigestCliDeps } from "../src/cli/digest.js";
import { parseForce, parseWindow, runDigestCli } from "../src/cli/digest.js";
import {
  CapturingMailer,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
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
      expect(mailer.sent[0]?.subject).toBe("MLB Daily Tracker: Last 7 Days (Jul 12-18)");

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
        "error: unsupported --window value; supported: 1d, 7d, 14d, 21d, ytd",
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
  });
});
