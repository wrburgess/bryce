import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared fixture copier for the parity self-tests (issue #139). Both tooling tests hand
// `runParityCheck` a real tree in an OS tmpdir; this module owns HOW that tree is built so there is
// one copy strategy instead of two divergent ones.
//
// The exclusion that matters — agent worktree runtime state is not part of the shipped bundle — is
// expressed as ABSOLUTE EQUALITY against `<sourceRoot>/.claude/worktrees`, never as a substring test
// on the source path. A substring test matches the copy root itself whenever the checkout lives under
// `.claude/worktrees/<name>/`, which rejects every source path, produces an empty destination, and
// leaves the caller to die on a confusing ENOENT (issue #139).

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The Project Config is the fixture's proof of life: no PROJECT.md, no usable bundle. */
const PROJECT_FILE = "PROJECT.md";

// The parity-relevant tree. Determined empirically: this is the top-level set for which
// `npx tsx scripts/parity-check.ts --root <copy>` reports nothing missing.
export const BUNDLE_ENTRIES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "PROJECT.md",
  "README.md",
  "CONTEXT.md",
  ".github",
  ".claude",
  ".githooks",
  "bin",
  "docs",
  "rules",
  "scripts",
  "skills",
];

// Mirrors LINK_CHECKED in scripts/parity-check.ts — the files whose relative links parity resolves.
const LINK_CHECKED = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "PROJECT.md",
  ".github/copilot-instructions.md",
  "README.md",
  "docs/standards/development-lifecycle.md",
  "docs/guides/usage.md",
  "docs/guides/branch-protection.md",
  "docs/cli/README.md",
  "docs/api/README.md",
  "docs/mcp/README.md",
];

// One capture group: the link TARGET. (scripts/parity-check.ts also captures the label, so its
// target is group 2 there and group 1 here — reading group 2 off this pattern yields undefined and
// silently heals nothing.)
const MARKDOWN_LINK = /\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g;

/**
 * Reject agent worktree runtime state rooted at `sourceRoot`, and nothing else. Comparing the
 * absolute worktrees directory for equality — rather than testing whether a path *contains*
 * `.claude/worktrees` — is what keeps the copy correct when `sourceRoot` is itself a worktree.
 */
export function bundleFilter(sourceRoot: string): (source: string) => boolean {
  const worktrees = join(sourceRoot, ".claude", "worktrees");
  return (source: string): boolean => source !== worktrees;
}

/**
 * Copy `entries` from `sourceRoot` into `destRoot`, pruning agent worktree state.
 *
 * Both failure modes are loud by design: an entry named in `entries` but absent from `sourceRoot`
 * throws ENOENT from `cpSync` (a silent skip would let a typo produce a quietly incomplete fixture
 * that still ran a "green" parity check), and a copy that lands no PROJECT.md throws below. Callers
 * passing a custom `entries` list must therefore include PROJECT.md.
 */
export function copyBundle(
  sourceRoot: string,
  destRoot: string,
  entries: readonly string[] = BUNDLE_ENTRIES,
): void {
  const filter = bundleFilter(sourceRoot);
  for (const entry of entries) {
    cpSync(join(sourceRoot, entry), join(destRoot, entry), { recursive: true, filter });
  }

  if (!existsSync(join(destRoot, PROJECT_FILE))) {
    throw new Error(
      `parity fixture: copying ${sourceRoot} produced no ${PROJECT_FILE} — the exclusion filter rejected the bundle`,
    );
  }
}

/**
 * Make the COPY green so a happy path can assert exit 0. A bundle mid-PR legitimately links to a doc
 * a later commit adds, and a link that has not landed yet is not what these self-tests are about.
 * Self-healing: once the target exists, nothing is created.
 */
export function healDeadLinks(root: string): void {
  for (const rel of LINK_CHECKED) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;

    for (const match of readFileSync(file, "utf-8").matchAll(MARKDOWN_LINK)) {
      const raw = (match[1] ?? "").trim();
      if (raw === "" || /^(?:https?:|mailto:|#)/.test(raw)) continue;

      const target = raw.split("#")[0] ?? "";
      if (target === "") continue;

      const resolved = resolve(dirname(file), target);
      if (existsSync(resolved)) continue;

      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, "# fixture stub\n\nCreated by the parity self-test so the base bundle is green.\n");
    }
  }
}

/** Copy the parity-relevant tree into an OS tmpdir, hand it to `fn`, then always remove it. */
export function withBundleCopy(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "parity-bundle-"));
  try {
    copyBundle(REPO_ROOT, root);
    healDeadLinks(root);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
