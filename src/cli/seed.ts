import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { players } from "../db/schema.js";
import { startupDb } from "../db/startup.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbClient as MlbClientImpl } from "../mlb/client.js";
import type { NcaaClient } from "../ncaa/client.js";
import { NcaaClient as NcaaClientImpl } from "../ncaa/client.js";
import {
  ManualWriteToDerivedNamespaceError,
  UnknownTagError,
  addManualTag,
  listTags,
  removeManualTag,
  syncAllDerivedTags,
} from "../tags/service.js";
import {
  PlayerNotFoundError,
  UnknownNcaaPlayerError,
  UnknownPersonError,
  addNcaaPlayer,
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
 *   add --ncaa-seq N           add an NCAA player by stats.ncaa.org stats_player_seq
 *   add --search "name" [--pick i]   search by name; --pick chooses (1-based)
 *   deactivate --person-id N   remove from the Watch List (history kept)
 *   deactivate --ncaa-seq N    remove an NCAA player from the Watch List
 *   list [--tags EXPR]         print every player row, optionally tag-filtered
 *   tag add --person-id N|--ncaa-seq N --tag ns:value      add a manual tag
 *   tag remove --person-id N|--ncaa-seq N --tag ns:value   remove a manual tag
 *   tag list --person-id N|--ncaa-seq N                    list a player's tags
 *   tag rebuild                re-derive every player's derived tags (backfill)
 */

export interface SeedDeps {
  db: Db;
  client: MlbClient;
  ncaaClient: NcaaClient;
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
      return runList(flags, deps);
    case "tag":
      return runTag(rest, flags, deps);
    default:
      deps.write(
        "error: usage: seed <add|deactivate|list|tag> [--person-id N] [--ncaa-seq N] [--search NAME] [--pick I] [--tags EXPR] [--tag ns:value]",
      );
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
  const ncaaSeqFlag = flags.get("ncaa-seq");
  if (ncaaSeqFlag !== undefined) {
    return runAddNcaa(ncaaSeqFlag, deps);
  }

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
    deps.write("error: add requires --person-id N, --ncaa-seq N, or --search NAME");
    return 1;
  }

  let result;
  try {
    result = await addPlayer(
      { db: deps.db, client: deps.client, ncaaClient: deps.ncaaClient, now: deps.now, tz: deps.tz },
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

async function runAddNcaa(seqFlag: string, deps: SeedDeps): Promise<number> {
  const seq = Number.parseInt(seqFlag, 10);
  if (!Number.isInteger(seq) || seq <= 0) {
    deps.write(`error: invalid --ncaa-seq ${seqFlag}`);
    return 1;
  }

  let result;
  try {
    result = await addNcaaPlayer(
      { db: deps.db, client: deps.client, ncaaClient: deps.ncaaClient, now: deps.now, tz: deps.tz },
      seq,
    );
  } catch (err) {
    if (err instanceof UnknownNcaaPlayerError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { player, refresh } = result;
  if (result.action === "updated") {
    deps.write(`updated player id=${player.id} ncaaSeq=${seq} name=${player.fullName}`);
    return 0;
  }

  deps.write(`added player id=${player.id} ncaaSeq=${seq} name=${player.fullName}`);
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
  const ncaaSeqFlag = flags.get("ncaa-seq");
  const personIdFlag = flags.get("person-id");

  let ref: number | { ncaaPlayerSeq: number };
  let label: string;
  if (ncaaSeqFlag !== undefined) {
    const seq = Number.parseInt(ncaaSeqFlag, 10);
    if (!Number.isInteger(seq) || seq <= 0) {
      deps.write("error: deactivate requires --ncaa-seq N");
      return 1;
    }
    ref = { ncaaPlayerSeq: seq };
    label = `ncaaSeq=${seq}`;
  } else {
    const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
    if (!Number.isInteger(personId) || personId <= 0) {
      deps.write("error: deactivate requires --person-id N or --ncaa-seq N");
      return 1;
    }
    ref = personId;
    label = `personId=${personId}`;
  }

  let player;
  try {
    player = await deactivatePlayer({ db: deps.db, now: deps.now }, ref);
  } catch (err) {
    if (err instanceof PlayerNotFoundError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
  deps.write(`deactivated player id=${player.id} ${label} name=${player.fullName}`);
  return 0;
}

async function runList(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const tagsFlag = flags.get("tags");
  // A PRESENT-but-empty `--tags` (the flag given with no value) must not silently
  // list the whole roster as if it were absent — that is a falsely unfiltered
  // result. Only an ABSENT flag (undefined) means "no filter".
  if (tagsFlag !== undefined && tagsFlag.length === 0) {
    deps.write("error: --tags requires a selector expression");
    return 1;
  }
  let rows;
  try {
    rows = await listPlayers(deps.db, "all", tagsFlag);
  } catch (err) {
    if (err instanceof ZodError) {
      deps.write(`error: ${err.issues[0]?.message ?? "invalid --tags selector"}`);
      return 1;
    }
    throw err;
  }
  for (const p of rows) {
    const base =
      `player id=${p.id} personId=${p.externalId ?? "-"} name=${p.fullName} ` +
      `level=${p.level} milbLevel=${p.milbLevel ?? "-"} team=${p.teamName ?? "-"} active=${p.active}`;
    // NCAA rows carry a school and a stats_player_seq instead of a team/personId.
    const suffix =
      p.level === "ncaa" ? ` school=${p.schoolName ?? "-"} ncaaSeq=${p.ncaaPlayerSeq ?? "-"}` : "";
    deps.write(`${base}${suffix}`);
  }
  deps.write(`total=${rows.length}`);
  return 0;
}

/** Resolve --person-id / --ncaa-seq to a Player row; print an error and return null on miss. */
async function resolveTagPlayer(flags: Map<string, string>, deps: SeedDeps): Promise<PlayerRow | null> {
  const ncaaSeqFlag = flags.get("ncaa-seq");
  if (ncaaSeqFlag !== undefined) {
    const seq = Number.parseInt(ncaaSeqFlag, 10);
    if (!Number.isInteger(seq) || seq <= 0) {
      deps.write(`error: invalid --ncaa-seq ${ncaaSeqFlag}`);
      return null;
    }
    const row = (await deps.db.select().from(players).where(eq(players.ncaaPlayerSeq, seq)))[0];
    if (row === undefined) {
      deps.write(`error: ${new PlayerNotFoundError({ ncaaPlayerSeq: seq }).message}`);
      return null;
    }
    return row;
  }
  const personIdFlag = flags.get("person-id");
  const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
  if (!Number.isInteger(personId) || personId <= 0) {
    deps.write("error: tag requires --person-id N or --ncaa-seq N");
    return null;
  }
  const row = (await deps.db.select().from(players).where(eq(players.externalId, personId)))[0];
  if (row === undefined) {
    deps.write(`error: ${new PlayerNotFoundError(personId).message}`);
    return null;
  }
  return row;
}

/** Parse `--tag ns:value` into its parts, or null when malformed. */
function parseTagFlag(raw: string | undefined): { namespace: string; value: string } | null {
  if (raw === undefined || raw.length === 0) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return null;
  return { namespace: raw.slice(0, colon), value: raw.slice(colon + 1) };
}

async function runTag(rest: string[], flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const sub = rest[0];
  switch (sub) {
    case "add":
      return runTagAdd(flags, deps);
    case "remove":
      return runTagRemove(flags, deps);
    case "list":
      return runTagList(flags, deps);
    case "rebuild":
      return runTagRebuild(deps);
    default:
      deps.write(
        "error: usage: seed tag <add|remove|list|rebuild> [--person-id N|--ncaa-seq N] [--tag ns:value]",
      );
      return 1;
  }
}

async function runTagAdd(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const player = await resolveTagPlayer(flags, deps);
  if (player === null) return 1;
  const tag = parseTagFlag(flags.get("tag"));
  if (tag === null) {
    deps.write("error: tag add requires --tag ns:value");
    return 1;
  }
  try {
    const created = addManualTag(deps.db, player.id, tag.namespace, tag.value, deps.now());
    deps.write(
      `tag added playerId=${player.id} namespace=${created.namespace} value=${created.value} source=${created.source}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ManualWriteToDerivedNamespaceError || err instanceof UnknownTagError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function runTagRemove(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const player = await resolveTagPlayer(flags, deps);
  if (player === null) return 1;
  const tag = parseTagFlag(flags.get("tag"));
  if (tag === null) {
    deps.write("error: tag remove requires --tag ns:value");
    return 1;
  }
  try {
    removeManualTag(deps.db, player.id, tag.namespace, tag.value);
    deps.write(`tag removed playerId=${player.id} namespace=${tag.namespace} value=${tag.value}`);
    return 0;
  } catch (err) {
    if (err instanceof ManualWriteToDerivedNamespaceError) {
      deps.write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function runTagList(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const player = await resolveTagPlayer(flags, deps);
  if (player === null) return 1;
  const tags = listTags(deps.db, player.id);
  for (const t of tags) {
    deps.write(`tag playerId=${player.id} namespace=${t.namespace} value=${t.value} source=${t.source}`);
  }
  deps.write(`total=${tags.length}`);
  return 0;
}

function runTagRebuild(deps: SeedDeps): number {
  const count = syncAllDerivedTags(deps.db, deps.now());
  deps.write(`rebuilt derived tags players=${count}`);
  return 0;
}

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    const client = new MlbClientImpl({ delayMs: config.mlbApiDelayMs });
    const ncaaClient = new NcaaClientImpl({ delayMs: config.ncaaScrapeDelayMs });
    return await runSeed(process.argv.slice(2), {
      db,
      client,
      ncaaClient,
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
