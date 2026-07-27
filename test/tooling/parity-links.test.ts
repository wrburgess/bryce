import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { linkCheckedFiles, markdownLinks, runParityCheck } from "../../scripts/parity-check.js";
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
