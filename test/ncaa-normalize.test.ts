import { describe, it, expect } from "vitest";
import { canonicalizeStats } from "../src/ncaa/normalize.js";

/**
 * The NCAA pitching game log carries a per-game GS (games started) column
 * (test/fixtures/ncaa/gamelog_pitching.html). Mapping it to the canonical
 * `gamesStarted` key is what lets the digest classify relief decisions (RW/RL):
 * a decision counts as relief only when gamesStarted is PRESENT and 0, so an
 * unmapped GS would fail closed and silently drop an NCAA reliever's win.
 */
describe("canonicalizeStats — pitching GS → gamesStarted mapping", () => {
  it("preserves GS 0 for a relief appearance, so the relief decision is countable", () => {
    const relief = canonicalizeStats("pitching", { GS: "0", IP: "1.0", W: "1" });
    expect(relief.gamesStarted).toBe(0);
    expect(relief.wins).toBe(1);
  });

  it("maps GS 1 for a starter", () => {
    const starter = canonicalizeStats("pitching", { GS: "1", IP: "6.0", W: "1" });
    expect(starter.gamesStarted).toBe(1);
    expect(starter.wins).toBe(1);
  });

  it("omits gamesStarted entirely when the page exposes no GS (fail-closed input)", () => {
    const noGs = canonicalizeStats("pitching", { IP: "1.0", W: "1" });
    expect("gamesStarted" in noGs).toBe(false);
  });
});
