/**
 * The safe command boundary for the locally activated `bryce` executable.
 *
 * This module intentionally imports no configuration or service modules.  Route resolution,
 * help, and option preflight are pure; a leaf is imported only after that work succeeds.
 */
export type CliAdapter = (argv: string[]) => Promise<number>;

export type Option = { name: string; value?: boolean; aliases?: string[]; values?: readonly string[]; description: string; validate?: (value: string) => string | null; inline?: boolean };
export type Command = {
  path: readonly string[];
  purpose: string;
  usage: string;
  options?: readonly Option[];
  example: string;
  load: () => Promise<{ main: CliAdapter }>;
  required?: readonly string[];
  oneOf?: readonly (readonly string[])[];
  exactlyOneOf?: readonly (readonly string[])[];
};

const leaf = (
  path: readonly string[], purpose: string, usage: string, example: string,
  load: Command["load"], options: readonly Option[] = [], requirements: Pick<Command, "required" | "oneOf" | "exactlyOneOf"> = {},
): Command => ({ path, purpose, usage, example, load, options, ...requirements });

const value = (name: string, description: string, values?: readonly string[], aliases?: string[], validate?: Option["validate"]): Option =>
  ({ name, description, values, aliases, validate });
const inlineValue = (name: string, description: string, values?: readonly string[], aliases?: string[], validate?: Option["validate"]): Option =>
  ({ name, description, values, aliases, validate, inline: true });
const flag = (name: string, description: string): Option => ({ name, description, value: false });
const positiveInteger = (value: string): string | null => /^\d+$/.test(value) && Number(value) > 0 ? null : "a positive integer";
const year = (value: string): string | null => /^\d{4}$/.test(value) ? null : "a four-digit year";
const positiveIntegerList = (value: string): string | null => value.split(",").every((part) => positiveInteger(part.trim()) === null) ? null : "a comma-separated list of positive integers";

/** Canonical built-in syntax/help metadata. Operational detail belongs in docs/cli. */
export const COMMANDS: readonly Command[] = [
  leaf(["digest"], "Build and send a digest.", "bryce digest [--window SPEC|-w SPEC] [--list NAME] [--force]", "bryce digest -w 7d", () => import("./digest.js"), [inlineValue("window", "Digest window.", ["1d", "7d", "14d", "21d", "28d", "35d", "60d", "ytd"], ["w"]), inlineValue("list", "Named player list."), flag("force", "Replay the daily slot when allowed.")]),
  leaf(["refresh"], "Refresh the active watch list.", "bryce refresh", "bryce refresh", () => import("./refresh.js")),
  leaf(["players", "lists", "create"], "Create a named player list.", "bryce players lists create --name NAME", "bryce players lists create --name Prospects", () => import("./lists.js"), [value("name", "List name.")], { required: ["name"] }),
  leaf(["players", "lists", "rename"], "Rename a named player list.", "bryce players lists rename --name OLD --to NEW", "bryce players lists rename --name Prospects --to 'Top 30'", () => import("./lists.js"), [value("name", "Current list name."), value("to", "New list name.")], { required: ["name", "to"] }),
  leaf(["players", "lists", "delete"], "Delete a named player list.", "bryce players lists delete --name NAME", "bryce players lists delete --name Prospects", () => import("./lists.js"), [value("name", "List name.")], { required: ["name"] }),
  leaf(["players", "lists", "add"], "Add players to a named list.", "bryce players lists add --name NAME [--person-ids IDS] [--ncaa-seqs IDS]", "bryce players lists add --name Prospects --person-ids 691185", () => import("./lists.js"), [value("name", "List name."), value("person-ids", "Comma-separated MLB ids.", undefined, undefined, positiveIntegerList), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, positiveIntegerList)], { required: ["name"], oneOf: [["person-ids", "ncaa-seqs"]] }),
  leaf(["players", "lists", "remove"], "Remove players from a named list.", "bryce players lists remove --name NAME [--person-ids IDS] [--ncaa-seqs IDS]", "bryce players lists remove --name Prospects --person-ids 691185", () => import("./lists.js"), [value("name", "List name."), value("person-ids", "Comma-separated MLB ids.", undefined, undefined, positiveIntegerList), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, positiveIntegerList)], { required: ["name"], oneOf: [["person-ids", "ncaa-seqs"]] }),
  leaf(["players", "lists", "show"], "Show named lists or their members.", "bryce players lists show [--name NAME]", "bryce players lists show", () => import("./lists.js"), [value("name", "List name.")]),
  leaf(["players", "backup"], "Write a player-list backup.", "bryce players backup --out FILE", "bryce players backup --out backups/players.json", () => import("./players-backup.js"), [value("out", "Output file.")], { required: ["out"] }),
  leaf(["players", "restore"], "Restore a player-list backup.", "bryce players restore --in FILE", "bryce players restore --in backups/players.json", () => import("./players-restore.js"), [value("in", "Input file.")], { required: ["in"] }),
  leaf(["players", "batch-add"], "Stage many players.", "bryce players batch-add [--person-ids IDS] [--ncaa-seqs IDS] [--names NAME] [--file FILE]", "bryce players batch-add --person-ids 691185", () => import("./batch-add.js"), [value("person-ids", "Comma-separated MLB ids.", undefined, undefined, positiveIntegerList), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, positiveIntegerList), value("names", "Player name; repeatable."), value("file", "Input file.")], { oneOf: [["person-ids", "ncaa-seqs", "names", "file"]] }),
  leaf(["db", "migrate"], "Apply pending database migrations.", "bryce db migrate", "bryce db migrate", () => import("./migrate.js")),
  leaf(["db", "backup"], "Create a database snapshot.", "bryce db backup", "bryce db backup", () => import("./backup.js")),
  leaf(["db", "restore"], "Restore a database snapshot.", "bryce db restore --from FILE", "bryce db restore --from backups/bryce-YYYYMMDDTHHMMSSZ-000.db", () => import("./restore.js"), [value("from", "Snapshot file.")], { required: ["from"] }),
  leaf(["ncaa", "probe"], "Probe the NCAA scraper.", "bryce ncaa probe --seq N [--season YYYY] [--type TYPE]", "bryce ncaa probe --seq 2649785", () => import("./ncaa-probe.js"), [value("seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("season", "Season year.", undefined, undefined, year), value("type", "Stat type.", ["batting", "pitching", "fielding"])], { required: ["seq"] }),
  leaf(["connector", "smoke"], "Smoke-test a running MCP connector.", "bryce connector smoke [--mutate]", "bryce connector smoke", () => import("./connector-smoke.js"), [flag("mutate", "Also run the configured mutation probe.")]),
  leaf(["seed", "add"], "Add a watch-list player.", "bryce seed add (--person-id N|--ncaa-seq N|--search NAME) [--pick I]", "bryce seed add --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("search", "Player name."), value("pick", "One-based search result.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq", "search"]] }),
  leaf(["seed", "deactivate"], "Deactivate a watch-list player.", "bryce seed deactivate (--person-id N|--ncaa-seq N)", "bryce seed deactivate --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "list"], "List watch-list players.", "bryce seed list [--tags EXPR]", "bryce seed list --tags status:rostered", () => import("./seed.js"), [value("tags", "Tag selector.")]),
  leaf(["seed", "tag", "add"], "Add a manual player tag.", "bryce seed tag add (--person-id N|--ncaa-seq N) --tag TAG", "bryce seed tag add --person-id 691185 --tag status:rostered", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("tag", "Manual tag.")], { required: ["tag"], exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "remove"], "Remove a manual player tag.", "bryce seed tag remove (--person-id N|--ncaa-seq N) --tag TAG", "bryce seed tag remove --person-id 691185 --tag status:rostered", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("tag", "Manual tag.")], { required: ["tag"], exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "list"], "List player tags.", "bryce seed tag list (--person-id N|--ncaa-seq N)", "bryce seed tag list --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "rebuild"], "Rebuild derived tags.", "bryce seed tag rebuild", "bryce seed tag rebuild", () => import("./seed.js")),
  leaf(["server"], "Run the REST and MCP server.", "bryce server", "bryce server", () => import("../server.js")),
];

const write = (line: string, error = false): void => {
  (error ? process.stderr : process.stdout).write(`${line}\n`);
};
export function renderHelp(path: readonly string[] = [], commands: readonly Command[] = COMMANDS): string {
  const exact = commands.find((command) => command.path.join("\0") === path.join("\0"));
  if (exact !== undefined) {
    const optionLines = (exact.options ?? []).map((option) => {
      const names = [`--${option.name}`, ...(option.aliases ?? []).map((alias) => `-${alias}`)].join(", ");
      return `  ${names}${option.value === false ? "" : " <value>"}  ${option.description}`;
    });
    return [exact.purpose, "", `Usage: ${exact.usage}`, ...(optionLines.length ? ["", "Options:", ...optionLines] : []), "", `Example: ${exact.example}`].join("\n");
  }
  const label = path.length === 0 ? "bryce" : `bryce ${path.join(" ")}`;
  const entries = [...new Set(commands.filter((c) => c.path.length > path.length && path.every((p, i) => c.path[i] === p)).map((c) => c.path[path.length]!))].sort().map((child) => `  ${child}`);
  return [`Usage: ${label} <command>`, "", "Commands:", ...entries, "", `Run '${label} help <command>' for command help.`].join("\n");
}

type Resolution = { command?: Command; argv?: string[]; help?: readonly string[]; error?: string };
export function resolve(argv: readonly string[], commands: readonly Command[] = COMMANDS): Resolution {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!)) {
    const path = argv[0] === "help" ? argv.slice(1) : [];
    return { help: path };
  }
  const candidates = commands.filter((command) => command.path[0] === argv[0]);
  if (candidates.length === 0) return { error: `unknown command '${argv[0]}'` };
  let pathLength = 0;
  for (let index = 1; index <= argv.length; index += 1) {
    const path = argv.slice(0, index);
    const exact = commands.find((command) => command.path.length === index && command.path.every((segment, segmentIndex) => segment === path[segmentIndex]));
    const hasChild = commands.some((command) => command.path.length > index && path.every((segment, segmentIndex) => command.path[segmentIndex] === segment));
    if (hasChild && ["help", "--help", "-h"].includes(argv[index] ?? "")) return { help: path };
    if (exact !== undefined && (!hasChild || argv[index] === undefined || argv[index]!.startsWith("-"))) {
      return { command: exact, argv: argv.slice(index) };
    }
    if (!hasChild && exact === undefined) break;
    pathLength = index;
  }
  const attempted = argv.slice(0, pathLength + 1).join(" ");
  return { error: `unknown or incomplete command '${attempted}'` };
}

export function preflight(command: Command, argv: readonly string[]): string | null {
  const allowed = new Map<string, Option>();
  const seen = new Set<string>();
  for (const option of command.options ?? []) {
    allowed.set(`--${option.name}`, option);
    for (const alias of option.aliases ?? []) allowed.set(`-${alias}`, option);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) return `unexpected argument '${arg}'`;
    const [name, inline] = arg.split("=", 2);
    const option = allowed.get(name ?? "");
    if (option === undefined) return `unknown option '${name}'`;
    if (inline !== undefined && (option.inline !== true || !name?.startsWith("--"))) return `option '${name}' does not support '=' syntax`;
    if (option.value === false) {
      if (inline !== undefined) return `option '${name}' does not take a value`;
      continue;
    }
    const candidate = inline ?? argv[++index];
    if (candidate === undefined || candidate.startsWith("-")) return `option '${name}' requires a value`;
    if (option.values !== undefined && !option.values.includes(candidate)) return `invalid value '${candidate}' for '${name}'; expected ${option.values.join(", ")}`;
    const validation = option.validate?.(candidate);
    if (validation !== undefined && validation !== null) return `invalid value '${candidate}' for '${name}'; expected ${validation}`;
    seen.add(option.name);
  }
  for (const name of command.required ?? []) {
    if (!seen.has(name)) return `missing required option '--${name}'`;
  }
  for (const group of command.oneOf ?? []) {
    if (!group.some((name) => seen.has(name))) return `one of ${group.map((name) => `--${name}`).join(", ")} is required`;
  }
  for (const group of command.exactlyOneOf ?? []) {
    const selected = group.filter((name) => seen.has(name));
    if (selected.length !== 1) return `exactly one of ${group.map((name) => `--${name}`).join(", ")} is required`;
  }
  return null;
}

export async function runRouter(argv = process.argv.slice(2), output: (line: string, error?: boolean) => void = write, commands: readonly Command[] = COMMANDS): Promise<number> {
  const resolution = resolve(argv, commands);
  if (resolution.help !== undefined) {
    if (!commands.some((command) => resolution.help!.every((part, index) => command.path[index] === part))) {
      output(`error: unknown command '${resolution.help.join(" ")}'`, true);
      return 1;
    }
    output(renderHelp(resolution.help, commands));
    return 0;
  }
  if (resolution.error !== undefined || resolution.command === undefined || resolution.argv === undefined) {
    output(`error: ${resolution.error ?? "invalid command"}\n${renderHelp([], commands)}`, true);
    return 1;
  }
  if (["--help", "-h"].includes(resolution.argv[0] ?? "")) {
    output(renderHelp(resolution.command.path, commands));
    return 0;
  }
  const failure = preflight(resolution.command, resolution.argv);
  if (failure !== null) {
    output(`error: ${failure}\nUsage: ${resolution.command.usage}`, true);
    return 1;
  }
  const module = await resolution.command.load();
  // Existing grouped presenters own their final verb (`lists create`, `seed tag
  // add`). Keep that compatibility grammar while exposing one router boundary.
  const prefix = resolution.command.path[0] === "seed"
    ? resolution.command.path.slice(1)
    : resolution.command.path[0] === "players" && resolution.command.path[1] === "lists"
      ? resolution.command.path.slice(2)
      : [];
  return module.main([...prefix, ...resolution.argv]);
}

import { exitAfterDrain, isMain } from "./main.js";
if (isMain(import.meta.url)) {
  runRouter().then(exitAfterDrain).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return exitAfterDrain(1);
  });
}
