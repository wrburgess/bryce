import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { openDb } from "../db/client.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbClient as MlbClientImpl } from "../mlb/client.js";
import {
  PlayerNotFoundError,
  UnknownPersonError,
  addPlayer,
  deactivatePlayer,
  listPlayers,
} from "../watchlist/service.js";
import { isMain } from "./main.js";

/**
 * Watch-list seeding CLI: a thin presenter over the watch-list service
 * (src/watchlist/service.ts). Output is deterministic, greppable, ASCII-only
 * key=value lines (rules/scripting.md); exit code is non-zero on failure.
 *
 * Subcommands:
 *   add --person-id N          add by MLB Stats API personId
 *   add --search "name" [--pick i]   search by name; --pick chooses (1-based)
 *   deactivate --person-id N   remove from the Watch List (history kept)
 *   list                       print every player row
 */

export interface SeedDeps {
  db: Db;
  client: MlbClient;
  now: () => Date;
  tz: string;
  write: (line: string) => void;
}

export async function runSeed(argv: string[], deps: SeedDeps): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "add":
      return runAdd(flags, deps);
    case "deactivate":
      return runDeactivate(flags, deps);
    case "list":
      return runList(deps);
    default:
      deps.write("error: usage: seed <add|deactivate|list> [--person-id N] [--search NAME] [--pick I]");
      return 1;
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

async function runAdd(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const personIdFlag = flags.get("person-id");
  const search = flags.get("search");

  let personId: number;
  if (personIdFlag !== undefined) {
    personId = Number.parseInt(personIdFlag, 10);
    if (!Number.isInteger(personId) || personId <= 0) {
      deps.write(`error: invalid --person-id ${personIdFlag}`);
      return 1;
    }
  } else if (search !== undefined && search.trim().length > 0) {
    const picked = await pickFromSearch(search.trim(), flags.get("pick"), deps);
    if (picked === null) return 1;
    personId = picked;
  } else {
    deps.write("error: add requires --person-id N or --search NAME");
    return 1;
  }

  let result;
  try {
    result = await addPlayer(
      { db: deps.db, client: deps.client, now: deps.now, tz: deps.tz },
      personId,
    );
  } catch (err) {
    if (err instanceof UnknownPersonError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { player, refresh } = result;
  if (result.action === "updated") {
    deps.write(`updated player id=${player.id} personId=${personId} name=${player.fullName}`);
    return 0;
  }

  deps.write(`added player id=${player.id} personId=${personId} name=${player.fullName}`);
  if (refresh === null || refresh.skipped) {
    deps.write("refresh skipped reason=offseason-sleep");
  } else {
    deps.write(`refresh done inserted=${refresh.inserted} updated=${refresh.updated}`);
  }
  return 0;
}

async function pickFromSearch(
  name: string,
  pickFlag: string | undefined,
  deps: SeedDeps,
): Promise<number | null> {
  const results = await deps.client.searchPeople(name);
  if (results.length === 0) {
    deps.write(`error: no matches for search=${name}`);
    return null;
  }
  if (results.length === 1 && pickFlag === undefined) {
    const only = results[0];
    return only !== undefined ? only.id : null;
  }
  if (pickFlag === undefined) {
    deps.write(`multiple matches for search=${name}; re-run with --pick I`);
    results.forEach((p, i) => {
      deps.write(
        `[${i + 1}] personId=${p.id} name=${p.fullName} position=${p.primaryPosition?.abbreviation ?? "?"}`,
      );
    });
    return null;
  }
  const pick = Number.parseInt(pickFlag, 10);
  const chosen = Number.isInteger(pick) ? results[pick - 1] : undefined;
  if (chosen === undefined) {
    deps.write(`error: --pick ${pickFlag} out of range 1..${results.length}`);
    return null;
  }
  return chosen.id;
}

async function runDeactivate(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const personIdFlag = flags.get("person-id");
  const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
  if (!Number.isInteger(personId) || personId <= 0) {
    deps.write("error: deactivate requires --person-id N");
    return 1;
  }
  let player;
  try {
    player = await deactivatePlayer({ db: deps.db, now: deps.now }, personId);
  } catch (err) {
    if (err instanceof PlayerNotFoundError) {
      deps.write(`error: no player with personId=${personId}`);
      return 1;
    }
    throw err;
  }
  deps.write(`deactivated player id=${player.id} personId=${personId} name=${player.fullName}`);
  return 0;
}

async function runList(deps: SeedDeps): Promise<number> {
  const rows = await listPlayers(deps.db, "all");
  for (const p of rows) {
    deps.write(
      `player id=${p.id} personId=${p.externalId ?? "-"} name=${p.fullName} level=${p.level} milbLevel=${p.milbLevel ?? "-"} team=${p.teamName ?? "-"} active=${p.active}`,
    );
  }
  deps.write(`total=${rows.length}`);
  return 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = openDb(config.databasePath);
  try {
    const client = new MlbClientImpl({ delayMs: config.mlbApiDelayMs });
    return await runSeed(process.argv.slice(2), {
      db,
      client,
      now: () => new Date(),
      tz: config.tz,
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    close();
  }
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
