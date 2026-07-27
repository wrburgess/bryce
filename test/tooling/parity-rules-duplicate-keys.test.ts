import { describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runParityCheck } from "../../scripts/parity-check.js";
import { withBundleCopy } from "./parity-fixture.js";

// Issue #179, ADR 0058. `NARRATIVE_ALLOWLIST` is keyed by a bullet's bolded imperative, so uniqueness is
// the property its whole design rests on -- and nothing enforced it. `checkRulesNarrative` DOES report an
// ambiguous key, but only from inside `for (const key of allowed)`: two NON-allowlisted bullets could
// share an imperative with the gate green. PR #174 answered it with a one-shot hand scan (95 bullets, 0
// duplicates), which is a measurement, not a guard.
//
// Every case here drives the REAL `runParityCheck` over a fixture bundle it mutates, so the suite proves
// the checker's behavior rather than asserting that today's files happen to be fine.

const DUPLICATE_ERROR = /^Tier-1 duplicate imperative /;
const NARRATIVE_ERROR = /^Tier-1 narrative/;

/**
 * The checker's message, rebuilt from its parts.
 *
 * One case below asserts the FULL string literally as well. Both are wanted: a builder alone drifts with
 * the code it mirrors and would keep passing through a wording regression, while a single literal alone
 * makes every other case restate 300 characters of boilerplate.
 */
function duplicateError(key: string, where: string[]): string {
  const list = where.map((rel) => `"${rel}"`).join(", ");
  return (
    `Tier-1 duplicate imperative "${key}": ${where.length} bullets in [${list}] - the bolded ` +
    `imperative identifies a bullet and keys NARRATIVE_ALLOWLIST, so a shared one makes an allowlist ` +
    `entry ambiguous; reword one imperative so each is distinct. A Pattern and its mirrored ` +
    `Anti-Pattern are not a duplicate (ADR 0053) - they carry different imperative text`
  );
}

/**
 * A structurally valid rule file carrying `antiPatterns` (and optionally custom `patterns`).
 *
 * The default Patterns bullet is uniquified BY PATH, unlike the narrative suite's fixed one. That suite
 * only ever replaces a single file; this one replaces two at once, and a fixed filler bullet would
 * manufacture the very cross-file duplicate several cases are trying to isolate.
 */
function ruleFile(rel: string, antiPatterns: string, patterns?: string): string {
  const fill = patterns ?? `- **Do the fixture thing for ${rel}** — because reasons.`;
  return `# Fixture Rules\n\n## Patterns\n\n${fill}\n\n## Anti-Patterns\n\n${antiPatterns}\n`;
}

/** Replace one or more Tier-1 rule files in a copied bundle; hand back only the duplicate-class errors. */
function withRuleBodies(bodies: Record<string, string>, assert: (errors: string[]) => void): void {
  withBundleCopy((root) => {
    for (const [rel, body] of Object.entries(bodies)) writeFileSync(join(root, rel), body);
    assert(runParityCheck(root).errors.filter((e) => DUPLICATE_ERROR.test(e)));
  });
}

describe("parity check - a bolded imperative identifies one bullet", () => {
  // The 102/102 measurement, pinned as an assertion that runs every day instead of a scan that ran once.
  it("reports no duplicate for the real Rules Layer", () => {
    withBundleCopy((root) => {
      expect(runParityCheck(root).errors.filter((e) => DUPLICATE_ERROR.test(e))).toEqual([]);
    });
  });

  // The negative control. Without it every case below is satisfied by a checker that rejects any two
  // bullets, and the suite would prove nothing about duplication at all.
  it("accepts distinct imperatives in one file", () => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          "- **Never do the first bad thing** — because reasons.\n" +
          "- **Never do the second bad thing** — because reasons.",
        ),
      },
      (errors) => expect(errors).toEqual([]),
    );
  });

  it("rejects two bullets sharing an imperative in ONE file, naming that file twice", () => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          "- **Never do the bad thing** — because reasons.\n" +
          "- **Never do the bad thing** — because other reasons.",
        ),
      },
      (errors) => {
        // The one literal assertion in the suite: the exact contract, including the ADR 0053 carve-out
        // and the reword remedy. A message that stopped naming NARRATIVE_ALLOWLIST, or started reading
        // as "one bullet per invariant", would still satisfy a looser `toContain`.
        expect(errors).toEqual([
          'Tier-1 duplicate imperative "Never do the bad thing": 2 bullets in ' +
          '["rules/testing.md", "rules/testing.md"] - the bolded imperative identifies a bullet and ' +
          "keys NARRATIVE_ALLOWLIST, so a shared one makes an allowlist entry ambiguous; reword one " +
          "imperative so each is distinct. A Pattern and its mirrored Anti-Pattern are not a duplicate " +
          "(ADR 0053) - they carry different imperative text",
        ]);
      },
    );
  });

  // ORDERED, not merely present. The checker documents its output as a deterministic function of the
  // tree (REQUIRED_RULES order, then source order); a set comparison would let that silently stop being
  // true, and an unstable error list is what makes a gate's output unusable in CI.
  it("rejects an imperative shared ACROSS two files, in REQUIRED_RULES order", () => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile("rules/testing.md", "- **Never cross the streams** — because reasons."),
        "rules/security.md": ruleFile("rules/security.md", "- **Never cross the streams** — because reasons."),
      },
      (errors) => {
        expect(errors).toEqual([
          duplicateError("Never cross the streams", ["rules/testing.md", "rules/security.md"]),
        ]);
      },
    );
  });

  it("counts every occurrence, not just the first collision", () => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          "- **Never repeat yourself** — because reasons.\n" +
          "- **Never repeat yourself** — because other reasons.",
        ),
        "rules/security.md": ruleFile("rules/security.md", "- **Never repeat yourself** — because reasons."),
      },
      (errors) => {
        expect(errors).toEqual([
          duplicateError("Never repeat yourself", ["rules/testing.md", "rules/testing.md", "rules/security.md"]),
        ]);
      },
    );
  });

  // THE governing-convention case (rules/scripting.md: run a guard's own convention through it before
  // shipping it, including the state the docs tell authors to move TO). ADR 0053 permits one invariant in
  // both moods, and quotes this exact pair as its worked example -- so the pair is lifted verbatim, and
  // written into the very file it lives in so the originals are replaced rather than duplicated.
  //
  // A guard keyed on "one bullet per invariant" instead of on imperative TEXT reddens here, which is the
  // ordering trap issue #179's body named and this test exists to spring first.
  it("accepts a mirrored Pattern / Anti-Pattern pair (ADR 0053)", () => {
    withRuleBodies(
      {
        "rules/backend.md": ruleFile(
          "rules/backend.md",
          "- **Never infer that an external source lacks a field by reading the adapter's mapping " +
          "table alone** — because the mapping table is not the source.",
          "- **Confirm an external source's actual fields before coding around an assumed absence** — " +
          "because the source is the authority.",
        ),
      },
      (errors) => expect(errors).toEqual([]),
    );
  });

  // Exact equality, per ADR 0058: the guard must be no stricter than the property it protects.
  // `NARRATIVE_ALLOWLIST` lookup is `allowed.includes(key)`, so two composition forms are two distinct
  // keys and an entry matches exactly one of them -- there is no ambiguity to report.
  //
  // Both spellings are written as \uXXXX escapes, never as typed accented characters. A literal is
  // normalized to ONE form by the editor that saves this file, which collapses the two fixtures into the
  // same string and leaves a test that passes while proving nothing.
  it("treats NFD and NFC spellings of one imperative as distinct keys", () => {
    const nfc = "Never mangle Acu\u00f1a's name";        // precomposed n-tilde
    const nfd = "Never mangle Acun\u0303a's name";       // n + combining tilde
    expect(nfc).not.toEqual(nfd);
    expect(nfc.normalize("NFD")).toEqual(nfd.normalize("NFD"));   // they really are the same glyph run

    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          `- **${nfc}** — because reasons.\n- **${nfd}** — because other reasons.`,
        ),
      },
      (errors) => expect(errors).toEqual([]),
    );

    // The control, and it is not optional. The assertion above is an ABSENCE, so it would also pass if a
    // combining mark simply broke bullet extraction and neither line was seen as a bullet at all -- a
    // test that reads as an equality decision while pinning nothing. Repeat ONE of the two spellings and
    // the guard must fire, which proves both were extracted in the first place.
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          `- **${nfd}** — because reasons.\n- **${nfd}** — because other reasons.`,
        ),
      },
      (errors) => {
        expect(errors).toEqual([
          duplicateError("Never mangle Acun\\u0303a's name", ["rules/testing.md", "rules/testing.md"]),
        ]);
      },
    );
  });

  // rules/scripting.md / ADR 0011: a bundled script's output must survive a non-UTF-8 locale, and these
  // bullets are full of em dashes.
  it("escapes a non-ASCII imperative rather than emitting raw bytes", () => {
    const key = "Never ship a half\u2014measure";   // em dash, written as an escape for the same reason
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          `- **${key}** — because reasons.\n- **${key}** — because other reasons.`,
        ),
      },
      (errors) => {
        expect(errors).toEqual([
          duplicateError("Never ship a half\\u2014measure", ["rules/testing.md", "rules/testing.md"]),
        ]);
        expect(errors[0]).not.toContain("\u2014");
        expect(errors[0]).toMatch(/^[\x20-\x7e]*$/);
      },
    );
  });

  // A missing rule file is checkRules()' error to report. This pass must neither double-report it nor
  // die on it -- the same `this.exists` guard checkRulesNarrative uses.
  it("skips an absent rule file without crashing, leaving checkRules to report it", () => {
    withBundleCopy((root) => {
      rmSync(join(root, "rules/frontend.md"), { force: true });

      const errors = runParityCheck(root).errors;
      expect(errors.filter((e) => DUPLICATE_ERROR.test(e))).toEqual([]);
      // Named exactly once as a MISSING RULE, by the check that owns that report. "At least one" would
      // also pass if this pass started re-reporting the same absence in its own words. The dead links
      // the deletion also produces are a different question, asked by checkLinks, and are excluded
      // rather than asserted here so this case does not drift every time a file links to frontend.md.
      expect(errors.filter((e) => e.includes("rules/frontend.md") && !/^Dead link /.test(e))).toEqual([
        "Tier-1 rule missing: rules/frontend.md not found",
      ]);
    });
  });
});

// Task 0 of issue #179's plan, folded in after the Reviewer's plan critique found the premise false:
// `ruleBullets` and `checkRulesPointers` each carried their own `` /^\s*```/ `` toggle, so CommonMark's
// OTHER fence character was invisible to both. A bullet parked in a `~~~` block was read as live prose.
// The fenced-line question now goes to the parser (`codeBlockLines`), which is ADR 0054's answer applied
// to block structure.
describe("parity check - code blocks are not bullets, in either fence spelling", () => {
  const DUPLICATE = "- **Never duplicate through a fence** — because reasons.";

  // The negative control this whole describe rests on, and it is not optional. Every fence case below
  // asserts an ABSENCE of errors, which stays true when the guard is deleted -- an input that yields no
  // findings whether or not the guard works reads as coverage while pinning nothing (rules/testing.md).
  // This case fails the moment the duplicate pass stops running, so the absences above it mean something.
  it("reports the same pair as a duplicate when it is NOT fenced", () => {
    withRuleBodies(
      { "rules/testing.md": ruleFile("rules/testing.md", `${DUPLICATE}\n${DUPLICATE}`) },
      (errors) => {
        expect(errors).toEqual([
          duplicateError("Never duplicate through a fence", ["rules/testing.md", "rules/testing.md"]),
        ]);
      },
    );
  });

  it.each([
    ["backtick", "```"],
    ["tilde", "~~~"],
  ])("hides a duplicate bullet inside a %s fence", (_label, fence) => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          `${DUPLICATE}\n\n${fence}\n${DUPLICATE}\n${fence}`,
        ),
      },
      (errors) => expect(errors).toEqual([]),
    );
  });

  // The case a naive `fenced = !fenced` over BOTH characters gets wrong, and the reason this went to the
  // parser rather than to a second character in each toggle: an inner fence of the other spelling is
  // content, so treating it as a closer would end the block early and hand the rest back as prose --
  // a regression, not a fix.
  it.each([
    ["backtick", "```", "~~~"],
    ["tilde", "~~~", "```"],
  ])("does not close a %s fence on the other fence character", (_label, outer, inner) => {
    withRuleBodies(
      {
        "rules/testing.md": ruleFile(
          "rules/testing.md",
          `${DUPLICATE}\n\n${outer}\n${inner}\n${DUPLICATE}\n${outer}`,
        ),
      },
      (errors) => expect(errors).toEqual([]),
    );
  });

  // The same defect reached the narrative budget, which is why this arm is asserted in ITS error class
  // too: a bullet hidden in a `~~~` block was measured for length and could redden a limit it is not
  // subject to.
  it("does not measure an over-limit bullet parked in a tilde fence", () => {
    const long = `- **Never write the case study inline** — ${"x".repeat(700)}`;
    withBundleCopy((root) => {
      writeFileSync(
        join(root, "rules/testing.md"),
        ruleFile("rules/testing.md", `~~~\n${long}\n~~~`),
      );
      expect(runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e))).toEqual([]);
    });
  });

  // ...and the negative control for the whole describe: the same bullet OUTSIDE a fence must still be
  // measured. Without it, a `codeBlockLines` that returned every line would pass every case above.
  it("still measures the same bullet outside a fence", () => {
    const long = `- **Never write the case study inline** — ${"x".repeat(700)}`;
    withBundleCopy((root) => {
      writeFileSync(join(root, "rules/testing.md"), ruleFile("rules/testing.md", long));
      expect(runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e))).toHaveLength(1);
    });
  });
});
