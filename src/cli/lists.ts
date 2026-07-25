import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import type { PlayerRef } from "../watchlist/service.js";
import { PlayerNotFoundError } from "../watchlist/service.js";
import {
  BlankListNameError,
  DuplicateListNameError,
  UnknownListError,
  addToList,
  createList,
  deleteList,
  listLists,
  listMembersById,
  removeFromList,
  renameList,
  resolveListByName,
} from "../lists/service.js";
import { exitAfterDrain, isMain } from "./main.js";

/**
 * Named-list CLI (issue #70 / ADR 0046): a thin presenter over the list service
 * (src/lists/service.ts). Output is deterministic, greppable key=value lines; as
 * a human-facing app CLI it echoes the member's canonical (NFC) identity and the
 * user-supplied list name verbatim in UTF-8 — not ASCII-folded (ADR 0047,
 * scoping rules/scripting.md). A failure writes an `error=` line and exits
 * non-zero. Distinct from `seed list` (which prints players).
 *
 * Subcommands:
 *   create --name NAME                    create a new list
 *   rename --name OLD --to NEW            rename a live list
 *   delete --name NAME                    soft-delete a list (name frees for reuse)
 *   add    --name NAME --person-ids a,b --ncaa-seqs c   add members (idempotent)
 *   remove --name NAME --person-ids a,b --ncaa-seqs c   remove members
 *   show                                  print every live list + member counts
 *   show   --name NAME                    print a list's active members
 */

export interface ListsDeps {
  db: Db;
  now: () => Date;
  write: (line: string) => void;
  writeError?: (line: string) => void;
}

export async function runLists(argv: string[], deps: ListsDeps): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const err = deps.writeError ?? deps.write;
  try {
    switch (command) {
      case "create":
        return await runCreate(flags, deps);
      case "rename":
        return await runRename(flags, deps);
      case "delete":
        return await runDelete(flags, deps);
      case "add":
        return await runAddRemove("add", flags, deps);
      case "remove":
        return await runAddRemove("remove", flags, deps);
      case "show":
        return await runShow(flags, deps);
      default:
        err("error=usage: lists <create|rename|delete|add|remove|show> [--name NAME] ...");
        return 1;
    }
  } catch (e) {
    if (
      e instanceof UnknownListError ||
      e instanceof DuplicateListNameError ||
      e instanceof BlankListNameError ||
      e instanceof PlayerNotFoundError
    ) {
      err(`error=${e.message}`);
      return 1;
    }
    throw e;
  }
}

function parseFlags(args: string[]): Map<string, string> {
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

function requireName(flags: Map<string, string>, deps: ListsDeps): string | null {
  const name = flags.get("name");
  if (name === undefined || name.trim().length === 0) {
    (deps.writeError ?? deps.write)("error=--name is required and must be non-blank");
    return null;
  }
  return name.trim();
}

async function runCreate(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const list = await createList(deps.db, name, deps.now());
  deps.write(`list created id=${list.id} name=${list.name}`);
  return 0;
}

async function runRename(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const to = flags.get("to");
  if (to === undefined || to.trim().length === 0) {
    (deps.writeError ?? deps.write)("error=rename requires --to NEW");
    return 1;
  }
  const list = await renameList(deps.db, name, to.trim(), deps.now());
  deps.write(`list renamed id=${list.id} name=${list.name}`);
  return 0;
}

async function runDelete(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const list = await deleteList(deps.db, name, deps.now());
  deps.write(`list deleted id=${list.id} name=${list.name}`);
  return 0;
}

/** Parse comma-separated positive integers, or null on any malformed token. */
function parseIds(value: string | undefined, deps: ListsDeps, label: string): number[] | null {
  if (value === undefined || value.trim().length === 0) return [];
  const ids: number[] = [];
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      (deps.writeError ?? deps.write)(`error=invalid ${label} value ${trimmed}`);
      return null;
    }
    ids.push(n);
  }
  return ids;
}

async function runAddRemove(
  op: "add" | "remove",
  flags: Map<string, string>,
  deps: ListsDeps,
): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const personIds = parseIds(flags.get("person-ids"), deps, "--person-ids");
  if (personIds === null) return 1;
  const ncaaSeqs = parseIds(flags.get("ncaa-seqs"), deps, "--ncaa-seqs");
  if (ncaaSeqs === null) return 1;
  const refs: PlayerRef[] = [
    ...personIds.map((id): PlayerRef => id),
    ...ncaaSeqs.map((seq): PlayerRef => ({ ncaaPlayerSeq: seq })),
  ];
  if (refs.length === 0) {
    (deps.writeError ?? deps.write)(`error=${op} requires --person-ids and/or --ncaa-seqs`);
    return 1;
  }
  if (op === "add") {
    const result = await addToList(deps.db, name, refs, deps.now());
    deps.write(`list add name=${result.list.name} added=${result.changed} refs=${refs.length}`);
  } else {
    const result = await removeFromList(deps.db, name, refs, deps.now());
    deps.write(`list remove name=${result.list.name} removed=${result.changed} refs=${refs.length}`);
  }
  return 0;
}

async function runShow(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = flags.get("name");
  if (name !== undefined && name.trim().length > 0) {
    const list = await resolveListByName(deps.db, name.trim());
    const members = await listMembersById(deps.db, list.id);
    for (const p of members) {
      const idRef =
        p.level === "ncaa" ? `ncaaSeq=${p.ncaaPlayerSeq ?? "-"}` : `personId=${p.externalId ?? "-"}`;
      deps.write(`member listId=${list.id} playerId=${p.id} name=${p.fullName} ${idRef}`);
    }
    deps.write(`total=${members.length}`);
    return 0;
  }
  const lists = await listLists(deps.db);
  for (const l of lists) {
    deps.write(`list id=${l.id} name=${l.name} members=${l.memberCount}`);
  }
  deps.write(`total=${lists.length}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runLists(argv, {
      db,
      now: () => new Date(),
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    close();
  }
}

if (isMain(import.meta.url)) {
  main()
    .then(exitAfterDrain)
    .catch((err: unknown) => {
      process.stderr.write(`error=${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
