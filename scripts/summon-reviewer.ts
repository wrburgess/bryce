// summon-reviewer.ts — summon the local Codex CLI as the independent Reviewer (issue #39; ported to
// TypeScript per ADR 0039).
//
// Produces a plan critique (`--mode plan`) or a work review of a branch (`--mode work`) by running the
// LOCAL Codex CLI, classifies the outcome, and writes the reviewer's body to a file. The AC reads the
// classification and posts the body to the lifecycle host.
//
// This script NEVER touches the network and NEVER calls the lifecycle host. That split is deliberate:
// no token handling in a bundled script, no credential prompt mid-run, and the entire failure ladder is
// testable offline against a fake `codex` (scripts/summon_reviewer.test.sh).
//
// Runs on the app's own Node/TS toolchain via `tsx` (ADR 0039).
//
// Usage:
//   npx tsx scripts/summon-reviewer.ts --mode work --out FILE [--base BRANCH]
//   npx tsx scripts/summon-reviewer.ts --mode plan --input FILE --out FILE
//     --mode plan|work    plan = critique the plan text in --input; work = review the branch's diff
//     --input FILE        plan mode only: the plan text to critique (required in plan mode)
//     --base BRANCH       work mode only: the branch to review against (default: main)
//     --out FILE          where to write the reviewer's body, raw bytes (required)
//     --codex-bin PATH    the Codex CLI to summon (default: codex, resolved on PATH)
//     --timeout SECONDS   wall-clock cap on the review (default: 900)
//     --ac NAME           the acting agent, so a self-review can be refused (default: claude)
//     --min-bytes N       substance floor on the review body (default: 200; 0 disables)
//
// Output (stdout, ASCII only — rules/scripting.md / ADR 0011), exactly two shapes:
//   summon_reviewer: OK - {mode} review, {n} bytes -> {path}
//   summon_reviewer: FAILED ({classification})        [followed by "  - detail" lines]
// Classifications: ok | not_found | not_authenticated | exit_nonzero | empty_output |
//                  insufficient_output | drain_timeout | timeout | self_review
// Usage errors and an unwritable --out are NOT classifications: they go to stderr and exit 1. Callers
// must branch on the EXIT STATUS (any non-zero = summon failed, fall back to the secondary Reviewer).
//
// Exit status: 0 when the review succeeded (classification `ok`); 1 for every failure.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  writeSync, writeFileSync, readFileSync, statSync, accessSync, constants,
} from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { argv, env } from "node:process";

const USAGE =
  "Usage: npx tsx scripts/summon-reviewer.ts --mode work --out FILE [--base BRANCH]\n" +
  "       npx tsx scripts/summon-reviewer.ts --mode plan --input FILE --out FILE\n";

const MODES = ["plan", "work"];

const DEFAULT_BASE = "main";
const DEFAULT_CODEX_BIN = "codex";
const DEFAULT_AC = "claude";
const DEFAULT_TIMEOUT = 900;

const PREFLIGHT_TIMEOUT = 30;
const SELF_REVIEW_AC = "codex";
const POLL_INTERVAL = 0.025;
const TERM_GRACE = 2.0;
const DRAIN_TIMEOUT = 5.0;
const FINAL_POLL_GRACE = 0.25;
const DEFAULT_MIN_BYTES = 200;
const DETAIL_MAX = 200;

const PLAN_CRITIQUE_PROMPT =
  "You are an independent second-model Reviewer critiquing an implementation plan before any code is\n" +
  "written. Be adversarial and specific: your job is to find what the plan misses, not to summarize it.\n" +
  "\n" +
  "Report, in markdown:\n" +
  "1. Must-fix findings - steps too vague to implement without guessing, missing edge cases or sad\n" +
  "   paths, a stated requirement the plan does not address, an unsafe data/schema step, or a risk the\n" +
  "   plan leaves unhandled. Quote the plan text each finding refers to.\n" +
  "2. Should-consider findings - ordering, test strategy, or structural improvements.\n" +
  "3. A one-line verdict: APPROVE or REVISE.\n" +
  "\n" +
  "If you find nothing must-fix, say so explicitly rather than inventing a finding.\n" +
  "\n" +
  "The plan follows.\n" +
  "\n" +
  "----- BEGIN PLAN -----\n";

type ChildStatus = "ok" | "exit_nonzero" | "timeout" | "drain_timeout" | "spawn_failed";
interface ChildResult {
  status: ChildStatus;
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

class UsageError extends Error {}

// --- ASCII rendering (rules/scripting.md, ADR 0011) -------------------------
// Replace every byte outside 0x20-0x7E with '?', then truncate to DETAIL_MAX chars + '...'.
function ascii(text: string | Buffer): string {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ""), "utf8");
  let flat = "";
  for (const b of bytes) flat += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "?";
  if (flat.length > DETAIL_MAX) flat = flat.slice(0, DETAIL_MAX) + "...";
  return flat;
}

// A UTF-8 view of raw subprocess bytes, always safe to split (invalid sequences become U+FFFD).
function readable(bytes: Buffer): string {
  return bytes.toString("utf8");
}

// The last non-empty line of a CLI's stderr, ASCII-safe and bounded.
function detail(stderr: Buffer): string | null {
  const lines = readable(stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return null;
  return ascii(lines[lines.length - 1] as string);
}

// Emptiness decided on BYTES (Ruby String#strip byte set: \0 \t \n \v \f \r space).
function blank(bytes: Buffer): boolean {
  const ws = new Set([0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
  for (const b of bytes) if (!ws.has(b)) return false;
  return true;
}

function exitReason(code: number | null): string {
  return code === null
    ? "the Codex CLI terminated abnormally (killed by a signal)"
    : `the Codex CLI exited ${code}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Poll `pred` until true or `ms` elapses; resolves true if it became true, false on timeout.
function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  return new Promise((res) => {
    if (pred()) return res(true);
    const start = performance.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        res(true);
      } else if (performance.now() - start >= ms) {
        clearInterval(iv);
        res(false);
      }
    }, POLL_INTERVAL * 1000);
  });
}

interface Options {
  mode: string | null;
  input: string | null;
  base: string;
  out: string | null;
  codexBin: string;
  timeout: number;
  ac: string;
  minBytes: number;
}

class SummonReviewer {
  private readonly opts: Options;

  constructor(opts: Options) {
    this.opts = opts;
  }

  async run(): Promise<number> {
    const problem = this.usageProblem();
    if (problem) return this.usageError(problem);

    if (this.selfReview()) {
      return this.failed("self_review", [
        `acting agent is \`${ascii(this.opts.ac)}\` - the Reviewer must be a different model`,
      ]);
    }

    const writeProblem = this.outPathProblem();
    if (writeProblem) return this.writeError(writeProblem);

    const bin = this.resolveBin();
    if (bin === null) {
      return this.failed("not_found", [`no executable Codex CLI at \`${ascii(this.opts.codexBin)}\``]);
    }

    const auth = await this.runChild([bin, "login", "status"], Buffer.alloc(0), PREFLIGHT_TIMEOUT);
    if (auth.status === "spawn_failed") {
      return this.failed("not_found", [`cannot execute \`${ascii(bin)}\``, detail(auth.stderr)]);
    }
    if (auth.status !== "ok") {
      return this.failed("not_authenticated", [
        `\`${ascii(basename(bin))} login status\` did not confirm a session`,
        detail(auth.stderr),
      ]);
    }

    const review = await this.runChild(this.commandFor(bin), this.stdinFor(), this.opts.timeout);
    switch (review.status) {
      case "spawn_failed":
        return this.failed("not_found", [`cannot execute \`${ascii(bin)}\``, detail(review.stderr)]);
      case "timeout":
        return this.failed("timeout", [
          `no review within ${Math.round(this.opts.timeout)} seconds - child process group terminated`,
        ]);
      case "drain_timeout":
        return this.failed("drain_timeout", [
          "the Codex CLI exited but its output could not be read within " +
            `${Math.round(DRAIN_TIMEOUT)} seconds - a surviving child is holding the pipe open`,
          "the review text, if any, was discarded rather than reported as an empty review",
        ]);
      case "exit_nonzero":
        return this.failed("exit_nonzero", [exitReason(review.exitCode), detail(review.stderr)]);
    }

    const body = review.stdout;
    if (blank(body)) {
      return this.failed("empty_output", ["the Codex CLI exited 0 but produced no review text"]);
    }

    if (body.length < this.opts.minBytes) {
      return this.failed("insufficient_output", [
        `the Codex CLI exited 0 but produced only ${body.length} bytes ` +
          `(floor: ${this.opts.minBytes}) - too short to be a review`,
        detail(body),
      ]);
    }

    try {
      writeFileSync(this.opts.out as string, body);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "Error";
      return this.writeError(`${ascii(this.opts.out as string)} (${ascii(code)})`);
    }

    writeSync(1, `summon_reviewer: OK - ${this.opts.mode} review, ${body.length} bytes -> ${ascii(this.opts.out as string)}\n`);
    return 0;
  }

  // --- validation -----------------------------------------------------------

  private usageProblem(): string | null {
    const o = this.opts;
    if (o.mode === null || o.mode === "") return `missing required --mode (one of: ${MODES.join(", ")})`;
    if (!MODES.includes(o.mode)) return `unknown --mode \`${ascii(o.mode)}\` (one of: ${MODES.join(", ")})`;
    if (o.out === null || o.out === "") return "missing required --out FILE";
    if (!(o.timeout > 0)) return "--timeout must be greater than zero";
    if (o.minBytes < 0) return "--min-bytes must be zero or greater";

    if (o.mode === "plan") {
      if (o.input === null || o.input === "") return "--mode plan requires --input FILE (the plan text to critique)";
      if (!this.isFile(o.input)) return `--input file not found: ${ascii(o.input)}`;
      if (!this.isReadable(o.input)) return `--input file not readable: ${ascii(o.input)}`;
    }
    return null;
  }

  private selfReview(): boolean {
    return String(this.opts.ac).trim().toLowerCase() === SELF_REVIEW_AC;
  }

  private outPathProblem(): string | null {
    const out = this.opts.out as string;
    const dir = dirname(out);
    if (!this.isDirectory(dir)) return `${ascii(dir)} is not a directory`;
    if (this.pathExists(out) && !this.isWritable(out)) return `${ascii(out)} exists but is not writable`;
    if (!this.isWritable(dir)) return `${ascii(dir)} is not writable`;
    return null;
  }

  // --- invocation -----------------------------------------------------------

  private commandFor(bin: string): string[] {
    return this.opts.mode === "work"
      ? [bin, "review", "--base", this.opts.base]
      : [bin, "exec"];
  }

  // Assembled in BINARY: prompt + "\n" + raw plan bytes + "\n----- END PLAN -----\n".
  private stdinFor(): Buffer {
    if (this.opts.mode !== "plan") return Buffer.alloc(0);
    return Buffer.concat([
      Buffer.from(PLAN_CRITIQUE_PROMPT, "utf8"),
      Buffer.from("\n"),
      readFileSync(this.opts.input as string),
      Buffer.from("\n----- END PLAN -----\n"),
    ]);
  }

  private resolveBin(): string | null {
    const bin = this.opts.codexBin;
    if (bin.includes("/")) {
      return this.executableFile(bin) ? bin : null;
    }
    for (const dir of (env.PATH ?? "").split(":")) {
      if (dir === "") continue;
      const candidate = `${dir}/${bin}`;
      if (this.executableFile(candidate)) return candidate;
    }
    return null;
  }

  private executableFile(path: string): boolean {
    return this.isFile(path) && this.isExecutable(path);
  }

  // Spawn `argv` with `stdinData` under a wall-clock cap. Detached process group so a timeout can
  // signal the WHOLE group with one kill (a bare-child kill would orphan its workers).
  private runChild(argv: string[], stdinData: Buffer, timeoutSec: number): Promise<ChildResult> {
    return new Promise<ChildResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(argv[0] as string, argv.slice(1), {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({
          status: "spawn_failed",
          exitCode: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(String((e as Error)?.message ?? "")),
        });
        return;
      }

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let stdoutEof = false;
      let stderrEof = false;
      let exited = false;
      let exitCode: number | null = null;
      let spawnErr: Error | null = null;

      child.stdout.on("data", (c: Buffer) => outChunks.push(c));
      child.stderr.on("data", (c: Buffer) => errChunks.push(c));
      child.stdout.once("end", () => { stdoutEof = true; });
      child.stderr.once("end", () => { stderrEof = true; });
      child.stdout.on("error", () => {});
      child.stderr.on("error", () => {});
      child.stdin.on("error", () => {}); // swallow EPIPE if the child never reads stdin
      child.once("error", (e: Error) => { spawnErr = e; exited = true; });
      child.once("exit", (code: number | null) => { exited = true; exitCode = code; });

      try {
        child.stdin.write(stdinData);
        child.stdin.end();
      } catch {
        /* EPIPE handled by the error listener */
      }

      const pid = child.pid ?? -1;

      void (async () => {
        await waitUntil(() => exited, timeoutSec * 1000);
        if (!exited) {
          // The poll can cross the deadline in the instant a finished child is exiting: one last look.
          await waitUntil(() => exited, FINAL_POLL_GRACE * 1000);
        }

        if (spawnErr) {
          this.cleanup(child);
          resolve({
            status: "spawn_failed",
            exitCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(String((spawnErr as Error).message ?? "")),
          });
          return;
        }

        if (!exited) {
          // Timeout: TERM the group, grace, then KILL, then reap.
          this.killPid(-pid, "SIGTERM");
          await waitUntil(() => exited, TERM_GRACE * 1000);
          if (!exited) {
            this.killPid(-pid, "SIGKILL");
            await waitUntil(() => exited, TERM_GRACE * 1000);
          }
          this.cleanup(child);
          resolve({ status: "timeout", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
          return;
        }

        // Exited: drain the pipes (bounded — a grandchild may hold one open).
        const stdoutDrained = await waitUntil(() => stdoutEof, DRAIN_TIMEOUT * 1000);
        const stderrDrained = await waitUntil(() => stderrEof, DRAIN_TIMEOUT * 1000);

        const ok = exitCode === 0; // success? semantics: exit 0 and not signaled
        const stderr = stderrDrained ? Buffer.concat(errChunks) : Buffer.alloc(0);

        if (ok && !stdoutDrained) {
          // A survivor outlived the child holding the pipe open — signal the group and discard the
          // body. TERM first, then KILL any survivor that ignores TERM (hardening over the original
          // Ruby, which only sent TERM: a `trap '' TERM` grandchild must not outlive the summon).
          this.killPid(-pid, "SIGTERM");
          await sleep(TERM_GRACE * 1000);
          this.killPid(-pid, "SIGKILL");
          this.cleanup(child);
          resolve({ status: "drain_timeout", exitCode, stdout: Buffer.alloc(0), stderr });
          return;
        }

        const stdout = stdoutDrained ? Buffer.concat(outChunks) : Buffer.alloc(0);
        this.cleanup(child);
        resolve({ status: ok ? "ok" : "exit_nonzero", exitCode, stdout, stderr });
      })();
    });
  }

  private cleanup(child: ChildProcessWithoutNullStreams): void {
    try { child.stdin.destroy(); } catch { /* noop */ }
    try { child.stdout.destroy(); } catch { /* noop */ }
    try { child.stderr.destroy(); } catch { /* noop */ }
  }

  private killPid(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(pid, sig);
    } catch {
      /* ESRCH/EPERM: the target is already gone */
    }
  }

  // --- fs helpers -----------------------------------------------------------

  private isFile(path: string): boolean {
    try { return statSync(path).isFile(); } catch { return false; }
  }

  private isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
  }

  private pathExists(path: string): boolean {
    try { statSync(path); return true; } catch { return false; }
  }

  private isReadable(path: string): boolean {
    try { accessSync(path, constants.R_OK); return true; } catch { return false; }
  }

  private isWritable(path: string): boolean {
    try { accessSync(path, constants.W_OK); return true; } catch { return false; }
  }

  private isExecutable(path: string): boolean {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  }

  // --- output ---------------------------------------------------------------

  private failed(classification: string, details: Array<string | null>): number {
    writeSync(1, `summon_reviewer: FAILED (${classification})\n`);
    for (const d of details) {
      if (d !== null && d !== "") writeSync(1, `  - ${d}\n`);
    }
    return 1;
  }

  private usageError(message: string): number {
    writeSync(2, `summon_reviewer: usage error - ${message}\n`);
    writeSync(2, USAGE);
    return 1;
  }

  private writeError(message: string): number {
    writeSync(2, `summon_reviewer: cannot write output - ${message}\n`);
    return 1;
  }
}

// --- strict numeric parsing -------------------------------------------------

function parseStrictFloat(flag: string, value: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
    throw new UsageError(`invalid argument: ${flag} ${value}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`invalid argument: ${flag} ${value}`);
  return n;
}

function parseStrictInt(flag: string, value: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new UsageError(`invalid argument: ${flag} ${value}`);
  }
  return parseInt(value, 10);
}

function parseArgs(args: string[]): Options {
  const opts: Options = {
    mode: null,
    input: null,
    base: DEFAULT_BASE,
    out: null,
    codexBin: DEFAULT_CODEX_BIN,
    timeout: DEFAULT_TIMEOUT,
    ac: DEFAULT_AC,
    minBytes: DEFAULT_MIN_BYTES,
  };

  const takesValue = new Set([
    "--mode", "--input", "--base", "--out", "--codex-bin", "--timeout", "--ac", "--min-bytes",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    let flag = arg;
    let value: string | null = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }

    if (!flag.startsWith("-")) throw new UsageError(`unexpected argument: ${arg}`);
    if (!takesValue.has(flag)) throw new UsageError(`invalid option: ${flag}`);

    if (value === null) {
      if (i + 1 >= args.length) throw new UsageError(`missing argument: ${flag}`);
      value = args[++i] as string;
    }

    switch (flag) {
      case "--mode": opts.mode = value; break;
      case "--input": opts.input = value; break;
      case "--base": opts.base = value; break;
      case "--out": opts.out = value; break;
      case "--codex-bin": opts.codexBin = value; break;
      case "--ac": opts.ac = value; break;
      case "--timeout": opts.timeout = parseStrictFloat(flag, value); break;
      case "--min-bytes": opts.minBytes = parseStrictInt(flag, value); break;
    }
  }

  return opts;
}

async function main(args: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      writeSync(2, `summon_reviewer: usage error - ${e.message}\n`);
      writeSync(2, USAGE);
      return 1;
    }
    throw e;
  }
  return new SummonReviewer(opts).run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main(argv.slice(2)).then((code) => process.exit(code));
}
