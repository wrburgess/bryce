// Parser for the host-owned attribution identity mapping in PROJECT.md.
// The model is deliberately absent: artifact attribution records the runtime-actual value.

import { readFileSync } from "node:fs";

export const ATTRIBUTION_HEADING = "## Attribution & Model Declaration";
export const ATTRIBUTION_HEADER = ["Agent (harness)", "Identity email"] as const;
export const CANONICAL_HARNESSES = [
  "Claude Code", "Codex", "Copilot", "Antigravity", "Grok Build",
] as const;

export interface AttributionMapping {
  readonly harness: string;
  readonly email: string;
}

export interface AttributionParseResult {
  readonly mappings: readonly AttributionMapping[];
  readonly errors: readonly string[];
}

function sectionBodies(markdown: string): string[] {
  const lines = markdown.split("\n");
  const starts = lines
    .map((line, index) => line.trim() === ATTRIBUTION_HEADING ? index : -1)
    .filter((index) => index !== -1);
  return starts.map((start) => {
    const endRelative = lines.slice(start + 1).findIndex((line) => /^##\s/.test(line));
    const end = endRelative === -1 ? lines.length : start + 1 + endRelative;
    return lines.slice(start + 1, end).join("\n");
  });
}

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function tables(section: string): string[][][] {
  const found: string[][][] = [];
  let current: string[][] = [];
  for (const line of section.split("\n")) {
    const row = cells(line);
    if (row === null) {
      if (current.length > 0) found.push(current);
      current = [];
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) found.push(current);
  return found;
}

function isSeparator(row: readonly string[]): boolean {
  return row.length === 2 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Parse and validate the exact host attribution table without inventing a model default. */
export function parseAttribution(markdown: string): AttributionParseResult {
  const errors: string[] = [];
  const sections = sectionBodies(markdown);
  if (sections.length !== 1) {
    errors.push(`Attribution configuration must contain exactly one \`${ATTRIBUTION_HEADING}\` section (found ${sections.length})`);
    return { mappings: [], errors };
  }

  const section = sections[0] as string;
  const prohibited = [
    /\bdeclared model\b/i,
    /\bdeclared default\b/i,
    /\breconciling against\b[^\n]*(?:\bdeclared\b|\bdefault\b)/i,
  ];
  if (prohibited.some((pattern) => pattern.test(section))) {
    errors.push("Attribution configuration must not prescribe a declared model/default or reconciliation against one");
  }

  const found = tables(section);
  if (found.length !== 1) {
    errors.push(`Attribution configuration must contain exactly one Markdown table (found ${found.length})`);
    return { mappings: [], errors };
  }
  const table = found[0] as string[][];
  if (table.length < 2) {
    errors.push("Attribution configuration table must include a header and separator row");
    return { mappings: [], errors };
  }
  if (table.some((row) => row.length !== 2)) {
    errors.push("Attribution configuration table must have exactly two columns");
    return { mappings: [], errors };
  }
  if (table[0]?.join("|") !== ATTRIBUTION_HEADER.join("|")) {
    errors.push("Attribution configuration table header must be `Agent (harness) | Identity email`");
  }
  if (!isSeparator(table[1] as string[])) {
    errors.push("Attribution configuration table must have a two-column Markdown separator row");
  }

  const mappings = table.slice(2).map(([harness, email]) => ({ harness: harness as string, email: email as string }));
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.email === "") errors.push(`Attribution configuration has a blank identity email for \`${mapping.harness}\``);
    if (seen.has(mapping.harness)) errors.push(`Attribution configuration has duplicate harness \`${mapping.harness}\``);
    seen.add(mapping.harness);
    if (!CANONICAL_HARNESSES.includes(mapping.harness as typeof CANONICAL_HARNESSES[number])) {
      errors.push(`Attribution configuration has unknown harness \`${mapping.harness}\``);
    }
  }
  for (const harness of CANONICAL_HARNESSES) {
    if (!seen.has(harness)) errors.push(`Attribution configuration is missing required harness \`${harness}\``);
  }
  return { mappings, errors };
}

export function fromFile(path: string): AttributionParseResult {
  return parseAttribution(readFileSync(path, "utf-8"));
}
