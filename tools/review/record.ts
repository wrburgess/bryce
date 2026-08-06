// Recording is delivery: the summons and the review land on the pull request,
// whatever mechanism produced them (Chapter 2, *The summons, completed*).
//
// A post that fails is itself an outcome, never an unhandled crash. It throws
// PostFailure carrying the record it could not place, so the boundary can print
// that record and exit with a code of its own — for an unreachable or
// unresponsive reviewer, the post *is* the only account of what happened, and
// losing it is the failure shape this machinery exists to eliminate (#40).
// A throw rather than a returned result on purpose: a returned failure can be
// ignored by the next post site somebody writes, and that is this same defect
// re-armed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fields are declared and assigned rather than written as constructor parameter
// properties: the runtime strips types without transforming, so parameter
// properties are not available here (`erasableSyntaxOnly`, tsconfig.json).
export class PostFailure extends Error {
  readonly prNumber: number;
  readonly label: string;
  readonly body: string;
  readonly detail: string;

  constructor(prNumber: number, label: string, body: string, detail: string) {
    super(`posting ${label} to PR #${prNumber} failed: ${detail}`);
    this.name = "PostFailure";
    this.prNumber = prNumber;
    this.label = label;
    this.body = body;
    this.detail = detail;
  }
}

/** The un-posted record, rendered for the HC to place by hand. The body is
 *  carried whole and last: a report that truncates it loses the thing it
 *  exists to preserve. */
export function formatUnpostedRecord(failure: PostFailure): string {
  return [
    `## Post failed — this record was not placed`,
    ``,
    `- Pull request: #${failure.prNumber}`,
    `- What was being recorded: ${failure.label}`,
    `- Why the post failed: ${failure.detail}`,
    ``,
    `The run stops here. Nothing about the review outcome above is changed by`,
    `this failure — only that it is not on the pull request. Place the record`,
    `below by hand, or re-run once the post path works again.`,
    ``,
    `--- the un-posted record begins ---`,
    failure.body,
    `--- the un-posted record ends ---`,
    ``,
  ].join("\n");
}

export interface SavedRecord {
  /** Where the record landed, when it landed. */
  path?: string;
  /** Why it did not, when it did not. Both are never set. */
  error?: string;
}

const MAX_RECORDS_PER_PR = 1_000;

/** Writes the report to a fresh path, **never over an existing one**. A record
 *  already sitting here is one the HC has not placed yet, and overwriting it
 *  would be this file's own defect wearing a third hat — a mechanism built to
 *  stop records being lost, losing them.
 *  Raised as must-fix by the contractor review of 002d18c on PR #46. */
function writeWithoutOverwriting(
  location: string,
  prNumber: number,
  report: string,
): string {
  for (let n = 1; n <= MAX_RECORDS_PER_PR; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join(location, `deuce-unposted-pr${prNumber}${suffix}.md`);
    try {
      writeFileSync(path, report, { flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(
    `${MAX_RECORDS_PER_PR} un-posted records for PR #${prNumber} are already here`,
  );
}

/** Saves the un-posted record where the HC can find it, and **never throws** —
 *  a delivery mechanism that can throw is the defect this file is about (#40).
 *
 *  Two locations, tried in order: the **working directory**, then the OS temp
 *  directory. The working directory is the repository root for every real run,
 *  so a predictably named file there is discoverable with no pointer at all —
 *  which matters because the pointer travels over the same stream that can fail.
 *  A temp directory would be tidier and is second for one reason: the operating
 *  system may clean it up before the HC gets there, and a record whose whole job
 *  is to survive until a human moves it must not sit somewhere that reaps it.
 *  `.gitignore` keeps a saved record out of commits.
 *  Order set by the HC at the second stop on PR #46, reversing this Plan's
 *  step 2 on the reviewer's reasoning. */
export function saveUnpostedRecord(
  failure: PostFailure,
  locations?: readonly string[],
): SavedRecord {
  const report = formatUnpostedRecord(failure);
  const candidates = locations ?? [process.cwd(), tmpdir()];
  const errors: string[] = [];
  for (const location of candidates) {
    try {
      return { path: writeWithoutOverwriting(location, failure.prNumber, report) };
    } catch (err) {
      errors.push(
        `${location}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { error: errors.join("; ").slice(0, 1_000) || "no location to write to" };
}

const NOTICE_LIMIT_BYTES = 512;

/** Trims to a UTF-8 **byte** budget, by whole code points so nothing is split
 *  mid-character. Measured in bytes because the guarantee is about bytes: a
 *  string of 350 multi-byte characters is 950 bytes, and a character-counting
 *  check waves it through.
 *  Raised as should-fix by the contractor review of 002d18c on PR #46. */
function fitToBytes(line: string, limit: number): string {
  if (Buffer.byteLength(line, "utf8") <= limit) return line;
  const points = [...line.replace(/\n$/, "")];
  while (
    points.length > 0 &&
    Buffer.byteLength(`${points.join("")}...\n`, "utf8") > limit
  ) {
    points.pop();
  }
  return `${points.join("")}...\n`;
}

/** The one-line pointer to the saved record. Held to at most 512 **bytes** —
 *  POSIX guarantees a write of PIPE_BUF bytes or fewer is atomic — so the pointer
 *  cannot itself be cut in half by a reader that goes away. */
export function formatUnpostedNotice(
  failure: PostFailure,
  saved: SavedRecord,
): string {
  const head = `post failed (${failure.label}, PR #${failure.prNumber}): `;
  const tail = saved.path
    ? `record saved to ${saved.path}`
    : `record NOT saved — ${saved.error}`;
  // Trim the explanation, never the fact: a reader must still learn that a
  // record exists and roughly where, even if the detail has to go.
  return fitToBytes(`${head}${tail}\n`, NOTICE_LIMIT_BYTES);
}

export function postComment(
  prNumber: number,
  body: string,
  label: string,
  command: readonly string[] = ["gh"],
): void {
  let dir: string | undefined;
  let posted = "";
  try {
    // Staging counts as posting. A temp directory that cannot be made, or a body
    // that cannot be written, loses the record exactly as surely as a rejected
    // post — so it takes the same classified path rather than escaping raw.
    // Raised as must-fix by the contractor review of 3d466c3 on PR #46.
    dir = mkdtempSync(join(tmpdir(), "deuce-record-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, body);
    const argv = [
      ...command.slice(1),
      "pr",
      "comment",
      String(prNumber),
      "--body-file",
      file,
    ];
    const r = spawnSync(command[0]!, argv, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) {
      // The spawn never happened — an uninstalled or renamed poster. Still a
      // post failure, so it takes the same path rather than a second shape.
      throw new PostFailure(prNumber, label, body, r.error.message);
    }
    if (r.status !== 0) {
      const detail =
        `${(r.stderr ?? "").trim()} ${(r.stdout ?? "").trim()}`.trim() ||
        `poster exited ${r.status}`;
      throw new PostFailure(prNumber, label, body, detail.slice(0, 2_000));
    }
    posted = r.stdout ?? "";
  } catch (err) {
    if (err instanceof PostFailure) throw err;
    throw new PostFailure(
      prNumber,
      label,
      body,
      (err instanceof Error ? err.message : String(err)).slice(0, 2_000),
    );
  } finally {
    // An exception thrown from `finally` supersedes the one in flight, so a
    // failing cleanup would replace the PostFailure and lose the record. Nothing
    // may escape here. A leaked directory under the OS temp directory carries no
    // record and no consequence; the lost record is the whole defect. The notice
    // is deliberately omitted rather than guarded twice — writing it could throw
    // in turn, which is the same masking hazard wearing a helpful face.
    // Raised as must-fix by the contractor review of e595042 on PR #46.
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Intentionally swallowed; see above.
      }
    }
  }
  // The streams are captured so a failure's detail can go inside the report
  // instead of scattering to the terminal — but a successful post has always
  // printed the comment's URL, and callers read it, so it is written through.
  // Written after the catch: a broken stdout pipe must not turn a post that
  // succeeded into a report saying it failed.
  if (posted) process.stdout.write(posted);
}
