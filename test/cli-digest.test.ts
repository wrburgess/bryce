import { describe, expect, it } from "vitest";
import { parseForce } from "../src/cli/digest.js";

/**
 * `npm run digest -- --force`. The flag parse is extracted as a pure function
 * precisely so it is testable without a database, a mailer, or process.argv:
 * the rest of that entrypoint is wiring, and wiring is not what breaks here.
 */
describe("digest CLI --force", () => {
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
