// The impure edge: runs the readiness check, then the mechanism. Unreachable
// (readiness failed — immediate, no waiting window) and unresponsive (dispatched,
// nothing came back) are different outcomes and are reported as such
// (Chapter 2, *The summons, completed*).
//
// No shell, anywhere: configured commands are tokenized to argv and executed
// directly. A command carrying shell metacharacters is refused before anything
// runs — configuration is data, and data never reaches an interpreter here
// (raised live on PR #39; shell quoting is one of the predecessor's recurring
// classes).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DispatchOutcome =
  | { kind: "review"; output: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "unresponsive"; detail: string };

export interface DispatchOptions {
  readinessCommand: string;
  /** Builds the argv that receives the summons on stdin and must write the
   *  final review text to the file path it is given. Executed without a shell. */
  buildArgv: (outFile: string) => string[];
  summons: string;
  timeoutMs?: number;
}

const SAFE_TOKEN = /^[A-Za-z0-9._/:=-]+$/;

export function argvFromCommand(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  for (const t of tokens) {
    if (!SAFE_TOKEN.test(t)) {
      throw new Error(
        `configured command carries a shell metacharacter and is refused: ${t}`,
      );
    }
  }
  if (tokens.length === 0 || tokens[0] === "") {
    throw new Error("configured command is empty");
  }
  return tokens;
}

export function runReadiness(command: string): { ok: boolean; detail: string } {
  const argv = argvFromCommand(command);
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 60_000 });
  const detail = `${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim()}`.trim();
  return { ok: r.status === 0, detail: detail || `exit ${r.status}` };
}

export function dispatch(opts: DispatchOptions): DispatchOutcome {
  const readiness = runReadiness(opts.readinessCommand);
  if (!readiness.ok) {
    return { kind: "unreachable", detail: readiness.detail };
  }

  const dir = mkdtempSync(join(tmpdir(), "deuce-review-"));
  const outFile = join(dir, "review.md");
  try {
    const argv = opts.buildArgv(outFile);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      input: opts.summons,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { kind: "unresponsive", detail: "dispatch timed out" };
    }
    const output = existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
    if (output.length === 0) {
      const detail = `${(r.stderr ?? "").trim()}`.slice(0, 2_000);
      return {
        kind: "unresponsive",
        detail: detail || `mechanism exited ${r.status} with no review`,
      };
    }
    return { kind: "review", output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
