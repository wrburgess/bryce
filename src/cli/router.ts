import { NCAA_SEASONS } from "../ncaa/seasons.js";
import { readFileSync, statSync } from "node:fs";

/**
 * The safe command boundary for the locally activated `bryce` executable.
 *
 * This module intentionally imports no configuration or service modules.  Route resolution,
 * help, and option preflight are pure; a leaf is imported only after that work succeeds.
 */
export type CliAdapter = (argv: string[]) => Promise<number>;

export type Option = { name: string; value?: boolean; aliases?: string[]; values?: readonly string[]; description: string; validate?: (value: string) => string | null; inline?: boolean; repeatable?: boolean };
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
  requires?: readonly (readonly [string, string])[];
  /** Long-lived adapters keep the router process alive after startup. */
  longRunning?: boolean;
  semantic?: (values: ReadonlyMap<string, readonly string[]>) => string | null;
};

export type Group = {
  path: readonly string[];
  purpose: string;
  usage: string;
  options: readonly string[];
  example: string;
};

export const GROUPS: readonly Group[] = [
  { path: ["players"], purpose: "Manage players, lists, and backups.", usage: "bryce players <command>", options: [], example: "bryce players lists show" },
  { path: ["players", "lists"], purpose: "Manage named player lists.", usage: "bryce players lists <command>", options: ["--name", "--person-ids", "--ncaa-seqs"], example: "bryce players lists show" },
  { path: ["db"], purpose: "Manage the Bryce database.", usage: "bryce db <command>", options: [], example: "bryce db migrate" },
  { path: ["ncaa"], purpose: "Probe NCAA data sources.", usage: "bryce ncaa <command>", options: ["--seq", "--season", "--type"], example: "bryce ncaa probe --seq 2649785" },
  { path: ["connector"], purpose: "Check external connectors.", usage: "bryce connector <command>", options: ["--mutate"], example: "bryce connector smoke" },
  { path: ["seed"], purpose: "Manage the watch list and player tags.", usage: "bryce seed <command>", options: ["--person-id", "--ncaa-seq", "--tags"], example: "bryce seed list" },
  { path: ["seed", "tag"], purpose: "Manage manual and derived player tags.", usage: "bryce seed tag <command>", options: ["--person-id", "--ncaa-seq", "--tag"], example: "bryce seed tag list --person-id 691185" },
];

const leaf = (
  path: readonly string[], purpose: string, usage: string, example: string,
  load: Command["load"], options: readonly Option[] = [], requirements: Pick<Command, "required" | "oneOf" | "exactlyOneOf" | "requires" | "semantic"> = {},
): Command => ({ path, purpose, usage, example, load, options, ...requirements });

const nonBlank = (value: string): string | null => value.trim().length > 0 ? null : "a non-blank value";
const controlFree = (value: string): string | null => /\p{Cc}/u.test(value) ? "a value without control characters" : null;
const withNonBlank = (validate?: Option["validate"]): Option["validate"] => (candidate) =>
  nonBlank(candidate) ?? controlFree(candidate) ?? validate?.(candidate) ?? null;
const value = (name: string, description: string, values?: readonly string[], aliases?: string[], validate?: Option["validate"], repeatable = false): Option =>
  ({ name, description, values, aliases, validate: withNonBlank(validate), repeatable });
const inlineValue = (name: string, description: string, values?: readonly string[], aliases?: string[], validate?: Option["validate"]): Option =>
  ({ name, description, values, aliases, validate: withNonBlank(validate), inline: true });
const flag = (name: string, description: string, aliases?: string[]): Option => ({ name, description, value: false, aliases });
const positiveInteger = (value: string): string | null => /^\d+$/.test(value) && String(Number(value)) === value && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? null : "a canonical positive integer";
const supportedSeasons = NCAA_SEASONS.map((season) => season.year);
const year = (value: string): string | null => /^\d{4}$/.test(value)
  ? (supportedSeasons.includes(value) ? null : `a supported NCAA season (${supportedSeasons.join(", ")})`)
  : "a four-digit year";
const positiveIntegerList = (value: string): string | null => value.split(",").every((part) => positiveInteger(part.trim()) === null) ? null : "a comma-separated list of positive integers";
const uniqueBoundedIntegerList = (value: string): string | null => {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "at least one canonical positive integer";
  if (parts.some((part) => positiveInteger(part) !== null)) return "a comma-separated list of canonical positive integers";
  if (new Set(parts).size !== parts.length) return "a comma-separated list without duplicate IDs";
  return null;
};
const batchName = (value: string): string | null => value.trim().length > 120 ? "a name of at most 120 characters" : null;
const normalizedBatchName = (value: string): string => value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
const batchShape = (values: ReadonlyMap<string, readonly string[]>): string | null => {
  const personIds = (values.get("person-ids") ?? []).flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean));
  const ncaaSeqs = (values.get("ncaa-seqs") ?? []).flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean));
  if (new Set(personIds).size !== personIds.length || new Set(ncaaSeqs).size !== ncaaSeqs.length) return "batch IDs must be unique within each identity type";
  const names = values.get("names") ?? [];
  if (names.some((name) => batchName(name) !== null)) return "batch names must be at most 120 characters";
  const nameKeys = new Set(names.map(normalizedBatchName));
  if (nameKeys.size !== names.length) return "batch names must be unique ignoring case and whitespace";
  let fileEntries: string[] = [];
  for (const file of values.get("file") ?? []) {
    try {
      if (statSync(file).size > 64 * 1024) return "batch file exceeds the 64 KB size ceiling";
      fileEntries = fileEntries.concat(readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")));
    } catch {
      return `batch file '${file}' is unreadable`;
    }
  }
  const filePersonIds = fileEntries.filter((entry) => /^\d+$/.test(entry));
  const fileNcaaSeqs = fileEntries.filter((entry) => entry.startsWith("ncaa:")).map((entry) => entry.slice(5).trim());
  if (new Set([...personIds, ...filePersonIds]).size !== personIds.length + filePersonIds.length || new Set([...ncaaSeqs, ...fileNcaaSeqs]).size !== ncaaSeqs.length + fileNcaaSeqs.length) {
    return "batch IDs must be unique within each identity type";
  }
  const fileNames = fileEntries.filter((entry) => !/^\d+$/.test(entry) && !entry.startsWith("ncaa:")).map((entry) => entry.startsWith("name:") ? entry.slice(5).trim() : entry);
  if (fileNames.some((name) => name.length === 0)) return "batch file contains a blank name";
  if (fileNames.some((name) => /\p{Cc}/u.test(name))) return "batch file names must not contain control characters";
  if (fileNames.some((name) => name.trim().length > 120)) return "batch names must be at most 120 characters";
  for (const name of fileNames.map(normalizedBatchName)) {
    if (nameKeys.has(name)) return "batch names must be unique ignoring case and whitespace";
    nameKeys.add(name);
  }
  const total = personIds.length + ncaaSeqs.length + names.length + fileEntries.length;
  if (total === 0) return "batch must contain at least one entry";
  if (fileEntries.some((entry) => entry.startsWith("ncaa:") && positiveInteger(entry.slice(5).trim()) !== null)) return "batch file contains an invalid NCAA sequence";
  if (fileEntries.some((entry) => /^\d+$/.test(entry) && positiveInteger(entry) !== null)) return "batch file contains an invalid person ID";
  return total > 25 ? "batch contains at most 25 entries" : null;
};
const manualTag = (candidate: string): string | null => {
  const match = /^([^:]+):([^:]+)$/.exec(candidate);
  if (match === null || match[1] !== "status" || !["rostered", "scouted"].includes(match[2]!)) {
    return "a manual tag status:rostered or status:scouted";
  }
  return null;
};
const tagSelector = (candidate: string): string | null => {
  const segments = candidate.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return "a non-empty comma-separated tag selector";
  const seen = new Set<string>();
  for (const segment of segments) {
    if ((segment.match(/:/g) ?? []).length > 1) return "well-formed tag tokens (namespace or namespace:value)";
    const [namespace, tagValue] = segment.split(":");
    if (!namespace || (tagValue !== undefined && !tagValue)) return "well-formed tag tokens (namespace or namespace:value)";
    seen.add(`${namespace}\0${tagValue ?? ""}`);
  }
  return seen.size > 16 ? "at most 16 distinct tag tokens" : null;
};

/** Canonical built-in syntax/help metadata. Operational detail belongs in docs/cli. */
export const COMMANDS: readonly Command[] = [
  leaf(["digest"], "Build and send a digest.", "bryce digest [--window SPEC|-w SPEC] [--list NAME] [--force|-f]", "bryce digest -w 7d", () => import("./digest.js"), [inlineValue("window", "Digest window.", ["1d", "7d", "14d", "21d", "28d", "35d", "60d", "ytd"], ["w"]), inlineValue("list", "Named player list."), flag("force", "Replay the daily slot when allowed.", ["f"])]),
  leaf(["refresh"], "Refresh the active watch list.", "bryce refresh", "bryce refresh", () => import("./refresh.js")),
  leaf(["players", "lists", "create"], "Create a named player list.", "bryce players lists create --name NAME", "bryce players lists create --name Prospects", () => import("./lists.js"), [value("name", "List name.")], { required: ["name"] }),
  leaf(["players", "lists", "rename"], "Rename a named player list.", "bryce players lists rename --name OLD --to NEW", "bryce players lists rename --name Prospects --to 'Top 30'", () => import("./lists.js"), [value("name", "Current list name."), value("to", "New list name.")], { required: ["name", "to"] }),
  leaf(["players", "lists", "delete"], "Delete a named player list.", "bryce players lists delete --name NAME", "bryce players lists delete --name Prospects", () => import("./lists.js"), [value("name", "List name.")], { required: ["name"] }),
  leaf(["players", "lists", "add"], "Add players to a named list.", "bryce players lists add --name NAME [--person-ids IDS] [--ncaa-seqs IDS]", "bryce players lists add --name Prospects --person-ids 691185", () => import("./lists.js"), [value("name", "List name."), value("person-ids", "Comma-separated MLB ids.", undefined, undefined, positiveIntegerList), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, positiveIntegerList)], { required: ["name"], oneOf: [["person-ids", "ncaa-seqs"]] }),
  leaf(["players", "lists", "remove"], "Remove players from a named list.", "bryce players lists remove --name NAME [--person-ids IDS] [--ncaa-seqs IDS]", "bryce players lists remove --name Prospects --person-ids 691185", () => import("./lists.js"), [value("name", "List name."), value("person-ids", "Comma-separated MLB ids.", undefined, undefined, positiveIntegerList), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, positiveIntegerList)], { required: ["name"], oneOf: [["person-ids", "ncaa-seqs"]] }),
  leaf(["players", "lists", "show"], "Show named lists or their members.", "bryce players lists show [--name NAME]", "bryce players lists show", () => import("./lists.js"), [value("name", "List name.")]),
  leaf(["players", "backup"], "Write a player-list backup.", "bryce players backup --out FILE", "bryce players backup --out backups/players.json", () => import("./players-backup.js"), [value("out", "Output file.")], { required: ["out"] }),
  leaf(["players", "restore"], "Restore a player-list backup.", "bryce players restore --in FILE", "bryce players restore --in backups/players.json", () => import("./players-restore.js"), [value("in", "Input file.")], { required: ["in"] }),
  leaf(["players", "batch-add"], "Stage many players.", "bryce players batch-add [--person-ids IDS] [--ncaa-seqs IDS] [--names NAME] [--file FILE]", "bryce players batch-add --person-ids 691185", () => import("./batch-add.js"), [value("person-ids", "Comma-separated MLB ids.", undefined, undefined, uniqueBoundedIntegerList, true), value("ncaa-seqs", "Comma-separated NCAA ids.", undefined, undefined, uniqueBoundedIntegerList, true), value("names", "Player name; repeatable.", undefined, undefined, batchName, true), value("file", "Input file.", undefined, undefined, undefined, true)], { oneOf: [["person-ids", "ncaa-seqs", "names", "file"]], semantic: batchShape }),
  leaf(["db", "migrate"], "Apply pending database migrations.", "bryce db migrate", "bryce db migrate", () => import("./migrate.js")),
  leaf(["db", "backup"], "Create a database snapshot.", "bryce db backup", "bryce db backup", () => import("./backup.js")),
  leaf(["db", "restore"], "Restore a database snapshot.", "bryce db restore --from FILE", "bryce db restore --from backups/bryce-YYYYMMDDTHHMMSSZ-000.db", () => import("./restore.js"), [value("from", "Snapshot file.")], { required: ["from"] }),
  leaf(["ncaa", "probe"], "Probe the NCAA scraper.", "bryce ncaa probe --seq N [--season YYYY] [--type TYPE]", "bryce ncaa probe --seq 2649785", () => import("./ncaa-probe.js"), [value("seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("season", "Season year.", supportedSeasons, undefined, year), value("type", "Stat type.", ["batting", "pitching", "fielding"])], { required: ["seq"] }),
  leaf(["connector", "smoke"], "Smoke-test a running MCP connector.", "bryce connector smoke [--mutate]", "bryce connector smoke", () => import("./connector-smoke.js"), [flag("mutate", "Also run the configured mutation probe.")]),
  leaf(["seed", "add"], "Add a watch-list player.", "bryce seed add (--person-id N|--ncaa-seq N|--search NAME) [--pick I]", "bryce seed add --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("search", "Player name."), value("pick", "One-based search result.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq", "search"]], requires: [["pick", "search"]] }),
  leaf(["seed", "deactivate"], "Deactivate a watch-list player.", "bryce seed deactivate (--person-id N|--ncaa-seq N)", "bryce seed deactivate --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "list"], "List watch-list players.", "bryce seed list [--tags EXPR]", "bryce seed list --tags status:rostered", () => import("./seed.js"), [value("tags", "Tag selector.", undefined, undefined, tagSelector)]),
  leaf(["seed", "tag", "add"], "Add a manual player tag.", "bryce seed tag add (--person-id N|--ncaa-seq N) --tag TAG", "bryce seed tag add --person-id 691185 --tag status:rostered", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("tag", "Manual tag.", undefined, undefined, manualTag)], { required: ["tag"], exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "remove"], "Remove a manual player tag.", "bryce seed tag remove (--person-id N|--ncaa-seq N) --tag TAG", "bryce seed tag remove --person-id 691185 --tag status:rostered", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger), value("tag", "Manual tag.", undefined, undefined, manualTag)], { required: ["tag"], exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "list"], "List player tags.", "bryce seed tag list (--person-id N|--ncaa-seq N)", "bryce seed tag list --person-id 691185", () => import("./seed.js"), [value("person-id", "MLB person id.", undefined, undefined, positiveInteger), value("ncaa-seq", "NCAA player sequence.", undefined, undefined, positiveInteger)], { exactlyOneOf: [["person-id", "ncaa-seq"]] }),
  leaf(["seed", "tag", "rebuild"], "Rebuild derived tags.", "bryce seed tag rebuild", "bryce seed tag rebuild", () => import("./seed.js")),
  { ...leaf(["server"], "Run the REST and MCP server.", "bryce server", "bryce server", () => import("../server.js")), longRunning: true },
];

const write = (line: string, error = false): void => {
  (error ? process.stderr : process.stdout).write(`${line}\n`);
};
export function renderHelp(path: readonly string[] = [], commands: readonly Command[] = COMMANDS): string {
  const group = GROUPS.find((entry) => entry.path.join("\0") === path.join("\0"));
  if (group !== undefined) {
    return [group.purpose, "", `Usage: ${group.usage}`, `Options: ${group.options.join(", ") || "none"}`, "", `Example: ${group.example}`, "", ...renderGroupChildren(path, commands), `Run 'bryce ${path.join(" ")} help <command>' for command help.`].join("\n");
  }
  const exact = commands.find((command) => command.path.join("\0") === path.join("\0"));
  if (exact !== undefined) {
    const optionLines = (exact.options ?? []).map((option) => {
      const names = [`--${option.name}`, ...(option.aliases ?? []).map((alias) => `-${alias}`)].join(", ");
      const accepted = option.values === undefined ? "" : ` (values: ${option.values.join(" | ")})`;
      return `  ${names}${option.value === false ? "" : " <value>"}  ${option.description}${accepted}`;
    });
    return [exact.purpose, "", `Usage: ${exact.usage}`, ...(optionLines.length ? ["", "Options:", ...optionLines] : []), "", `Example: ${exact.example}`].join("\n");
  }
  const label = path.length === 0 ? "bryce" : `bryce ${path.join(" ")}`;
  const entries = renderGroupChildren(path, commands);
  return [`Usage: ${label} <command>`, "", "Commands:", ...entries, "", `Run '${label} help <command>' for command help.`].join("\n");
}

function renderGroupChildren(path: readonly string[], commands: readonly Command[]): string[] {
  return [...new Set(commands.filter((c) => c.path.length > path.length && path.every((p, i) => c.path[i] === p)).map((c) => c.path[path.length]!))].sort().map((child) => {
    const group = GROUPS.find((entry) => entry.path.length === path.length + 1 && entry.path[path.length] === child && path.every((p, i) => entry.path[i] === p));
    if (group !== undefined) {
      return `  ${child}\n    Purpose: ${group.purpose}\n    Usage: ${group.usage}\n    Options: ${group.options.join(", ") || "none"}\n    Example: ${group.example}`;
    }
    const childCommand = commands.find((c) => c.path.length === path.length + 1 && c.path[path.length] === child && path.every((p, i) => c.path[i] === p))
      ?? commands.find((c) => c.path.length > path.length && c.path[path.length] === child && path.every((p, i) => c.path[i] === p));
    if (childCommand === undefined) return `  ${child}`;
    const details = childCommand.path.length === path.length + 1
      ? `\n    Purpose: ${childCommand.purpose}\n    Usage: ${childCommand.usage}\n    Options: ${(childCommand.options ?? []).map((option) => `--${option.name}`).join(", ") || "none"}\n    Example: ${childCommand.example}`
      : `  ${childCommand.purpose}`;
    return `  ${child}${details}`;
  });
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
    if (hasChild && ["help", "--help", "-h"].includes(argv[index] ?? "")) return { help: [...path, ...argv.slice(index + 1)] };
    if (exact !== undefined && (!hasChild || argv[index] === undefined || argv[index]!.startsWith("-"))) {
      return { command: exact, argv: argv.slice(index) };
    }
    if (!hasChild && exact === undefined) break;
    pathLength = index;
  }
  const attempted = argv.slice(0, pathLength + 1).join(" ");
  return { error: `unknown or incomplete command '${attempted}'` };
}

export function preflight(command: Command, argv: readonly string[], validateValues = true): string | null {
  const allowed = new Map<string, Option>();
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  for (const option of command.options ?? []) {
    allowed.set(`--${option.name}`, option);
    for (const alias of option.aliases ?? []) allowed.set(`-${alias}`, option);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) return `unexpected argument '${arg}'`;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (equals !== -1 && arg.indexOf("=", equals + 1) !== -1) return `option '${name}' contains extra '=' content`;
    const option = allowed.get(name ?? "");
    if (option === undefined) return `unknown option '${name}'`;
    if (inline !== undefined && (option.inline !== true || !name?.startsWith("--"))) return `option '${name}' does not support '=' syntax`;
    if (seen.has(option.name) && option.repeatable !== true) return `option '--${option.name}' may not be repeated`;
    if (option.value === false) {
      if (inline !== undefined) return `option '${name}' does not take a value`;
      seen.add(option.name);
      continue;
    }
    const candidate = inline ?? argv[++index];
    if (candidate === undefined || candidate.startsWith("-")) return `option '${name}' requires a value`;
    if (validateValues) {
      const validation = option.validate?.(candidate);
      if (validation !== undefined && validation !== null) return `invalid value '${candidate}' for '${name}'; expected ${validation}`;
      if (option.values !== undefined && !option.values.includes(candidate)) return `invalid value '${candidate}' for '${name}'; expected ${option.values.join(", ")}`;
    }
    seen.add(option.name);
    const prior = values.get(option.name) ?? [];
    prior.push(candidate);
    values.set(option.name, prior);
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
  for (const [dependent, prerequisite] of command.requires ?? []) {
    if (seen.has(dependent) && !seen.has(prerequisite)) {
      return `option '--${dependent}' requires '--${prerequisite}'`;
    }
  }
  const semanticFailure = command.semantic?.(values);
  if (semanticFailure !== undefined && semanticFailure !== null) return semanticFailure;
  return null;
}

/**
 * Validates a direct npm-compatible entry point against the router's canonical
 * schema. Call this before dotenv/config/database initialization; `prefix`
 * retains the public grouped verbs used by the lists and seed scripts.
 */
export function preflightDirect(path: readonly string[], argv: readonly string[], prefix: readonly string[] = [], validateValues = true): string | null {
  const command = COMMANDS.find((candidate) => candidate.path.join("\0") === path.join("\0"));
  if (command === undefined) return `unknown command '${path.join(" ")}'`;
  if (prefix.length > 0) {
    if (!prefix.every((part, index) => argv[index] === part)) return `unknown or incomplete command '${argv.join(" ")}'`;
    return preflight(command, argv.slice(prefix.length), validateValues);
  }
  return preflight(command, argv, validateValues);
}

export async function runRouter(argv = process.argv.slice(2), output: (line: string, error?: boolean) => void = write, commands: readonly Command[] = COMMANDS): Promise<number> {
  const resolution = resolve(argv, commands);
  if (resolution.help !== undefined) {
    if (!GROUPS.some((group) => group.path.join("\0") === resolution.help!.join("\0")) && !commands.some((command) => resolution.help!.every((part, index) => command.path[index] === part))) {
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
  const processArgv = process.argv.slice(2);
  runRouter(processArgv).then((code) => {
    // A server listener owns the process lifetime and installs its own signal
    // shutdown/drain path. Do not call process.exit after startup, or the
    // routed `bryce server` command would die immediately after `serve()`.
    if (resolve(processArgv).command?.longRunning === true) {
      process.exitCode = code;
      return;
    }
    return exitAfterDrain(code);
  }).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return exitAfterDrain(1);
  });
}
