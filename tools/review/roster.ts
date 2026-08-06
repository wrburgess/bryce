// Reads the reviewer roster out of config/review.md — the declaration stays the
// single source, and a reshaped table breaks here loudly rather than silently.

export interface Reviewer {
  name: string;
  mechanismCommand: string;
  responseKind: string;
  readinessCommand: string;
}

const ROSTER_HEADING = /^##\s+Reviewer roster\s*$/m;

function firstBacktick(cell: string, column: string): string {
  const m = cell.match(/`([^`]+)`/);
  if (!m) {
    throw new Error(
      `roster row carries no backticked command in its "${column}" column: ${cell.trim()}`,
    );
  }
  return m[1]!.trim();
}

export function parseRoster(markdown: string): Reviewer {
  const at = markdown.search(ROSTER_HEADING);
  if (at === -1) {
    throw new Error("config carries no '## Reviewer roster' section");
  }
  const section = markdown.slice(at).split(/\n##\s/)[0]!;
  const rows = section
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim());
  // rows[0] header, rows[1] separator, rows[2] first data row
  const data = rows.filter((r) => !/^\|[\s\-|]+\|$/.test(r)).slice(1);
  if (data.length === 0) {
    throw new Error("roster table carries no data row");
  }
  if (data.length > 1) {
    // Fail loud, never first-row-wins: silently dispatching the first reviewer
    // would make a declared second reviewer unreachable without a trace.
    throw new Error(
      `roster table carries ${data.length} rows and reviewer selection is not built yet — ` +
        "summoning is single-reviewer until selection lands",
    );
  }
  const cells = data[0]!
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length < 4) {
    throw new Error(`roster row carries ${cells.length} columns, expected 4`);
  }
  const [nameCell, mechanismCell, responseCell, readinessCell] = cells as [
    string,
    string,
    string,
    string,
  ];
  const bold = nameCell.match(/\*\*(.+?)\*\*/);
  return {
    name: bold ? bold[1]! : nameCell,
    mechanismCommand: firstBacktick(mechanismCell, "Mechanism"),
    responseKind: responseCell,
    readinessCommand: firstBacktick(readinessCell, "Readiness check"),
  };
}
