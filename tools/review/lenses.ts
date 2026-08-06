// Enforces the declared review bounds at dispatch: the lens set is selected
// from the menu and capped at the declared size (Chapter 2, *Bounded by lens
// set*; values in config/review.md). The declaration is read here so a run
// cannot exceed its bounds and still record as conforming.

const MENU_HEADING = /^##\s+Lens menu\s*$/m;
const SIZE_HEADING = /^##\s+Lens-set size\s*$/m;
const EMPTY_MARKER = /\*\*Empty — zero lenses\.?\*\*/;

function section(markdown: string, heading: RegExp, name: string): string {
  const at = markdown.search(heading);
  if (at === -1) {
    throw new Error(`config carries no '${name}' section`);
  }
  return markdown.slice(at).split(/\n##\s/)[0]!;
}

export function parseLensMenu(markdown: string): string[] {
  const body = section(markdown, MENU_HEADING, "## Lens menu");
  // Entries, when they exist, are backticked list items: - `the lens question`
  const entries = [...body.matchAll(/^\s*-\s+`([^`]+)`/gm)].map((m) => m[1]!.trim());
  const markedEmpty = EMPTY_MARKER.test(body);
  if (markedEmpty && entries.length > 0) {
    // Neither side silently wins: a stale marker beside real entries is a
    // malformed declaration, and resolving it is the declaration's job.
    throw new Error(
      "lens menu contradicts itself — it carries the empty marker and " +
        `${entries.length} entr${entries.length === 1 ? "y" : "ies"}; fix the declaration`,
    );
  }
  if (markedEmpty) return [];
  if (entries.length === 0) {
    throw new Error(
      "lens menu is neither the empty marker nor recognizable entries — " +
        "teach parseLensMenu the menu's shape before dispatching",
    );
  }
  return entries;
}

export function parseLensSetSize(markdown: string): number {
  const body = section(markdown, SIZE_HEADING, "## Lens-set size");
  const m = body.match(/\*\*(\d+)\s+lens/);
  if (!m) {
    throw new Error("lens-set size declaration carries no '**N lens…**' value");
  }
  return Number(m[1]);
}

// Canon's own lenses for prose subjects — pinned copies of the phrases in
// Chapter 2 → *Verifying prose*, drift-guarded by the test that asserts each
// against the section. A canon pull request is summoned with these; they are
// canon-sourced, not menu-derived, so an empty menu strands no canon subject.
export const PROSE_LENSES: readonly string[] = [
  "restatement of content another document owns",
  "contradiction with ratified canon",
  "a term used with no Glossary entry behind it",
  "drift between a copy and its source",
];

export function checkLensSelection(
  chosen: string[],
  menu: string[],
  size: number,
  proseSubject: boolean,
): string[] {
  const errors: string[] = [];
  for (const lens of chosen) {
    if (menu.includes(lens)) continue;
    if (PROSE_LENSES.includes(lens)) {
      if (!proseSubject) {
        // Prose lenses are canon-sourced for canon subjects only — accepting
        // them everywhere would let a code review bypass the menu.
        errors.push(
          `prose lens summoned for a non-prose subject: ${lens} — declare the subject prose, or select from the menu`,
        );
      }
      continue;
    }
    errors.push(
      `lens is not on the menu and cannot be summoned: ${lens} — ` +
        "the menu derives from the class index and canon names the prose lenses; " +
        "a one-off lens enters as a dated menu entry, never as a bypass",
    );
  }
  if (chosen.length > size) {
    errors.push(
      `${chosen.length} lenses chosen, over the declared lens-set size of ${size}`,
    );
  }
  return errors;
}
