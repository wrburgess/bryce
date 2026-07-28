/**
 * The presenters' shared `--flag value` scanner.
 *
 * `src/cli/seed.ts` and `src/cli/lists.ts` each carried a byte-identical private
 * copy; #191 added a third add command, and a third copy is how the rule stops
 * being one rule (rules/scripting.md — copying a guard's condition is the signal
 * to extract it, not to paste it).
 *
 * It reads an argv the router has ALREADY validated and normalized, so it sees
 * only canonical `--name value` pairs: aliases and `=` forms were rewritten by
 * `normalizeOptions`, and an unknown option never reaches a presenter at all.
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
