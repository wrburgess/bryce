import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  extract,
  fromFile,
  invalid,
  report,
  cliName,
  asciiSafe,
  ALLOWED,
  DEFAULTS,
  FIELD_KEYS,
  LABELS,
} from "../../scripts/human-gates.js";
import type { FieldKey, HumanGates } from "../../scripts/human-gates.js";

// Pure-parser tests for the Human Gates derivation (scripts/human-gates.ts). These lock the parsing
// contract with PROJECT.md; test/tooling/parity-human-gates.test.ts drives the resulting parity check
// end-to-end through `--root` fixture bundles.
//
// Every fixture is COMPOSED from parts by `projectMd()` rather than pasted as a schema-coupled blob
// (rules/testing.md), so a change to the authored table shape is a one-line edit here.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ASCII = /^[\x20-\x7E]*$/;

const GATE_HEADER = "| Gate | Setting | Allowed values |";
const GATE_SEPARATOR = "|------|---------|----------------|";

function planRow(setting: string): string {
  return `| **Plan approval** — the Stage-2 plan approval | ${setting} | \`required\` · \`auto\` |`;
}

function mergeRow(setting: string): string {
  return `| **Merge** — the HC merges the delivered PR | ${setting} | \`required\` (not configurable) |`;
}

function floorBullet(value: string): string {
  return `- **Reviewer degradation floor:** ${value} — what happens when the Reviewer chain is exhausted.`;
}

function dispositionSentence(value: string): string[] {
  return [
    "How `final` handles the Rules-Layer improvements it learns while implementing. Its shipped default is",
    `${value}; allowed values \`autonomous-fold | present-to-hc\`.`,
  ];
}

interface Parts {
  /** SETTING cell for the Plan approval row; `null` omits the row. */
  planApproval?: string | null;
  /** SETTING cell for the Merge row; `null` omits the row. */
  merge?: string | null;
  /** Full override of the gate table's raw lines (header + separator + rows). */
  rows?: string[];
  /** `false` omits the whole `## Human Gates` section. */
  gatesSection?: boolean;
  /** Value on the floor bullet; `null` omits the bullet. */
  floor?: string | null;
  /** Full override of the floor bullet lines. */
  floorBullets?: string[];
  /** `false` omits the whole `## Lifecycle Host` section. */
  hostSection?: boolean;
  /** Value in the declaring sentence; `null` keeps the subsection but declares nothing. */
  disposition?: string | null;
  /** Full override of the disposition subsection's body lines. */
  dispositionLines?: string[];
  /** `false` omits the `### Rule-suggestion disposition` subsection. */
  dispositionSubsection?: boolean;
  /** Lines placed under a trailing `## Appendix` H2 — i.e. OUTSIDE every parsed section. */
  tail?: string[];
}

function projectMd(parts: Parts = {}): string {
  const lines: string[] = ["# PROJECT.md - fixture", ""];

  if (parts.hostSection !== false) {
    lines.push("## Lifecycle Host", "", "- **Host platform:** `GitHub` (default).");
    const bullets =
      parts.floorBullets ??
      (parts.floor === null ? [] : [floorBullet(parts.floor ?? "`stop-and-ask`")]);
    lines.push(...bullets, "");
  }

  if (parts.gatesSection !== false) {
    lines.push("## Human Gates", "");
    const rows = parts.rows ?? [
      GATE_HEADER,
      GATE_SEPARATOR,
      ...(parts.planApproval === null ? [] : [planRow(parts.planApproval ?? "`auto`")]),
      ...(parts.merge === null ? [] : [mergeRow(parts.merge ?? "`required`")]),
    ];
    lines.push(...rows, "");

    if (parts.dispositionSubsection !== false) {
      lines.push("### Rule-suggestion disposition", "");
      const body =
        parts.dispositionLines ??
        (parts.disposition === null
          ? ["This subsection declares no default at all."]
          : dispositionSentence(parts.disposition ?? "`autonomous-fold`"));
      lines.push(...body, "");
    }
  }

  if (parts.tail && parts.tail.length > 0) {
    lines.push("## Appendix", "", ...parts.tail, "");
  }

  return lines.join("\n");
}

/** Compact `{ value, status, effective }` assertion helper. */
function expectField(
  gates: HumanGates,
  key: FieldKey,
  value: string | null,
  status: string,
  effective: string,
): void {
  expect({ key, ...gates[key] }).toEqual({ key, value, status, effective });
}

describe("extract - the shipped PROJECT.md data contract", () => {
  const shipped = fromFile(join(REPO_ROOT, "PROJECT.md"));

  it("parses this host's plan-approval, floor, and disposition declarations", () => {
    expectField(shipped, "planApproval", "auto", "parsed", "auto");
    expectField(shipped, "reviewerFloor", "stop-and-ask", "parsed", "stop-and-ask");
    expectField(shipped, "ruleDisposition", "autonomous-fold", "parsed", "autonomous-fold");
  });

  // Asserted on its own: a plan-approval edit must never be able to mask a merge-gate regression.
  it("parses the merge gate as `required`", () => {
    expectField(shipped, "merge", "required", "parsed", "required");
  });

  it("reports no invalid declaration", () => {
    expect(invalid(shipped)).toEqual([]);
  });
});

describe("extract - absent declarations", () => {
  it("reports both gates absent when the `## Human Gates` section is missing", () => {
    const gates = extract(projectMd({ gatesSection: false }));
    expectField(gates, "planApproval", null, "absent", "required");
    expectField(gates, "merge", null, "absent", "required");
  });

  it("reports the disposition absent when the section that nests it is missing", () => {
    const gates = extract(projectMd({ gatesSection: false }));
    expectField(gates, "ruleDisposition", null, "absent", "present-to-hc");
  });

  it("reports only the plan-approval row absent when only that row is missing", () => {
    const gates = extract(projectMd({ planApproval: null }));
    expectField(gates, "planApproval", null, "absent", "required");
    expectField(gates, "merge", "required", "parsed", "required");
  });

  it("reports only the merge row absent when only that row is missing", () => {
    const gates = extract(projectMd({ merge: null }));
    expectField(gates, "merge", null, "absent", "required");
    expectField(gates, "planApproval", "auto", "parsed", "auto");
  });

  it("reports the floor absent when its bullet is missing", () => {
    expectField(extract(projectMd({ floor: null })), "reviewerFloor", null, "absent", "stop-and-ask");
  });

  it("reports the floor absent when the `## Lifecycle Host` section is missing", () => {
    const gates = extract(projectMd({ hostSection: false }));
    expectField(gates, "reviewerFloor", null, "absent", "stop-and-ask");
  });

  it("reports the disposition absent when its subsection is missing", () => {
    const gates = extract(projectMd({ dispositionSubsection: false }));
    expectField(gates, "ruleDisposition", null, "absent", "present-to-hc");
  });
});

describe("extract - unparseable declarations (present, but no backticked value)", () => {
  // The headline case: a value written without backticks must NOT silently read as `absent` and
  // fall back to the safe default. It is a real, wrong declaration and must be reported as such.
  it("reports an unbackticked merge value as unparseable, not absent", () => {
    const gates = extract(projectMd({ rows: [GATE_HEADER, GATE_SEPARATOR, "| Merge | auto |"] }));
    expectField(gates, "merge", null, "unparseable", "required");
  });

  it("reports an unbackticked plan-approval value as unparseable", () => {
    const gates = extract(projectMd({ planApproval: "auto" }));
    expectField(gates, "planApproval", null, "unparseable", "required");
  });

  it("reports an unbackticked floor value as unparseable", () => {
    const gates = extract(projectMd({ floor: "stop-and-ask" }));
    expectField(gates, "reviewerFloor", null, "unparseable", "stop-and-ask");
  });

  it("reports a disposition subsection with no declaring sentence as unparseable", () => {
    const gates = extract(projectMd({ disposition: null }));
    expectField(gates, "ruleDisposition", null, "unparseable", "present-to-hc");
  });

  it("reports an unbackticked disposition value as unparseable", () => {
    const gates = extract(projectMd({ disposition: "autonomous-fold" }));
    expectField(gates, "ruleDisposition", null, "unparseable", "present-to-hc");
  });

  it("reports an empty SETTING cell as unparseable", () => {
    const gates = extract(projectMd({ rows: [GATE_HEADER, GATE_SEPARATOR, "| Merge |  |"] }));
    expectField(gates, "merge", null, "unparseable", "required");
  });

  it("reports a whitespace-only backtick span as unparseable", () => {
    const gates = extract(projectMd({ merge: "` `" }));
    expectField(gates, "merge", null, "unparseable", "required");
  });
});

describe("extract - duplicate declarations", () => {
  // Duplication is an error even when the values AGREE: first-wins must never silently resolve a
  // conflict, because the next editor's change to the "other" row would go unnoticed.
  it("reports duplicate merge rows whose values agree", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, mergeRow("`required`"), mergeRow("`required`")];
    expectField(extract(projectMd({ rows })), "merge", null, "duplicate", "required");
  });

  it("reports duplicate merge rows whose values conflict", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, mergeRow("`required`"), mergeRow("`auto`")];
    expectField(extract(projectMd({ rows })), "merge", null, "duplicate", "required");
  });

  it("reports duplicate plan-approval rows whose values agree", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, planRow("`auto`"), planRow("`auto`")];
    expectField(extract(projectMd({ rows })), "planApproval", null, "duplicate", "required");
  });

  it("reports duplicate plan-approval rows whose values conflict", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, planRow("`auto`"), planRow("`required`")];
    expectField(extract(projectMd({ rows })), "planApproval", null, "duplicate", "required");
  });

  it("leaves the other gate parsed when one gate is duplicated", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, planRow("`auto`"), mergeRow("`required`"), mergeRow("`required`")];
    const gates = extract(projectMd({ rows }));
    expectField(gates, "merge", null, "duplicate", "required");
    expectField(gates, "planApproval", "auto", "parsed", "auto");
  });

  it("reports duplicate floor bullets", () => {
    const bullets = [floorBullet("`stop-and-ask`"), floorBullet("`stop-and-ask`")];
    const gates = extract(projectMd({ floorBullets: bullets }));
    expectField(gates, "reviewerFloor", null, "duplicate", "stop-and-ask");
  });

  it("reports duplicate disposition subsections", () => {
    const body = [
      ...dispositionSentence("`autonomous-fold`"),
      "",
      "### Rule-suggestion disposition",
      "",
      ...dispositionSentence("`present-to-hc`"),
    ];
    const gates = extract(projectMd({ dispositionLines: body }));
    expectField(gates, "ruleDisposition", null, "duplicate", "present-to-hc");
  });
});

describe("extract - out-of-range values are parsed, then rejected by invalid()", () => {
  function invalidKeys(gates: HumanGates): FieldKey[] {
    return invalid(gates).map((f) => f.key);
  }

  it("parses a self-merge declaration but reports it invalid and keeps `required` effective", () => {
    const gates = extract(projectMd({ merge: "`auto`" }));
    expectField(gates, "merge", "auto", "parsed", "required");
    expect(invalidKeys(gates)).toEqual(["merge"]);
  });

  it("parses a softened floor but reports it invalid and keeps `stop-and-ask` effective", () => {
    const gates = extract(projectMd({ floor: "`flag-in-SOW`" }));
    expectField(gates, "reviewerFloor", "flag-in-SOW", "parsed", "stop-and-ask");
    expect(invalidKeys(gates)).toEqual(["reviewerFloor"]);
  });

  it("rejects an unknown plan-approval value", () => {
    const gates = extract(projectMd({ planApproval: "`sometimes`" }));
    expectField(gates, "planApproval", "sometimes", "parsed", "required");
    expect(invalidKeys(gates)).toEqual(["planApproval"]);
  });

  it("accepts both `required` and `auto` for plan approval", () => {
    expectField(extract(projectMd({ planApproval: "`required`" })), "planApproval", "required", "parsed", "required");
    expectField(extract(projectMd({ planApproval: "`auto`" })), "planApproval", "auto", "parsed", "auto");
    expect(invalid(extract(projectMd({ planApproval: "`required`" })))).toEqual([]);
    expect(invalid(extract(projectMd({ planApproval: "`auto`" })))).toEqual([]);
  });

  it("rejects an unknown disposition value", () => {
    const gates = extract(projectMd({ disposition: "`fold-everything`" }));
    expectField(gates, "ruleDisposition", "fold-everything", "parsed", "present-to-hc");
    expect(invalidKeys(gates)).toEqual(["ruleDisposition"]);
  });

  it("accepts both allowed disposition values", () => {
    expect(invalid(extract(projectMd({ disposition: "`autonomous-fold`" })))).toEqual([]);
    expect(invalid(extract(projectMd({ disposition: "`present-to-hc`" })))).toEqual([]);
  });

  it("reports every failing declaration, not just the first", () => {
    const gates = extract(projectMd({ merge: "`auto`", floor: "`flag-in-SOW`", planApproval: null }));
    expect(invalidKeys(gates)).toEqual(["planApproval", "merge", "reviewerFloor"]);
  });

  it("carries the label and allowed list needed to render a message", () => {
    const [bad] = invalid(extract(projectMd({ merge: "`auto`" })));
    expect(bad?.label).toBe("Merge");
    expect(bad?.allowed).toEqual(["required"]);
  });
});

describe("extract - the disposition declaring-sentence anchor", () => {
  // A bare substring search would false-green here: the subsection legitimately names the OTHER
  // allowed value in its explanatory prose, so the value must come from the declaring sentence.
  it("returns the declared default even when the other value appears later in the prose", () => {
    const body = [
      ...dispositionSentence("`autonomous-fold`"),
      "",
      "- **`autonomous-fold`** (shipped default) - `final` folds low-risk improvements in.",
      "- **`present-to-hc`** - `final` presents the suggestions and waits.",
    ];
    const gates = extract(projectMd({ dispositionLines: body }));
    expectField(gates, "ruleDisposition", "autonomous-fold", "parsed", "autonomous-fold");
  });

  it("reads a declaring sentence that wraps across a line break", () => {
    const gates = extract(projectMd({ disposition: "`present-to-hc`" }));
    expectField(gates, "ruleDisposition", "present-to-hc", "parsed", "present-to-hc");
  });

  it("matches the declaring sentence case-insensitively", () => {
    const body = ["Its SHIPPED DEFAULT IS `present-to-hc` for this fixture."];
    const gates = extract(projectMd({ dispositionLines: body }));
    expectField(gates, "ruleDisposition", "present-to-hc", "parsed", "present-to-hc");
  });
});

describe("extract - section boundaries", () => {
  // The bug class scripts/protected-branches.ts guards: content BELOW the next `## ` H2 belongs to
  // another section and must not leak in.
  it("does not read a gate table placed below the next `## ` H2", () => {
    const text = projectMd({
      rows: [],
      tail: [GATE_HEADER, GATE_SEPARATOR, planRow("`auto`"), mergeRow("`required`")],
    });
    const gates = extract(text);
    expectField(gates, "planApproval", null, "absent", "required");
    expectField(gates, "merge", null, "absent", "required");
  });

  it("does not read a floor bullet placed below the next `## ` H2", () => {
    const text = projectMd({ floorBullets: [], tail: [floorBullet("`stop-and-ask`")] });
    expectField(extract(text), "reviewerFloor", null, "absent", "stop-and-ask");
  });

  it("does not read a disposition subsection placed below the next `## ` H2", () => {
    const text = projectMd({
      dispositionSubsection: false,
      tail: ["### Rule-suggestion disposition", "", ...dispositionSentence("`autonomous-fold`")],
    });
    expectField(extract(text), "ruleDisposition", null, "absent", "present-to-hc");
  });
});

describe("extract - row-label matching", () => {
  it("matches a label wrapped in emphasis and backticks, in mixed case", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, "| **`MeRgE`** | `required` |"];
    expectField(extract(projectMd({ rows })), "merge", "required", "parsed", "required");
  });

  it("matches a label by prefix, ignoring the trailing prose in the same cell", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, "| Plan approval and the Stage-1 option pick | `auto` |"];
    expectField(extract(projectMd({ rows })), "planApproval", "auto", "parsed", "auto");
  });

  it("does not treat the header or separator rows as gate rows", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR];
    const gates = extract(projectMd({ rows }));
    expectField(gates, "merge", null, "absent", "required");
    expectField(gates, "planApproval", null, "absent", "required");
  });
});

describe("extract - locating the SETTING column", () => {
  const OFF_INDEX_ROWS = (settingHeader: string): string[] => [
    `| Gate | Allowed values | ${settingHeader} |`,
    "|------|----------------|---------|",
    "| **Merge** | `not-the-setting` | `required` |",
  ];

  it("reads the column named by a `Setting` header, not column 1", () => {
    const gates = extract(projectMd({ rows: OFF_INDEX_ROWS("Setting") }));
    expectField(gates, "merge", "required", "parsed", "required");
  });

  it("matches the `Setting` header case-insensitively and through emphasis", () => {
    const gates = extract(projectMd({ rows: OFF_INDEX_ROWS("**SETTING**") }));
    expectField(gates, "merge", "required", "parsed", "required");
  });

  it("falls back to column index 1 when the header names no `Setting` column", () => {
    const gates = extract(projectMd({ rows: OFF_INDEX_ROWS("Value") }));
    expectField(gates, "merge", "not-the-setting", "parsed", "required");
  });

  it("falls back to column index 1 when there is no header row at all", () => {
    const gates = extract(projectMd({ rows: [mergeRow("`required`")] }));
    expectField(gates, "merge", "required", "parsed", "required");
  });
});

describe("extract - malformed input never throws", () => {
  it("returns the fail-closed defaults for empty, null, and undefined input", () => {
    for (const text of ["", null, undefined]) {
      const gates = extract(text);
      for (const key of FIELD_KEYS) {
        expectField(gates, key, null, "absent", DEFAULTS[key]);
      }
    }
  });

  it("treats a table with no pipes as no table", () => {
    const gates = extract(projectMd({ rows: ["Gate: Merge is required", "Plan approval is auto"] }));
    expectField(gates, "merge", null, "absent", "required");
    expectField(gates, "planApproval", null, "absent", "required");
  });

  it("tolerates rows with empty cells and bare pipes", () => {
    const rows = [GATE_HEADER, GATE_SEPARATOR, "|", "| | |", "|  |"];
    const gates = extract(projectMd({ rows }));
    expectField(gates, "merge", null, "absent", "required");
    expectField(gates, "planApproval", null, "absent", "required");
  });

  it("tolerates a row with fewer columns than the SETTING index", () => {
    const rows = ["| Gate | Allowed values | Setting |", "|--|--|--|", "| **Merge** |"];
    expectField(extract(projectMd({ rows })), "merge", null, "unparseable", "required");
  });

  it("tolerates a section that is completely empty", () => {
    const text = ["## Lifecycle Host", "", "## Human Gates", ""].join("\n");
    const gates = extract(text);
    for (const key of FIELD_KEYS) {
      expectField(gates, key, null, "absent", DEFAULTS[key]);
    }
  });
});

describe("extract - line endings", () => {
  it("parses CRLF input identically to LF input", () => {
    const lf = projectMd();
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(extract(crlf)).toEqual(extract(lf));
    expectField(extract(crlf), "merge", "required", "parsed", "required");
    expectField(extract(crlf), "reviewerFloor", "stop-and-ask", "parsed", "stop-and-ask");
  });

  it("parses a file with no trailing newline", () => {
    expect(extract(projectMd().replace(/\n+$/, ""))).toEqual(extract(projectMd()));
  });
});

describe("emitted output is ASCII-only", () => {
  // rules/scripting.md: a bundled script must never emit non-ASCII bytes, because a CI runner on a
  // non-UTF-8 locale raises `invalid byte sequence` the moment it reads or matches the output.
  it("keeps every exported label, default, and allowed value ASCII", () => {
    for (const key of FIELD_KEYS) {
      expect(LABELS[key]).toMatch(ASCII);
      expect(DEFAULTS[key]).toMatch(ASCII);
      expect(cliName(key)).toMatch(ASCII);
      for (const value of ALLOWED[key]) expect(value).toMatch(ASCII);
    }
  });

  it("keeps every reported line ASCII, for the shipped file and for broken fixtures", () => {
    const cases: HumanGates[] = [
      fromFile(join(REPO_ROOT, "PROJECT.md")),
      extract(projectMd()),
      extract(projectMd({ gatesSection: false, hostSection: false })),
      extract(projectMd({ merge: "auto", floor: "stop-and-ask", disposition: null })),
      extract(projectMd({ rows: [GATE_HEADER, GATE_SEPARATOR, mergeRow("`required`"), mergeRow("`auto`")] })),
      extract(""),
    ];
    for (const gates of cases) {
      const lines = report(gates);
      expect(lines).toHaveLength(FIELD_KEYS.length);
      for (const line of lines) expect(line).toMatch(ASCII);
    }
  });

  it("formats each reported line as `name: value (status)`", () => {
    expect(report(extract(projectMd()))).toEqual([
      "plan-approval: auto (parsed)",
      "merge: required (parsed)",
      "reviewer-degradation-floor: stop-and-ask (parsed)",
      "rule-suggestion-disposition: autonomous-fold (parsed)",
    ]);
  });

  it("prints `none` rather than an empty value when nothing was parsed", () => {
    expect(report(extract(""))).toEqual([
      "plan-approval: none (absent)",
      "merge: none (absent)",
      "reviewer-degradation-floor: none (absent)",
      "rule-suggestion-disposition: none (absent)",
    ]);
  });
});

describe("extract - a duplicated policy section can never false-green (PR #83 review, P1)", () => {
  // A vendoring that leaves two `## Human Gates` (or two `## Lifecycle Host`) sections must not let a
  // safe first section mask an unsafe second: `findIndex` would read only the first. Every declaration
  // the duplicated section carries reports `duplicate`, so `invalid()` is non-empty and parity reddens.
  const safeGates = [
    "## Human Gates",
    "",
    GATE_HEADER,
    GATE_SEPARATOR,
    planRow("`auto`"),
    mergeRow("`required`"),
    "",
    "### Rule-suggestion disposition",
    "",
    ...dispositionSentence("`autonomous-fold`"),
    "",
  ];
  const unsafeGates = [
    "## Human Gates",
    "",
    GATE_HEADER,
    GATE_SEPARATOR,
    planRow("`auto`"),
    mergeRow("`auto`"), // self-merge, the exact thing the boundary must reject
    "",
    "### Rule-suggestion disposition",
    "",
    ...dispositionSentence("`autonomous-fold`"),
    "",
  ];

  it("reports every gate-table + disposition field as duplicate when `## Human Gates` appears twice", () => {
    const text = ["# fixture", "", ...safeGates, ...unsafeGates].join("\n");
    const gates = extract(text);
    expectField(gates, "planApproval", null, "duplicate", "required");
    expectField(gates, "merge", null, "duplicate", "required");
    expectField(gates, "ruleDisposition", null, "duplicate", "present-to-hc");
  });

  it("does NOT let a safe first section hide a self-merge in the second (the security case)", () => {
    const text = ["# fixture", "", ...safeGates, ...unsafeGates].join("\n");
    const bad = invalid(extract(text)).map((b) => b.key);
    // Both gate rows and the disposition are flagged; a first-wins parser would have reported none.
    expect(bad).toContain("merge");
    expect(bad).toContain("planApproval");
    expect(bad).toContain("ruleDisposition");
  });

  it("reports the floor as duplicate when `## Lifecycle Host` appears twice", () => {
    const host = ["## Lifecycle Host", "", floorBullet("`stop-and-ask`"), ""];
    const hostSoftened = ["## Lifecycle Host", "", floorBullet("`flag-in-SOW`"), ""];
    const text = ["# fixture", "", ...host, ...hostSoftened, ...safeGates].join("\n");
    expectField(extract(text), "reviewerFloor", null, "duplicate", "stop-and-ask");
  });
});

describe("asciiSafe - user-derived values are ASCII-escaped before emission (PR #83 review, P2)", () => {
  it("escapes a non-ASCII value to `\\uXXXX`", () => {
    expect(asciiSafe("café")).toBe("caf\\u00e9");
    expect(asciiSafe("—")).toBe("\\u2014");
    expect(asciiSafe("ño")).toMatch(ASCII);
  });

  it("passes an ASCII value through unchanged and maps null to `none`", () => {
    expect(asciiSafe("stop-and-ask")).toBe("stop-and-ask");
    expect(asciiSafe(null)).toBe("none");
  });

  it("keeps report() output ASCII even when a parsed value contains a non-ASCII byte", () => {
    // A malformed declaration whose backticked value is non-ASCII must not leak a raw byte to stdout.
    const text = projectMd({ merge: "`autö`" });
    const lines = report(extract(text));
    for (const line of lines) expect(line).toMatch(ASCII);
    expect(lines.some((l) => l.includes("\\u00f6"))).toBe(true);
  });
});
