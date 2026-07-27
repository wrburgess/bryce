import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { linkCheckedFiles, maskCode, runParityCheck } from "../../scripts/parity-check.js";
import { REPO_ROOT, healDeadLinks, withBundleCopy } from "./parity-fixture.js";

// Issue #159. `rules/*.md` carried markdown links its whole life and none of them were ever resolved:
// the files sat outside `checkLinks`' scope because ONE of their lines — rules/security.md's
// `![x](url)`, written while teaching output escaping — is prose ABOUT markdown inside a code span, and
// `MARKDOWN_LINK` could not tell that from a link. So the fix has two halves, and both are covered
// here: teach the scanner what code is, then widen the scope.
//
// The masking half is where the danger sits. Under-masking is a false RED: loud, cheap, and it names
// itself. Over-masking is a false GREEN: real dead links stop being reported and the gate says fine
// (rules/scripting.md — "the two errors are not symmetric"). The unit cases below spend most of their
// effort on that boundary, not on the happy path.

const DEAD_LINK = /^Dead link /;
const ADR_MISMATCH = /^ADR link number mismatch /;
const ABSENT = "./no-such-target-159.md";

/** Replace `rel` in a copied bundle with a synthetic body, then return only its dead-link errors. */
function withMarkdownFile(rel: string, body: string, assert: (errors: string[]) => void): void {
  withBundleCopy((root) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
    assert(runParityCheck(root).errors.filter((e) => DEAD_LINK.test(e)));
  });
}

describe("maskCode - the offset contract", () => {
  // Every caller matches the SAME regexes at the SAME offsets and reports the raw href a contributor
  // typed. If masking ever changed length, those reports would name the wrong text.
  it("returns a string of identical length with newline positions preserved", () => {
    const source = "intro `code [x](url)` tail\n\n```\nfenced [y](url)\n```\n\ntrailing `a`\n";
    const masked = maskCode(source);

    expect(masked).toHaveLength(source.length);
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") expect(masked[i]).toBe("\n");
    }
  });

  it("preserves length and line count over a real Tier-1 rule file", () => {
    const source = "- **Never x** — see `![x](url)` and [ADR 0011](../docs/adr/0011.md).\n";
    const masked = maskCode(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("handles empty input, backtick-free input, and a bare fence run", () => {
    expect(maskCode("")).toBe("");
    expect(maskCode("plain [x](y.md) prose")).toBe("plain [x](y.md) prose");
    // A lone ``` never closes, so it is not a fence and masks nothing — see the unclosed-fence case.
    expect(maskCode("```")).toBe("```");
  });
});

describe("maskCode - inline code spans", () => {
  it("blanks a single-backtick span and leaves the surrounding prose alone", () => {
    expect(maskCode("a `[x](url)` b")).toBe("a" + " ".repeat(12) + "b");
  });

  it("blanks a double-backtick span that contains a lone backtick", () => {
    const source = "``a ` [x](url)``";
    expect(maskCode(source)).toBe(" ".repeat(source.length));
  });

  // THE anti-false-green case. If an unmatched opener swallowed the rest of the file, one stray
  // backtick in any checked document would silently disable the dead-link check for everything after it.
  it("treats an UNMATCHED backtick run as literal text, leaving later links visible", () => {
    expect(maskCode("` [x](dead.md) and more prose")).toContain("[x](dead.md)");
  });

  it("does not let a run of 2 close a run of 1 (both stay literal)", () => {
    const source = "`[a](one.md)`` [b](two.md)";
    const masked = maskCode(source);

    expect(masked).toContain("[a](one.md)");
    expect(masked).toContain("[b](two.md)");
  });

  // CommonMark DOES allow a span to cross a line break. This deliberately does not — the line is the
  // bound that keeps a span inside its block without anyone having to enumerate what a block is (four
  // review rounds' worth of misses; ADR 0054). The cost is a genuine multi-line span going unmasked,
  // which is a false RED: loud, and absent from every checked file.
  it("does NOT let a span cross a line break", () => {
    const masked = maskCode("`[a](one.md)\n[b](two.md)`");

    expect(masked).toContain("[a](one.md)");
    expect(masked).toContain("[b](two.md)");
  });

  it("does not let a span cross a BLANK line", () => {
    const masked = maskCode("`[a](one.md)\n\n[b](two.md)`");

    expect(masked).toContain("[a](one.md)");
    expect(masked).toContain("[b](two.md)");
  });

  it("still masks a span that opens and closes on the same line, anywhere on it", () => {
    expect(maskCode("- **Rule** — `![x](url)` escapes it. See [ok](AGENTS.md)."))
      .toBe("- **Rule** — " + " ".repeat(11) + " escapes it. See [ok](AGENTS.md).");
  });

  // CommonMark honors backslash escapes everywhere except inside a code span, so `\`` opens nothing.
  it("does not let a backslash-escaped backtick open a span", () => {
    expect(maskCode("\\` [x](dead.md) still prose")).toContain("[x](dead.md)");
  });

  // The single highest-frequency link shape in this repo — `[`PROJECT.md`](../../PROJECT.md)` — puts a
  // code span INSIDE the label. A masker even slightly greedier here would silently stop resolving
  // hundreds of real links across the skill bodies while the gate still printed OK.
  it("leaves a link whose LABEL contains a code span fully matchable", () => {
    const masked = maskCode("see [`PROJECT.md`](../../PROJECT.md) and [`x`](one.md) too");

    expect(masked).toContain("](../../PROJECT.md)");
    expect(masked).toContain("](one.md)");
  });

  it("does not let a span between two links swallow either of them", () => {
    const masked = maskCode("[a](one.md) `code` [b](two.md)");

    expect(masked).toContain("[a](one.md)");
    expect(masked).toContain("[b](two.md)");
  });
});

describe("maskCode - fenced blocks", () => {
  it("blanks a backtick-fenced block, including one with an info string", () => {
    const masked = maskCode("before\n```ts\n[x](dead.md)\n```\nafter [y](also.md)\n");

    expect(masked).not.toContain("[x](dead.md)");
    expect(masked).toContain("after [y](also.md)");
  });

  it("blanks a tilde-fenced block", () => {
    expect(maskCode("~~~\n[x](dead.md)\n~~~\n")).not.toContain("[x](dead.md)");
  });

  it("accepts a closer LONGER than its opener", () => {
    expect(maskCode("```\n[x](dead.md)\n`````\n")).not.toContain("[x](dead.md)");
  });

  it("does not open a backtick fence whose info string contains a backtick", () => {
    // Not a fence — so the runs are read as inline spans instead, and the link between them is masked
    // by that rule rather than this one. What matters is that the FENCE rule declined it.
    expect(maskCode("```js `x`\n[y](dead.md)\n")).toContain("[y](dead.md)");
  });

  // PR #162 review, Critical. CommonMark runs an unclosed fence to end of document — correct for a
  // renderer, catastrophic for a guard: one dropped ``` line would silently disable dead-link checking
  // for the whole rest of the file. Declining to mask reports the links inside instead, which is wrong
  // OUT LOUD. This is the asymmetry rule applied to its hardest case.
  it("masks NOTHING when a fence is never closed", () => {
    expect(maskCode("```\n[x](dead.md)\nstill inside\n")).toContain("[x](dead.md)");
  });

  // An unrecognized opener must not poison the rest of the file in the other direction either: a later,
  // properly closed fence still masks. (The unclosed opener here is container-scoped — at top level a
  // stray delimiter would simply pair with the next one, which is correct.)
  it("still masks a later, properly closed fence after an unrecognized opener", () => {
    const masked = maskCode("- item\n  ```\n  loose [a](one.md)\n\nTop level:\n\n```\n[b](two.md)\n```\n");

    expect(masked).toContain("[a](one.md)");
    expect(masked).not.toContain("[b](two.md)");
  });

  // Issue #159 plan review, finding 1. Under CommonMark's container-relative ` {0,3}` opener rule, a
  // fence beneath a wide list marker is NOT recognized — and its delimiter backticks then fall through
  // to the inline scanner, free to pair with a distant run and blank the real links in between.
  // Recognizing a fence at any indentation removes that hazard instead of documenting it.
  it("recognizes a fence nested under a wide list marker", () => {
    const masked = maskCode("10. step\n    ```\n    code [x](dead.md)\n    ```\n");
    expect(masked).not.toContain("[x](dead.md)");
  });

  it("recognizes a fence nested under a bullet, and one nested two levels deep", () => {
    expect(maskCode("- step\n  ```\n  [x](dead.md)\n  ```\n")).not.toContain("[x](dead.md)");
    expect(maskCode("- a\n  - b\n      ```\n      [x](dead.md)\n      ```\n")).not.toContain("[x](dead.md)");
  });

  // The adversarial half of the same finding: whatever a nested fence does, it must not reach past
  // itself. A real dead link in the prose AFTER the list stays visible.
  it("never lets a nested fence swallow prose that follows it", () => {
    const masked = maskCode("10. step\n    ```\n    [x](inside.md)\n    ```\n\nLater prose [b](dead.md).\n");

    expect(masked).not.toContain("[x](inside.md)");
    expect(masked).toContain("[b](dead.md)");
  });

  it("recognizes a fence inside a blockquote", () => {
    expect(maskCode("> ```\n> [x](dead.md)\n> ```\n")).not.toContain("[x](dead.md)");
  });

  // Why the blockquote prefix is consumed by the FENCE rule rather than left to the inline scanner.
  // With a matched-length pair the inline rule reaches the same answer by luck; widen the closer — a
  // perfectly valid fence close — and the luck runs out, and an unpaired run goes hunting through the
  // prose that follows. This case fails if `>` is ever dropped from the delimiter prefix.
  it("closes a blockquoted fence whose closer is longer, without leaking into later prose", () => {
    const masked = maskCode("> ```\n> [x](inside.md)\n> `````\n\nafter [b](dead.md)\n");

    expect(masked).not.toContain("[x](inside.md)");
    expect(masked).toContain("[b](dead.md)");
  });

  // The named limitation: at this altitude a 4-space indent is indistinguishable from a wrapped
  // continuation under a nested list item, and the checked files are made of those. Under-masking here
  // is the safe direction.
  it("does NOT mask a 4-space indented code block", () => {
    expect(maskCode("prose\n\n    [x](dead.md)\n")).toContain("[x](dead.md)");
  });
});

// PR #162 review, Critical finding. Each case below was cross-checked against the CommonMark reference
// parser: a renderer shows the trailing link as LIVE, so masking it is a real dead link going silently
// unreported. All three are the same bug — a fence recognized without regard for the container it was
// opened in — and all three are fixed by requiring a closer to be reachable inside that container.
describe("maskCode - a fence may not escape its container", () => {
  it("does not let an unclosed fence in a BLOCKQUOTE mask the paragraph after it", () => {
    const masked = maskCode("> ```\n> code inside quote\n\nReal paragraph: [x](dead.md)\n");

    expect(masked).toContain("[x](dead.md)");
  });

  it("does not let an unclosed fence in a LIST ITEM mask the paragraph after it", () => {
    const masked = maskCode("- item\n  ```\n  code\n\nNext paragraph outside list: [x](dead.md)\n");

    expect(masked).toContain("[x](dead.md)");
  });

  // A fence-look line indented under a paragraph with no blank line between is a lazy CONTINUATION of
  // that paragraph, not a code block — which is why the old comment's "a line indented >= 4 outside a
  // list is already code" was wrong.
  it("does not let an indented fence-look line inside a paragraph mask the rest of the file", () => {
    const masked = maskCode("Some paragraph text here\n    ```\nMore text with a link [x](dead.md)\n");

    expect(masked).toContain("[x](dead.md)");
  });

  // The other direction, so the bound is not just a blanket refusal: a fence that DOES close inside its
  // container still masks, and only up to its closer.
  it("still masks a closed fence inside a blockquote, and stops at its closer", () => {
    const masked = maskCode("> ```\n> [x](inside.md)\n> ```\n\nAfter: [y](dead.md)\n");

    expect(masked).not.toContain("[x](inside.md)");
    expect(masked).toContain("[y](dead.md)");
  });

  it("still masks a closed fence inside a list item, and stops at its closer", () => {
    const masked = maskCode("- item\n  ```\n  [x](inside.md)\n  ```\n\nAfter: [y](dead.md)\n");

    expect(masked).not.toContain("[x](inside.md)");
    expect(masked).toContain("[y](dead.md)");
  });

  // A blank line does not end a fenced block, so a closer on the far side of one is still reachable.
  it("finds a closer across a blank line inside the same container", () => {
    expect(maskCode("```\n[x](dead.md)\n\nstill code\n```\n")).not.toContain("[x](dead.md)");
  });

  // PR #162 DELTA review, High. Cases A-C above are all saved by the must-close bound alone, so none of
  // them would notice if the container bound were deleted. This one would: the opener has real
  // in-container content AND a matching delimiter exists later at top level, so only `leavesContainer`
  // stops the search from reaching it. Neuter that function and this test — and only this test — reddens.
  it("stops the closer search at the container boundary even when a later delimiter exists", () => {
    const masked = maskCode("> ```\n> real content\n\nParagraph one [x](dead.md)\n\n```\nend fence\n```\n");

    expect(masked).toContain("[x](dead.md)");
  });

  // PR #162 DELTA review, Critical, and a regression this PR introduced rather than inherited: once a
  // declined opener stopped being masked, its bare delimiter run fell through to the INLINE pass and
  // paired with the next unrelated ``` line. CommonMark renders the link between them live — a fenced
  // block can interrupt a paragraph, so the ``` on line 3 opens a NEW block and cannot close a span
  // started on line 1.
  it("does not let a DECLINED fence delimiter pair as an inline span", () => {
    const masked = maskCode("```js `x`\n[y](dead.md)\n```\nafter [z](dead2.md)\n");

    expect(masked).toContain("[y](dead.md)");
  });

  // PR #162 delta round 3, Critical — a false green found by differential fuzzing against the CommonMark
  // reference parser. A mid-line run of three backticks paired with a run in a LATER BLOCK, masking the
  // live link between them. CommonMark renders `[l1](dead.md)` inside the opening paragraph.
  it("does not let an inline span skip past fence-delimiter lines to a farther partner", () => {
    const masked = maskCode(
      "abc ``` def [l0](dead0.md)\n```js `x`\nghi [l1](dead.md) jkl\n```js\nmno [l2](dead2.md) pqr\nstu ``` vwx\n",
    );

    expect(masked).toContain("[l1](dead.md)");
  });

  // The same class, but reached through a block opener that is NOT a fence — a list item. These two
  // inputs came out of the fuzzer while validating the first fix for the case above, which handled only
  // fence lines and left these masked. Together they pin `inlineBarriers`: revert the block-opener
  // barrier to blank-lines-only and both redden.
  it("stops an inline span at a list item that opens a new block", () => {
    const masked = maskCode("abc ``` def [L8](t.md)\nstu ~~~ vwx [L6](t.md)\n- ```\n");

    expect(masked).toContain("[L8](t.md)");
    expect(masked).toContain("[L6](t.md)");
  });

  // No blank lines here, deliberately: with them, the blank-line barrier alone would carry the case and
  // this would pin nothing. An ATX heading can interrupt a paragraph, so these are three blocks.
  it("stops an inline span at a heading that opens a new block", () => {
    const masked = maskCode("abc ``` def [L0](t.md)\n# Heading\nstu ``` vwx [L1](t.md)\n");

    expect(masked).toContain("[L0](t.md)");
    expect(masked).toContain("[L1](t.md)");
  });
});

describe("parity check - dead links in the widened scope", () => {
  // The issue's exact case, and the reason `rules/*.md` could not simply be added to the list. Without
  // masking this file yields TWO errors; the code-span one is the false positive.
  //
  // The span's target is deliberately unique rather than the issue's literal `url`. `healDeadLinks`
  // stubs `rules/url` into existence from the real rules/security.md whenever masking is broken, which
  // would let this case pass against an unmasked checker — a test that cannot fail. Caught by neutering
  // maskCode and re-running (rules/testing.md: "if this test passed but the feature were broken, would
  // I know?").
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

  // Issue #159 plan review, finding 3. Membership in a list proves nothing: a wrong join for a skill
  // body or a wrong base directory for a shim would satisfy the case above and still check nothing.
  // Each category has to REDDEN on a real dead link, so run one representative of each through it.
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
});

describe("parity fixture - healDeadLinks shares the checker's masking", () => {
  // Issue #159 plan review, finding 2. `healDeadLinks` stubs a file into existence for every dead link
  // it finds, so scanning RAW text over the widened scope makes it stub the pseudo-links in prose that
  // TEACHES markdown: `rules/url`, `docs/rules/path`, a literal `docs/rules/MMMM-...md`, and two
  // nonsense nested directories. Nothing about the checker's OUTPUT can see that — it masks either way
  // — which is exactly why this needs its own assertion.
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

  // The healer must still do its job for a genuine link, or every fixture-based suite starts failing on
  // a link that a later commit legitimately adds. Masking must silence the pseudo-links and nothing else.
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
