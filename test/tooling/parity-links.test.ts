import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RepositoryReadError, linkCheckedFiles, main, markdownLinks, runParityCheck } from "../../scripts/parity-check.js";
import { REPO_ROOT, healDeadLinks, withBundleCopy } from "./parity-fixture.js";

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
    ["an ADR", "docs/adr/0011-ascii-safe-stdout-stays-doc-only.md"],
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

// Issue #164. `docs/adr/*.md` was the last markdown surface outside the dead-link scope — 47 files of
// accepted decisions citing each other, with nothing resolving those citations, and two of them dead.
// The repair rule is ADR 0057 (repair a rename, de-link a deletion); these tests are about the scope.
describe("parity check - docs/adr joins the derived scope (issue #164)", () => {
  const ADR_DIR = "docs/adr";

  /** Every `*.md` regular file the checker should be deriving from a real `docs/adr` on disk. */
  const adrFilesOn = (root: string): string[] =>
    readdirSync(join(root, ADR_DIR))
      .sort()
      .filter((name) => name.endsWith(".md") && statSync(join(root, ADR_DIR, name)).isFile())
      .map((name) => `${ADR_DIR}/${name}`);

  // THE test for the widening, and the one a hand-kept list cannot pass. A complete hardcoded roster of
  // today's ADRs satisfies the set comparison below it — but this file did not exist when any list was
  // written, so only a derivation from disk finds it.
  it("discovers an ADR that did not exist when the scope was written", () => {
    withBundleCopy((root) => {
      const rel = `${ADR_DIR}/9999-derivation-probe-164.md`;
      writeFileSync(join(root, rel), `# ADR 9999 - probe\n\n[gone](${ABSENT})\n`);

      expect(runParityCheck(root).errors.filter((e) => DEAD_LINK.test(e)))
        .toEqual([`Dead link in ${rel}: \`${ABSENT}\` does not resolve`]);
    });
  });

  it("covers every ADR currently on disk", () => {
    const derived = linkCheckedFiles(REPO_ROOT).filter((rel) => rel.startsWith(`${ADR_DIR}/`));
    expect(derived).toEqual(adrFilesOn(REPO_ROOT));
    expect(derived.length).toBeGreaterThan(40); // the surface this issue was about, not a sample of it
  });

  // Both call sites of the shared `markdownFilesIn` helper: a DIRECTORY whose name ends in `.md` passes a
  // name-only filter. `checkLinks` would merely skip it, so this bug is invisible from the checker's own
  // output — but `healDeadLinks` guards with existsSync (true for a directory) and then readFileSync's
  // it, which is EISDIR and takes down every bundle-copy test in this file.
  it.each([[ADR_DIR], [".claude/commands"]])("excludes a directory named like a markdown file in %s", (dir) => {
    withBundleCopy((root) => {
      mkdirSync(join(root, dir, "nested.md"), { recursive: true });

      expect(linkCheckedFiles(root)).not.toContain(`${dir}/nested.md`);
      expect(() => runParityCheck(root)).not.toThrow();
    });
  });

  it("excludes a non-markdown file", () => {
    withBundleCopy((root) => {
      writeFileSync(join(root, ADR_DIR, "notes.txt"), "not markdown\n");
      expect(linkCheckedFiles(root)).not.toContain(`${ADR_DIR}/notes.txt`);
    });
  });

  // Absent is a FACT about a bundle that ships a subset, so it fails soft...
  it("fails soft when docs/adr is absent, keeping the rest of the scope", () => {
    withBundleCopy((root) => {
      rmSync(join(root, ADR_DIR), { recursive: true, force: true });

      const files = linkCheckedFiles(root);
      expect(files.filter((rel) => rel.startsWith(`${ADR_DIR}/`))).toEqual([]);
      expect(files).toContain("rules/testing.md");
    });
  });

  it("contributes nothing, and does not throw, for an empty docs/adr", () => {
    withBundleCopy((root) => {
      rmSync(join(root, ADR_DIR), { recursive: true, force: true });
      mkdirSync(join(root, ADR_DIR), { recursive: true });

      expect(linkCheckedFiles(root).filter((rel) => rel.startsWith(`${ADR_DIR}/`))).toEqual([]);
    });
  });

  // ...but UNREADABLE is a malformed bundle, and returning "no ADRs" for it is the false green
  // rules/scripting.md forbids: the gate would print OK while checking none of them. A path that is a
  // regular file raises ENOTDIR portably, with none of the chmod games that behave differently as root.
  it("raises a typed read failure rather than silently emptying the scope", () => {
    withBundleCopy((root) => {
      rmSync(join(root, ADR_DIR), { recursive: true, force: true });
      writeFileSync(join(root, ADR_DIR), "a file where a directory belongs\n");

      // The TYPE is the contract, not just the fact of throwing: `main` discriminates on it to decide
      // what is a read failure and what is a bug it must not relabel.
      expect(() => linkCheckedFiles(root)).toThrow(RepositoryReadError);
      try {
        linkCheckedFiles(root);
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryReadError);
        expect((error as RepositoryReadError).code).toBe("ENOTDIR");
        expect((error as RepositoryReadError).path).toContain(ADR_DIR);
      }
    });
  });

  // The same rule per file. A child that VANISHED between the read and the stat is absent, so it is
  // skipped; an unreadable one must not be quietly demoted to "not a markdown file", which would
  // re-open the false green one level down from where it was closed.
  it("skips a child that vanished, but raises on one that cannot be statted", () => {
    withBundleCopy((root) => {
      symlinkSync(join(root, ADR_DIR, "no-such-target.md"), join(root, ADR_DIR, "dangling.md"));
      expect(linkCheckedFiles(root)).not.toContain(`${ADR_DIR}/dangling.md`);

      symlinkSync(join(root, ADR_DIR, "loop-b.md"), join(root, ADR_DIR, "loop-a.md"));
      symlinkSync(join(root, ADR_DIR, "loop-a.md"), join(root, ADR_DIR, "loop-b.md"));
      expect(() => linkCheckedFiles(root)).toThrow(RepositoryReadError);
    });
  });

  // ...and being loud must not mean being unreadable. Left unguarded, that throw escapes `main` as a
  // stack trace, which is not the deterministic, greppable output rules/scripting.md requires of a
  // bundled script — the exit code is right and the line a Host App greps for is gone.
  it("reports an unreadable repository in the CLI's own failure grammar, not as a stack trace", () => {
    withBundleCopy((root) => {
      rmSync(join(root, ADR_DIR), { recursive: true, force: true });
      writeFileSync(join(root, ADR_DIR), "a file where a directory belongs\n");

      const stderr: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });

      try {
        expect(main(["--root", root])).toBe(1);
      } finally {
        spy.mockRestore();
      }

      expect(stderr.join("")).toMatch(/^parity_check: FAILED - cannot read .*docs\/adr - .*ENOTDIR/);
    });
  });

  // The other half of that guard, and the reason it catches ONE error type instead of all of them: a
  // catch-all would relabel a genuine internal bug as a repository-read failure and swallow the stack
  // trace pointing at it. A false diagnosis is worse than a crash — the log now names the wrong cause.
  it("lets a non-read error crash with its stack trace instead of relabelling it", () => {
    const boom = new TypeError("an internal bug, not a read failure");
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    try {
      expect(() => main(["--root", REPO_ROOT], () => { throw boom; })).toThrow(boom);
    } finally {
      spy.mockRestore();
    }

    expect(stderr.join("")).toBe("");
  });
});

describe("parity check - ADR citation numbers", () => {
  // The 0040 repair repointed a citation at a renamed file; its `ADR 0029` label must still match the
  // number in the new filename. Asserted against the REAL tree, so a future repair that repoints at the
  // wrong ADR is caught here rather than by a reader.
  it("reports no citation mismatch anywhere in the real repository", () => {
    expect(runParityCheck(REPO_ROOT).errors.filter((e) => ADR_MISMATCH.test(e))).toEqual([]);
  });

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
