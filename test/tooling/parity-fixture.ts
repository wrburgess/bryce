import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ADR_DIR, linkCheckedFiles, markdownLinks, resolveInsideRoot } from "../../scripts/parity-check.js";

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
 *
 * Stub creation is CONTAINED to `root`: the target comes from file content, so a relative link that
 * climbs out (`../../elsewhere.md`) would otherwise have this helper WRITE into the real filesystem
 * outside the throwaway copy — the stakes here are higher than the checker's, which only reads. An
 * escaping link is skipped, not healed, and the containment test itself comes from the checker
 * (`resolveInsideRoot`) rather than being re-derived: this file used to carry its own copy of that
 * expression, and a rule written three times and enforced twice is what issue #165 was.
 *
 * It is contained AWAY from `docs/adr/` for the opposite reason — see the rule in the body. Issue #164
 * put that directory in the checked scope, and therefore in this healer's reach, without the rule:
 * healing there manufactures a record file and converts a dead link into a duplicate-ADR-number error
 * naming a file nobody wrote (issue #163).
 *
 * The file list and the link EXTRACTION both come from scripts/parity-check.ts (issue #159) rather than
 * being mirrored here, so the healer and the checker cannot drift apart on either. Sharing
 * `markdownLinks` is what stops it stubbing out the pseudo-links in code spans — with a regex of its
 * own, healing the widened scope writes `rules/url`, `docs/rules/path`, a literal
 * `docs/rules/MMMM-...md`, and two nonsense nested directories, all sourced from prose that TEACHES
 * markdown. That pollution is invisible to every assertion about the checker's output, because the
 * checker ignores those either way — so it has its own test in parity-links.test.ts.
 */
export function healDeadLinks(root: string): void {
  const adrDir = resolve(root, ADR_DIR);

  for (const rel of linkCheckedFiles(root)) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;

    for (const { destination } of markdownLinks(readFileSync(file, "utf-8"))) {
      const raw = destination.trim();
      if (raw === "" || /^(?:https?:|mailto:|#)/.test(raw)) continue;

      const target = raw.split("#")[0] ?? "";
      if (target === "") continue;

      // Root containment comes from the checker's ONE authored copy (issue #165), not a fourth
      // hand-written prefix test -- this file used to carry its own and that is how #165 happened.
      const resolved = resolveInsideRoot(root, dirname(file), target);
      if (resolved === null) continue;

      // Then a SECOND, narrower rule: never synthesize a record file. A stub under docs/adr/ named
      // `NNNN-*.md` collides with the real ADR of that number, so checkAdrNumbers reports "Duplicate ADR
      // number" for a file nobody wrote and the dead link that caused it vanishes from the output
      // entirely (issue #163). A dead ADR link is a defect; it stays visible AS a dead link.
      //
      // Tested on the RESOLVED path, so `../adr/x`, `./0001-y.md`, and a plain name all land in it.
      // Deliberately not limited to the ADR filename pattern or to `.md`: the rule is "this directory
      // holds records", and a narrower rule just moves the hole.
      //
      // CASE-INSENSITIVE, and deliberately NOT delegated to `resolveInsideRoot`, which is exact. The two
      // are different guards pointing different ways. `resolve()` never consults the filesystem, so on a
      // case-insensitive volume (APFS, NTFS -- what this repo is developed on) `../ADR/0029-x.md` fails an
      // exact test while `writeFileSync` still lands the stub in that very directory; reproduced before
      // fixing. Folding is safe HERE because this guard DENIES: on a case-sensitive volume `docs/ADR/` is
      // genuinely separate and declining to stub into it merely reports the dead link. Folding
      // `resolveInsideRoot` instead would loosen a guard whose callers ask the permissive question --
      // exactly what `rules/scripting.md` forbids. ADR_DIR is fixed ASCII lowercase, so no locale care.
      // Like `resolveInsideRoot`, this is string arithmetic: a symlink inside the copy pointing back at
      // docs/adr/ would resolve outside the literal prefix and slip both guards. Not reachable today --
      // nothing under docs/ is a symlink and `copyBundle`'s `cpSync` manufactures none -- so the
      // assumption is recorded rather than paid for with a `realpath` on every href.
      const resolvedKey = resolved.toLowerCase();
      const adrKey = adrDir.toLowerCase();
      if (resolvedKey === adrKey || resolvedKey.startsWith(adrKey + sep)) continue;
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
