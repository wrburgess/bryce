// check-action-pins.ts — supply-chain guard: every external GitHub Action must be
// pinned to a full 40-character commit SHA, not a mutable tag or branch.
//
// A mutable ref (`@v4`, `@main`) can be silently repointed by whoever controls the
// action's repo, injecting code into this repo's CI ("pipeline injection"). Pinning
// to a commit SHA makes the referenced code immutable. This guard fails the build if
// any workflow reintroduces an unpinned external `uses:`, so the hardening in
// renovate.json + the workflows cannot erode as new steps are added (issue #59).
//
// Runs on the app's own Node/TS toolchain via `tsx` (ADR 0039). Output is ASCII-only
// and greppable (rules/scripting.md, ADR 0011).
//
// Usage:
//   npx tsx scripts/check-action-pins.ts [--root DIR]
//     --root DIR   Directory to scan (default: current directory). Used by the
//                  self-test to point the checker at fixture workflow trees.
//
// Exit status: 0 when every external `uses:` is SHA-pinned; 1 when any is not
// (all offenders are printed as `path:line -> value`).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { argv } from "node:process";

const SHA_RE = /^[0-9a-f]{40}$/;
// Capture the token after `uses:` (quotes optional), stopping before any trailing
// `# vX.Y.Z` comment or whitespace.
const USES_RE = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Local (`./…`, `../…`) and docker refs are first-party or out of scope for tag
// repointing; every other `uses:` is a `owner/repo[/path]@ref` that must pin a SHA.
export function unpinned(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("../")) return false;
  if (value.startsWith("docker://")) return false;

  const at = value.indexOf("@");
  const owner = at === -1 ? value : value.slice(0, at);
  const ref = at === -1 ? undefined : value.slice(at + 1);
  if (ref === undefined || ref === "" || owner === "") return true; // no ref at all -> floating

  return !SHA_RE.test(ref);
}

function workflowFiles(root: string): string[] {
  const dir = `${root}/.github/workflows`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .map((n) => `${dir}/${n}`)
    .sort();
}

// Scan a root's workflow tree and return the unpinned offenders as `rel:line -> uses: value` lines.
export function scan(root: string): string[] {
  const offenders: string[] = [];
  const relRe = new RegExp("^" + escapeRegExp(root) + "/?");

  for (const path of workflowFiles(root)) {
    const rel = path.replace(relRe, "");
    const lines = readFileSync(path, "utf-8").split("\n");
    lines.forEach((line, i) => {
      const m = USES_RE.exec(line);
      if (!m) return;
      const value = m[1] ?? "";
      if (unpinned(value)) {
        offenders.push(`${rel}:${i + 1} -> uses: ${value}`);
      }
    });
  }

  return offenders;
}

function run(root: string): number {
  const offenders = scan(root);

  if (offenders.length === 0) {
    process.stdout.write("check_action_pins: OK - every external `uses:` is pinned to a commit SHA.\n");
    return 0;
  }
  process.stdout.write(`check_action_pins: FAIL - ${offenders.length} unpinned external action(s):\n`);
  for (const o of offenders) process.stdout.write(`  ${o}\n`);
  process.stdout.write("Pin each to a full 40-char commit SHA (e.g. `uses: owner/repo@<sha> # vX.Y.Z`).\n");
  return 1;
}

function main(args: string[]): number {
  let root = ".";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      const val = args[++i];
      if (val === undefined) {
        process.stderr.write("check_action_pins: usage error - missing argument: --root\n");
        return 2;
      }
      root = val;
    } else if (arg !== undefined && arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else {
      // Reject unknown flags / stray positionals rather than silently scanning
      // the default root — a mis-invocation must fail loudly, not false-green.
      process.stderr.write(`check_action_pins: usage error - invalid option: ${arg}\n`);
      return 2;
    }
  }
  return run(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Set exitCode (don't process.exit) so buffered stdout drains before exit.
  process.exitCode = main(argv.slice(2));
}
