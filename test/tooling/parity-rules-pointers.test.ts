import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runParityCheck } from "../../scripts/parity-check.js";
import { REPO_ROOT, withBundleCopy } from "./parity-fixture.js";

// Issue #148: trimming a Tier-1 bullet to a case-study POINTER creates a failure mode the repo
// could not previously detect — a pointer naming a deep doc that does not exist silently loses the
// content it stands for, and no existing check sees it, because these paths are deliberately
// backticked rather than linked (docs/rules/README.md) and `checkLinks` resolves only links.
//
// Every case below drives the real `runParityCheck` over a fixture bundle it mutates, so the suite
// proves the checker's behavior rather than only asserting that today's files happen to be fine.

const RULE = "rules/testing.md";
const DEEP_DOC = "docs/rules/testing-postmortems.md";
const POINTER_ERROR = /^Rules pointer /;

/** Replace `rules/testing.md` in the copied bundle with a synthetic file, then run parity. */
function withRuleBody(body: string, assert: (errors: string[]) => void): void {
  withBundleCopy((root) => {
    writeFileSync(join(root, RULE), `# Testing Rules\n\n${body}\n\n## Patterns\n\n- x\n\n## Anti-Patterns\n\n- y\n`);
    assert(runParityCheck(root).errors.filter((e) => POINTER_ERROR.test(e)));
  });
}

describe("parity check - Tier-2 deep-doc pointers", () => {
  it("reports no pointer error for the real Rules Layer", () => {
    withBundleCopy((root) => {
      expect(runParityCheck(root).errors.filter((e) => POINTER_ERROR.test(e))).toEqual([]);
    });
  });

  // The case that catches a botched trim: the bullet survives, the content it points at does not.
  it("rejects a body pointer whose deep doc does not exist", () => {
    withRuleBody("- **Never x** — because y. *(Host case study: `docs/rules/absent-postmortems.md`.)*", (errors) => {
      expect(errors).toEqual([
        "Rules pointer rules/testing.md: case-study pointer `docs/rules/absent-postmortems.md` does not exist",
      ]);
    });
  });

  // docs/rules/README.md: a deep doc stays "absent until a host has a real postmortem to record".
  // rules/frontend.md, rules/security.md and rules/scripting.md all rely on this today.
  it("accepts a `**Deep doc:**` header that forward-references an absent deep doc", () => {
    withRuleBody("**Deep doc:** `docs/rules/absent-postmortems.md` (Tier 2 — deferred)", (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("rejects an inline markdown link to a deep doc even when the target exists", () => {
    withRuleBody(`- **Never x** — because y. See [the deep doc](${DEEP_DOC}).`, (errors) => {
      expect(errors).toEqual([
        "Rules pointer rules/testing.md: `docs/rules/testing-postmortems.md` is written as a markdown link; " +
        "a deep-doc path must be a backticked path (docs/rules/README.md) so it cannot redden the dead-link " +
        "check before its target lands",
      ]);
    });
  });

  // The spelling a contributor writing from `rules/` would actually reach for. An earlier draft of
  // this check skipped it as an unresolvable `../` path and never applied the link rule at all.
  it.each(["../", "./", "/"])("rejects a markdown link whose target is prefixed with %s", (prefix) => {
    withRuleBody(`- **Never x** — because y. See [the deep doc](${prefix}${DEEP_DOC}).`, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is written as a markdown link");
    });
  });

  it("rejects a reference-style link definition for a deep doc", () => {
    withRuleBody(`- **Never x** — because y. See [deep doc][dd].\n\n[dd]: ${DEEP_DOC}`, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is written as a markdown link");
    });
  });

  // Without this, the missing-target and link cases could both be satisfied by a checker that
  // simply rejects every pointer it sees.
  it("accepts a backticked body pointer whose deep doc exists", () => {
    withRuleBody(`- **Never x** — because y. *(Host case study: \`${DEEP_DOC}\`.)*`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("ignores absolute, traversal, URL, and fenced-code forms", () => {
    withRuleBody(
      [
        "- absolute: `/opt/vendor/docs/rules/absent-postmortems.md`",
        "- traversal: `../docs/rules/absent-postmortems.md`",
        "- url: <https://example.com/docs/rules/absent-postmortems.md>",
        "",
        "```md",
        "- fenced: `docs/rules/absent-postmortems.md`",
        "```",
      ].join("\n"),
      (errors) => {
        expect(errors).toEqual([]);
      },
    );
  });
});

describe("issue #148 - the moved content is reachable and intact", () => {
  const doc = readFileSync(join(REPO_ROOT, DEEP_DOC), "utf-8");
  const sections = doc.split(/\n(?=## )/).slice(1);

  it("is listed in the Tier-2 trigger table", () => {
    expect(existsSync(join(REPO_ROOT, DEEP_DOC))).toBe(true);
    expect(readFileSync(join(REPO_ROOT, "docs/rules/README.md"), "utf-8")).toContain(DEEP_DOC);
  });

  // A single section citing all four incidents would satisfy a file-wide check; these assert the
  // one-entry-per-incident structure the trim depends on.
  it("carries exactly four case studies, one per incident", () => {
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => (s.match(/#(25|28|67|139)\b/) ?? [])[0]))
      .toEqual(expect.arrayContaining(["#67", "#25", "#28", "#139"]));
  });

  it("gives every case study the required structure", () => {
    for (const section of sections) {
      const heading = (section.split("\n")[0] ?? "").slice(0, 60);
      for (const required of ["**The case.**", "**What shipped", "**The rule it yields.**", "**Symptom to watch for.**"]) {
        expect(section, `${heading} is missing ${required}`).toContain(required);
      }
    }
  });

  // Source discipline: a "caught in review" claim must name the artifact that supports it, not just
  // the parent issue (rules/self-review.md — cite what actually states the claim).
  it("closes every case study with a reference naming a specific artifact", () => {
    for (const section of sections) {
      const reference = section.split("\n").filter((l) => l.startsWith("_(Reference:")).at(-1) ?? "";
      expect(reference, `${(section.split("\n")[0] ?? "").slice(0, 60)} has no _(Reference: …)_ line`).not.toBe("");
      expect(reference).toMatch(/#\d+/);
      expect(reference).toMatch(/PR #\d+|`[0-9a-f]{7,40}`/);
    }
  });
});

describe("issue #148 - every trimmed Tier-1 bullet kept its instruction", () => {
  // Hardcoded, NOT derived from the file: a dynamically selected set would shrink silently when a
  // bullet or its pointer is removed, and the test would still pass.
  const TRIMMED_BULLETS = [
    "Construct the environment a test claims to cover",
    "Enforce the offline-test invariant fail-closed",
    "Enforce coverage floors against the report the run produced",
    "Never prove a cross-process concurrency invariant with a second in-process connection alone",
    "Never test a gate's logic without also pinning what invokes it",
    "Never scope a fixture's copy filter by substring-matching an absolute path",
    "Never construct a default/real provider client in a default-suite test",
  ];

  const bullets = readFileSync(join(REPO_ROOT, RULE), "utf-8").split("\n").filter((l) => l.startsWith("- **"));

  it.each(TRIMMED_BULLETS)("keeps the imperative, a rationale, and the case-study pointer: %s", (fragment) => {
    const bullet = bullets.find((b) => b.includes(fragment));
    expect(bullet, `no bullet in ${RULE} contains "${fragment}"`).toBeTypeOf("string");
    // The instruction never moves behind the pointer (rules/skills.md): the rationale stays in Tier 1.
    expect(bullet).toMatch(/because|rather than|instead of/);
    expect(bullet).toContain(`\`${DEEP_DOC}\``);
  });

  it("covers every bullet that carries a case-study pointer", () => {
    const pointing = bullets.filter((b) => b.includes(DEEP_DOC));
    expect(pointing).toHaveLength(TRIMMED_BULLETS.length);
  });
});
