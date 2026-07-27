import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const ABSENT_DEEP_DOC = "docs/rules/absent-postmortems.md";
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
    withRuleBody(`- **Never x** — because y. *(Host case study: \`${ABSENT_DEEP_DOC}\`.)*`, (errors) => {
      expect(errors).toEqual([
        "Rules pointer rules/testing.md: case-study pointer `docs/rules/absent-postmortems.md` does not exist; " +
        "a deep doc that is not written yet is forward-referenced from the `**Deep doc:**` header, not from a body bullet",
      ]);
    });
  });

  // docs/rules/README.md: a deep doc stays "absent until a host has a real postmortem to record".
  // rules/frontend.md and rules/security.md rely on this today (rules/scripting.md did until issue
  // #166 wrote its deep doc).
  it("accepts a `**Deep doc:**` header that forward-references an absent deep doc", () => {
    withRuleBody(`**Deep doc:** \`${ABSENT_DEEP_DOC}\` (Tier 2 — deferred)`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // Issue #154: docs/rules/README.md instructs a contributor to promote a backticked path to a real
  // link "only once the target file exists". Before this, the checker rejected EVERY link, so the
  // documented promotion step could not be followed without reddening the gate.
  it("accepts a promoted link, written relative to the rule file, once the deep doc exists", () => {
    withRuleBody(`- **Never x** — because y. See [the deep doc](../${DEEP_DOC}).`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("accepts a promoted link carrying an anchor fragment", () => {
    withRuleBody(`- **Never x** — because y. See [the case](../${DEEP_DOC}#a-case-study).`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("accepts a promoted reference-style definition that resolves", () => {
    withRuleBody(`- **Never x** — because y. See [deep doc][dd].\n\n[dd]: ../${DEEP_DOC}`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // The other half of the promotion rule, and the reason it is not a false green: the target
  // EXISTING is not enough — the href has to reach it from `rules/`, the way markdown resolves it.
  // The bare `docs/rules/...` spelling names a real file and still renders as a 404 on GitHub.
  it.each([
    ["no prefix (repo-root spelling)", ""],
    ["./", "./"],
    ["/", "/"],
    ["../../ (climbs out of the repo)", "../../"],
  ])("rejects a promoted link whose href does not resolve from rules/: %s", (_label, prefix) => {
    withRuleBody(`- **Never x** — because y. See [the deep doc](${prefix}${DEEP_DOC}).`, (errors) => {
      expect(errors).toEqual([
        `Rules pointer rules/testing.md: markdown link \`${prefix}${DEEP_DOC}\` does not resolve from rules/; ` +
        "a promoted link is relative to the referring file",
      ]);
    });
  });

  // The spelling a contributor writing from `rules/` would actually reach for. An earlier draft of
  // this check skipped it as an unresolvable `../` path and never applied the link rule at all.
  it.each(["../", "./", "/"])("rejects a markdown link to an ABSENT deep doc, prefixed with %s", (prefix) => {
    withRuleBody(`- **Never x** — because y. See [the deep doc](${prefix}${ABSENT_DEEP_DOC}).`, (errors) => {
      expect(errors).toEqual([
        "Rules pointer rules/testing.md: `docs/rules/absent-postmortems.md` is written as a markdown link; " +
        "a deep-doc path must be a backticked path (docs/rules/README.md) so it cannot redden the dead-link " +
        "check before its target lands",
      ]);
    });
  });

  it("rejects a reference-style link definition for an absent deep doc", () => {
    withRuleBody(`- **Never x** — because y. See [deep doc][dd].\n\n[dd]: ${ABSENT_DEEP_DOC}`, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is written as a markdown link");
    });
  });

  // The header exemption is about the BARE form only — a dead link in a header is still dead.
  it("rejects a `**Deep doc:**` header written as a link to an absent deep doc", () => {
    withRuleBody(`**Deep doc:** [deferred](../${ABSENT_DEEP_DOC})`, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is written as a markdown link");
    });
  });

  it("accepts a `**Deep doc:**` header promoted to a link that resolves", () => {
    withRuleBody(`**Deep doc:** [the deep doc](../${DEEP_DOC}) (Tier 2)`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // Without this, the missing-target and link cases could both be satisfied by a checker that
  // simply rejects every pointer it sees.
  it("accepts a backticked body pointer whose deep doc exists", () => {
    withRuleBody(`- **Never x** — because y. *(Host case study: \`${DEEP_DOC}\`.)*`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // Each token on a line is classified from its OWN `before` slice, so a line may legitimately mix
  // the two forms. Nothing asserted this before the rewrite, and the link branch's early return is
  // exactly the kind of change that could leak one token's verdict into the next.
  it("classifies a bare pointer and a promoted link on the same line independently", () => {
    withRuleBody(`- **Never x** — see \`${DEEP_DOC}\` and also [the deep doc](../${DEEP_DOC}).`, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("reports both tokens when a line carries a bad pointer and a bad link", () => {
    withRuleBody(`- **Never x** — see \`${ABSENT_DEEP_DOC}\` and also [it](${DEEP_DOC}).`, (errors) => {
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("case-study pointer `docs/rules/absent-postmortems.md` does not exist");
      expect(errors[1]).toContain("does not resolve from rules/");
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

  // Issue #179. This walk's own ``` -only fence toggle is gone; the fenced-line question now goes to
  // the CommonMark parser (`codeBlockLines`), which knows BOTH fence characters and indented code too.
  //
  // The exemption widens: a pointer in an INDENTED code block was checked before and is not now. That is
  // the intended reading -- a pointer inside code is a worked example, the same reason the fenced one was
  // always skipped -- but it is a widening toward a false GREEN, so it is pinned here rather than left
  // implicit. Measured across the real tree before landing: all 30 live pointers are still checked,
  // line for line.
  it.each([
    ["a tilde fence", ["~~~md", "- fenced: `docs/rules/absent-postmortems.md`", "~~~"]],
    ["an indented code block", ["", "    - indented: `docs/rules/absent-postmortems.md`", ""]],
  ])("ignores a pointer inside %s", (_label, block) => {
    withRuleBody(block.join("\n"), (errors) => expect(errors).toEqual([]));
  });

  // The control the three cases above rest on. Each asserts an ABSENCE, which stays true if the walk
  // stopped looking at pointers altogether; this one fails the moment it does.
  it("still reports the same pointer when it is NOT inside code", () => {
    withRuleBody("- **Never x** — because y. *(Host case study: `docs/rules/absent-postmortems.md`.)*", (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("`docs/rules/absent-postmortems.md` does not exist");
    });
  });
});

describe("issue #148 - the moved content is reachable and intact", () => {
  const doc = readFileSync(join(REPO_ROOT, DEEP_DOC), "utf-8");
  const sections = doc.split(/\n(?=## )/).slice(1);

  // Issue #166: this asserted `toContain(DEEP_DOC)` over the whole README, which also spells the path
  // in its convention prose -- deleting the trigger-table row left the test green (proved by mutation).
  // Assert the ROW that binds this Tier-1 rule to this deep doc.
  it("is listed in the Tier-2 trigger table", () => {
    expect(existsSync(join(REPO_ROOT, DEEP_DOC))).toBe(true);
    const row = readFileSync(join(REPO_ROOT, "docs/rules/README.md"), "utf-8")
      .split("\n")
      .find((l) => l.startsWith("|") && l.includes(`\`${RULE}\``));
    expect(row, `no trigger-table row for ${RULE}`).toBeTypeOf("string");
    expect(row).toContain(DEEP_DOC);
  });

  // A single section citing all five incidents would satisfy a file-wide check; these assert the
  // one-entry-per-incident structure the trim depends on. Issue #166 added the fifth (#159's fuzzer
  // and mutation lessons); the count is hardcoded so a merge that drops an entry turns red.
  it("carries exactly five case studies, one per incident", () => {
    expect(sections).toHaveLength(5);
    expect(sections.map((s) => (s.match(/#(25|28|67|139|159)\b/) ?? [])[0]))
      .toEqual(expect.arrayContaining(["#67", "#25", "#28", "#139", "#159"]));
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
    // Issue #166 (#159's testing lessons): one added bullet, one sharpened to absorb the mutation
    // lesson. Both point at the deep doc, so both must be listed here or the coverage test below
    // catches the omission.
    "Never read a generated corpus's silence as a statement about the real one",
    "Never believe a guard you have not broken on purpose",
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

// Issue #166 stood up the scripting domain's first Tier-2 deep doc. The #148 block above pins the
// testing one and nothing pinned this; the same failure mode applies — a pointer whose target loses
// its content is invisible to `checkLinks` (the path is backticked, not linked) and the parity
// pointer check only proves the FILE exists, not that a case study is still in it.
describe("issue #166 - the scripting deep doc is reachable and intact", () => {
  const SCRIPTING_RULE = "rules/scripting.md";
  const SCRIPTING_DEEP_DOC = "docs/rules/scripting-postmortems.md";
  const doc = readFileSync(join(REPO_ROOT, SCRIPTING_DEEP_DOC), "utf-8");
  const sections = doc.split(/\n(?=## )/).slice(1);

  // A file-wide `toContain` would pass on the convention prose further down docs/rules/README.md,
  // which also spells this path -- so it would stay green with the trigger-table row deleted. Assert
  // the ROW: the line that binds this Tier-1 rule to this deep doc.
  it("is listed in the Tier-2 trigger table", () => {
    expect(existsSync(join(REPO_ROOT, SCRIPTING_DEEP_DOC))).toBe(true);
    const row = readFileSync(join(REPO_ROOT, "docs/rules/README.md"), "utf-8")
      .split("\n")
      .find((l) => l.startsWith("|") && l.includes(`\`${SCRIPTING_RULE}\``));
    expect(row, `no trigger-table row for ${SCRIPTING_RULE}`).toBeTypeOf("string");
    expect(row).toContain(SCRIPTING_DEEP_DOC);
  });

  it("carries one case study per incident", () => {
    expect(sections).toHaveLength(1);
    expect(sections.map((s) => (s.match(/#159\b/) ?? [])[0])).toEqual(["#159"]);
  });

  it("gives every case study the required structure", () => {
    for (const section of sections) {
      const heading = (section.split("\n")[0] ?? "").slice(0, 60);
      for (const required of ["**The case.**", "**What shipped", "**The rule it yields.**", "**Symptom to watch for.**"]) {
        expect(section, `${heading} is missing ${required}`).toContain(required);
      }
    }
  });

  it("closes every case study with a reference naming a specific artifact", () => {
    for (const section of sections) {
      const reference = section.split("\n").filter((l) => l.startsWith("_(Reference:")).at(-1) ?? "";
      expect(reference, `${(section.split("\n")[0] ?? "").slice(0, 60)} has no _(Reference: …)_ line`).not.toBe("");
      expect(reference).toMatch(/#\d+/);
      expect(reference).toMatch(/PR #\d+|`[0-9a-f]{7,40}`/);
    }
  });

  // The instruction never moves behind the pointer (rules/skills.md): the imperative and its
  // rationale stay resident in Tier 1, and only the narrative moves down.
  it("keeps the pointing Tier-1 bullet's imperative and rationale resident", () => {
    const bullets = readFileSync(join(REPO_ROOT, SCRIPTING_RULE), "utf-8").split("\n").filter((l) => l.startsWith("- **"));
    const pointing = bullets.filter((b) => b.includes(SCRIPTING_DEEP_DOC));
    expect(pointing).toHaveLength(1);
    expect(pointing[0]).toContain("Never model a format yourself to check something about it");
    expect(pointing[0]).toMatch(/because|rather than|instead of/);
  });
});
