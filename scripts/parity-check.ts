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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";
import { fromFile as protectedBranchesFromFile } from "./protected-branches.js";

const CANONICAL = "AGENTS.md";

const IMPORT_ADAPTERS = ["CLAUDE.md", "GEMINI.md"];
const NATIVE_CAPABLE_ADAPTERS = ["GEMINI.md"];
const COPILOT_ADAPTER = ".github/copilot-instructions.md";
const PROJECT_CONFIG = "PROJECT.md";

const LINK_CHECKED = [
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

const GUIDES_DIR = "docs/guides";
const REQUIRED_GUIDES = ["docs/guides/usage.md"];

const ADR_DIR = "docs/adr";
const ADR_FILENAME = /^(\d+)-.+\.md$/;

const RULES_DIR = "rules";
const REQUIRED_RULES = [
  "rules/backend.md", "rules/frontend.md", "rules/testing.md",
  "rules/security.md", "rules/self-review.md", "rules/scripting.md", "rules/skills.md",
];
const RULE_REQUIRED_SECTIONS = ["## Patterns", "## Anti-Patterns"];

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

class ParityCheck {
  private readonly root: string;
  private readonly errors: string[] = [];

  constructor(root: string) {
    this.root = root;
  }

  run(): number {
    this.checkCanonicalExists();
    this.checkImportAdapters();
    this.checkCopilotAdapter();
    this.checkRenderedRegions();
    this.checkProjectSections();
    this.checkRules();
    this.checkSkills();
    this.checkGuardrails();
    this.checkGuides();
    this.checkAdrNumbers();
    this.checkLinks();
    this.report();
    return this.errors.length === 0 ? 0 : 1;
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
    for (const rel of LINK_CHECKED) {
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

  private checkLinks(): void {
    const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
    for (const rel of LINK_CHECKED) {
      if (!this.exists(rel)) continue;

      const dir = dirname(this.path(rel));
      for (const m of this.read(rel).matchAll(linkRe)) {
        let target = (m[1] ?? "").trim();
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

  private report(): void {
    if (this.errors.length === 0) {
      const skills = this.dirExists(SKILLS_DIR) ? this.presentSkills().length : 0;
      process.stdout.write(
        `parity_check: OK - Canonical Source, ${IMPORT_ADAPTERS.length + 1} Adapters, Project Config, ` +
        `${skills} Skill${skills !== 1 ? "s" : ""}, and links all resolve.\n`,
      );
    } else {
      process.stdout.write(`parity_check: FAILED (${this.errors.length} problem${this.errors.length !== 1 ? "s" : ""})\n`);
      for (const e of this.errors) process.stdout.write(`  - ${e}\n`);
    }
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function main(args: string[]): number {
  let root = ".";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      root = args[++i] ?? ".";
    } else if (arg !== undefined && arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    }
  }
  return new ParityCheck(root).run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  exit(main(argv.slice(2)));
}
