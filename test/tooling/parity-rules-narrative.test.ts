import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NARRATIVE_ALLOWLIST,
  NARRATIVE_MAX_CHARS,
  RULE_DEEP_DOC,
  runParityCheck,
} from "../../scripts/parity-check.js";
import { withBundleCopy } from "./parity-fixture.js";

// Issue #152: PR #149 trimmed rules/testing.md and nothing stopped the accretion resuming -- it did,
// in the very next merged PR (7856eda: testing.md 5,906 -> 6,964 bytes, past the 6,712 the trim
// started from). This suite covers the per-bullet guard that answers it (ADR 0051).
//
// Every case below drives the REAL `runParityCheck` over a fixture bundle it mutates, so the suite
// proves the checker's behavior rather than only asserting that today's files happen to be fine.

const NARRATIVE_ERROR = /^Tier-1 narrative/;

/** A rule file the checker will accept structurally, carrying `body` between its two sections. */
function ruleFile(title: string, body: string): string {
  return `# ${title}\n\n## Patterns\n\n- **Do the thing** — because reasons.\n\n## Anti-Patterns\n\n${body}\n`;
}

/**
 * Replace one Tier-1 rule file in a copied bundle, then run parity and hand back only the
 * narrative-class errors. `prepare` can further mutate the copy (e.g. create a deep doc) first.
 */
function withRuleBody(
  rel: string,
  body: string,
  assert: (errors: string[]) => void,
  prepare?: (root: string) => void,
): void {
  withBundleCopy((root) => {
    prepare?.(root);
    writeFileSync(join(root, rel), ruleFile("Fixture Rules", body));
    assert(runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e)));
  });
}

/**
 * A bullet whose rstripped line is EXACTLY `length` characters, with `key` as its bolded imperative.
 * Callers assert the length before using it -- a boundary case built one char off would pass for the
 * wrong reason (rules/testing.md: never test a limit with an input that is not the input you meant).
 */
function longBullet(length: number, key = "Never do the bad thing", marker = "- "): string {
  const bullet = `${marker}**${key}** — because reasons. `;
  if (bullet.length > length) throw new Error(`longBullet: prefix is already ${bullet.length} chars`);
  return bullet + "x".repeat(length - bullet.length);
}

/** Create `rel` inside the fixture copy so a "declared but absent" deep doc becomes "present". */
function createDeepDoc(root: string, rel: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "# Fixture deep doc\n\n## A case\n\nCreated by the narrative self-test.\n");
}

describe("parity check - Tier-1 per-bullet narrative guard", () => {
  it("reports no narrative error for the real Rules Layer", () => {
    withBundleCopy((root) => {
      expect(runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e))).toEqual([]);
    });
  });

  it("accepts a bullet comfortably under the limit", () => {
    withRuleBody("rules/testing.md", "- **Never do the bad thing** — because reasons.", (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // Without this, every case below could be satisfied by a checker that rejects any long bullet.
  it("accepts an over-limit bullet that carries its own domain's case-study pointer", () => {
    const bullet = `${longBullet(NARRATIVE_MAX_CHARS + 200)} *(Host case study: \`docs/rules/testing-postmortems.md\`.)*`;
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("rejects an over-limit bullet with no pointer, naming the bullet, its length, and the limit", () => {
    const bullet = longBullet(700, "Never write the case study inline");
    expect(bullet).toHaveLength(700);
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toEqual([
        'Tier-1 narrative rules/testing.md: bullet "Never write the case study inline" is 700 characters ' +
        "(limit 600) and carries no case-study pointer; move the case narrative to " +
        "`docs/rules/testing-postmortems.md` and leave a backticked pointer to it, or shorten the bullet",
      ]);
    });
  });

  // The check must not care whether the bullet carries a `(Provenance: ...)` tag. Issue #152 proposed
  // requiring one; measured, that clause exempts nothing today and is a one-token bypass tomorrow, so
  // it was deliberately dropped (plan decision 2). Both spellings must fail identically.
  it.each([
    ["with a Provenance tag", " *(Provenance: issue #1 / PR #2; extend per host.)*"],
    ["without a Provenance tag", ""],
  ])("rejects an over-limit bullet %s", (_label, suffix) => {
    withRuleBody("rules/testing.md", longBullet(NARRATIVE_MAX_CHARS + 50) + suffix, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("carries no case-study pointer");
    });
  });

  // A cross-domain pointer would be a one-line bypass for every over-long bullet in the tree.
  it("rejects an over-limit bullet pointing at ANOTHER domain's deep doc", () => {
    const bullet = `${longBullet(NARRATIVE_MAX_CHARS + 100)} *(Host case study: \`docs/rules/testing-postmortems.md\`.)*`;
    withRuleBody("rules/backend.md", bullet, (errors) => {
      const narrative = errors.filter((e) => e.startsWith("Tier-1 narrative rules/backend.md: bullet"));
      expect(narrative).toHaveLength(1);
      expect(narrative[0]).toContain("move the case narrative to `docs/rules/backend-postmortems.md`");
      expect(narrative[0]).not.toContain("does not exist yet");
    });
  });
});

describe("parity check - the remedy tracks the deep doc's state on disk", () => {
  // rules/frontend.md's deep doc is DECLARED but not yet written (docs/rules/README.md: deep docs are
  // "absent until a host has a real postmortem to record"). Advising "just add a pointer" here would
  // march the contributor straight into checkRulesPointers()'s does-not-exist error.
  it("tells a contributor to author an absent deep doc FIRST, not to point at it", () => {
    withRuleBody("rules/frontend.md", longBullet(NARRATIVE_MAX_CHARS + 1), (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("`docs/rules/frontend-postmortems.md` does not exist yet, so author it first");
      expect(errors[0]).toContain("a pointer to an absent deep doc fails the rules-pointer check");
    });
  });

  // The same bullet, same file, with the deep doc present: the advice must change with the disk, not
  // with a hardcoded list, so it cannot go stale the day a host writes its first frontend postmortem.
  it("switches to the pointer remedy once that deep doc exists", () => {
    withRuleBody(
      "rules/frontend.md",
      longBullet(NARRATIVE_MAX_CHARS + 1),
      (errors) => {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("move the case narrative to `docs/rules/frontend-postmortems.md`");
        expect(errors[0]).not.toContain("does not exist yet");
      },
      (root) => createDeepDoc(root, "docs/rules/frontend-postmortems.md"),
    );
  });

  // rules/security.md is the other "declared but absent" file and, unlike frontend, it carries an
  // allowlist entry -- so this also proves the two failure classes are reported independently rather
  // than one masking the other.
  it("gives the same author-it-first advice for rules/security.md, alongside its stale-entry error", () => {
    withRuleBody("rules/security.md", longBullet(NARRATIVE_MAX_CHARS + 1, "Never write it inline"), (errors) => {
      const bulletErrors = errors.filter((e) => e.includes(': bullet "'));
      expect(bulletErrors).toHaveLength(1);
      expect(bulletErrors[0]).toContain("`docs/rules/security-postmortems.md` does not exist yet, so author it first");
      // The allowlist entry for this file is now orphaned, and that must be reported too, not swallowed.
      expect(errors.filter((e) => e.includes("matches no bullet"))).toHaveLength(1);
    });
  });

  // rules/self-review.md has no deep doc BY DESIGN, so the only honest remedy is "shorten it".
  it("offers only the shorten remedy for a rule with no deep doc, naming no docs/rules path", () => {
    withRuleBody("rules/self-review.md", longBullet(NARRATIVE_MAX_CHARS + 1), (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("rules/self-review.md has no Tier-2 deep doc, so shorten the bullet");
      expect(errors[0]).not.toContain("docs/rules/");
    });
  });
});

describe("parity check - the narrative limit's boundary", () => {
  it("accepts a bullet of exactly the limit", () => {
    const bullet = longBullet(NARRATIVE_MAX_CHARS);
    expect(bullet).toHaveLength(NARRATIVE_MAX_CHARS);
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("rejects a bullet one character over the limit", () => {
    const bullet = longBullet(NARRATIVE_MAX_CHARS + 1);
    expect(bullet).toHaveLength(NARRATIVE_MAX_CHARS + 1);
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`is ${NARRATIVE_MAX_CHARS + 1} characters (limit ${NARRATIVE_MAX_CHARS})`);
    });
  });

  // These files are full of em dashes: one char, three UTF-8 bytes. A byte-based measure would reject
  // this bullet, which is well within the limit a reader experiences. Pins the unit.
  it("measures characters, not bytes", () => {
    const dashes = "—".repeat(200);
    const bullet = `- **Never do the bad thing** ${dashes} ${"x".repeat(NARRATIVE_MAX_CHARS - 30 - dashes.length)}`;
    expect(bullet.length).toBeLessThanOrEqual(NARRATIVE_MAX_CHARS);
    expect(Buffer.byteLength(bullet, "utf-8")).toBeGreaterThan(NARRATIVE_MAX_CHARS);
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toEqual([]);
    });
  });
});

describe("parity check - the narrative allowlist is itself checked", () => {
  const ALLOWED = NARRATIVE_ALLOWLIST["rules/security.md"] ?? [];
  const KEY = ALLOWED[0] as string;

  it("exempts a bullet named in the allowlist", () => {
    const bullet = `${longBullet(NARRATIVE_MAX_CHARS + 100, KEY)}`;
    withRuleBody("rules/security.md", bullet, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // A reworded imperative silently orphans its entry. Left unchecked, the stale entry sits there ready
  // to exempt some future bullet that happens to reuse the wording.
  it("rejects an entry whose imperative matches no bullet", () => {
    withRuleBody("rules/security.md", "- **A completely different imperative** — because reasons.", (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`entry "${KEY}" matches no bullet`);
    });
  });

  // The ratchet. Trimming a bullet turns parity RED until the now-pointless entry is deleted, so the
  // backlog cannot quietly stop shrinking -- which is the whole reason this guard is worth its keep.
  it("rejects an entry whose bullet no longer trips the limit", () => {
    withRuleBody("rules/security.md", `- **${KEY}** — because reasons.`, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`entry "${KEY}" is no longer needed`);
      expect(errors[0]).toContain("this list only shrinks");
    });
  });

  it("rejects an entry whose imperative matches more than one bullet", () => {
    const body = `${longBullet(NARRATIVE_MAX_CHARS + 10, KEY)}\n${longBullet(NARRATIVE_MAX_CHARS + 20, KEY)}`;
    withRuleBody("rules/security.md", body, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`entry "${KEY}" matches 2 bullets`);
    });
  });

  // Mutating the shared constant is deliberate and contained: this failure mode cannot be reached by
  // editing a fixture file, because the offending key names a path no rule file can occupy.
  it("rejects an entry naming a file that is not a Tier-1 rule", () => {
    const STRAY = "rules/nonexistent.md";
    (NARRATIVE_ALLOWLIST as Record<string, readonly string[]>)[STRAY] = ["Never do the bad thing"];
    try {
      withBundleCopy((root) => {
        const errors = runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e));
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`\`${STRAY}\` is not a Tier-1 rule file`);
      });
    } finally {
      delete (NARRATIVE_ALLOWLIST as Record<string, readonly string[]>)[STRAY];
    }
    // The mutation must not leak into any later case.
    withBundleCopy((root) => {
      expect(runParityCheck(root).errors.filter((e) => NARRATIVE_ERROR.test(e))).toEqual([]);
    });
  });
});

// Found by the Stage-4 adversarial pass, not by the plan. Measuring only a bullet's FIRST line meant
// any prose-wrapper -- an editor reflow, a formatter with `proseWrap` on -- would silently disable the
// guard for the whole tree at once, by a routine and well-intentioned edit. Today's files happen to
// write one bullet per line, which is exactly what made the assumption dangerous to encode.
describe("parity check - a bullet is measured across its wrapped continuation lines", () => {
  /**
   * The same content as `oneLine`, re-flowed at ~95 columns. `indent` distinguishes the two flavors a
   * real wrap produces: an indented body (a formatter that re-indents list contents) and CommonMark's
   * LAZY continuation at column zero (`gq`, a hand edit, a formatter that does not). Both render as one
   * bullet, so both must measure the same -- the lazy flavor is the cheaper bypass and was the one the
   * Reviewer found still open after the first fix.
   */
  function wrap(oneLine: string, indent = "  "): string {
    const words = oneLine.split(" ");
    const lines: string[] = [];
    let current = words.shift() as string;
    for (const word of words) {
      if (current.length + 1 + word.length > 95) {
        lines.push(current);
        current = `${indent}${word}`;
      } else {
        current += ` ${word}`;
      }
    }
    lines.push(current);
    return lines.join("\n");
  }

  const OVER = longBullet(NARRATIVE_MAX_CHARS + 210, "Never write the case study inline");

  it.each([
    ["indented continuation lines", "  "],
    ["lazy continuation lines at column zero", ""],
  ])("rejects an over-limit bullet wrapped with %s", (_label, indent) => {
    const wrapped = wrap(OVER, indent);
    expect(wrapped).toContain("\n");   // the fixture must actually be wrapped, or this proves nothing
    if (indent === "") expect(wrapped).toMatch(/\n\S/);   // ...and actually be flush-left
    withRuleBody("rules/testing.md", wrapped, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("carries no case-study pointer");
    });
  });

  // Wrap-invariance: the reported length must not depend on where the breaks fell OR on how the
  // continuation lines were indented. All three spellings are the same bullet to a reader.
  it("reports the same length however the bullet is wrapped", () => {
    const lengths: number[] = [];
    for (const body of [OVER, wrap(OVER, "  "), wrap(OVER, "")]) {
      withRuleBody("rules/testing.md", body, (errors) => {
        expect(errors).toHaveLength(1);
        lengths.push(Number(/is (\d+) characters/.exec(errors[0] as string)?.[1]));
      });
    }
    expect(lengths[0]).toBe(NARRATIVE_MAX_CHARS + 210);
    expect(new Set(lengths).size).toBe(1);
  });

  it.each([["indented", "  "], ["lazy", ""]])(
    "accepts a %s-wrapped bullet whose case-study pointer sits on a continuation line",
    (_label, indent) => {
      const body = `${wrap(OVER, indent)}\n${indent}*(Host case study: \`docs/rules/testing-postmortems.md\`.)*`;
      withRuleBody("rules/testing.md", body, (errors) => {
        expect(errors).toEqual([]);
      });
    },
  );

  // The continuation scan must not run away past the bullet: a blank line, a sibling bullet, a
  // heading, and a fence each end it. Every trailer below is long enough that ABSORBING it would push
  // the bullet over the limit, so each case fails if its terminator is dropped -- "no errors" on a
  // short bullet with a short trailer would pass either way.
  const SHORT = longBullet(NARRATIVE_MAX_CHARS - 100, "Never run away past the bullet");
  const LONG_TRAILER = "x".repeat(200);

  it.each([
    ["a blank line", `${SHORT}\n\n${LONG_TRAILER}`],
    ["a sibling bullet", `${SHORT}\n- **Another one** — ${LONG_TRAILER}`],
    ["a heading", `${SHORT}\n## A heading ${LONG_TRAILER}`],
    ["a bare hash heading", `${SHORT}\n#\n${LONG_TRAILER}`],
    ["a fenced block", `${SHORT}\n\`\`\`\n${LONG_TRAILER}\n\`\`\``],
    ["a blockquote", `${SHORT}\n> ${LONG_TRAILER}`],
  ])("stops the bullet at %s", (_label, body) => {
    expect(SHORT.length + LONG_TRAILER.length).toBeGreaterThan(NARRATIVE_MAX_CHARS);
    withRuleBody("rules/testing.md", body, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  // `#` NOT followed by a space is literal text, not an ATX heading (CommonMark: `#5 bolt` renders as
  // a paragraph). These files are made of issue references, so a wrap breaking before `#152` is the
  // likeliest accident in the whole format -- and treating it as a block opener made the rest of the
  // bullet count toward nothing at all. Found by the Reviewer on the delta.
  it.each([
    ["an issue reference", "#152"],
    ["a hash-prefixed word", "#hashtag"],
    ["seven hashes (too many for a heading)", "#######"],
  ])("keeps consuming a continuation line beginning with %s", (_label, prefix) => {
    const body = `${SHORT}\n${prefix} ${LONG_TRAILER}`;
    withRuleBody("rules/testing.md", body, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('bullet "Never run away past the bullet"');
      // The continuation must be COUNTED, not merely noticed: the reported length includes it.
      const measured = Number(/is (\d+) characters/.exec(errors[0] as string)?.[1]);
      expect(measured).toBeGreaterThan(SHORT.length + LONG_TRAILER.length);
    });
  });
});

// Also from the Reviewer. `RULE_BULLET` originally demanded the literal four bytes `- **`, so a bullet
// written with any other CommonMark-valid marker spelling was not merely unmeasured -- it was invisible.
// `-  **Never ...**` is one accidental keystroke, renders identically, and silently exempted itself.
describe("parity check - every CommonMark bullet-marker spelling is measured", () => {
  it.each([
    ["one space after a dash (the house style)", "- "],
    ["two spaces after a dash", "-  "],
    ["four spaces after a dash", "-    "],
    ["a tab after a dash", "-\t"],
    ["a star marker", "* "],
    ["a plus marker", "+ "],
    ["an indented dash", "  - "],
  ])("measures a bullet written with %s", (_label, marker) => {
    const bullet = longBullet(NARRATIVE_MAX_CHARS + 60, "Never hide behind a marker spelling", marker);
    expect(bullet).toHaveLength(NARRATIVE_MAX_CHARS + 60);
    withRuleBody("rules/testing.md", bullet, (errors) => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('bullet "Never hide behind a marker spelling"');
      expect(errors[0]).toContain(`is ${NARRATIVE_MAX_CHARS + 60} characters`);
    });
  });

  // The marker set that TERMINATES a bullet must stay in lockstep with the set that STARTS one --
  // otherwise a star-marked bullet is absorbed as prose by the dash-marked bullet above it, and two
  // legitimate bullets are reported as one over-length one.
  //
  // Each half is deliberately just under the limit and the pair is well over it, so this FAILS if the
  // terminator set is narrowed. Asserting "no errors" on two short bullets would pass either way --
  // a false green, which is what an earlier draft of this test actually was.
  it.each([["a dash", "- "], ["a star", "* "], ["a plus", "+ "], ["an ordered marker", "1. "]])(
    "ends the preceding bullet at a sibling written with %s",
    (_label, marker) => {
      const first = longBullet(NARRATIVE_MAX_CHARS - 100, "Never do the first bad thing");
      const second = longBullet(NARRATIVE_MAX_CHARS - 100, "Never do the second bad thing", marker);
      expect(first.length + second.length).toBeGreaterThan(NARRATIVE_MAX_CHARS);
      withRuleBody("rules/testing.md", `${first}\n${second}`, (errors) => {
        expect(errors).toEqual([]);
      });
    },
  );
});

describe("parity check - narrative guard structural edge cases", () => {
  it("ignores an over-limit bullet inside a fenced code block", () => {
    const body = ["```md", longBullet(NARRATIVE_MAX_CHARS + 200), "```", "", "- **A short one** — fine."].join("\n");
    withRuleBody("rules/testing.md", body, (errors) => {
      expect(errors).toEqual([]);
    });
  });

  it("ignores an over-limit line that is not a bolded bullet", () => {
    const body = [
      `**Deep doc:** \`docs/rules/testing-postmortems.md\` ${"x".repeat(NARRATIVE_MAX_CHARS)}`,
      "",
      `A plain paragraph ${"x".repeat(NARRATIVE_MAX_CHARS)}`,
      "",
      `- an unbolded list item ${"x".repeat(NARRATIVE_MAX_CHARS)}`,
    ].join("\n");
    withRuleBody("rules/testing.md", body, (errors) => {
      expect(errors).toEqual([]);
    });
  });
});

describe("issue #152 - the shipped tables are pinned", () => {
  // Hardcoded, NOT derived from the constant: an assertion built from the thing it checks shrinks
  // silently along with it (test/tooling/coverage-floors.test.ts makes the same choice).
  const EXPECTED_ALLOWLIST: Record<string, string[]> = {
    "rules/backend.md": [
      "Anchor a freshness or completeness claim on when a job _started_, not when it _finished_.",
      "A freshness/completeness verdict must not sit over data a consumer silently drops because a filter's own prerequisite was missing or unusable.",
      "Never swap a live data file into place by moving the old one aside and then renaming the new one in",
      "Never assume a framework's central error handler catches every route's thrown error",
      "Never embed a raw control byte (most often a literal NUL) as a delimiter or sentinel in a text source file",
    ],
    "rules/security.md": [
      "Never reuse a *coercing* validator at a typed-JSON boundary",
    ],
    "rules/scripting.md": [
      "Never emit non-ASCII bytes from a bundled script's stdout/stderr",
      "Never widen a guard's matching rule to clear a false alarm without asking which way the new failure points",
    ],
  };

  it("carries exactly the grandfathered files", () => {
    expect(Object.keys(NARRATIVE_ALLOWLIST).sort()).toEqual(Object.keys(EXPECTED_ALLOWLIST).sort());
  });

  it.each(Object.entries(EXPECTED_ALLOWLIST))("pins every %s entry by name", (file, expected) => {
    expect([...(NARRATIVE_ALLOWLIST[file] ?? [])].sort()).toEqual([...expected].sort());
  });

  it("grandfathers exactly eight bullets - five of them the rules/backend.md ones issue #151 targets", () => {
    expect(Object.values(NARRATIVE_ALLOWLIST).flatMap((v) => [...v])).toHaveLength(8);
    expect(NARRATIVE_ALLOWLIST["rules/backend.md"]).toHaveLength(5);
  });

  // A new Tier-1 rule file with no mapping would be checked against `undefined` and could never be
  // exempted by a pointer; the checker reports that, and this pins the table it reports against.
  it("maps every Tier-1 rule to its deep doc, with self-review explicitly null", () => {
    expect(RULE_DEEP_DOC).toEqual({
      "rules/backend.md": "docs/rules/backend-postmortems.md",
      "rules/frontend.md": "docs/rules/frontend-postmortems.md",
      "rules/testing.md": "docs/rules/testing-postmortems.md",
      "rules/security.md": "docs/rules/security-postmortems.md",
      "rules/self-review.md": null,
      "rules/scripting.md": "docs/rules/scripting-postmortems.md",
      "rules/skills.md": "docs/rules/skills-postmortems.md",
    });
  });

  it("keeps the limit above the longest already-trimmed bullet, so a trim is never asked to go further", () => {
    expect(NARRATIVE_MAX_CHARS).toBe(600);
    // The pointer exempts at any length; this documents that a correctly-shaped bullet may exceed the
    // number (rules/skills.md's is 604 chars today) without the guard having anything to say.
    expect(existsSync(join(process.cwd(), "rules/skills.md"))).toBe(true);
  });
});

// Guard against this suite leaving anything behind in the repo it reads from.
describe("issue #152 - the suite is non-destructive", () => {
  it("leaves no fixture deep doc in the real tree", () => {
    for (const rel of ["docs/rules/frontend-postmortems.md", "docs/rules/security-postmortems.md"]) {
      expect(existsSync(join(process.cwd(), rel)), `${rel} was created outside the fixture copy`).toBe(false);
    }
  });
});
