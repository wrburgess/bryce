import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import {
  linkCheckedFiles,
  markdownLinks,
  resolveInsideRoot,
  runParityCheck,
} from "../../scripts/parity-check.js";
import { REPO_ROOT, copyBundle, healDeadLinks, withBundleCopy } from "./parity-fixture.js";

// Issue #159. `rules/*.md` carried markdown links its whole life and none of them were ever resolved:
// the files sat outside `checkLinks`' scope because ONE of their lines — rules/security.md's
// `![x](url)`, written while teaching output escaping — is prose ABOUT markdown inside a code span, and
// a regex could not tell that from a link. So the fix has two halves: recognize what a link actually is,
// then widen the scope.
//
// The first half is now a PARSER rather than a hand-rolled masker, and the reason is the whole story of
// PR #162: five independent review rounds each found a silent FALSE GREEN in that masker — a link the
// CommonMark reference parser renders live that the masker hid — and two of the five were introduced
// while fixing the round before. Every repro from those rounds is kept below, asserted against the
// parser, so the migration is provably not a regression on any of them.

const DEAD_LINK = /^Dead link /;
const ADR_MISMATCH = /^ADR link number mismatch /;
const ABSENT = "./no-such-target-159.md";

/** Every destination the checker would consider, for a source string. */
const destinations = (source: string): string[] => markdownLinks(source).map((l) => l.destination);

/** A throwaway directory for a test that needs real paths to reason about, always removed. */
function withScratch(fn: (scratch: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "parity-scratch-165-"));
  try {
    fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Replace `rel` in a copied bundle with a synthetic body, then return only its dead-link errors. */
function withMarkdownFile(rel: string, body: string, assert: (errors: string[]) => void): void {
  withBundleCopy((root) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
    assert(runParityCheck(root).errors.filter((e) => DEAD_LINK.test(e)));
  });
}

describe("markdownLinks - what counts as a link", () => {
  it("reports an ordinary inline link with its label and destination", () => {
    expect(markdownLinks("see [the doc](../docs/x.md) now")).toEqual([
      { label: "the doc", destination: "../docs/x.md" },
    ]);
  });

  it("flattens a code span inside a label, the repo's most common link shape", () => {
    expect(markdownLinks("see [`PROJECT.md`](../../PROJECT.md)")).toEqual([
      { label: "PROJECT.md", destination: "../../PROJECT.md" },
    ]);
  });

  it("reports images too, so an href that rots is caught either way", () => {
    expect(markdownLinks("![diagram](assets/d.png)")).toEqual([
      { label: "diagram", destination: "assets/d.png" },
    ]);
  });

  // New coverage the parser brings: a regex never resolved these at all.
  it("resolves a reference link through its definition", () => {
    expect(destinations("see [the doc][ref]\n\n[ref]: ../docs/x.md\n")).toEqual(["../docs/x.md"]);
  });

  // The `MARKDOWN_LINK` regex captured everything to the closing paren, so a title became part of the
  // path and the link could never resolve. That documented limitation is gone.
  it("separates a link TITLE from the destination", () => {
    expect(destinations('[text](path.md "a title")')).toEqual(["path.md"]);
  });

  it("handles an angle-bracket destination", () => {
    expect(destinations("[text](<a path.md>)")).toEqual(["a path.md"]);
  });

  // PR #162 delta round 6, High. A line break inside a label is its own node carrying no literal, so
  // dropping it concatenates the runs either side — `[ADR\n0007](…)` flattens to `ADR0007`, which
  // `ADR_LINK_LABEL` does not match, so the ADR-number check silently decides this is not a citation.
  // A formatter or a hand wrap is all it takes.
  it("preserves the word boundary at a soft line break in a label", () => {
    expect(markdownLinks("[ADR\n0007](0007-x.md)")).toEqual([
      { label: "ADR 0007", destination: "0007-x.md" },
    ]);
  });

  it("preserves the word boundary at a hard line break in a label", () => {
    expect(markdownLinks("[ADR\\\n0007](0007-x.md)")).toEqual([
      { label: "ADR 0007", destination: "0007-x.md" },
    ]);
  });

  // PR #162 delta round 7, Medium: `html_inline` is the third node type that carries an effect and no
  // literal, so it glues label fragments together exactly as an unhandled line break did.
  it("preserves the word boundary at an inline HTML comment in a label", () => {
    expect(markdownLinks("[ADR<!-- c -->0007](0007-x.md)")).toEqual([
      { label: "ADR 0007", destination: "0007-x.md" },
    ]);
  });

  // The other half of the same fix, and the reason it is a normalization rather than one more branch:
  // an inline comment renders to NOTHING, so emitting a space for it would add a trailing one here and
  // stop this label matching — swapping round 6's false green for a new one.
  it("does not let a trailing inline comment push a label out of the citation grammar", () => {
    expect(markdownLinks("[ADR 0007<!-- note -->](0008-x.md)")).toEqual([
      { label: "ADR 0007", destination: "0008-x.md" },
    ]);
  });

  it("collapses a doubled space inside a label", () => {
    expect(markdownLinks("[ADR  0007](0007-x.md)")).toEqual([
      { label: "ADR 0007", destination: "0007-x.md" },
    ]);
  });
});

describe("markdownLinks - a link inside code is not a link", () => {
  // The motivating case, and the reason rules/*.md could not simply be added to the checked list.
  it("ignores a link inside an inline code span", () => {
    expect(markdownLinks("- **Never x** — `![x](url)` auto-loads a remote resource.")).toEqual([]);
  });

  it("ignores links inside a fenced block but not after it", () => {
    expect(destinations("```markdown\n[shown](a.md)\n```\n\n[real](b.md)\n")).toEqual(["b.md"]);
  });

  it("ignores a link inside a tilde fence, and one with an info string", () => {
    expect(destinations("~~~\n[a](a.md)\n~~~\n")).toEqual([]);
    expect(destinations("```ts\n[a](a.md)\n```\n")).toEqual([]);
  });

  it("ignores a link inside a 4-space indented code block", () => {
    expect(destinations("prose\n\n    [x](a.md)\n")).toEqual([]);
  });

  it("still sees a span that opens and closes on a bullet line, and the link beside it", () => {
    expect(destinations("- **Rule** — `![x](url)` escapes it. See [ok](AGENTS.md)."))
      .toEqual(["AGENTS.md"]);
  });
});

// Every input that a review round of PR #162 proved the hand-rolled masker got WRONG. Each one hid a
// link the CommonMark reference parser renders live — a silent false green. They are kept as the
// migration's regression suite: the parser is only worth its dependency if it gets all of them right.
describe("markdownLinks - the five rounds of masker defects", () => {
  it("round 1: an unclosed fence in a blockquote does not swallow the paragraph after it", () => {
    expect(destinations("> ```\n> code inside quote\n\nReal paragraph: [x](dead.md)\n"))
      .toContain("dead.md");
  });

  it("round 1: an unclosed fence in a list item does not swallow the paragraph after it", () => {
    expect(destinations("- item\n  ```\n  code\n\nNext paragraph: [x](dead.md)\n")).toContain("dead.md");
  });

  it("round 1: an indented fence-look line inside a paragraph is a lazy continuation, not a fence", () => {
    expect(destinations("Some paragraph text here\n    ```\nMore text [x](dead.md)\n")).toContain("dead.md");
  });

  it("round 2: a declined fence delimiter does not pair as an inline span", () => {
    expect(destinations("```js `x`\n[y](dead.md)\n```\nafter [z](dead2.md)\n")).toContain("dead.md");
  });

  it("round 3: an inline span does not skip fence-delimiter lines to a farther partner", () => {
    const found = destinations(
      "abc ``` def [l0](dead0.md)\n```js `x`\nghi [l1](dead.md) jkl\n```js\nmno [l2](dead2.md) pqr\nstu ``` vwx\n",
    );
    expect(found).toContain("dead.md");
  });

  it("round 4: an inline span does not pair across a thematic break or a list item", () => {
    expect(destinations("abc ``` def [L8](t.md)\nstu ~~~ vwx [L6](u.md)\n- ```\n"))
      .toEqual(expect.arrayContaining(["t.md", "u.md"]));
    expect(destinations("abc ``` def [L0](t.md)\n***\nmid [L1](mid.md) prose\nstu ``` vwx [L2](u.md)\n"))
      .toContain("mid.md");
  });

  it("round 4: an inline span does not pair across an ATX heading", () => {
    expect(destinations("abc ``` def [L0](t.md)\n# Heading\nstu ``` vwx [L1](u.md)\n"))
      .toEqual(expect.arrayContaining(["t.md", "u.md"]));
  });

  it("round 5: a deeper-nested delimiter does not close a fence opened at top level", () => {
    expect(destinations("```\n\n> ```\n> inside\n\nParagraph: [x](dead.md)\n\n````\n[y](live.md)\n`````\n"))
      .toContain("live.md");
  });

  // The one the line-bounded masker could not do at all: a span whose backticks are on different lines.
  // Both files below really contain one, which is why the masker mis-masked prose in them.
  it("round 5: a MULTI-LINE inline code span is recognized, and the prose after it is not masked", () => {
    const source = 'a `{ "summary": {\n  total } }`. Then on `status` — see [ok](AGENTS.md).\n';
    expect(destinations(source)).toEqual(["AGENTS.md"]);
  });
});

describe("parity check - dead links in the widened scope", () => {
  // The issue's exact case. Without treating the code span as code, this file yields TWO errors.
  it("reports the real dead link and NOT the code-span one in the same file", () => {
    const body = [
      "# Testing Rules",
      "",
      "- **Never x** — `![x](nowhere-159.md)` auto-loads a remote resource.",
      `- **Never y** — see [gone](${ABSENT}).`,
      "",
      "## Patterns",
      "",
      "- x",
      "",
      "## Anti-Patterns",
      "",
      "- y",
      "",
    ].join("\n");

    withMarkdownFile("rules/testing.md", body, (errors) => {
      expect(errors).toEqual([`Dead link in rules/testing.md: \`${ABSENT}\` does not resolve`]);
    });
  });

  // Run against the REAL repository, not a healed copy: `withBundleCopy` stubs dead links into
  // existence, which would make this assertion unable to fail.
  it("reports no dead link anywhere in the real repository", () => {
    expect(runParityCheck(REPO_ROOT).errors.filter((e) => DEAD_LINK.test(e))).toEqual([]);
  });

  it("ignores a dead link inside a fenced block but reports one after the fence closes", () => {
    const body = ["# Context", "", "```markdown", `[shown](${ABSENT})`, "```", "", `[real](${ABSENT})`, ""].join("\n");

    withMarkdownFile("CONTEXT.md", body, (errors) => {
      expect(errors).toEqual([`Dead link in CONTEXT.md: \`${ABSENT}\` does not resolve`]);
    });
  });

  it("never reports a link that resolves", () => {
    withMarkdownFile("CONTEXT.md", "# Context\n\n[canonical](AGENTS.md) and [rules](rules/testing.md)\n", (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // ADRs are the most fence-dense documents in the tree, so the widened scope leans hard on the parser
  // here. Over-masking would silently un-check all 47 of them while the gate still printed OK.
  it("ignores a dead link inside a fence in an ADR but reports one after it closes", () => {
    const body = [
      "# ADR 0001",
      "",
      "```markdown",
      `[illustrative](${ABSENT})`,
      "```",
      "",
      `And a real one: [gone](${ABSENT}).`,
      "",
    ].join("\n");

    withMarkdownFile("docs/adr/0001-distribute-as-copy-in-sync-script.md", body, (errors) => {
      expect(errors).toEqual([`Dead link in docs/adr/0001-distribute-as-copy-in-sync-script.md: \`${ABSENT}\` does not resolve`]);
    });
  });

  // The exact shape of the ADR 0011 bug this issue repaired: docs/adr/ is TWO levels down, so a link is
  // written `../../scripts/x`. Resolving from the repo root instead of the file's own directory would
  // make both of these agree with the filesystem by accident, and the bug would stay invisible.
  it("resolves an ADR's relative-traversal link from the ADR's own directory", () => {
    const body = [
      "# ADR 0001",
      "",
      "Live: [`scripts/protected-branches.ts`](../../scripts/protected-branches.ts).",
      "",
      "Dead: [gone](../../scripts/no-such-script-163.ts).",
      "",
    ].join("\n");

    withMarkdownFile("docs/adr/0001-distribute-as-copy-in-sync-script.md", body, (errors) => {
      expect(errors).toEqual([
        "Dead link in docs/adr/0001-distribute-as-copy-in-sync-script.md: `../../scripts/no-such-script-163.ts` does not resolve",
      ]);
    });
  });
});

describe("parity check - the checked file set", () => {
  it("derives every Tier-1 rule, skill body, and command shim", () => {
    const files = linkCheckedFiles(REPO_ROOT);

    for (const rel of ["rules/backend.md", "rules/frontend.md", "rules/testing.md", "rules/security.md",
      "rules/self-review.md", "rules/scripting.md", "rules/skills.md"]) {
      expect(files).toContain(rel);
    }
    for (const name of ["distill", "assess", "devise", "invoke", "verify", "listen", "final", "ship", "create-skill"]) {
      expect(files).toContain(`skills/${name}/SKILL.md`);
      expect(files).toContain(`.claude/commands/${name}.md`);
    }
    expect(files).toContain("docs/rules/README.md");
    expect(files).toContain("CONTEXT.md");
  });

  // Issue #163. Compared against a fresh listing rather than a sample: spot-checking one ADR passes just
  // as happily against a derivation that truncated, sorted wrong, or dropped every file but the first.
  it("derives every top-level ADR", () => {
    const onDisk = readdirSync(join(REPO_ROOT, "docs/adr"))
      .filter((n) => n.endsWith(".md"))
      .map((n) => `docs/adr/${n}`)
      .sort();
    const derived = linkCheckedFiles(REPO_ROOT).filter((f) => f.startsWith("docs/adr/")).sort();

    expect(onDisk.length).toBeGreaterThan(40); // the listing itself must not be silently empty
    expect(derived).toEqual(onDisk);
  });

  // The scope is top-level BY DECISION, matching checkAdrNumbers, which reads the same directory
  // non-recursively and is what defines an ADR here. Pinned so that widening it is a deliberate act
  // rather than something that drifts in the first time somebody adds a subdirectory.
  it("does not descend into a subdirectory of docs/adr", () => {
    withBundleCopy((root) => {
      const nested = join(root, "docs/adr/archive/0056-nested.md");
      mkdirSync(dirname(nested), { recursive: true });
      writeFileSync(nested, "# ADR 0056\n\n[gone](./nowhere-163.md)\n");

      expect(linkCheckedFiles(root)).not.toContain("docs/adr/archive/0056-nested.md");
      expect(runParityCheck(root).errors.filter((e) => DEAD_LINK.test(e))).toEqual([]);
    });
  });

  it("contains no duplicate entries", () => {
    const files = linkCheckedFiles(REPO_ROOT);
    expect(new Set(files).size).toBe(files.length);
  });

  // Membership in a list proves nothing: a wrong join for a skill body or a wrong base directory for a
  // shim would satisfy the case above and still check nothing. Each category has to REDDEN on a real
  // dead link, so run one representative of each through it.
  it.each([
    ["a Tier-1 rule", "rules/testing.md"],
    ["a skill body", "skills/assess/SKILL.md"],
    ["a command shim", ".claude/commands/assess.md"],
    ["the deep-doc README", "docs/rules/README.md"],
    ["the glossary", "CONTEXT.md"],
    ["an ADR", "docs/adr/0001-distribute-as-copy-in-sync-script.md"],
  ])("resolves links in %s", (_label, rel) => {
    withMarkdownFile(rel, `# probe\n\n[gone](${ABSENT})\n`, (errors) => {
      expect(errors).toEqual([`Dead link in ${rel}: \`${ABSENT}\` does not resolve`]);
    });
  });

  // The render marker is an Adapter concern and deliberately did NOT follow the link scope when the two
  // lists split. A skill body is link-checked; it must not be scanned for a `parity:render` block.
  it("does not scan the widened set for rendered regions", () => {
    withBundleCopy((root) => {
      writeFileSync(
        join(root, "skills/assess/SKILL.md"),
        "---\nname: assess\n---\n\n<!-- parity:render source=AGENTS.md -->\nnot the canonical text\n<!-- parity:endrender -->\n",
      );
      expect(runParityCheck(root).errors.filter((e) => /Rendered region/.test(e))).toEqual([]);
    });
  });
});

describe("parity check - ADR citation numbers", () => {
  it("still reports a label/target mismatch in ordinary prose", () => {
    withBundleCopy((root) => {
      writeFileSync(join(root, "docs/adr-number-probe.md"), "See [ADR 0001](0002-some-decision.md).\n");
      expect(runParityCheck(root).errors.filter((e) => ADR_MISMATCH.test(e)))
        .toEqual(["ADR link number mismatch in docs/adr-number-probe.md: label ADR 0001 targets ADR 0002"]);
    });
  });

  it("ignores the same mismatch inside a code span", () => {
    withBundleCopy((root) => {
      writeFileSync(join(root, "docs/adr-number-probe.md"), "Write it as `[ADR 0001](0002-some-decision.md)`.\n");
      expect(runParityCheck(root).errors.filter((e) => ADR_MISMATCH.test(e))).toEqual([]);
    });
  });

  // The label is the RENDERED text, so a backticked citation is the same citation.
  it("reads a label through a code span", () => {
    withBundleCopy((root) => {
      writeFileSync(join(root, "docs/adr-number-probe.md"), "See [`ADR 0001`](0002-some-decision.md).\n");
      expect(runParityCheck(root).errors.filter((e) => ADR_MISMATCH.test(e)))
        .toEqual(["ADR link number mismatch in docs/adr-number-probe.md: label ADR 0001 targets ADR 0002"]);
    });
  });

  // End-to-end for the round-6 High: a wrapped label is still a citation, so the mismatch is still
  // reported. Without the break handling this reports nothing at all — silently.
  it("still catches a mismatch when the label wraps across a line", () => {
    withBundleCopy((root) => {
      writeFileSync(join(root, "docs/adr-number-probe.md"), "See [ADR\n0001](0002-some-decision.md).\n");
      expect(runParityCheck(root).errors.filter((e) => ADR_MISMATCH.test(e)))
        .toEqual(["ADR link number mismatch in docs/adr-number-probe.md: label ADR 0001 targets ADR 0002"]);
    });
  });
});

describe("parity fixture - healDeadLinks shares the checker's link extraction", () => {
  // `healDeadLinks` stubs a file into existence for every dead link it finds, so scanning with a regex
  // of its own over the widened scope makes it stub the pseudo-links in prose that TEACHES markdown:
  // `rules/url`, `docs/rules/path`, a literal `docs/rules/MMMM-...md`, and two nonsense nested
  // directories. Nothing about the checker's OUTPUT can see that — it ignores them either way — which is
  // exactly why this needs its own assertion.
  it("creates no stub for a pseudo-link that lives inside a code span", () => {
    withBundleCopy((root) => {
      for (const junk of [
        "rules/url",
        "docs/rules/path",
        "docs/rules/MMMM-...md",
        "docs/docs/rules/x-postmortems.md",
        "docs/rules/docs/rules/x-postmortems.md",
      ]) {
        expect(existsSync(join(root, junk)), `healDeadLinks stubbed ${junk}`).toBe(false);
      }
    });
  });

  // Issue #163, and the reason the ADR containment rule exists at all. Healing a dead ADR link stubs
  // `0029-<something>.md` into docs/adr/, which collides with the REAL ADR 0029 — so the run reports
  // "Duplicate ADR number" for a file nobody wrote, and the dead link that caused it disappears from the
  // output. Probed before the fix: the dead-link error was gone and that was the only error left.
  //
  // Both halves are asserted. Checking only "no stub" would still pass if the resulting error were
  // useless; checking only the error would pass against a healer that stubbed somewhere else.
  it("does not heal a dead ADR link into a duplicate ADR number", () => {
    withBundleCopy((root) => {
      const stub = join(root, "docs/adr/0029-per-game-stat-line-identity.md");
      writeFileSync(
        join(root, "docs/adr/0040-exclude-in-progress-games-from-ingestion.md"),
        "# ADR 0040\n\nUpserts on the [ADR 0029](0029-per-game-stat-line-identity.md) per-game key.\n",
      );

      healDeadLinks(root);
      expect(existsSync(stub), "healDeadLinks manufactured an ADR record file").toBe(false);

      const errors = runParityCheck(root).errors;
      expect(errors).toContain(
        "Dead link in docs/adr/0040-exclude-in-progress-games-from-ingestion.md: " +
        "`0029-per-game-stat-line-identity.md` does not resolve",
      );
      expect(errors.filter((e) => /^Duplicate ADR number /.test(e))).toEqual([]);
    });
  });

  // The case the rejected rule would have missed. An earlier draft skipped only targets matching the ADR
  // FILENAME pattern, which stubs this one: a traversal spelling, no `NNNN-` prefix, not even `.md`. The
  // shipped rule tests the RESOLVED path against the directory, so every equivalent spelling lands in it.
  it("creates no stub under docs/adr for a traversal, non-ADR-shaped target", () => {
    withBundleCopy((root) => {
      writeFileSync(
        join(root, "docs/adr/0001-distribute-as-copy-in-sync-script.md"),
        "# ADR 0001\n\nSee [note](../adr/no-such-note-163.txt) and [sub](./nested/deep-163.md).\n",
      );

      healDeadLinks(root);

      expect(existsSync(join(root, "docs/adr/no-such-note-163.txt"))).toBe(false);
      expect(existsSync(join(root, "docs/adr/nested/deep-163.md"))).toBe(false);
      expect(existsSync(join(root, "docs/adr/nested"))).toBe(false);
    });
  });

  // Issue #163, found by the independent Stage-4 Reviewer and reproduced before fixing. `resolve()` is
  // string arithmetic and never touches the filesystem, so on a case-INSENSITIVE volume (APFS, NTFS) a
  // link spelled `../ADR/…` resolved to a path that failed an exact prefix test while `writeFileSync`
  // still landed the stub in the same physical `docs/adr/`. Confirmed end to end: the stub appeared, the
  // "Duplicate ADR number 0029" error came back, and the dead-link error disappeared -- the exact defect
  // this guard exists to close, on the platform the repo is developed on.
  //
  // Asserted on BOTH spellings deliberately, so the case is not a no-op on either kind of filesystem:
  // on a case-insensitive volume the two paths are one file and the lower-case assertion catches it; on a
  // case-sensitive volume the unfixed healer creates a genuinely separate `docs/ADR/`, which the
  // upper-case assertion catches. Neither platform gets a silently vacuous test.
  it("creates no stub for a differently-cased spelling of docs/adr", () => {
    withBundleCopy((root) => {
      writeFileSync(
        join(root, "docs/adr/0040-exclude-in-progress-games-from-ingestion.md"),
        "# ADR 0040\n\nUpserts on the [ADR 0029](../ADR/0029-per-game-stat-line-identity.md) key.\n",
      );

      healDeadLinks(root);

      expect(existsSync(join(root, "docs/adr/0029-per-game-stat-line-identity.md"))).toBe(false);
      expect(existsSync(join(root, "docs/ADR/0029-per-game-stat-line-identity.md"))).toBe(false);
      expect(runParityCheck(root).errors.filter((e) => /^Duplicate ADR number /.test(e))).toEqual([]);
    });
  });

  // A whole-directory comparison rather than a named-stub check: any pollution at all, from any future
  // link shape, shows up here without somebody having predicted its name.
  it("leaves docs/adr byte-for-byte identical to the real repository's listing", () => {
    withBundleCopy((root) => {
      expect(readdirSync(join(root, "docs/adr")).sort()).toEqual(readdirSync(join(REPO_ROOT, "docs/adr")).sort());
    });
  });

  // Issue #165, and the reason this test builds its own harness instead of using `withBundleCopy`:
  // the healer WRITES, so if containment regressed, the file it must not create lands OUTSIDE the
  // bundle root that `withBundleCopy` cleans up — the test for the leak would itself leak. So the
  // bundle is nested inside a scratch parent, and the parent is what gets removed.
  it("creates no stub for a link that climbs out of the copy", () => {
    withScratch((scratch) => {
      const root = join(scratch, "bundle");
      mkdirSync(root, { recursive: true });
      copyBundle(REPO_ROOT, root);

      const escaped = join(scratch, "escaped-heal-165.md");
      writeFileSync(join(root, "CONTEXT.md"), "# Context\n\n[out](../escaped-heal-165.md)\n");
      expect(existsSync(escaped)).toBe(false);

      healDeadLinks(root);

      expect(existsSync(escaped), "healDeadLinks wrote outside its root").toBe(false);
    });
  });

  it("still heals a genuine dead link that is not inside code", () => {
    withBundleCopy((root) => {
      const probe = join(root, "docs/heal-probe-target-159.md");
      writeFileSync(
        join(root, "CONTEXT.md"),
        "# Context\n\n[later](docs/heal-probe-target-159.md) and `[example](docs/heal-probe-span-159.md)`\n",
      );
      expect(existsSync(probe)).toBe(false);

      healDeadLinks(root);

      expect(existsSync(probe)).toBe(true);
      expect(existsSync(join(root, "docs/heal-probe-span-159.md"))).toBe(false);
    });
  });
});

// Issue #165. `resolvesFrom` rejected an href that escapes the repository and `checkLinks` did not, so
// a link written `../../../etc/passwd` was reported GREEN whenever that path happened to exist on the
// runner. The rule was authored three times across the tree and enforced twice; it is now authored once
// here and shared, so these are the first direct tests it has ever had.
//
// Every path is CONSTRUCTED from a scratch directory rather than written as a literal, because the
// behavior under test IS path shape (rules/testing.md: construct the environment a test claims to
// cover) — a hardcoded `/x/repo` asserts nothing on a runner whose paths do not look like that.
describe("resolveInsideRoot - the containment rule, once", () => {
  it("returns the resolved path for an ordinary intra-repo href", () => {
    withScratch((scratch) => {
      expect(resolveInsideRoot(scratch, join(scratch, "skills"), "../PROJECT.md"))
        .toBe(join(scratch, "PROJECT.md"));
    });
  });

  // The boundary: `..` from an immediate child lands ON the root, which is inside it. A guard written
  // as `startsWith(base + sep)` alone rejects exactly this, so the `resolved !== base` half is what
  // this case pins -- and nothing else does.
  it("accepts an href that resolves to the root itself", () => {
    withScratch((scratch) => {
      expect(resolveInsideRoot(scratch, join(scratch, "skills"), "..")).toBe(scratch);
    });
  });

  it("rejects a relative href that climbs past the root", () => {
    withScratch((scratch) => {
      expect(resolveInsideRoot(scratch, join(scratch, "skills"), "../../outside.md")).toBeNull();
    });
  });

  // A root-absolute link (`/docs/x.md`) resolves against the filesystem root, not the repo root, so it
  // is broken on the lifecycle host however the runner's disk looks. Built from `parse().root` so the
  // case means the same thing on a drive-lettered filesystem.
  it("rejects a root-absolute href", () => {
    withScratch((scratch) => {
      const filesystemRoot = parse(scratch).root;
      expect(resolveInsideRoot(scratch, scratch, join(filesystemRoot, "etc", "passwd"))).toBeNull();
    });
  });

  // The near miss the `+ sep` exists for: `<root>-old` shares every character of `<root>` as a prefix
  // and is a different tree. Drop the separator and this reads as contained -- a guard loosened just
  // enough to print a false green (rules/scripting.md).
  it("rejects a sibling directory that merely shares the root's name prefix", () => {
    withScratch((scratch) => {
      const root = join(scratch, "repo");
      expect(resolveInsideRoot(root, root, "../repo-old/README.md")).toBeNull();
    });
  });

  // The contract says the helper normalizes `root` itself rather than requiring an absolute one. Without
  // that, `base` stays "." while `resolved` is absolute, nothing starts with "./", and every href on a
  // relative root is rejected -- a silent, total false red.
  it("normalizes a relative root rather than requiring the caller to", () => {
    expect(resolveInsideRoot(".", ".", "AGENTS.md")).toBe(resolve("AGENTS.md"));
  });
});

describe("parity check - a link that escapes the repository", () => {
  /** Run `body` as `rel` inside a bundle copy and return only its dead-link errors, with the copy root. */
  function inBundle(rel: string, body: (root: string) => string, assert: (errors: string[]) => void): void {
    withBundleCopy((root) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body(root));
      assert(runParityCheck(root).errors.filter((e) => DEAD_LINK.test(e)));
    });
  }

  /** A relative href from `fromDir` to a real file that lives OUTSIDE the bundle copy. */
  const escapeToRealFile = (fromDir: string): string =>
    relative(fromDir, join(REPO_ROOT, "AGENTS.md")).split("\\").join("/");

  // THE case the issue is about, and the one that fails on main: the target genuinely exists, so
  // `statSync` succeeds and the checker reports nothing at all. On GitHub the link is a 404.
  it("reports an escaping link whose target really exists on disk", () => {
    let target = "";
    inBundle(
      "CONTEXT.md",
      (root) => {
        target = escapeToRealFile(root);
        return `# Context\n\n[canonical](<${target}>)\n`;
      },
      (errors) => {
        expect(errors).toEqual([`Dead link in CONTEXT.md: \`${target}\` escapes the repository`]);
      },
    );
  });

  // `decodeDestination` (PR #162) turns a percent-encoded traversal into a real one before resolution,
  // which reaches this same gap. The diagnostic must name the DECODED path -- the decode happens inside
  // `markdownLinks`, so `checkLinks` never sees the `%2F` spelling and must not appear to.
  it("reports the percent-encoded spelling of the same escape, decoded", () => {
    let target = "";
    inBundle(
      "CONTEXT.md",
      (root) => {
        target = escapeToRealFile(root);
        return `# Context\n\n[canonical](<${target.split("/").join("%2F")}>)\n`;
      },
      (errors) => {
        expect(errors).toEqual([`Dead link in CONTEXT.md: \`${target}\` escapes the repository`]);
        expect(errors[0]).not.toContain("%2F");
      },
    );
  });

  // Containment is decided WITHOUT consulting the disk, so the verdict may not depend on whether the
  // far end happens to be there. Same rejection, different reason from "does not resolve".
  it("reports an escaping link whose target does not exist, and says why", () => {
    inBundle(
      "CONTEXT.md",
      () => "# Context\n\n[out](../../no-such-target-165.md)\n",
      (errors) => {
        expect(errors).toEqual([
          "Dead link in CONTEXT.md: `../../no-such-target-165.md` escapes the repository",
        ]);
      },
    );
  });

  // The happy path, and the reason it is not optional: every sad case above passes under a guard that
  // rejects EVERYTHING, and `../../PROJECT.md` from a skill body is the repo's single most common link.
  // rules/scripting.md: never ship a guard without running its own governing convention through it.
  it("still accepts a legitimate ../ link inside the repository", () => {
    inBundle(
      "skills/assess/SKILL.md",
      () => "---\nname: assess\n---\n\nSee [`PROJECT.md`](../../PROJECT.md).\n",
      (errors) => {
        expect(errors).toEqual([]);
      },
    );
  });

  // `checkLinks` accepts a DIRECTORY where `resolvesFrom` requires a file, and that difference is
  // deliberate: `[Rules Layer](../../rules/)` is a valid link. Folding a stat into the shared helper
  // would break this and nothing else would notice.
  it("still accepts a link to a directory inside the repository", () => {
    inBundle(
      "skills/assess/SKILL.md",
      () => "---\nname: assess\n---\n\nSee the [Rules Layer](../../rules).\n",
      (errors) => {
        expect(errors).toEqual([]);
      },
    );
  });
});
