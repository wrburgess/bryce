// Composes a summons at dispatch time, from the canonical documents — never
// from copies. The summons carries the standards (Chapter 0, mechanism one);
// its content and bounds are Chapter 2's *The summons, completed*.

export const PERMANENT_LENS = "what class is not on this list?";

// Dispatch bound, not a posting bound: over this, the tool stops rather than
// truncates — a truncated scope is a review of something else.
export const MAX_DIFF_BYTES = 200_000;

export interface SummonsInput {
  prNumber: number;
  subject: string;
  commit: string;
  lenses: string[];
  severityFramework: string;
  acceptedEntries: string[];
  diff: string;
  reviewerName: string;
}

export function extractSeverityFramework(chapterMarkdown: string): string {
  const at = chapterMarkdown.search(/^###\s+The severity framework\s*$/m);
  if (at === -1) {
    throw new Error("chapter carries no '### The severity framework' section");
  }
  const body = chapterMarkdown.slice(at);
  const next = body.slice(4).search(/\n###?\s/);
  return next === -1 ? body : body.slice(0, next + 4);
}

export function parseAcceptedRegister(markdown: string): string[] {
  const at = markdown.search(/^##\s+Entries\s*$/m);
  if (at === -1) {
    // Fail loud, never open: an empty list from a reshaped register would tell
    // the reviewer "none accepted to date" and re-open every settled question.
    throw new Error(
      "the accepted register carries no '## Entries' section — refusing to treat a malformed register as empty",
    );
  }
  // Bounded to the Entries section — a bullet in any later section is not an
  // accepted finding, and carrying it would suppress unrelated review findings.
  const section = markdown.slice(at).split(/\n##\s/)[0]!;
  return section
    .split("\n")
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.trim());
}

export function composeSummons(input: SummonsInput): string {
  const diffBytes = Buffer.byteLength(input.diff, "utf8");
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(
      `diff is ${diffBytes} bytes, over the ${MAX_DIFF_BYTES}-byte dispatch bound — ` +
        "narrow the scope; the tool never truncates a scope silently",
    );
  }
  const lenses = [...input.lenses, `${PERMANENT_LENS} (the permanent lens)`];
  const accepted =
    input.acceptedEntries.length > 0
      ? input.acceptedEntries.join("\n")
      : "- none accepted to date";

  return `# Review summons — PR #${input.prNumber} at \`${input.commit}\`

You are summoned as a contractor reviewer: ${input.reviewerName}. Read \`AGENTS.md\` at the
repository root — you review; you never implement, commit, push, or modify a file. Your
standards are in this summons; if something you need is missing from it, say so in your
response rather than inventing a standard.

## Subject

- **Pull request:** PR #${input.prNumber} — ${input.subject}
- **Commit reviewed:** \`${input.commit}\` — bind your review to exactly this commit and name it in your output.
- **Scope:** the whole diff below. Nothing outside it is commissioned; anything you notice
  outside it, report as an observation and it will be routed, never dropped.

## Lens set

Answer every lens. A lens with no findings is answered explicitly with a line of the shape
\`- **Lens:** <the lens> — no findings\` — never silently skipped. An unanswered lens makes
the review nonconforming.

${lenses.map((l, i) => `${i + 1}. ${l}`).join("\n")}

## Severity framework — use only this vocabulary

${input.severityFramework.trim()}

## Findings already accepted — do not re-litigate

New evidence about an accepted finding is a new finding that cites the old one, never a
re-opening.

${accepted}

## Required output shape

For each finding, exactly these fields:

- **Lens:** the lens that raised it
- **Type:** defect | risk | improvement | lesson
- **Severity:** must-fix | should-fix | note
- **Location:** file and line, or section
- **Defect:** stated concretely enough to be disposed of

End your review with these two lines:

- **Commit reviewed:** \`${input.commit}\`
- **Signed:** your tool and your model, human-readable

## Diff

\`\`\`diff
${input.diff}
\`\`\`
`;
}
