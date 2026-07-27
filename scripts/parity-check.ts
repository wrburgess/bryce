// parity-check.ts — structural parity check for the Config Bundle (ADR 0008; ported to TypeScript per
// ADR 0039).
//
// Verifies, WITHOUT any model-in-the-loop testing, that every per-tool Adapter still resolves to the
// Canonical Source and that the Project Config is structurally intact. Runs on the app's own Node/TS
// toolchain via `tsx`.
//
// Usage:
//   npx tsx scripts/parity-check.ts [--root DIR]
//     --root DIR   Directory to check (default: current directory). Used by the self-test to point
//                  the checker at fixture bundles.
//
// Exit status: 0 when every invariant holds; 1 when any fails (all failures are printed).
//
// Adapter marker conventions (kept in lockstep with AGENTS.md / PROJECT.md):
//   Native-discovery adapter:  <!-- parity:native source=AGENTS.md -->
//   Rendered adapter:          <!-- parity:render source=AGENTS.md --> … <!-- parity:endrender -->
//                              (the region between the markers must equal AGENTS.md byte-for-byte)

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, dirname, sep, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { fromFile as protectedBranchesFromFile } from "./protected-branches.js";
import {
  fromFile as humanGatesFromFile,
  invalid as invalidHumanGates,
  asciiSafe as asciiSafeGateValue,
  DEFAULTS as DEFAULT_HUMAN_GATES,
} from "./human-gates.js";
import { fromFile as attributionFromFile } from "./attribution.js";
import { Parser, type Node } from "commonmark";

const CANONICAL = "AGENTS.md";

const IMPORT_ADAPTERS = ["CLAUDE.md", "GEMINI.md"];
const NATIVE_CAPABLE_ADAPTERS = ["GEMINI.md"];
const COPILOT_ADAPTER = ".github/copilot-instructions.md";
const PROJECT_CONFIG = "PROJECT.md";

// The Adapter surface `checkRenderedRegions` scans for a `parity:render` block. This was once the same
// list as the dead-link scope; issue #159 split them because they answer different questions. A render
// marker is an ADAPTER concern, so folding it into the (much wider) link scope would silently start
// scanning ~30 more files for a marker that has no business appearing in them.
const RENDER_SCANNED = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "PROJECT.md",
  ".github/copilot-instructions.md",
  "README.md",
  "docs/standards/development-lifecycle.md",
  "docs/guides/usage.md",
  "docs/guides/branch-protection.md",
  "docs/cli/README.md",
  "docs/api/README.md",
  "docs/mcp/README.md",
];

// The AUTHORED seed of the dead-link scope; `linkCheckedFiles()` derives the rest. Every render-scanned
// file is also link-checked (the containment runs one way only, which is why this is derived rather
// than a second hand-kept copy), plus the two prose-heavy documents that have no other home.
const LINK_CHECKED = [
  ...RENDER_SCANNED,
  "CONTEXT.md",
  "docs/rules/README.md",
];

const GUIDES_DIR = "docs/guides";
const REQUIRED_GUIDES = ["docs/guides/usage.md"];

// Exported so the self-test fixture names this directory from the same source the checker does, rather
// than mirroring the literal and drifting from it (issue #163).
export const ADR_DIR = "docs/adr";
const ADR_FILENAME = /^(\d+)-.+\.md$/;
const ADR_LINK_LABEL = /^ADR (\d{4})$/;
const ADR_LINK_TARGET = /^(\d{4})-[^/]+\.md$/;
const MARKDOWN_SCAN_EXCLUDED_DIRS = new Set([".git", "node_modules", ".claude/worktrees", ".codex-worktrees"]);

const RULES_DIR = "rules";
const REQUIRED_RULES = [
  "rules/backend.md", "rules/frontend.md", "rules/testing.md",
  "rules/security.md", "rules/self-review.md", "rules/scripting.md", "rules/skills.md",
];
const RULE_REQUIRED_SECTIONS = ["## Patterns", "## Anti-Patterns"];

// Tier-2 deep docs referenced from a Tier-1 rule file (issue #148). The token is matched only in
// its bare form so an absolute path, a `../` traversal, or a URL containing it is ignored by the
// caller; `DEEP_DOC_LINKED` recognizes the two markdown-link shapes — inline `](path)` and a
// reference definition `[label]: path` — that the convention forbids for these paths.
const DEEP_DOC_LABEL = "**Deep doc:**";
const DEEP_DOC_TOKEN = /docs\/rules\/[a-z0-9-]+-postmortems\.md(?:#[A-Za-z0-9._-]+)?/g;
// A link opener may be followed by a relative prefix before the token — `](../docs/rules/x.md)` is
// the spelling a contributor writing from `rules/` would actually reach for, so the link form must
// be recognized THROUGH `./`, `../`, and `/` rather than mistaken for an unresolvable path. The
// prefix is CAPTURED, not just matched: a link's href is `prefix + token`, and the href is what has
// to resolve from the referring file (issue #154).
const DEEP_DOC_LINKED = /\](?:\(|:)\s*((?:\.{0,2}\/)*)$/;
const RULES_DEEP_DOC_README = "docs/rules/README.md";

// --- Tier-1 accretion guard (issue #152, ADR 0051) -------------------------
//
// The invariant is "Tier 1 carries the lesson, Tier 2 carries the narrative" (docs/rules/README.md).
// This measures it PER BULLET rather than per file, because a per-file byte budget cannot tell a dense
// lesson from an embedded case study: PR #150 added three genuinely new invariants that a byte budget
// would have reddened, while the tree's worst inline narrative sat untouched in a file that budget
// blessed. A bullet carrying its domain's case-study pointer is exempt at ANY length, so this never
// asks more of an already-trimmed bullet (the longest such bullet today is 604 chars).
export const NARRATIVE_MAX_CHARS = 600;

// Group 1 is the bolded imperative, used verbatim as the allowlist key. `exec`-based (no /g) so there
// is no shared-lastIndex hazard across the lines it is applied to.
//
// The marker is matched the way CommonMark defines it, NOT as the literal four bytes `- **` today's
// files happen to use: any of `-`/`*`/`+`, one or more spaces or a tab, and optional leading indent.
// A regex demanding exactly one space makes `-  **Never ...**` -- one accidental keystroke, rendering
// identically for a reader -- completely invisible to this guard, which is a silent false green
// reachable without any adversarial intent. Matching more marker spellings can only add coverage.
const RULE_BULLET = /^\s*[-*+][ \t]+\*\*(.+?)\*\*/;

// A line that opens a new block ends the preceding bullet. Kept in lockstep with RULE_BULLET's marker
// set, so a spelling this guard measures is also a spelling that terminates its predecessor.
//
// Each alternative demands exactly the padding CommonMark demands, no more and no less. The ATX
// heading rule is the one that bites: `#` NOT followed by a space, a tab, or end-of-line is not a
// heading at all -- `#152` is literal text. Treating it as a block opener would end the bullet at any
// wrap that happened to break before an issue reference, and these files are made of issue references,
// so the remainder of the bullet would be counted toward nothing at all. Seven or more hashes is not a
// heading either, and falls out of the same bound.
//
// The list markers take `$` for the same reason in the other direction: a bare `-`, `*`, `+`, or `1.`
// alone on a line opens an EMPTY list item in CommonMark, so it ends the preceding bullet rather than
// continuing it. A blockquote `>` and a fence genuinely need no following space and take none.
const RULE_BLOCK_OPENER = /^\s*(?:[-*+](?:[ \t]|$)|\d+\.(?:[ \t]|$)|#{1,6}(?:[ \t]|$)|```|>)/;

// Each Tier-1 rule's own domain deep doc, or `null` for a rule that has none BY DESIGN
// (docs/rules/README.md records self-review as "(none - the checklist is the whole rule)").
// A bullet is exempted only by ITS OWN domain's deep doc: accepting any `docs/rules/*-postmortems.md`
// would let a rules/backend.md bullet be silenced by appending an unrelated domain's path.
//
// `null` is NOT the same state as "declared here but not yet written on disk" — three of these files
// do not exist yet (docs/rules/README.md: deep docs are "absent until a host has a real postmortem to
// record"), and pointing at an absent one trips checkRulesPointers(). The remedy this check advises is
// therefore chosen from the path's state on disk, never from this table alone.
export const RULE_DEEP_DOC: Record<string, string | null> = {
  "rules/backend.md": "docs/rules/backend-postmortems.md",
  "rules/frontend.md": "docs/rules/frontend-postmortems.md",
  "rules/testing.md": "docs/rules/testing-postmortems.md",
  "rules/security.md": "docs/rules/security-postmortems.md",
  "rules/self-review.md": null,
  "rules/scripting.md": "docs/rules/scripting-postmortems.md",
  "rules/skills.md": "docs/rules/skills-postmortems.md",
};

// The bullets that already exceeded the limit when the guard landed, keyed by file and by the bullet's
// exact bolded imperative. Keying on the imperative rather than a line number is deliberate: a line
// number silently re-points at whatever bullet later occupies that line, which is the false green this
// guard exists to prevent.
//
// This table only ever SHRINKS. Deleting an entry (by trimming its bullet) is welcome and requires no
// other edit; ADDING one is a deliberate, reviewable act. An entry that is stale, ambiguous, or no
// longer needed is itself an error, so the backlog cannot quietly stop shrinking -- the same
// fail-closed discipline scripts/coverage-floors.ts applies to a floored path missing from the report.
//
// The ratchet has already been exercised once, before this guard even merged. The baseline was eight
// bullets, five of them in rules/backend.md; issue #151 then trimmed exactly those five on main, and
// this check turned RED demanding their removal until they were deleted here -- which is the mechanism
// working, not a merge accident. In the same window two OTHER bullets grew past the limit on main
// (rules/scripting.md and rules/skills.md), so the list is now five. That churn, in the days it took to
// review this guard, is the clearest possible restatement of why issue #152 was filed.
export const NARRATIVE_ALLOWLIST: Record<string, readonly string[]> = {
  "rules/security.md": [
    "Never reuse a *coercing* validator at a typed-JSON boundary",
  ],
  "rules/scripting.md": [
    "Never emit non-ASCII bytes from a bundled script's stdout/stderr",
    "Never widen a guard's matching rule to clear a false alarm without asking which way the new failure points",
    "Never ship a guard without first running its own governing convention through it",
  ],
  "rules/skills.md": [
    "Never trim length by moving a load-bearing instruction behind a link",
  ],
};

const SKILLS_DIR = "skills";
const CLAUDE_COMMANDS_DIR = ".claude/commands";
const LIFECYCLE_SKILLS = ["assess", "devise", "invoke", "verify", "listen", "final"];
const REQUIRED_SKILLS = ["distill", ...LIFECYCLE_SKILLS, "ship", "create-skill"];

const HOST_SPECIFIC_TOKENS = [
  "Searchkick", "Elasticsearch", "Pundit", "Devise", "Kamal", "SimpleCov",
  "strong_migrations", "Ransack", "Markaz", "admin_root_path", "SKIP_TITLE_REINDEX",
  "rubocop", "rspec", "brakeman", "bundler-audit", ".claude/rules/", "docs/rules/",
];

const REQUIRED_PROJECT_SECTIONS = [
  "## Quality Checks",
  "## Attribution & Model Declaration",
  "## Branch & PR Policy",
  "## Review Severity Framework",
  "## Lifecycle Host",
  "## Human Gates",
];

const SIDECAR = ".githooks/protected-branches";
const GUARDRAIL_FILES = [
  ".githooks/pre-commit", ".githooks/pre-push", ".githooks/pre-merge-commit", ".githooks/pre-rebase",
  "bin/guard-protected-branch", "bin/install-git-hooks", "bin/protected-branches",
  ".claude/hooks/enforce-branch-creation.sh", ".claude/settings.json",
];

// `^`/`$` are line-anchored (m flag) to mirror Ruby's default multiline `^`/`$` in IMPORT_TOKEN.
const IMPORT_TOKEN = /(?:^|\s)@AGENTS\.md(?:\s|$)/m;
// Markers are recognized only when alone on their own line — tested against a stripped line.
const NATIVE_MARKER = /^<!--\s*parity:native\s+source=AGENTS\.md\s*-->$/;
const RENDER_OPEN = /^<!--\s*parity:render\s+source=AGENTS\.md\s*-->$/;
const RENDER_CLOSE = /^<!--\s*parity:endrender\s*-->$/;

// Ruby String#strip / #rstrip equivalents.
const strip = (s: string): string => s.replace(/^\s+/, "").replace(/\s+$/, "");
const rstrip = (s: string): string => s.replace(/\s+$/, "");

// Ruby String#lines: split on "\n" but KEEP the trailing newline on each element (needed for the
// byte-exact rendered-region reconstruction). "" -> [].
function toLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i < parts.length - 1) lines.push(parts[i] + "\n");
    else if (parts[i] !== "") lines.push(parts[i] as string);
  }
  return lines;
}

// Ruby Array#inspect for an array of plain strings: ["a", "b"].
function inspectArray(arr: string[]): string {
  const esc = (s: string) =>
    '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
  return "[" + arr.map(esc).join(", ") + "]";
}

// --- Links come from a parser, not a regex (issue #159, ADR 0054) ---------------------------------
//
// `rules/security.md` writes `![x](url)` while TEACHING escaping; `docs/rules/README.md` writes
// `[text](path)` four times while teaching the deep-doc form rule. Those are prose ABOUT markdown, and
// resolving them as hrefs is a false RED — which is exactly why both files sat outside the dead-link
// scope entirely, an unchecked gap that announced itself to nobody (rules/scripting.md: nothing tells
// you it isn't checking).
//
// A link inside a code span or a fenced block is not a link because IT IS NOT A NODE. The parser settles
// that, and every question like it, by construction. ADR 0054 records why this is a parser rather than
// the hand-rolled masker it replaced: five independent review rounds of PR #162 each found a silent
// FALSE GREEN in that masker — a link the reference parser renders live that the masker hid — and two of
// the five were introduced while fixing the round before. Enumerating CommonMark's block structure in
// regexes is a game a structural checker cannot win, and every loss is invisible.
//
// The dependency is deliberate and narrow: `commonmark` is a devDependency used by tooling only, never
// by the app, under the host opt-in in rules/scripting.md (ADR 0039) that scopes `scripts/*.ts` to the
// app's own toolchain. The masker it replaces was ~180 lines with five known-and-fixed defect classes.
const MARKDOWN_PARSER = new Parser();

export interface MarkdownLink {
  /** The link's visible text, with code spans flattened — what `[ADR 0007](...)` shows a reader. */
  readonly label: string;
  /** The href, already unescaped by the parser. */
  readonly destination: string;
}

/**
 * Flatten a node's rendered text, WHITESPACE-NORMALIZED, so `[`ADR 0007`](…)`, `[ADR 0007](…)` and a
 * copy of either that a formatter has wrapped all produce the same label.
 *
 * Three inline node types carry an effect but no literal — `softbreak` (a wrap), `linebreak` (a hard
 * break), and `html_inline` (e.g. an inline comment). Skipping them concatenates the runs either side,
 * so `[ADR\n0007](…)` or `[ADR<!-- c -->0007](…)` flattens to `ADR0007`, which `ADR_LINK_LABEL` does not
 * match — and the citation check then silently decides this is not a citation at all and never compares
 * its number to the target. A false green reachable by a formatter or a hand wrap, with no error
 * anywhere (PR #162 delta rounds 6 and 7).
 *
 * Each becomes a space, and the result is then collapsed and trimmed. The normalization is not
 * decoration: emitting a space for `html_inline` is what a reader does NOT see (a comment renders to
 * nothing), so without a trim, `[ADR 0007<!-- note -->](…)` would gain a trailing space and stop
 * matching — trading round 6's false green for a new one. Both halves are needed, and both fail toward
 * MORE checking, which is the direction `rules/scripting.md` asks for.
 *
 * `emph` and `strong` need no case: they are pure containers whose `text` children are already walked.
 */
function nodeText(node: Node): string {
  let text = "";
  const walker = node.walker();
  let event = walker.next();
  while (event !== null) {
    if (event.entering) {
      const type = event.node.type;
      if (type === "text" || type === "code") text += event.node.literal ?? "";
      else if (type === "softbreak" || type === "linebreak" || type === "html_inline") text += " ";
    }
    event = walker.next();
  }
  return strip(text.replace(/\s+/g, " "));
}

/**
 * Undo the parser's URI normalization so a destination names a path on disk again.
 *
 * CommonMark normalizes destinations for rendering — `[t](<a path.md>)` comes back as `a%20path.md` —
 * which is right for an href and wrong for `statSync`. Decoding is attempted, never assumed: a malformed
 * escape throws, and the raw text is the better answer then. No file in the repo needs this today; it is
 * here because the parser silently introduced the difference, and a path that fails to resolve for an
 * invisible reason is the least debuggable failure this checker can produce.
 */
function decodeDestination(destination: string): string {
  if (!destination.includes("%")) return destination;
  try {
    return decodeURIComponent(destination);
  } catch {
    return destination;
  }
}

/**
 * Every inline link and image in `source`, in document order.
 *
 * IMAGES are included because the old regex could not tell `![alt](x.png)` from `[alt](x.png)` and so
 * checked both; an image href is a path that can rot exactly like a link's, so this keeps the coverage
 * rather than narrowing it on a technicality.
 *
 * REFERENCE links (`[text][ref]`) resolve here and never did before — the parser hands back the
 * definition's destination. That is new coverage, not a behavior change to argue about.
 */
export function markdownLinks(source: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const walker = MARKDOWN_PARSER.parse(source).walker();

  let event = walker.next();
  while (event !== null) {
    const node = event.node;
    if (event.entering && (node.type === "link" || node.type === "image")) {
      links.push({ label: nodeText(node), destination: decodeDestination(node.destination ?? "") });
    }
    event = walker.next();
  }
  return links;
}

/** Immediate subdirectory names of `absolute`, sorted; empty when it is not a readable directory. */
function subdirectories(absolute: string): string[] {
  try {
    return readdirSync(absolute)
      .sort()
      .filter((child) => {
        try {
          return statSync(join(absolute, child)).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Immediate `.md` file names in `absolute`, sorted; empty when it is not a readable directory. */
function markdownFilesIn(absolute: string): string[] {
  try {
    return readdirSync(absolute)
      .sort()
      .filter((child) => {
        if (!child.endsWith(".md")) return false;
        try {
          return statSync(join(absolute, child)).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * The files whose markdown links `checkLinks` resolves (issue #159).
 *
 * DERIVED, not hand-kept, for everything below the authored seed: a tenth Skill or a new command shim is
 * link-checked the day it lands, with nobody having to remember a list. The alternative — the twelve
 * hardcoded paths this replaced — is how `rules/*.md` went unchecked for its entire life while carrying
 * links the whole time.
 *
 * `docs/adr/*.md` joined in issue #163. It was excluded when the scope widened because it was holding two
 * dead links whose repair meant editing accepted ADRs — a records decision rather than a validator one.
 * That decision is now made and recorded (ADR 0055: an ADR's argument is immutable, the paths it cites are
 * maintained), the two links are repaired, and the exclusion has no remaining rationale.
 *
 * TOP-LEVEL ONLY, deliberately: `checkAdrNumbers` reads the same directory non-recursively and is what
 * DEFINES an ADR in this repo, so a nested `docs/adr/archive/0056-*.md` is already outside the numbering
 * authority. Giving the link scope a wider reach than the numbering scope would be the inconsistency, not
 * the fix. A test pins the exclusion so widening it later is a deliberate act.
 *
 * A path listed here but absent from disk is skipped by the caller, so the derivation is safe against a
 * bundle that ships a subset.
 */
export function linkCheckedFiles(root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };

  for (const rel of LINK_CHECKED) add(rel);
  for (const rel of REQUIRED_RULES) add(rel);
  for (const name of subdirectories(join(root, SKILLS_DIR))) add(`${SKILLS_DIR}/${name}/SKILL.md`);
  for (const name of markdownFilesIn(join(root, CLAUDE_COMMANDS_DIR))) add(`${CLAUDE_COMMANDS_DIR}/${name}`);
  for (const name of markdownFilesIn(join(root, ADR_DIR))) add(`${ADR_DIR}/${name}`);

  return out;
}

export interface ParityResult {
  readonly status: 0 | 1;
  readonly errors: readonly string[];
  readonly skillCount: number;
}

class ParityCheck {
  private readonly root: string;
  private readonly errors: string[] = [];

  constructor(root: string) {
    this.root = root;
  }

  run(): ParityResult {
    this.checkCanonicalExists();
    this.checkImportAdapters();
    this.checkCopilotAdapter();
    this.checkRenderedRegions();
    this.checkProjectSections();
    this.checkAttribution();
    this.checkHumanGates();
    this.checkRules();
    this.checkRulesPointers();
    this.checkRulesNarrative();
    this.checkSkills();
    this.checkGuardrails();
    this.checkGuides();
    this.checkAdrNumbers();
    this.checkAdrLinkNumbers();
    this.checkLinks();
    return {
      status: this.errors.length === 0 ? 0 : 1,
      errors: this.errors.slice(),
      skillCount: this.dirExists(SKILLS_DIR) ? this.presentSkills().length : 0,
    };
  }

  private path(rel: string): string {
    return join(this.root, rel);
  }

  private exists(rel: string): boolean {
    try {
      return statSync(this.path(rel)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Resolve `href` the way Markdown does — relative to the DIRECTORY OF THE REFERRING FILE, not the
   * repo root — and report whether it lands on a real file inside the repo. `exists()` above answers
   * the other question (does this repo-root path exist), and the two are deliberately distinct: a
   * backticked path is prose naming a repo path, a link is a link (issue #154).
   *
   * An href that escapes the repo (a root-absolute `/docs/...`, or a `../../` that climbs past the
   * root) is never a resolvable intra-repo link, so it is rejected WITHOUT consulting the disk. That
   * is a correctness rule first — such a link is broken on the lifecycle host however the runner's
   * filesystem happens to look — and it is what keeps the verdict from depending on files that
   * happen to exist outside the checkout (rules/testing.md: an environment-dependent assertion is
   * green on one machine and red on another).
   */
  private resolvesFrom(rel: string, href: string): boolean {
    const root = resolvePath(this.root);
    const resolved = resolvePath(dirname(this.path(rel)), href);
    if (resolved !== root && !resolved.startsWith(root + sep)) return false;
    try {
      return statSync(resolved).isFile();
    } catch {
      return false;
    }
  }

  private dirExists(rel: string): boolean {
    try {
      return statSync(this.path(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  private read(rel: string): string {
    return readFileSync(this.path(rel), "utf-8");
  }

  private err(msg: string): void {
    this.errors.push(msg);
  }

  private checkCanonicalExists(): void {
    if (!this.exists(CANONICAL)) {
      this.err(`Canonical Source missing: ${CANONICAL} not found`);
    } else if (strip(this.read(CANONICAL)) === "") {
      this.err(`Canonical Source empty: ${CANONICAL} has no content`);
    }
  }

  private checkImportAdapters(): void {
    for (const adapter of IMPORT_ADAPTERS) {
      if (!this.exists(adapter)) {
        this.err(`Import Adapter missing: ${adapter} not found`);
        continue;
      }
      const body = this.read(adapter);
      if (IMPORT_TOKEN.test(body)) continue;

      if (NATIVE_CAPABLE_ADAPTERS.includes(adapter)) {
        if (body.split("\n").some((l) => NATIVE_MARKER.test(strip(l)))) continue;

        this.err(
          `Adapter ${adapter} neither imports the Canonical Source (\`@${CANONICAL}\`) nor declares ` +
          `native discovery (expected an \`@${CANONICAL}\` line or a \`parity:native source=${CANONICAL}\` marker)`,
        );
      } else {
        this.err(`Import Adapter ${adapter} does not import the Canonical Source (expected an \`@${CANONICAL}\` line)`);
      }
    }
    if (!this.exists(CANONICAL)) {
      this.err(`Import target missing: adapters reference @${CANONICAL} but ${CANONICAL} not found`);
    }
  }

  private checkCopilotAdapter(): void {
    if (!this.exists(COPILOT_ADAPTER)) {
      this.err(`Copilot Adapter missing: ${COPILOT_ADAPTER} not found`);
      return;
    }
    const markerLines = this.read(COPILOT_ADAPTER).split("\n").map(strip);
    const native = markerLines.some((l) => NATIVE_MARKER.test(l));
    const render = markerLines.some((l) => RENDER_OPEN.test(l));
    if (!(native || render)) {
      this.err(`Copilot Adapter ${COPILOT_ADAPTER} has neither a \`parity:native\` marker nor a \`parity:render\` block`);
    }
  }

  private checkRenderedRegions(): void {
    if (!this.exists(CANONICAL)) return;

    const canonical = this.read(CANONICAL);
    for (const rel of RENDER_SCANNED) {
      if (!this.exists(rel)) continue;

      const lines = toLines(this.read(rel));
      const openI = lines.findIndex((l) => RENDER_OPEN.test(strip(l)));
      if (openI === -1) continue;

      const closeRel = lines.slice(openI + 1).findIndex((l) => RENDER_CLOSE.test(strip(l)));
      if (closeRel === -1) {
        this.err(`Rendered region in ${rel} opens with \`parity:render\` but has no \`parity:endrender\` close`);
        continue;
      }
      const closeI = closeRel + openI + 1;
      const captured = lines.slice(openI + 1, closeI).join("");
      if (captured !== canonical) {
        this.err(`Rendered region in ${rel} does not match ${CANONICAL} byte-for-byte (drift)`);
      }
    }
  }

  private checkProjectSections(): void {
    if (!this.exists(PROJECT_CONFIG)) {
      this.err(`Project Config missing: ${PROJECT_CONFIG} not found`);
      return;
    }
    const headings = this.read(PROJECT_CONFIG).split("\n").map(rstrip);
    for (const section of REQUIRED_PROJECT_SECTIONS) {
      if (!headings.includes(section)) {
        this.err(`Project Config ${PROJECT_CONFIG} missing required section: \`${section}\``);
      }
    }
  }

  // The one place parity asserts VALUES rather than heading presence: the Human Gates declarations
  // are policy boundaries a Host App must not be free to change (docs/guides/authoring-the-bundle.md).
  // Parse status is checked separately from the value, so a setting written without backticks reports
  // `unparseable` instead of silently falling back to the fail-closed default and passing.
  private checkHumanGates(): void {
    // Existence guard: checkProjectSections() only RECORDS the missing-file error and returns, so
    // without this a readFileSync here would throw ENOENT and abort the whole aggregate report.
    if (!this.exists(PROJECT_CONFIG)) return;

    for (const bad of invalidHumanGates(humanGatesFromFile(this.path(PROJECT_CONFIG)))) {
      const allowed = bad.allowed.map((v) => `\`${v}\``).join(" | ");

      if (bad.field.status !== "parsed") {
        this.err(
          `Human Gates declaration \`${bad.label}\` in ${PROJECT_CONFIG}: ${bad.field.status} ` +
          `(expected exactly one declaration carrying a backticked value, one of ${allowed}) - the ` +
          `fail-closed default \`${DEFAULT_HUMAN_GATES[bad.key]}\` applies until it is fixed`,
        );
        continue;
      }

      if (bad.key === "merge") {
        this.err(
          `Human Gates: \`Merge\` is declared \`${asciiSafeGateValue(bad.field.value)}\` in ` +
          `${PROJECT_CONFIG} but \`required\` is its only allowed value - no Host App may express ` +
          `self-merge; a human always merges the delivered PR`,
        );
      } else if (bad.key === "reviewerFloor") {
        this.err(
          `Human Gates: \`Reviewer degradation floor\` is declared ` +
          `\`${asciiSafeGateValue(bad.field.value)}\` in ${PROJECT_CONFIG} but \`stop-and-ask\` is ` +
          `its only allowed value - a run that cannot obtain an independent review may not certify itself`,
        );
      } else {
        this.err(
          `Human Gates declaration \`${bad.label}\` in ${PROJECT_CONFIG} has value ` +
          `\`${asciiSafeGateValue(bad.field.value)}\`, which is not allowed - allowed values: ${allowed}`,
        );
      }
    }
  }

  private checkAttribution(): void {
    if (!this.exists(PROJECT_CONFIG)) return;
    for (const error of attributionFromFile(this.path(PROJECT_CONFIG)).errors) this.err(error);
  }

  private checkRules(): void {
    if (!this.dirExists(RULES_DIR)) return;

    const agents = this.exists(CANONICAL) ? this.read(CANONICAL) : "";
    for (const rel of REQUIRED_RULES) {
      if (!this.exists(rel)) {
        this.err(`Tier-1 rule missing: ${rel} not found`);
        continue;
      }
      if (!agents.includes(rel)) {
        this.err(`Tier-1 rule ${rel} is not referenced by ${CANONICAL} (the Lean Core must be reachable from the Canonical Source)`);
      }
      const headings = this.read(rel).split("\n").map(rstrip);
      for (const section of RULE_REQUIRED_SECTIONS) {
        if (!headings.includes(section)) {
          this.err(`Tier-1 rule ${rel} missing required section: \`${section}\``);
        }
      }
    }
  }

  // The invariant (issue #154, refining #148): EVERY Tier-2 deep-doc path named in a Tier-1 rule
  // file must point at a file that is really there — a BARE path at the repo root (this.exists), a
  // LINK at wherever the link actually leads (this.resolvesFrom). Two bases, one requirement; the
  // paragraph below says why they differ. The single exception is a BARE-PATH `**Deep doc:**`
  // header declaration, which may forward-reference a deep doc that does not exist yet.
  //
  // Why it still matters now that `rules/*.md` IS link-checked (issue #159): checkLinks() validates the
  // LINK form only, and the convention's default form for a deep doc is a BACKTICKED path — precisely so
  // a pointer can be written before its target lands without reddening the gate. Nothing but this check
  // ever resolves a backticked path, and a Tier-1 bullet pointing at a deep doc stands in for content
  // that was MOVED there, so a broken bare pointer still loses the case study with nothing else to
  // notice. The two checks are complementary, not redundant.
  //
  // Corollary, and the reason the fenced-line walk below is NOT replaced by markdownLinks(): this check
  // exists to READ backticked text, which an AST walk does not surface as a link at all — it would go
  // blind. Same for ruleBullets(). Do not "finish the refactor".
  //
  // The two reference forms resolve against different bases, because Markdown does: a BACKTICKED
  // path is prose naming a REPO-ROOT path (this.exists), while a LINK is a link and resolves
  // relative to the REFERRING FILE (this.resolvesFrom) — the same base checkLinks() uses. So a
  // promoted link out of `rules/` reads `[…](../docs/rules/x-postmortems.md)`, and the repo-root
  // spelling inside `](…)` is a 404 that this check must still reject.
  //
  // The header exemption covers the bare form ONLY. docs/rules/README.md declares that a deep doc
  // stays "absent until a host has a real postmortem to record", and rules/frontend.md,
  // rules/security.md and rules/scripting.md all forward-reference one today; a dead LINK in that
  // same header is still dead, so it is still rejected.
  private checkRulesPointers(): void {
    if (!this.dirExists(RULES_DIR)) return;

    for (const rel of REQUIRED_RULES) {
      if (!this.exists(rel)) continue;   // already reported by checkRules()

      let fenced = false;
      for (const raw of this.read(rel).split("\n")) {
        const line = rstrip(raw);
        if (/^\s*```/.test(line)) {
          fenced = !fenced;
          continue;
        }
        if (fenced) continue;

        const isHeader = strip(line).startsWith(DEEP_DOC_LABEL);
        for (const match of line.matchAll(DEEP_DOC_TOKEN)) {
          const before = line.slice(0, match.index);
          const target = (match[0] as string).split("#")[0] as string;

          // The link form is recognized FIRST and independently of the path's shape: a relative
          // link (`](../docs/rules/x.md)`) is still a link, and skipping it as "unresolvable" would
          // let the likeliest real spelling through.
          const link = DEEP_DOC_LINKED.exec(before);
          if (link) {
            const href = (link[1] ?? "") + target;
            if (this.resolvesFrom(rel, href)) continue;   // a promoted link that works — the convention allows it

            // Two different mistakes, two different fixes: the target isn't written yet (keep it
            // backticked), or it is written but the link can't reach it from here (fix the path).
            this.err(this.exists(target)
              ? `Rules pointer ${rel}: markdown link \`${href}\` does not resolve from ${dirname(rel)}/; ` +
                `a promoted link is relative to the referring file`
              : `Rules pointer ${rel}: \`${target}\` is written as a markdown link; a deep-doc path must be a ` +
                `backticked path (${RULES_DEEP_DOC_README}) so it cannot redden the dead-link check before its target lands`);
            continue;
          }

          // Not a bare pointer this check can resolve: an absolute path, a `../` traversal, or a URL
          // that merely contains the path.
          if (/[./]$|:\/\/\S*$/.test(before)) continue;

          if (isHeader) continue;   // a declaration, not a stand-in for moved content
          if (!this.exists(target)) {
            this.err(
              `Rules pointer ${rel}: case-study pointer \`${target}\` does not exist; a deep doc that is not ` +
              `written yet is forward-referenced from the \`${DEEP_DOC_LABEL}\` header, not from a body bullet`,
            );
          }
        }
      }
    }
  }

  /**
   * Every `- **…**` bullet in a Tier-1 rule file, in source order, with the fenced-code skipping
   * checkRulesPointers() uses. Returns the bolded imperative (the allowlist key) alongside the
   * bullet's FULL text, because both the limit and the pointer exemption are read off that text.
   *
   * A bullet is measured INCLUDING its wrapped continuation lines, joined the way markdown renders
   * them (newline -> space). Measuring only the first line would let any prose-wrapper -- an editor
   * reflow, a formatter with `proseWrap` on -- silently disable this guard for the entire tree at
   * once by re-flowing every bullet: a false green, arrived at by a routine, well-intentioned edit.
   * Today's files happen to write one bullet per line, which is exactly why the assumption is
   * dangerous to encode.
   *
   * Length is JS `String.length` (UTF-16 code units), not bytes. These files are full of em dashes,
   * which are one char and three bytes, so the two measures disagree by ~10% on a typical bullet;
   * chars is the honest unit for "how much does a reader have to take in".
   */
  private ruleBullets(rel: string): { key: string; text: string }[] {
    const bullets: { key: string; text: string }[] = [];
    const lines = this.read(rel).split("\n").map(rstrip);
    let fenced = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;

      const match = RULE_BULLET.exec(line);
      if (match === null) continue;

      // Consume wrapped continuation lines. A continuation is any non-blank line that does not open a
      // new block; the opener is re-examined by the outer loop, so a fence can never be swallowed as
      // prose. Indentation is deliberately NOT required: CommonMark's *lazy* continuation lets a
      // list item's paragraph continue at column zero, which is what a plain hard-wrap (`gq`, a hand
      // edit, a formatter that does not re-indent list bodies) produces -- so requiring indentation
      // would leave the cheapest flavor of the wrap bypass wide open while looking closed.
      const parts = [line];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] as string;
        if (next === "") break;
        if (RULE_BLOCK_OPENER.test(next)) break;
        parts.push(strip(next));
        i++;
      }

      bullets.push({ key: match[1] as string, text: parts.join(" ") });
    }
    return bullets;
  }

  /**
   * Does this bullet carry a case-study pointer to its OWN domain's deep doc, in either form the
   * convention allows, that actually RESOLVES?
   *
   * Both forms are accepted because docs/rules/README.md (issue #154) sanctions both, and each is
   * validated against the same base checkRulesPointers() uses for that form -- a backticked path is
   * prose naming a REPO-ROOT path (exists), a promoted link resolves relative to the REFERRING FILE
   * (resolvesFrom). A contributor who promotes a pointer the way the convention tells them to must not
   * be told by this guard to un-promote it.
   *
   * The two checks share the bases, not the input: checkRulesPointers reads one physical line, this
   * reads the bullet's joined text, so a link broken across a wrap is adjacency here and is not there.
   * That direction is harmless -- this guard only ever GRANTS an exemption, and only for a path that
   * resolvesFrom/exists actually finds -- but it is why the claim is "same bases", not "identical".
   *
   * Resolution is required, not just presence. An unresolvable path exempts nothing -- otherwise a
   * bullet could buy its way out with a pointer to a file no check verifies, which is the false green
   * this whole guard exists to prevent.
   */
  private narrativePointerResolves(rel: string, text: string): boolean {
    const deepDoc = RULE_DEEP_DOC[rel];
    if (deepDoc === null || deepDoc === undefined) return false;

    for (const match of text.matchAll(DEEP_DOC_TOKEN)) {
      const target = (match[0] as string).split("#")[0] as string;
      if (target !== deepDoc) continue;   // another domain's deep doc exempts nothing

      const before = text.slice(0, match.index);
      const link = DEEP_DOC_LINKED.exec(before);
      if (link) {
        if (this.resolvesFrom(rel, (link[1] ?? "") + target)) return true;
        continue;
      }
      if (/[./]$|:\/\/\S*$/.test(before)) continue;   // a traversal or URL in bare form: unresolvable here
      if (this.exists(target)) return true;
    }
    return false;
  }

  /** A bullet is over the limit and not exempted by its own domain's case-study pointer. */
  private narrativeTrips(rel: string, text: string): boolean {
    if (text.length <= NARRATIVE_MAX_CHARS) return false;
    return !this.narrativePointerResolves(rel, text);
  }

  /**
   * The remedy is chosen from the deep doc's state ON DISK, in three cases, so the advice can never be
   * impossible to follow (issue #152 plan review):
   *
   *   null            - no deep doc by design (self-review). Shortening is the only remedy.
   *   present         - point at it, or shorten.
   *   declared/absent - authoring it comes FIRST. Adding a pointer to a file that does not exist trips
   *                     checkRulesPointers(), so advising "just add a pointer" here would march the
   *                     contributor straight into a second, differently-worded failure.
   *
   * Reading disk rather than a hardcoded list also means the advice updates itself the day a host
   * writes its first postmortem for that domain.
   */
  private narrativeRemedy(rel: string): string {
    const deepDoc = RULE_DEEP_DOC[rel];
    if (deepDoc === null || deepDoc === undefined) {
      return `${rel} has no Tier-2 deep doc, so shorten the bullet - keep the imperative and its rationale, drop the case narrative`;
    }
    if (this.exists(deepDoc)) {
      return (
        `move the case narrative to \`${deepDoc}\` and leave a pointer to it - either the backticked path or a ` +
        `link relative to ${dirname(rel)}/ (${RULES_DEEP_DOC_README}) - or shorten the bullet`
      );
    }
    return (
      `\`${deepDoc}\` does not exist yet, so author it first (${RULES_DEEP_DOC_README}) and then leave a ` +
      `backticked pointer to it, or shorten the bullet - a pointer to an absent deep doc fails the rules-pointer check`
    );
  }

  /**
   * Tier-1 accretion guard (issue #152, ADR 0051). Fails a `rules/*.md` bullet that exceeds
   * NARRATIVE_MAX_CHARS without carrying its own domain's case-study pointer, unless it is named in
   * NARRATIVE_ALLOWLIST.
   *
   * The allowlist is checked as strictly as the bullets are. An entry that names a non-Tier-1 file,
   * matches no bullet, matches more than one, or covers a bullet that no longer trips is an error --
   * so the grandfathered backlog cannot rot into a set of stale exemptions that silently re-cover a
   * future bullet. That last case is what makes this a ratchet: trimming a bullet turns parity RED
   * until its now-unnecessary entry is deleted.
   */
  private checkRulesNarrative(): void {
    if (!this.dirExists(RULES_DIR)) return;

    for (const rel of REQUIRED_RULES) {
      if (!(rel in RULE_DEEP_DOC)) {
        this.err(
          `Tier-1 narrative: no deep-doc mapping for ${rel} - add it to RULE_DEEP_DOC in ` +
          `scripts/parity-check.ts (use null for a rule with no Tier-2 deep doc)`,
        );
      }
    }

    for (const rel of Object.keys(NARRATIVE_ALLOWLIST)) {
      if (!REQUIRED_RULES.includes(rel)) {
        this.err(
          `Tier-1 narrative allowlist: \`${rel}\` is not a Tier-1 rule file - remove it or correct the path ` +
          `(expected one of ${inspectArray(REQUIRED_RULES.slice())})`,
        );
      }
    }

    for (const rel of REQUIRED_RULES) {
      if (!this.exists(rel)) continue;   // already reported by checkRules()

      const bullets = this.ruleBullets(rel);
      const allowed = NARRATIVE_ALLOWLIST[rel] ?? [];

      for (const { key, text } of bullets) {
        if (!this.narrativeTrips(rel, text)) continue;
        if (allowed.includes(key)) continue;
        this.err(
          `Tier-1 narrative ${rel}: bullet "${asciiSafeGateValue(key)}" is ${text.length} characters ` +
          `(limit ${NARRATIVE_MAX_CHARS}) and carries no case-study pointer; ${this.narrativeRemedy(rel)}`,
        );
      }

      for (const key of allowed) {
        const matches = bullets.filter((b) => b.key === key);
        const safeKey = asciiSafeGateValue(key);
        if (matches.length === 0) {
          this.err(
            `Tier-1 narrative allowlist ${rel}: entry "${safeKey}" matches no bullet - the imperative was ` +
            `reworded or the bullet removed; update the entry to the new wording or delete it`,
          );
          continue;
        }
        if (matches.length > 1) {
          this.err(
            `Tier-1 narrative allowlist ${rel}: entry "${safeKey}" matches ${matches.length} bullets - an ` +
            `ambiguous key cannot exempt one bullet; make the imperatives distinct`,
          );
          continue;
        }
        if (!this.narrativeTrips(rel, (matches[0] as { text: string }).text)) {
          this.err(
            `Tier-1 narrative allowlist ${rel}: entry "${safeKey}" is no longer needed - the bullet is now ` +
            `within the limit or carries its case-study pointer; remove the entry (this list only shrinks)`,
          );
        }
      }
    }
  }

  private checkSkills(): void {
    if (!this.dirExists(SKILLS_DIR)) return;

    const agents = this.exists(CANONICAL) ? this.read(CANONICAL) : "";

    for (const name of REQUIRED_SKILLS) {
      if (!this.exists(`${SKILLS_DIR}/${name}/SKILL.md`)) {
        this.err(`Required skill missing: ${SKILLS_DIR}/${name}/SKILL.md not found`);
      }
    }

    for (const name of this.presentSkills()) {
      const bodyRel = `${SKILLS_DIR}/${name}/SKILL.md`;
      if (!this.exists(bodyRel)) {
        this.err(`Skill ${name} missing its canonical body: ${bodyRel} not found`);
        continue;
      }
      const body = this.read(bodyRel);
      if (!this.frontmatterName(body)) {
        this.err(`Skill ${name}: ${bodyRel} lacks YAML frontmatter with a \`name:\` key`);
      }

      const shimRel = `${CLAUDE_COMMANDS_DIR}/${name}.md`;
      if (!this.exists(shimRel)) {
        this.err(`Skill ${name} missing its Claude Invocation Shim: ${shimRel} not found`);
      } else if (!this.read(shimRel).includes(bodyRel)) {
        this.err(`Claude Invocation Shim ${shimRel} does not reference its canonical body (expected \`${bodyRel}\`)`);
      }

      if (!agents.includes(bodyRel)) {
        this.err(`Skill ${name} is not referenced by ${CANONICAL} (the documented invocation must be reachable from the Canonical Source)`);
      }

      for (const token of HOST_SPECIFIC_TOKENS) {
        if (!this.hostToken(body, token)) continue;

        this.err(
          `Skill ${name}: ${bodyRel} contains host-specific token \`${token}\` (a generic Skill body ` +
          `must read host values from ${PROJECT_CONFIG}, not name a stack/domain)`,
        );
      }

      if (LIFECYCLE_SKILLS.includes(name) && !body.includes(PROJECT_CONFIG)) {
        this.err(
          `Lifecycle Skill ${name}: ${bodyRel} does not reference ${PROJECT_CONFIG} (it must read ` +
          `quality checks / attribution / severities / lifecycle host from Project Config, not hardcode them)`,
        );
      }
    }
  }

  private hostToken(body: string, token: string): boolean {
    if (/^[A-Za-z]+$/.test(token)) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`).test(body);
    }
    return body.includes(token);
  }

  private presentSkills(): string[] {
    return readdirSync(this.path(SKILLS_DIR))
      .filter((c) => {
        try {
          return statSync(join(this.path(SKILLS_DIR), c)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  private frontmatterName(content: string): boolean {
    const lines = content.split("\n");
    const first = lines.findIndex((l) => strip(l) !== "");
    if (first === -1 || strip(lines[first] as string) !== "---") return false;

    const closeRel = lines.slice(first + 1).findIndex((l) => strip(l) === "---");
    if (closeRel === -1) return false;

    return lines.slice(first + 1, first + 1 + closeRel).some((l) => /^name:\s*\S/.test(l));
  }

  private checkGuardrails(): void {
    if (!this.exists(SIDECAR)) return;

    for (const f of GUARDRAIL_FILES) {
      if (!this.exists(f)) this.err(`Guardrail file missing: ${f} not found`);
    }

    if (!this.exists(PROJECT_CONFIG)) {
      this.err(`Guardrails present but ${PROJECT_CONFIG} is missing (cannot verify the protected-branch list)`);
      return;
    }

    const derived = protectedBranchesFromFile(this.path(PROJECT_CONFIG));
    const committed = this.read(SIDECAR)
      .split("\n")
      .map(strip)
      .filter((l) => l !== "" && !l.startsWith("#"));
    if (!arraysEqual(derived, committed)) {
      this.err(
        `Protected-branch sidecar drift: ${SIDECAR} has ${inspectArray(committed)} but PROJECT.md derives ` +
        `${inspectArray(derived)} - run bin/install-git-hooks to regenerate it`,
      );
    }
  }

  private checkGuides(): void {
    if (!this.dirExists(GUIDES_DIR)) return;

    for (const rel of REQUIRED_GUIDES) {
      if (!this.exists(rel)) this.err(`Required guide missing: ${rel} not found`);
    }
  }

  private checkAdrNumbers(): void {
    if (!this.dirExists(ADR_DIR)) return;

    const byNumber = new Map<string, string[]>();
    const children = readdirSync(this.path(ADR_DIR)).sort();
    for (const name of children) {
      let isFile = false;
      try {
        isFile = statSync(join(this.path(ADR_DIR), name)).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;

      const m = ADR_FILENAME.exec(name);
      if (m === null) continue;
      const num = m[1] as string;
      const list = byNumber.get(num) ?? [];
      list.push(name);
      byNumber.set(num, list);
    }

    for (const [number, files] of byNumber) {
      if (files.length < 2) continue;
      this.err(
        `Duplicate ADR number ${number}: ${inspectArray(files.slice().sort())} share it - renumber all but one to ` +
        `the next free number and update its references`,
      );
    }
  }

  /**
   * Reject structurally provable ADR citation drift without attempting to interpret prose. This scans
   * every shipped Markdown file, unlike checkLinks(), whose dead-link scope remains LINK_CHECKED.
   */
  private checkAdrLinkNumbers(): void {
    for (const rel of this.markdownFiles()) {
      // Parsed, not matched (issue #159): a citation inside a code span is a worked EXAMPLE of the
      // convention, not a citation, and the parser simply does not report one.
      for (const { label, destination } of markdownLinks(this.read(rel))) {
        const labelMatch = ADR_LINK_LABEL.exec(label);
        if (labelMatch === null) continue;

        const rawTarget = destination.trim();
        if (
          rawTarget === "" ||
          rawTarget.startsWith("#") ||
          rawTarget.includes("%") ||
          /^(?:[a-z][a-z0-9+.-]*:)/i.test(rawTarget)
        ) {
          continue;
        }

        const target = rawTarget.split("#")[0] ?? "";
        const targetMatch = ADR_LINK_TARGET.exec(basename(target));
        if (targetMatch === null) continue;

        const displayed = labelMatch[1] as string;
        const targetNumber = targetMatch[1] as string;
        if (displayed !== targetNumber) {
          this.err(`ADR link number mismatch in ${rel}: label ADR ${displayed} targets ADR ${targetNumber}`);
        }
      }
    }
  }

  private markdownFiles(dir = "", files: string[] = []): string[] {
    const absolute = this.path(dir);
    let children: string[];
    try {
      children = readdirSync(absolute).sort();
    } catch {
      return files;
    }

    for (const child of children) {
      const rel = dir === "" ? child : join(dir, child);
      if (MARKDOWN_SCAN_EXCLUDED_DIRS.has(rel)) continue;

      let entry;
      try {
        entry = lstatSync(this.path(rel));
      } catch {
        continue;
      }
      let stat = entry;
      if (entry.isSymbolicLink()) {
        try {
          // Follow file links so shipped Markdown aliases remain covered, but
          // never recurse into a directory link that could point back upward.
          stat = statSync(this.path(rel));
        } catch {
          continue;
        }
        if (stat.isDirectory()) continue;
      }
      if (stat.isDirectory()) {
        this.markdownFiles(rel, files);
      } else if (stat.isFile() && rel.endsWith(".md")) {
        files.push(rel);
      }
    }
    return files;
  }

  private checkLinks(): void {
    for (const rel of linkCheckedFiles(this.root)) {
      if (!this.exists(rel)) continue;

      const dir = dirname(this.path(rel));
      // Parsed, not matched: a `[text](path)` inside a code span is prose about markdown, so the parser
      // never reports it as a link at all (issue #159, ADR 0054).
      for (const { destination } of markdownLinks(this.read(rel))) {
        let target = destination.trim();
        if (target === "") continue;
        if (
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:") ||
          target.startsWith("#")
        ) {
          continue;
        }

        target = target.split("#")[0] as string; // drop any #anchor fragment
        if (target === "") continue;

        const resolved = resolvePath(dir, target);
        try {
          statSync(resolved);
        } catch {
          this.err(`Dead link in ${rel}: \`${target}\` does not resolve`);
        }
      }
    }
  }

}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Run every parity assertion without writing output or changing process state. */
export function runParityCheck(root = "."): ParityResult {
  return new ParityCheck(root).run();
}

/** Render a run result for the command-line interface. */
export function formatParityResult(result: ParityResult): string {
  if (result.errors.length === 0) {
    return (
      `parity_check: OK - Canonical Source, ${IMPORT_ADAPTERS.length + 1} Adapters, Project Config, ` +
      `${result.skillCount} Skill${result.skillCount !== 1 ? "s" : ""}, and links all resolve.\n`
    );
  }

  return (
    `parity_check: FAILED (${result.errors.length} problem${result.errors.length !== 1 ? "s" : ""})\n` +
    result.errors.map((error) => `  - ${error}\n`).join("")
  );
}

export function main(args: string[]): number {
  let root = ".";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      const val = args[++i];
      if (val === undefined) {
        process.stderr.write("parity_check: usage error - missing argument: --root\n");
        return 2;
      }
      root = val;
    } else if (arg !== undefined && arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else {
      // Reject unknown flags / stray positionals rather than silently checking
      // the default root — a mis-invocation must fail loudly, not false-green.
      process.stderr.write(`parity_check: usage error - invalid option: ${arg}\n`);
      return 2;
    }
  }
  const result = runParityCheck(root);
  process.stdout.write(formatParityResult(result));
  return result.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  // Set exitCode (don't exit()) so buffered stdout drains before exit.
  process.exitCode = main(argv.slice(2));
}
