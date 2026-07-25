import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runParityCheck } from "../../scripts/parity-check.js";

// Self-test for the Human Gates parity check (scripts/parity-check.ts -> checkHumanGates), driven the
// way docs/guides/authoring-the-bundle.md requires: a fixture bundle behind `--root`, one GENUINELY
// GREEN happy path plus one case per failure mode, each asserting BOTH the non-zero exit AND the
// specific error string. The happy path asserts exit 0 and the success line rather than "no error
// string appeared", which would pass vacuously if the check never ran at all.
//
// Fixture semantics run in-process. Two narrow CLI-contract examples below retain coverage of the
// executable's output and status without paying a tsx startup cost for every mutation.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SPAWN_TIMEOUT_MS = 60_000;

// The parity-relevant tree. Determined empirically: this is the top-level set for which
// `npx tsx scripts/parity-check.ts --root <copy>` reports nothing missing.
const BUNDLE_ENTRIES = [
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

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const CLAUDE_WORKTREES = join(REPO_ROOT, ".claude", "worktrees");

// Worktree directories are agent runtime state, not part of the shipped bundle. Rejecting their
// root prevents cpSync from descending into arbitrary generated worktree names.
function isParityFixtureSource(source: string): boolean {
  return source !== CLAUDE_WORKTREES;
}

// Make the COPY green so the happy path can assert exit 0. A bundle mid-PR legitimately links to a
// doc a later commit adds (this PR's prose half authors ADR 0044), and a link that has not landed
// yet is not what this self-test is about. Self-healing: once the target exists, nothing is created.
function healDeadLinks(root: string): void {
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
function withBundleCopy(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "parity-bundle-"));
  try {
    for (const entry of BUNDLE_ENTRIES) {
      cpSync(join(REPO_ROOT, entry), join(root, entry), {
        recursive: true,
        filter: isParityFixtureSource,
      });
    }
    healDeadLinks(root);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("does not copy arbitrary agent worktree runtime state", () => {
  mkdirSync(CLAUDE_WORKTREES, { recursive: true });
  const source = mkdtempSync(join(CLAUDE_WORKTREES, "parity-fixture-"));
  const marker = join(source, "marker.txt");
  writeFileSync(marker, "must not enter the fixture\n");

  try {
    withBundleCopy((root) => {
      expect(existsSync(join(root, ".claude", "worktrees", source.split("/").at(-1) as string, "marker.txt"))).toBe(false);
    });
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

interface ParityRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runParityCli(root: string): ParityRun {
  const res = spawnSync("npx", ["tsx", "scripts/parity-check.ts", "--root", root], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// --- PROJECT.md mutations (the ONLY thing each failure fixture changes) ----

const PROJECT = "PROJECT.md";

function readProject(root: string): string[] {
  return readFileSync(join(root, PROJECT), "utf-8").split("\n");
}

function writeProject(root: string, lines: string[]): void {
  writeFileSync(join(root, PROJECT), lines.join("\n"));
}

function gateRowIndex(lines: string[], label: string): number {
  const i = lines.findIndex((l) => l.trim().startsWith(`| **${label}**`));
  if (i === -1) throw new Error(`fixture: no \`${label}\` gate row in ${PROJECT}`);
  return i;
}

/** Rewrite the SETTING cell (column index 1) of a gate row, leaving the rest of the table alone. */
function setGateSetting(root: string, label: string, cell: string): void {
  const lines = readProject(root);
  const i = gateRowIndex(lines, label);
  const parts = (lines[i] as string).split("|");
  parts[2] = ` ${cell} `;
  lines[i] = parts.join("|");
  writeProject(root, lines);
}

function duplicateGateRow(root: string, label: string): void {
  const lines = readProject(root);
  const i = gateRowIndex(lines, label);
  lines.splice(i + 1, 0, lines[i] as string);
  writeProject(root, lines);
}

function setFloor(root: string, value: string): void {
  const lines = readProject(root);
  const i = lines.findIndex((l) => l.trim().startsWith("- **Reviewer degradation floor:**"));
  if (i === -1) throw new Error(`fixture: no Reviewer degradation floor bullet in ${PROJECT}`);
  lines[i] = (lines[i] as string).replace(/`[^`]+`/, value);
  writeProject(root, lines);
}

function setDisposition(root: string, value: string): void {
  const lines = readProject(root);
  const i = lines.findIndex((l) => l.includes("shipped default is"));
  if (i === -1) throw new Error(`fixture: no disposition declaring sentence in ${PROJECT}`);

  // The declaring sentence legitimately wraps: the value may open the following line.
  const tail = (lines[i] as string).split("shipped default is")[1] ?? "";
  if (/`[^`]+`/.test(tail)) {
    lines[i] = (lines[i] as string).replace(/(shipped default is\s*)`[^`]+`/, `$1${value}`);
  } else {
    lines[i + 1] = (lines[i + 1] as string).replace(/`[^`]+`/, value);
  }
  writeProject(root, lines);
}

/** Drop a heading and everything under it, up to the next `## ` H2 (or EOF). */
function dropSection(root: string, heading: string): void {
  const lines = readProject(root);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) throw new Error(`fixture: no \`${heading}\` in ${PROJECT}`);

  const rest = lines.slice(start + 1);
  const relEnd = rest.findIndex((l) => l.startsWith("## "));
  const end = relEnd === -1 ? lines.length : start + 1 + relEnd;
  lines.splice(start, end - start);
  writeProject(root, lines);
}

/** Append a SECOND `## Human Gates` section carrying an unsafe self-merge row, at EOF. */
function appendDuplicateHumanGates(root: string): void {
  const lines = readProject(root);
  lines.push(
    "",
    "## Human Gates",
    "",
    "| Gate | Setting | Allowed values |",
    "|------|---------|----------------|",
    "| **Merge** — sneaky second section | `auto` | `required` |",
    "",
  );
  writeProject(root, lines);
}

/** Assert a semantic failure without coupling fixture cases to CLI formatting. */
function expectFailure(result: ReturnType<typeof runParityCheck>, message: string): void {
  expect(result.errors.join("\n")).toContain(message);
}

describe("parity check - Human Gates fixture bundles", () => {
  it(
    "keeps the CLI green contract exact",
    () => {
      withBundleCopy((root) => {
        expect(runParityCli(root)).toEqual({
          status: 0,
          stdout: "parity_check: OK - Canonical Source, 3 Adapters, Project Config, 9 Skills, and links all resolve.\n",
          stderr: "",
        });
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "keeps the CLI red contract exact",
    () => {
      withBundleCopy((root) => {
        setGateSetting(root, "Merge", "`auto`");
        expect(runParityCli(root)).toEqual({
          status: 1,
          stdout:
            "parity_check: FAILED (1 problem)\n" +
            "  - Human Gates: `Merge` is declared `auto` in PROJECT.md but `required` is its only allowed value - " +
            "no Host App may express self-merge; a human always merges the delivered PR\n",
          stderr: "",
        });
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "keeps an unmodified bundle green in-process",
    () => {
      withBundleCopy((root) => {
        expect(runParityCheck(root).errors).toEqual([]);
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects a self-merge declaration with the policy-boundary message",
    () => {
      withBundleCopy((root) => {
        setGateSetting(root, "Merge", "`auto`");
        expectFailure(
          runParityCheck(root),
          "Human Gates: `Merge` is declared `auto` in PROJECT.md but `required` is its only allowed " +
            "value - no Host App may express self-merge; a human always merges the delivered PR",
        );
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects a softened Reviewer degradation floor with the policy-boundary message",
    () => {
      withBundleCopy((root) => {
        setFloor(root, "`flag-in-SOW`");
        expectFailure(
          runParityCheck(root),
          "Human Gates: `Reviewer degradation floor` is declared `flag-in-SOW` in PROJECT.md but " +
            "`stop-and-ask` is its only allowed value - a run that cannot obtain an independent " +
            "review may not certify itself",
        );
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects an out-of-range plan-approval value with the allowed-values message",
    () => {
      withBundleCopy((root) => {
        setGateSetting(root, "Plan approval", "`sometimes`");
        expectFailure(
          runParityCheck(root),
          "Human Gates declaration `Plan approval` in PROJECT.md has value `sometimes`, which is " +
            "not allowed - allowed values: `required` | `auto`",
        );
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects an out-of-range rule-suggestion disposition with the allowed-values message",
    () => {
      withBundleCopy((root) => {
        setDisposition(root, "`fold-everything`");
        expectFailure(
          runParityCheck(root),
          "Human Gates declaration `Rule-suggestion disposition` in PROJECT.md has value " +
            "`fold-everything`, which is not allowed - allowed values: `autonomous-fold` | `present-to-hc`",
        );
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports the disposition as absent when its subsection is removed",
    () => {
      withBundleCopy((root) => {
        dropSection(root, "### Rule-suggestion disposition");
        expectFailure(
          runParityCheck(root),
          "Human Gates declaration `Rule-suggestion disposition` in PROJECT.md: absent",
        );
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports the missing section AND both gates as absent when `## Human Gates` is removed",
    () => {
      withBundleCopy((root) => {
        dropSection(root, "## Human Gates");
        const result = runParityCheck(root);
        expectFailure(result, "Project Config PROJECT.md missing required section: `## Human Gates`");
        expect(result.errors.join("\n")).toContain("Human Gates declaration `Plan approval` in PROJECT.md: absent");
        expect(result.errors.join("\n")).toContain("Human Gates declaration `Merge` in PROJECT.md: absent");
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  // The regression this check exists for: a value written without backticks must read as a real,
  // wrong declaration - never as "absent", which would let it fall back to the safe default and pass.
  it(
    "reports an unbackticked merge value as unparseable, not absent, and fails",
    () => {
      withBundleCopy((root) => {
        setGateSetting(root, "Merge", "auto");
        const result = runParityCheck(root);
        expectFailure(result, "Human Gates declaration `Merge` in PROJECT.md: unparseable (expected exactly one declaration carrying a backticked value, one of `required`) - the fail-closed default `required` applies until it is fixed");
        expect(result.errors.join("\n")).not.toContain("Human Gates declaration `Merge` in PROJECT.md: absent");
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports duplicate merge rows as duplicate even though their values agree",
    () => {
      withBundleCopy((root) => {
        duplicateGateRow(root, "Merge");
        const result = runParityCheck(root);
        expectFailure(result, "Human Gates declaration `Merge` in PROJECT.md: duplicate (expected exactly one declaration carrying a backticked value, one of `required`) - the fail-closed default `required` applies until it is fixed");
        expect(result.errors.join("\n")).not.toContain("Human Gates declaration `Plan approval` in PROJECT.md:");
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  // PR #83 review, P1: a first-wins parser would read only the first `## Human Gates` section and
  // miss a self-merge planted in a duplicated second one. A duplicated section must redden parity.
  it(
    "rejects a duplicated `## Human Gates` section so a safe first cannot mask an unsafe second",
    () => {
      withBundleCopy((root) => {
        appendDuplicateHumanGates(root);
        const result = runParityCheck(root);
        expectFailure(result, "Human Gates declaration `Merge` in PROJECT.md: duplicate (expected exactly one declaration carrying a backticked value, one of `required`) - the fail-closed default `required` applies until it is fixed");
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  // checkProjectSections() only RECORDS the missing-file error and returns, so checkHumanGates must
  // guard on existence: an unguarded readFileSync would throw ENOENT and abort the whole report.
  it(
    "still prints its normal aggregate report, without throwing, when PROJECT.md is deleted",
    () => {
      withBundleCopy((root) => {
        rmSync(join(root, PROJECT));
        const result = runParityCheck(root);
        expectFailure(result, "Project Config missing: PROJECT.md not found");
        expect(result.errors.join("\n")).toContain("Guardrails present but PROJECT.md is missing (cannot verify the protected-branch list)");
        expect(result.errors.join("\n")).not.toContain("Human Gates declaration");
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
