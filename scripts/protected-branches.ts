// protected-branches.ts — the ONE place that derives the protected-branch list from PROJECT.md
// (Option A, issue #6 / ADR 0009). PROJECT.md is the single authored source; the git hooks read a
// generated sidecar (.githooks/protected-branches). Parsing lives here so it is unit-tested once and
// reused by both `bin/protected-branches` (generate) and `scripts/parity-check.ts` (verify no drift).
//
// Runs on the app's own Node/TS toolchain via `tsx` (ADR 0039), mirroring scripts/parity-check.ts.
//
// Contract with PROJECT.md → "## Branch & PR Policy":
//   - the list is authored on the bullet line beginning `- **Protected branches:**`
//   - every `backticked` token on that line UP TO the first ` — ` (em dash) separator is a protected
//     branch; text after the separator is human prose and is ignored.
//
// Returns [] when the section or the line is absent — callers apply their own fail-closed default.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { argv } from "node:process";

const SECTION = "## Branch & PR Policy";
const LINE_PREFIX = "- **Protected branches:**";
const EM_DASH = "—";
const BACKTICKED = /`([^`]+)`/g;

// Parse the protected-branch names out of PROJECT.md text. Deterministic and order-preserving.
export function extract(text: string | null | undefined): string[] {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start === -1) return [];

  let line: string | null = null;
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("## ")) break; // the next H2 ends the section
    if (l.trim().startsWith(LINE_PREFIX)) {
      line = l;
      break;
    }
  }
  if (line === null) return [];

  const head = line.split(` ${EM_DASH} `)[0] ?? ""; // drop prose after the ` — ` separator
  const found: string[] = [];
  for (const m of head.matchAll(BACKTICKED)) {
    const token = (m[1] ?? "").trim();
    if (token.length === 0) continue; // reject empty
    if (!found.includes(token)) found.push(token); // order-preserving dedupe
  }
  return found;
}

export function fromFile(path: string): string[] {
  return extract(readFileSync(path, "utf-8"));
}

// --- direct-run CLI (equivalent to the old bin/protected-branches) ---------
// Prints each branch on its own line; empty list => no output, exit 0.
//   --file PATH   PROJECT.md to read (default: ./PROJECT.md).
// Missing file => stderr `protected-branches: no such file: {file}` + exit 1.
function main(args: string[]): number {
  let file = "PROJECT.md";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") {
      file = args[++i] ?? "";
    } else if (arg !== undefined && arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    }
  }

  if (!existsSync(file)) {
    process.stderr.write(`protected-branches: no such file: ${file}\n`);
    return 1;
  }

  const branches = fromFile(file);
  if (branches.length > 0) {
    process.stdout.write(branches.join("\n") + "\n");
  }
  return 0;
}

// Main-module guard: run the CLI only when executed directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(argv.slice(2)));
}
