import { describe, expect, it } from "vitest";
import { parseAttribution } from "../../scripts/attribution.js";

const rows = [
  "| Agent (harness) | Identity email |",
  "|-----------------|----------------|",
  "| Claude Code | `noreply@anthropic.com` |",
  "| Codex | `<host sets>` |",
  "| Copilot | `<host sets>` |",
  "| Antigravity | `<host sets>` |",
  "| Grok Build | `<host sets>` |",
];

function project(attribution: string): string {
  return `# Fixture\n\n## Attribution & Model Declaration\n\n${attribution}\n\n## Next\n`;
}

function errors(attribution: string): readonly string[] {
  return parseAttribution(project(attribution)).errors;
}

describe("parseAttribution", () => {
  it("accepts the exact harness-to-email mapping, including host placeholders and duplicate emails", () => {
    const result = parseAttribution(project(rows.join("\n")));
    expect(result.errors).toEqual([]);
    expect(result.mappings).toHaveLength(5);
    expect(result.mappings.filter((mapping) => mapping.email === "`<host sets>`")).toHaveLength(4);
  });

  it.each([
    ["malformed header", ["| Harness | Identity email |", ...rows.slice(1)].join("\n"), "table header"],
    ["third column", rows.map((row) => `${row.slice(0, -1)} | Extra |`).join("\n"), "exactly two columns"],
    ["unknown harness", rows.join("\n").replace("| Codex |", "| Claude |"), "unknown harness"],
    ["missing harness", rows.slice(0, -1).join("\n"), "missing required harness `Grok Build`"],
    ["duplicate harness", [...rows, "| Codex | `another@example.test` |"].join("\n"), "duplicate harness `Codex`"],
    ["blank email", rows.join("\n").replace("| Codex | `<host sets>` |", "| Codex |  |"), "blank identity email"],
  ])("rejects a %s", (_name, table, message) => {
    expect(errors(table)).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
  });

  it("rejects duplicate attribution tables and sections", () => {
    expect(errors(`${rows.join("\n")}\n\n${rows.join("\n")}`)).toEqual(expect.arrayContaining([expect.stringContaining("exactly one Markdown table")]));
    expect(parseAttribution(`${project(rows.join("\n"))}\n## Attribution & Model Declaration\n\n${rows.join("\n")}`).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining("exactly one `## Attribution & Model Declaration` section")]));
  });

  it("rejects live declared/default reconciliation language", () => {
    expect(errors(`${rows.join("\n")}\n\nUse the Declared model.`))
      .toEqual(expect.arrayContaining([expect.stringContaining("must not prescribe a declared model/default")]));
  });
});
