import { describe, it, expect } from "vitest";
import { extract } from "../../scripts/protected-branches.js";

// Pure-parser tests for the protected-branch derivation (scripts/protected-branches.ts). The bash
// self-tests cover the CLI shell; these lock the parsing contract with PROJECT.md.

describe("extract", () => {
  it("takes only backticked tokens up to the ` — ` em-dash, ignoring prose after it", () => {
    const text = [
      "## Branch & PR Policy",
      "- **Protected branches:** `main`, `master` — the authored source, blah `ignored`.",
    ].join("\n");
    expect(extract(text)).toEqual(["main", "master"]);
  });

  it("collects multiple backticked tokens and preserves order while de-duplicating", () => {
    const text = [
      "## Branch & PR Policy",
      "- **Protected branches:** `main` `develop` `main` `master`",
    ].join("\n");
    expect(extract(text)).toEqual(["main", "develop", "master"]);
  });

  it("rejects a whitespace-only backtick span", () => {
    const text = [
      "## Branch & PR Policy",
      "- **Protected branches:** `main`, ` `, `master`",
    ].join("\n");
    expect(extract(text)).toEqual(["main", "master"]);
  });

  it("ends the section at the next H2, so a later line does not leak in", () => {
    const text = [
      "## Branch & PR Policy",
      "## Next Section",
      "- **Protected branches:** `main`",
    ].join("\n");
    expect(extract(text)).toEqual([]);
  });

  it("returns [] when the section is absent", () => {
    const text = ["## Other", "- **Protected branches:** `main`"].join("\n");
    expect(extract(text)).toEqual([]);
  });

  it("returns [] when the line is absent within the section", () => {
    const text = ["## Branch & PR Policy", "some prose", "- **Branch naming:** foo"].join("\n");
    expect(extract(text)).toEqual([]);
  });

  it("tolerates a leading indent before the bullet prefix", () => {
    const text = ["## Branch & PR Policy", "  - **Protected branches:** `main`, `master`"].join("\n");
    expect(extract(text)).toEqual(["main", "master"]);
  });

  it("handles CRLF line endings", () => {
    const text = "## Branch & PR Policy\r\n- **Protected branches:** `main`, `master`\r\n";
    expect(extract(text)).toEqual(["main", "master"]);
  });

  it("handles a file with no final newline", () => {
    const text = "## Branch & PR Policy\n- **Protected branches:** `main`, `master`";
    expect(extract(text)).toEqual(["main", "master"]);
  });

  it("returns [] for empty / null input", () => {
    expect(extract("")).toEqual([]);
    expect(extract(null)).toEqual([]);
    expect(extract(undefined)).toEqual([]);
  });
});
