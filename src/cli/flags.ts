/**
 * The presenters' shared option parsers.
 *
 * Everything here reads an argv the router has ALREADY validated and normalized,
 * so it sees only canonical `--name value` pairs: aliases and `=` forms were
 * rewritten by `normalizeOptions`, and an unknown option never reaches a
 * presenter at all (#191).
 *
 * A parser earns a place here on its SECOND caller, not its first — copying a
 * parser is how one rule becomes two that drift (rules/scripting.md), and moving
 * a single-caller parser here would be motion rather than deduplication.
 */

/**
 * The generic `--flag value` scanner.
 *
 * `src/cli/seed.ts` and `src/cli/lists.ts` each carried a byte-identical private
 * copy; #191 added a third add command, and a third copy is how the rule stops
 * being one rule.
 *
 * A flag with no following value (or followed by another flag) maps to the empty
 * string, which each caller treats as "present but blank" — never as absent.
 */
export function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const value = args[i + 1];
      flags.set(arg.slice(2), value !== undefined && !value.startsWith("--") ? value : "");
      if (value !== undefined && !value.startsWith("--")) i += 1;
    }
  }
  return flags;
}

/**
 * `--list <name>`, the lane scope shared by `sk digest` (#70) and `sk refresh`
 * (#192). THREE states, and each one is load-bearing:
 *   - `undefined` — the flag is ABSENT. What that MEANS is the command's own
 *     decision, not this parser's: digest treats it as "no scope, every active
 *     player", refresh resolves the DEFAULT lane. Collapsing the two here would
 *     bake one command's default into the other's.
 *   - `null` — present but MALFORMED (no value, a following flag, or blank), so
 *     every caller can fail closed. A typo'd flag must never silently widen a
 *     scope, which is exactly what treating it as absent would do.
 *   - a trimmed name — the lane to resolve.
 *
 * It carries no alias branch of its own: `-l` and `--list=` were already
 * rewritten to `--list value` by the time it runs (#191).
 */
export function parseList(argv: string[]): string | null | undefined {
  const at = argv.indexOf("--list");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  // A following flag (or nothing) means the value is missing — fail closed.
  return value === undefined || value.startsWith("--") || value.trim().length === 0
    ? null
    : value.trim();
}
