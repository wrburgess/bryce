import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpinned, scan } from "../../scripts/check-action-pins.js";

// Pure-logic tests for the action-pin guard (scripts/check-action-pins.ts). The bash self-test
// covers the CLI/output shell; these lock the SHA classification and the workflow-line scanning.

describe("unpinned", () => {
  const SHA = "11d5960a326750d5838078e36cf38b85af677262"; // 40 lowercase hex

  it("treats an exact 40-char lowercase SHA as pinned", () => {
    expect(unpinned(`actions/checkout@${SHA}`)).toBe(false);
  });

  it("rejects an UPPERCASE 40-char hex ref as unpinned", () => {
    expect(unpinned(`actions/checkout@${SHA.toUpperCase()}`)).toBe(true);
  });

  it("rejects a short (7-char) hex ref", () => {
    expect(unpinned("actions/checkout@11d5960")).toBe(true);
  });

  it("rejects a value with no ref at all", () => {
    expect(unpinned("actions/checkout")).toBe(true);
  });

  it("rejects a mutable tag and a branch ref", () => {
    expect(unpinned("actions/checkout@v4")).toBe(true);
    expect(unpinned("actions/checkout@main")).toBe(true);
  });

  it("rejects an empty owner", () => {
    expect(unpinned("@v4")).toBe(true);
  });

  it("exempts local ./ and ../ actions", () => {
    expect(unpinned("./.github/actions/local")).toBe(false);
    expect(unpinned("../actions/x@v1")).toBe(false);
  });

  it("exempts docker:// refs", () => {
    expect(unpinned("docker://alpine:3.19")).toBe(false);
  });
});

describe("scan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "pins-"));
    dirs.push(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    for (const [name, uses] of Object.entries(files)) {
      const body = [
        "name: fixture",
        "on: [push]",
        "jobs:",
        "  job:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: ${uses}`,
        "",
      ].join("\n");
      writeFileSync(join(root, ".github", "workflows", name), body);
    }
    return root;
  }

  it("scans .yaml as well as .yml files", () => {
    const root = fixture({ "app.yaml": "actions/checkout@v4" });
    expect(scan(root)).toEqual([".github/workflows/app.yaml:7 -> uses: actions/checkout@v4"]);
  });

  it("strips surrounding quotes around the uses value", () => {
    const root = fixture({ "app.yml": '"actions/checkout@v4"' });
    expect(scan(root)).toEqual([".github/workflows/app.yml:7 -> uses: actions/checkout@v4"]);
  });

  it("ignores a trailing # comment after the ref", () => {
    const SHA = "11d5960a326750d5838078e36cf38b85af677262";
    const root = fixture({ "app.yml": `actions/checkout@${SHA}   # v4.4.0` });
    expect(scan(root)).toEqual([]);
  });

  it("reports each offender across multiple files, sorted by path", () => {
    const SHA = "11d5960a326750d5838078e36cf38b85af677262";
    const root = fixture({
      "a.yml": `actions/checkout@${SHA} # v4.4.0`,
      "b.yml": "actions/setup-node@v4",
      "c.yml": "x/y@main",
    });
    expect(scan(root)).toEqual([
      ".github/workflows/b.yml:7 -> uses: actions/setup-node@v4",
      ".github/workflows/c.yml:7 -> uses: x/y@main",
    ]);
  });

  it("returns [] when there is no workflows directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pins-empty-"));
    dirs.push(root);
    expect(scan(root)).toEqual([]);
  });
});
