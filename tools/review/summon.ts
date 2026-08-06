// The orchestrated path — readiness, compose, dispatch, validate, record — as
// one command, so it cannot be half-run silently. Exit codes: 0 conforming
// review recorded · 2 unreachable · 3 unresponsive · 4 nonconforming after the
// one re-summons · 5 a record could not be posted. 2, 3, 4, and 5 are stops:
// the run asks the HC and never certifies unreviewed work as reviewed.
//
// 5 supersedes 2, 3, and 4 when the post recording one of them is what failed:
// it is the code that changes what the HC must do — place a record by hand —
// and the outcome that was in flight is named in the saved record, so nothing
// is hidden by the precedence (#40).
//
// On 5, the un-posted record is written to a file and stderr carries a one-line
// pointer to it. The file is the delivery, not the printout: four reviews on
// PR #46 found four separate ways for a stream at exit time to lose the record,
// and the channel was replaced rather than patched a fifth time.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseRoster } from "./roster.ts";
import {
  composeSummons,
  extractSeverityFramework,
  parseAcceptedRegister,
  PERMANENT_LENS,
} from "./compose.ts";
import { validateReview } from "./validate.ts";
import { checkLensSelection, parseLensMenu, parseLensSetSize } from "./lenses.ts";
import { argvFromCommand, dispatch, runReadiness } from "./dispatch.ts";
import {
  formatUnpostedNotice,
  formatUnpostedRecord,
  postComment,
  PostFailure,
  saveUnpostedRecord,
} from "./record.ts";

const MAX_POSTED_CHARS = 60_000;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function elideDiffForPosting(summons: string, base: string, commit: string): string {
  if (summons.length <= MAX_POSTED_CHARS) return summons;
  return summons.replace(
    /## Diff\n[\s\S]*$/,
    `## Diff\n\nElided from this posted copy for length; the dispatched summons carried it inline, byte-identical to:\n\n\`\`\`\ngit diff ${base}...${commit}\n\`\`\`\n`,
  );
}

interface WaveResult {
  code: number;
  missing: string[];
}

function main(): void {
  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      commit: { type: "string" },
      base: { type: "string", default: "origin/main" },
      lens: { type: "string", multiple: true, default: [] },
      subject: { type: "string" },
      prose: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.pr || !values.commit) {
    console.error(
      'usage: node tools/review/summon.ts --pr <n> --commit <sha> [--base <ref>] [--lens "..."]... [--subject "..."] [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const prNumber = Number(values.pr);
  const commit = values.commit;
  const base = values.base!;

  const reviewConfig = readFileSync("config/review.md", "utf8");
  const roster = parseRoster(reviewConfig);

  // The declared bounds are enforced at dispatch, not trusted to the caller.
  const lensErrors = checkLensSelection(
    values.lens ?? [],
    parseLensMenu(reviewConfig),
    parseLensSetSize(reviewConfig),
    values.prose ?? false,
  );
  if (lensErrors.length > 0) {
    for (const e of lensErrors) console.error(e);
    process.exitCode = 1;
    return;
  }
  const severityFramework = extractSeverityFramework(
    readFileSync("sds/02-review-and-findings.md", "utf8"),
  );
  const acceptedEntries = parseAcceptedRegister(
    readFileSync("findings/accepted.md", "utf8"),
  );
  const subject =
    values.subject ??
    sh("gh", ["pr", "view", String(prNumber), "--json", "title", "-q", ".title"]).trim();
  const diff = sh("git", ["diff", `${base}...${commit}`]);

  const summonedLenses = [...(values.lens ?? []), PERMANENT_LENS];

  const summons = composeSummons({
    prNumber,
    subject,
    commit,
    lenses: values.lens ?? [],
    severityFramework,
    acceptedEntries,
    diff,
    reviewerName: roster.name,
  });

  if (values["dry-run"]) {
    process.stdout.write(summons);
    process.exitCode = 0;
    return;
  }

  // Readiness before any dispatch: a failing check is unreachable now — recorded
  // immediately, no waiting window, and the summons is never sent.
  const readiness = runReadiness(roster.readinessCommand);
  if (!readiness.ok) {
    postComment(
      prNumber,
      `## Review summons — not dispatched\n\n- **Reviewer:** ${roster.name}\n- **Readiness check:** \`${roster.readinessCommand}\` **failed** — ${readiness.detail}\n- **Outcome:** unreachable now. The summons was not dispatched and no waiting window was consumed.\n\nThis run stops here and asks the HC; it does not certify unreviewed work as reviewed.`,
      "the readiness-failure record",
    );
    console.error(`unreachable now: ${readiness.detail}`);
    process.exitCode = 2;
    return;
  }

  postComment(
    prNumber,
    `## Review summons — ${roster.name}\n\n- **Mechanism:** \`${roster.mechanismCommand}\`, sandboxed read-only\n- **Readiness check:** \`${roster.readinessCommand}\` passed\n- **Bound to commit:** \`${commit}\`\n\n---\n\n${elideDiffForPosting(summons, base, commit)}`,
    "the summons",
  );

  // Tokenized and executed without a shell — the configured command is data.
  const mechanismArgv = argvFromCommand(roster.mechanismCommand);
  const buildArgv = (outFile: string): string[] => [
    ...mechanismArgv,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    outFile,
    "-",
  ];

  function runWave(waveSummons: string, wave: string): WaveResult {
    const outcome = dispatch({
      readinessCommand: roster.readinessCommand,
      buildArgv,
      summons: waveSummons,
    });

    if (outcome.kind === "unreachable") {
      postComment(
        prNumber,
        `## Contractor review — ${wave}: reviewer unreachable\n\n- **Readiness check:** failed at dispatch — ${outcome.detail}\n- **Outcome:** unreachable now, recorded. This run stops and asks the HC.`,
        `the reviewer-unreachable record (${wave})`,
      );
      console.error(`unreachable at dispatch: ${outcome.detail}`);
      return { code: 2, missing: [] };
    }
    if (outcome.kind === "unresponsive") {
      postComment(
        prNumber,
        `## Contractor review — ${wave}: reviewer unresponsive\n\n- **Dispatched:** yes, readiness passed and the summons was sent\n- **Came back:** nothing — ${outcome.detail}\n- **Outcome:** unresponsive, recorded as a distinct outcome from unreachable. This run stops and asks the HC.`,
        `the reviewer-unresponsive record (${wave})`,
      );
      console.error(`unresponsive: ${outcome.detail}`);
      return { code: 3, missing: [] };
    }

    const validation = validateReview(outcome.output, commit, summonedLenses);
    if (validation.conforming) {
      postComment(
        prNumber,
        `## Contractor review — ${roster.name} (${wave})\n\n- **Validation on return: conforming.** Severity vocabulary, findings fields, and commit binding all check.\n\n---\n\n${outcome.output}`,
        `the conforming review (${wave})`,
      );
      console.log("conforming review recorded");
      return { code: 0, missing: [] };
    }

    postComment(
      prNumber,
      `## Contractor review — ${roster.name} (${wave}): nonconforming\n\n- **Validation on return failed.** Missing, named:\n${validation.missing.map((m) => `  - ${m}`).join("\n")}\n\n---\n\n${outcome.output}`,
      `the nonconforming review (${wave})`,
    );
    return { code: 4, missing: validation.missing };
  }

  const first = runWave(summons, "first response");
  let code = first.code;
  if (code === 4) {
    const reSummons =
      `# Re-summons — your previous response did not conform\n\n` +
      `Your previous response was validated against the contract in the summons and did not\n` +
      `conform. Missing, named:\n\n` +
      `${first.missing.map((m) => `- ${m}`).join("\n")}\n\n` +
      `Respond again, conforming, to the original summons below.\n\n---\n\n${summons}`;
    code = runWave(reSummons, "re-summons").code;
  }

  process.exitCode = code;
}

// The boundary. A failed post is caught here rather than at each post site, so
// a post site added later is covered the day it is written — the reason the
// poster throws instead of returning a result somebody can ignore (#40).
// Anything that is not a PostFailure is rethrown untouched: swallowing it here
// would recreate the unclassified crash one layer up.
//
// Nothing here — or anywhere in this file — calls process.exit(). On macOS a
// piped stdout or stderr is asynchronous, and process.exit() abandons whatever
// has not drained: measured, a payload over the 65_536-byte pipe buffer is cut
// off exactly there, which for this boundary would mean truncating the very
// record it exists to hand over. Setting exitCode and returning lets the
// streams flush first. The same hazard applied to the un-elided --dry-run
// summons, which is why every exit in this file moved, not just this one.
// Raised as must-fix by the contractor review of 123a1c3 on PR #46.
// Output errors must never become the outcome, on any path. An asynchronous
// EPIPE — a reader that went away, which `| head` does routinely — surfaces as
// an unhandled 'error' event and replaces a classified exit with a crash. No
// try/catch reaches it, because it arrives after the write returned.
//
// Installed once, here, before anything writes. Earlier these sat inside the
// failure branch, which left the *success* path — printing each comment's URL,
// with minutes between posts for a reader to disappear — with no guard at all.
// Measured: 200 short writes to a closed stdout pipe exit 1 unhandled without
// these, and 0 with them.
// Raised as must-fix by the contractor review of a161318 on PR #46.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

try {
  main();
} catch (err) {
  if (!(err instanceof PostFailure)) throw err;

  // The order below is the fix, so it is worth stating: save, then the pointer,
  // then the convenience copy, then the code. The stream guards are already on,
  // above.
  //
  // The file is the delivery. Four reviews found four different ways for a
  // stream at exit time to lose this record; a written file has none of them.
  const saved = saveUnpostedRecord(err);

  // One short line, written alone so the operating system delivers it whole.
  try {
    process.stderr.write(formatUnpostedNotice(err, saved));
  } catch {
    // Nothing further to try: the record is already on disk if it could be.
  }

  // The full record, convenience only — losing this copy costs nothing now.
  try {
    process.stderr.write(formatUnpostedRecord(err));
  } catch {
    // Ignored by design; see above.
  }

  process.exitCode = 5;
}
