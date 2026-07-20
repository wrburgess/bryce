import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { DigestCliDeps } from "../src/cli/digest.js";
import { parseForce, runDigestCli } from "../src/cli/digest.js";
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
 * `npm run digest -- --force`. The parse is covered directly, but the parse is
 * not the risk: a `--force` that parsed correctly and was then dropped on the
 * way to `runDigest` would leave the flag silently dead with the suite green.
 * So the CLI is exercised end to end through its injected deps, and the
 * assertion is the OBSERVABLE effect of force — a second mail for one day.
 */
describe("digest CLI --force", () => {
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

  describe("runDigestCli", () => {
    let opened: OpenedDb;
    let mailer: CapturingMailer;
    let output: string[];

    const deps = (): DigestCliDeps => ({
      db: opened.db,
      mailer,
      now: fakeClock(MID_SEASON).now,
      tz: TEST_TZ,
      to: "hc@example.com",
      from: "bryce@example.com",
      write: (line) => output.push(line),
    });

    beforeEach(async () => {
      opened = testDb();
      mailer = new CapturingMailer();
      output = [];
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
      expect(output).toEqual(["digest kind=digest action=sent statLines=1 players=1"]);
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
      expect(output[2]).toBe("digest kind=digest action=sent statLines=1 players=1 reason=forced");
      // The replay's CONTENT is the day's digest, not an empty one.
      expect(mailer.sent[1]?.text).toBe(mailer.sent[0]?.text);
    });

    it("exits non-zero and reports the reason when the provider rejects the send", async () => {
      mailer.failWith = new Error("postmark down");
      expect(await runDigestCli([], deps())).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      expect(output).toEqual([
        "digest kind=digest action=failed statLines=1 players=1 reason=postmark down",
      ]);
    });
  });
});
