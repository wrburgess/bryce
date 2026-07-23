// human-gates.ts — the ONE place that derives the Human Gates policy declarations from PROJECT.md
// (ADR 0044). PROJECT.md is the single authored source; parsing lives here so it is unit-tested once
// and reused by `scripts/parity-check.ts` (verify) and by any tool that needs to know which lifecycle
// pauses require a human.
//
// Runs on the app's own Node/TS toolchain via `tsx` (ADR 0039), mirroring scripts/protected-branches.ts.
//
// Contract with PROJECT.md — FOUR declarations, all required:
//   A) `## Human Gates` holds a two-row gate table. A row is identified by its FIRST cell, stripped of
//      markdown emphasis (`**`, `*`) and backticks, lowercased, and matched by PREFIX against
//      `plan approval` / `merge` — the authored cells carry trailing prose after the label. The value
//      is the first `backticked` span in the SETTING column, located by a header cell whose stripped
//      text is `setting` (case-insensitive) and falling back to column index 1 when no header names
//      it. The section ends at the next `## ` H2 (the same boundary rule as protected-branches.ts).
//   B) The `- **Reviewer degradation floor:**` bullet under `## Lifecycle Host`. The value is the
//      first `backticked` span BEFORE the first ` — ` separator — exactly the protected-branches.ts
//      contract; text after the separator is human prose and is ignored.
//   C) The `### Rule-suggestion disposition` subsection nested inside `## Human Gates`, sliced from
//      its heading to the end of that section (i.e. to the next `## ` H2 or EOF). The value is read
//      from the DECLARING sentence — /shipped default is\s+`([^`]+)`/i — never a bare substring scan:
//      the subsection legitimately names the other allowed value later in its own prose, and a
//      substring search would false-green on it.
//   D) Every declaration must be PRESENT and PARSEABLE, not merely present.
//
// PARSE STATUS IS SEPARATE FROM THE EFFECTIVE VALUE. Each field reports a `status`:
//   parsed      — a backticked value was read
//   unparseable — the row/bullet/subsection IS there but no backticked value could be read from it
//                 (e.g. `| Merge | auto |`, written without backticks)
//   absent      — the row/bullet/subsection is not there at all
//   duplicate   — the same declaration appears more than once. This is an error EVEN WHEN the
//                 duplicated values agree: first-wins must never silently resolve a conflict.
// and, independently, an `effective` value that is fail-closed: the parsed value only when it is in
// range, otherwise the conservative default. Fail-closed means a malformed edit degrades toward MORE
// human oversight, never less. A consumer reads `effective`; a checker reads `status` + `value`, so a
// malformed declaration can never hide behind the default and pass.
//
// This module reports; it does not gate. `scripts/parity-check.ts` is the gate.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { argv } from "node:process";

const GATES_SECTION = "## Human Gates";
const HOST_SECTION = "## Lifecycle Host";
const DISPOSITION_HEADING = "### Rule-suggestion disposition";
const FLOOR_PREFIX = "- **Reviewer degradation floor:**";
const EM_DASH = "—";
const SETTING_HEADER = "setting";
const SETTING_FALLBACK_INDEX = 1;
const BACKTICKED = /`([^`]+)`/;
const DISPOSITION_DECLARATION = /shipped default is\s+`([^`]+)`/i;
const SEPARATOR_CELL = /^:?-+:?$/;

export type FieldStatus = "parsed" | "unparseable" | "absent" | "duplicate";

export interface Field {
  /** The parsed setting, or null when unparseable / absent / duplicated. */
  value: string | null;
  status: FieldStatus;
  /** Fail-closed value for consumers: the parsed value only when it is in range, else the default. */
  effective: string;
}

export type FieldKey = "planApproval" | "merge" | "reviewerFloor" | "ruleDisposition";

export type HumanGates = Record<FieldKey, Field>;

export const FIELD_KEYS: readonly FieldKey[] = [
  "planApproval",
  "merge",
  "reviewerFloor",
  "ruleDisposition",
];

/** Human-readable name of each declaration, as PROJECT.md words it. ASCII only (it is emitted). */
export const LABELS: Record<FieldKey, string> = {
  planApproval: "Plan approval",
  merge: "Merge",
  reviewerFloor: "Reviewer degradation floor",
  ruleDisposition: "Rule-suggestion disposition",
};

/** Fail-closed defaults: each is the setting that demands the MOST human oversight. */
export const DEFAULTS: Record<FieldKey, string> = {
  planApproval: "required",
  merge: "required",
  reviewerFloor: "stop-and-ask",
  ruleDisposition: "present-to-hc",
};

export const ALLOWED: Record<FieldKey, readonly string[]> = {
  planApproval: ["required", "auto"],
  merge: ["required"],
  reviewerFloor: ["stop-and-ask"],
  ruleDisposition: ["autonomous-fold", "present-to-hc"],
};

/** Gate-table row labels, matched by prefix against the normalized first cell. */
const GATE_ROW_LABELS: Record<"planApproval" | "merge", string> = {
  planApproval: "plan approval",
  merge: "merge",
};

function makeField(key: FieldKey, value: string | null, status: FieldStatus): Field {
  const inRange = value !== null && ALLOWED[key].includes(value);
  return { value, status, effective: status === "parsed" && inRange ? value : DEFAULTS[key] };
}

// Lines of a section: everything AFTER the heading line up to the next `## ` H2 (or EOF).
// Returns null when the heading is absent, so callers can tell "no section" from "empty section".
function sectionBody(lines: string[], heading: string): string[] | null {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ")); // the next H2 ends the section
  return end === -1 ? rest : rest.slice(0, end);
}

// Cells of a markdown table row, leading/trailing pipes dropped. Non-rows yield [].
function tableCells(line: string): string[] {
  let body = line.trim();
  if (!body.startsWith("|")) return [];
  if (body.endsWith("|")) body = body.slice(0, -1);
  body = body.slice(1);
  if (body === "") return [];
  return body.split("|");
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c.trim()));
}

// Strip markdown emphasis and backticks so `| **`Merge`** — prose |` matches the label `merge`.
function normalizeLabel(cell: string): string {
  return cell.replace(/[`*]/g, "").trim().toLowerCase();
}

function firstBackticked(text: string): string | null {
  const m = BACKTICKED.exec(text);
  const token = (m?.[1] ?? "").trim();
  return token === "" ? null : token;
}

function extractGateRows(body: string[] | null): Record<"planApproval" | "merge", Field> {
  if (body === null) {
    return {
      planApproval: makeField("planApproval", null, "absent"),
      merge: makeField("merge", null, "absent"),
    };
  }

  const rows = body.map(tableCells).filter((cells) => cells.length > 0);

  // Locate the SETTING column by its header cell; fall back to column index 1.
  let settingIndex = SETTING_FALLBACK_INDEX;
  for (const cells of rows) {
    if (isSeparatorRow(cells)) continue;
    const i = cells.findIndex((c) => normalizeLabel(c) === SETTING_HEADER);
    if (i !== -1) {
      settingIndex = i;
      break;
    }
  }

  const read = (key: "planApproval" | "merge"): Field => {
    const label = GATE_ROW_LABELS[key];
    const matches = rows.filter(
      (cells) => !isSeparatorRow(cells) && normalizeLabel(cells[0] ?? "").startsWith(label),
    );
    if (matches.length === 0) return makeField(key, null, "absent");
    if (matches.length > 1) return makeField(key, null, "duplicate");

    const value = firstBackticked((matches[0] as string[])[settingIndex] ?? "");
    return value === null ? makeField(key, null, "unparseable") : makeField(key, value, "parsed");
  };

  return { planApproval: read("planApproval"), merge: read("merge") };
}

function extractFloor(body: string[] | null): Field {
  const key: FieldKey = "reviewerFloor";
  if (body === null) return makeField(key, null, "absent");

  const bullets = body.filter((l) => l.trim().startsWith(FLOOR_PREFIX));
  if (bullets.length === 0) return makeField(key, null, "absent");
  if (bullets.length > 1) return makeField(key, null, "duplicate");

  // Drop prose after the ` — ` separator, then take the first backticked token.
  const head = (bullets[0] as string).split(` ${EM_DASH} `)[0] ?? "";
  const value = firstBackticked(head);
  return value === null ? makeField(key, null, "unparseable") : makeField(key, value, "parsed");
}

function extractDisposition(gatesBody: string[] | null): Field {
  const key: FieldKey = "ruleDisposition";
  if (gatesBody === null) return makeField(key, null, "absent");

  const headings = gatesBody
    .map((l, i) => ({ i, heading: l.trim().toLowerCase() === DISPOSITION_HEADING.toLowerCase() }))
    .filter((x) => x.heading)
    .map((x) => x.i);
  if (headings.length === 0) return makeField(key, null, "absent");
  if (headings.length > 1) return makeField(key, null, "duplicate");

  // The subsection runs from its heading to the end of `## Human Gates` (the next `## ` H2 or EOF).
  // Join before matching: the declaring sentence legitimately wraps across a line break.
  const text = gatesBody.slice((headings[0] as number) + 1).join("\n");
  const m = DISPOSITION_DECLARATION.exec(text);
  const value = (m?.[1] ?? "").trim();
  return value === "" ? makeField(key, null, "unparseable") : makeField(key, value, "parsed");
}

// Parse every Human Gates declaration out of PROJECT.md text. Deterministic; never throws.
export function extract(text: string | null | undefined): HumanGates {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));

  const gatesBody = sectionBody(lines, GATES_SECTION);
  const gates = extractGateRows(gatesBody);

  return {
    planApproval: gates.planApproval,
    merge: gates.merge,
    reviewerFloor: extractFloor(sectionBody(lines, HOST_SECTION)),
    ruleDisposition: extractDisposition(gatesBody),
  };
}

export function fromFile(path: string): HumanGates {
  return extract(readFileSync(path, "utf-8"));
}

export interface InvalidField {
  key: FieldKey;
  label: string;
  allowed: readonly string[];
  field: Field;
}

// Every declaration that is NOT a cleanly parsed, in-range value — so a caller can render a distinct
// message per failure kind (status vs out-of-range) instead of one catch-all.
export function invalid(fields: HumanGates): InvalidField[] {
  const out: InvalidField[] = [];
  for (const key of FIELD_KEYS) {
    const field = fields[key];
    if (field.status === "parsed" && field.value !== null && ALLOWED[key].includes(field.value)) {
      continue;
    }
    out.push({ key, label: LABELS[key], allowed: ALLOWED[key], field });
  }
  return out;
}

/** CLI-stable, greppable name for a declaration, e.g. `reviewer-degradation-floor`. */
export function cliName(key: FieldKey): string {
  return LABELS[key].toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// The lines the direct-run CLI prints: `name: value (status)`, one per declaration. ASCII only.
export function report(fields: HumanGates): string[] {
  return FIELD_KEYS.map((key) => {
    const field = fields[key];
    return `${cliName(key)}: ${field.value ?? "none"} (${field.status})`;
  });
}

// --- direct-run CLI --------------------------------------------------------
// Prints each declaration as `name: value (status)`.
//   --file PATH   PROJECT.md to read (default: ./PROJECT.md).
// Missing file => stderr `human-gates: no such file: {file}` + exit 1.
function main(args: string[]): number {
  let file = "PROJECT.md";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") {
      const val = args[++i];
      if (val === undefined) {
        process.stderr.write("human-gates: usage error - missing argument: --file\n");
        return 2;
      }
      file = val;
    } else if (arg !== undefined && arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else {
      process.stderr.write(`human-gates: usage error - invalid option: ${arg}\n`);
      return 2;
    }
  }

  if (!existsSync(file)) {
    process.stderr.write(`human-gates: no such file: ${file}\n`);
    return 1;
  }

  process.stdout.write(report(fromFile(file)).join("\n") + "\n");
  return 0;
}

// Main-module guard: run the CLI only when executed directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Set exitCode (don't process.exit) so buffered stdout drains before exit.
  process.exitCode = main(argv.slice(2));
}
