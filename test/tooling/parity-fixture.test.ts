import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ENTRIES, copyBundle, healDeadLinks, withBundleCopy } from "./parity-fixture.js";

// Regression cover for issue #139: the fixture copier used to reject sources by SUBSTRING
// (`source.includes(".claude/worktrees")`), which matches the copy root itself whenever the checkout
// lives under `.claude/worktrees/<name>/` — every source path was rejected, the destination came back
// empty, and the caller died on an ENOENT that named PROJECT.md rather than the real cause.
//
// The environment cannot be relied on to expose that: it depends on where the suite happens to run
// (red from an agent worktree, green from the primary checkout, green in CI). So these cases BUILD
// both root shapes and copy from each, making the coverage deterministic everywhere.

// The synthetic bundle deliberately holds only what these cases assert on, so the reduced entry list
// below — never the real BUNDLE_ENTRIES, which names directories this tree does not have — is what
// gets copied.
const FIXTURE_ENTRIES = ["PROJECT.md", "docs", ".claude"];
const PROJECT_BODY = "# PROJECT.md\n\nsynthetic Project Config\n";
const NESTED_WORKTREE = join(".claude", "worktrees", "nested");

/** Plant a minimal bundle — plus nested worktree runtime state — at `root`. */
function writeSyntheticBundle(root: string): string {
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, NESTED_WORKTREE), { recursive: true });
  writeFileSync(join(root, "PROJECT.md"), PROJECT_BODY);
  writeFileSync(join(root, "docs", "note.md"), "# note\n");
  writeFileSync(join(root, NESTED_WORKTREE, "marker.txt"), "must not enter the copy\n");
  return root;
}

/**
 * Run `fn` against a freshly planted source root and an empty destination, both removed afterwards.
 * `shape` decides whether the SOURCE ROOT'S OWN PATH contains the excluded `.claude/worktrees`
 * segment — the single variable these cases exist to vary.
 */
function withSyntheticRoots(shape: "worktree-rooted" | "ordinary", fn: (source: string, dest: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "parity-fixture-case-"));
  try {
    const source = shape === "worktree-rooted"
      ? join(scratch, ".claude", "worktrees", "harbor")
      : join(scratch, "plain-root");
    mkdirSync(source, { recursive: true });
    writeSyntheticBundle(source);
    fn(source, join(scratch, "dest"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("parity fixture copier", () => {
  it("copies the bundle when the source root's own path contains .claude/worktrees", () => {
    withSyntheticRoots("worktree-rooted", (source, dest) => {
      copyBundle(source, dest, FIXTURE_ENTRIES);

      expect(readFileSync(join(dest, "PROJECT.md"), "utf-8")).toBe(PROJECT_BODY);
      expect(existsSync(join(dest, "docs", "note.md"))).toBe(true);
    });
  });

  it("still excludes nested worktree state when copying from a worktree-rooted source", () => {
    withSyntheticRoots("worktree-rooted", (source, dest) => {
      copyBundle(source, dest, FIXTURE_ENTRIES);

      expect(existsSync(join(dest, NESTED_WORKTREE, "marker.txt"))).toBe(false);
      expect(existsSync(join(dest, NESTED_WORKTREE))).toBe(false);
    });
  });

  it("excludes nested worktree state when copying from an ordinary source root", () => {
    withSyntheticRoots("ordinary", (source, dest) => {
      copyBundle(source, dest, FIXTURE_ENTRIES);

      expect(existsSync(join(dest, "PROJECT.md"))).toBe(true);
      expect(existsSync(join(dest, NESTED_WORKTREE, "marker.txt"))).toBe(false);
    });
  });

  // Without this, a future filter regression would again surface as a confusing ENOENT in whichever
  // assertion happened to read the copy first — or, worse, as a test that asserts nothing and passes.
  it("throws instead of returning an empty bundle when the copy lands no PROJECT.md", () => {
    withSyntheticRoots("ordinary", (source, dest) => {
      expect(() => copyBundle(source, dest, ["docs"])).toThrow(/produced no PROJECT\.md/);
    });
  });

  // The companion failure mode: an entry that was requested but does not exist must not be skipped,
  // or a typo in BUNDLE_ENTRIES would yield a quietly incomplete fixture that still checks "green".
  it("throws ENOENT instead of skipping a requested entry the source root does not have", () => {
    withSyntheticRoots("ordinary", (source, dest) => {
      expect(() => copyBundle(source, dest, ["PROJECT.md", "skills"]))
        .toThrow(expect.objectContaining({ code: "ENOENT" }));
    });
  });

  // healDeadLinks writes paths derived from FILE CONTENT, so an escaping relative link would have it
  // create files outside the throwaway copy — in the real filesystem — where nothing ever cleans them
  // up. The stub must land only for a link that stays inside the copy.
  it("heals a link inside the copy but never writes outside it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "parity-fixture-heal-"));
    try {
      const root = join(scratch, "bundle");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "PROJECT.md"), "[inside](docs/added-later.md)\n[escape](../escaped.md)\n");

      healDeadLinks(root);

      expect(existsSync(join(root, "docs", "added-later.md"))).toBe(true);
      expect(existsSync(join(scratch, "escaped.md"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // The acceptance criterion itself, against the real repository: red from a worktree before the fix,
  // green from the primary checkout and in CI, green from both after it.
  it("copies the real repository bundle, whatever path the checkout lives at", () => {
    withBundleCopy((root) => {
      for (const entry of BUNDLE_ENTRIES) {
        expect(existsSync(join(root, entry))).toBe(true);
      }
    });
  });
});
