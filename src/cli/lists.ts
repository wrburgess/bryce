import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import type { PlayerRef } from "../watchlist/service.js";
import { PlayerNotFoundError } from "../watchlist/service.js";
import type { ListConfigPatch } from "../lists/service.js";
import {
  BlankListNameError,
  CannotDeleteDefaultListError,
  DuplicateListNameError,
  InvalidListConfigError,
  NoDefaultListError,
  UnknownListError,
  addToList,
  configureList,
  createList,
  deleteList,
  listLists,
  listMembersById,
  removeFromList,
  renameList,
  resolveListByName,
  setDefaultList,
} from "../lists/service.js";
import { parseFlags } from "./flags.js";
import { exitAfterDrain, isMain } from "./main.js";
import { CLEAR_LITERAL, normalizeDirect, preflightDirect } from "./router.js";

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
 *   set-default --name NAME               point the default lane at a list (#190)
 *   configure --name NAME [--refresh-every M|none] [--digest-hour H|none] [--digest-to A|none]
 *                                         set a lane's cadence/recipients (#191)
 *   add    --name NAME --person-ids a,b --highlightly-player-ids c   add members (idempotent)
 *   remove --name NAME --person-ids a,b --highlightly-player-ids c   remove members
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
      case "set-default":
        return await runSetDefault(flags, deps);
      case "configure":
        return await runConfigure(flags, deps);
      case "add":
        return await runAddRemove("add", flags, deps);
      case "remove":
        return await runAddRemove("remove", flags, deps);
      case "show":
        return await runShow(flags, deps);
      default:
        err(
          "error=usage: lists <create|rename|delete|set-default|configure|add|remove|show> [--name NAME] ...",
        );
        return 1;
    }
  } catch (e) {
    if (
      e instanceof UnknownListError ||
      e instanceof DuplicateListNameError ||
      e instanceof BlankListNameError ||
      e instanceof CannotDeleteDefaultListError ||
      e instanceof NoDefaultListError ||
      e instanceof InvalidListConfigError ||
      e instanceof PlayerNotFoundError
    ) {
      err(`error=${e.message}`);
      return 1;
    }
    throw e;
  }
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

async function runSetDefault(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const list = await setDefaultList(deps.db, name, deps.now());
  deps.write(`list default id=${list.id} name=${list.name}`);
  return 0;
}

/**
 * A lane-configuration integer flag: absent → undefined (leave the column
 * alone), the RESERVED literal `none` → null (clear it), otherwise a CANONICAL
 * integer. Canonical in the `positiveInteger` sense the router uses, so `07`,
 * `1e2`, `+5`, and `3.0` are usage errors rather than values silently coerced
 * into a schedule. RANGE is deliberately NOT checked here — the service owns
 * the bounds (and 0 is a valid `--digest-hour`), so the CLI cannot drift from
 * the DB CHECKs by re-stating them.
 */
function parseConfigInteger(
  raw: string | undefined,
  label: string,
  deps: ListsDeps,
): number | null | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === CLEAR_LITERAL) return null;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || String(parsed) !== value || !Number.isSafeInteger(parsed)) {
    (deps.writeError ?? deps.write)(`error=invalid ${label} value ${raw}; expected a canonical integer or '${CLEAR_LITERAL}'`);
    return "invalid";
  }
  return parsed;
}

/**
 * `configure` — set a lane's cadence and recipients (#191). Only the flags
 * actually supplied are written; the other columns keep their values, which is
 * why the patch distinguishes "absent" from "cleared". The literal `none` is
 * RESERVED as the clear token and therefore cannot be used as a `--digest-to`
 * address.
 */
async function runConfigure(flags: Map<string, string>, deps: ListsDeps): Promise<number> {
  const name = requireName(flags, deps);
  if (name === null) return 1;
  const patch: ListConfigPatch = {};
  const interval = parseConfigInteger(flags.get("refresh-every"), "--refresh-every", deps);
  if (interval === "invalid") return 1;
  if (interval !== undefined) patch.refreshIntervalMinutes = interval;
  const hour = parseConfigInteger(flags.get("digest-hour"), "--digest-hour", deps);
  if (hour === "invalid") return 1;
  if (hour !== undefined) patch.digestHour = hour;
  const to = flags.get("digest-to");
  if (to !== undefined) patch.digestTo = to.trim() === CLEAR_LITERAL ? null : to;
  if (Object.keys(patch).length === 0) {
    (deps.writeError ?? deps.write)(
      "error=configure requires at least one of --refresh-every, --digest-hour, --digest-to",
    );
    return 1;
  }
  const list = await configureList(deps.db, name, patch, deps.now());
  // `-` for an unset column, the same null spelling `seed list` uses, so one
  // greppable line always carries all three fields.
  deps.write(
    `list configured id=${list.id} name=${list.name} refreshEvery=${list.refreshIntervalMinutes ?? "-"} ` +
      `digestHour=${list.digestHour ?? "-"} digestTo=${list.digestTo ?? "-"}`,
  );
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
  const highlightlyIds = parseIds(flags.get("highlightly-player-ids"), deps, "--highlightly-player-ids");
  if (highlightlyIds === null) return 1;
  const refs: PlayerRef[] = [
    ...personIds.map((id): PlayerRef => id),
    ...highlightlyIds.map((playerId): PlayerRef => ({ kind: "highlightly", playerId })),
  ];
  if (refs.length === 0) {
    (deps.writeError ?? deps.write)(`error=${op} requires --person-ids and/or --highlightly-player-ids`);
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
        p.level === "ncaa" ? `highlightlyPlayerId=${p.highlightlyPlayerId ?? "-"}` : `personId=${p.externalId ?? "-"}`;
      deps.write(`member listId=${list.id} playerId=${p.id} name=${p.fullName} ${idRef}`);
    }
    deps.write(`total=${members.length}`);
    return 0;
  }
  const lists = await listLists(deps.db);
  for (const l of lists) {
    deps.write(`list id=${l.id} name=${l.name} members=${l.memberCount} default=${l.isDefault}`);
  }
  deps.write(`total=${lists.length}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const failure = command === undefined
    ? "unknown or incomplete command ''"
    : preflightDirect(["players", "lists", command], argv, [command]);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  // Validate first, then collapse aliases/`=` forms to one canonical spelling,
  // so `parseFlags` below never has to know an option has a short form (#191).
  const normalized = command === undefined
    ? argv
    : normalizeDirect(["players", "lists", command], argv, [command]);
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runLists(normalized, {
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
