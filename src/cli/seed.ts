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
import type { HighlightlyClient } from "../highlightly/client.js";
import { HighlightlyClient as HighlightlyClientImpl, HighlightlyError } from "../highlightly/client.js";
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
  UnknownPersonError,
  addHighlightlyNcaaPlayer,
  addPlayer,
  deactivatePlayer,
  listPlayers,
} from "../watchlist/service.js";
import { exitAfterDrain, isMain } from "./main.js";

/**
 * Watch-list seeding CLI: a thin presenter over the watch-list service
 * (src/watchlist/service.ts). Output is deterministic, greppable key=value
 * lines; as a human-facing app CLI on the HC's UTF-8 host it echoes the
 * canonical (NFC) player identity verbatim in UTF-8 — not ASCII-folded
 * (Option 1 / ADR 0047, scoping rules/scripting.md). Exit code is non-zero on
 * failure.
 *
 * Subcommands:
 *   add --person-id N          add by MLB Stats API personId
 *   add --highlightly-player-id N --canonical-name NAME --team-id N
 *   add --search "name" [--pick i]   search by name; --pick chooses (1-based)
 *   deactivate --person-id N   remove from the Watch List (history kept)
 *   deactivate --highlightly-player-id N    remove an NCAA player from the Watch List
 *   list [--tags EXPR]         print every player row, optionally tag-filtered
 *   tag add --person-id N|--highlightly-player-id N --tag ns:value      add a manual tag
 *   tag remove --person-id N|--highlightly-player-id N --tag ns:value   remove a manual tag
 *   tag list --person-id N|--highlightly-player-id N                    list a player's tags
 *   tag rebuild                re-derive every player's derived tags (backfill)
 */

export interface SeedDeps {
  db: Db;
  client: MlbClient;
  highlightlyClient?: HighlightlyClient;
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
        "error: usage: seed <add|deactivate|list|tag> [--person-id N] [--highlightly-player-id N] [--search NAME] [--pick I] [--tags EXPR] [--tag ns:value]",
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
  const highlightlyId = flags.get("highlightly-player-id");
  if (highlightlyId !== undefined) {
    const name = flags.get("canonical-name");
    const team = flags.get("team-id");
    const playerId = Number(highlightlyId);
    const teamId = Number(team);
    if (!Number.isInteger(playerId) || playerId <= 0 || !Number.isInteger(teamId) || teamId <= 0 || !name?.trim()) {
      deps.write("error: Highlightly add requires --highlightly-player-id N --canonical-name NAME --team-id N");
      return 1;
    }
    try {
      const result = await addHighlightlyNcaaPlayer(
        { ...deps }, { playerId, canonicalName: name, teamId },
      );
      deps.write(`${result.action} player id=${result.player.id} highlightlyPlayerId=${playerId} name=${result.player.fullName}`);
      return 0;
    } catch (err) {
      if (err instanceof HighlightlyError) {
        deps.write(`error: ${err.code}: ${err.message}`);
        return err.code === "highlightly_not_configured" ? 78 : err.code === "highlightly_quota_exhausted" || err.code === "highlightly_coverage_incomplete" ? 75 : err.code === "highlightly_player_not_found" || err.code === "highlightly_identity_mismatch" ? 65 : 69;
      }
      throw err;
    }
  }
  const ncaaSeqFlag = flags.get("ncaa-seq");
  if (ncaaSeqFlag !== undefined) {
    deps.write("error: --ncaa-seq is retired; use --highlightly-player-id with --canonical-name and --team-id");
    return 1;
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
    deps.write("error: add requires --person-id N, --highlightly-player-id N with --canonical-name/--team-id, or --search NAME");
    return 1;
  }

  let result;
  try {
    result = await addPlayer(
      { db: deps.db, client: deps.client, highlightlyClient: deps.highlightlyClient, now: deps.now, tz: deps.tz },
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
  const highlightlyIdFlag = flags.get("highlightly-player-id");
  const personIdFlag = flags.get("person-id");

  let ref: number | { kind: "highlightly"; playerId: number };
  let label: string;
  if (highlightlyIdFlag !== undefined) {
    const playerId = Number.parseInt(highlightlyIdFlag, 10);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      deps.write("error: deactivate requires --highlightly-player-id N");
      return 1;
    }
    ref = { kind: "highlightly", playerId };
    label = `highlightlyPlayerId=${playerId}`;
  } else {
    const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
    if (!Number.isInteger(personId) || personId <= 0) {
      deps.write("error: deactivate requires --person-id N or --highlightly-player-id N");
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
    // NCAA rows carry an explicit Highlightly identity instead of a personId.
    const suffix =
      p.level === "ncaa" ? ` school=${p.schoolName ?? "-"} highlightlyPlayerId=${p.highlightlyPlayerId ?? "-"}` : "";
    deps.write(`${base}${suffix}`);
  }
  deps.write(`total=${rows.length}`);
  return 0;
}

/** Resolve --person-id / --highlightly-player-id to a Player row; print an error and return null on miss. */
async function resolveTagPlayer(flags: Map<string, string>, deps: SeedDeps): Promise<PlayerRow | null> {
  const highlightlyIdFlag = flags.get("highlightly-player-id");
  if (highlightlyIdFlag !== undefined) {
    const playerId = Number.parseInt(highlightlyIdFlag, 10);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      deps.write(`error: invalid --highlightly-player-id ${highlightlyIdFlag}`);
      return null;
    }
    const row = (await deps.db.select().from(players).where(eq(players.highlightlyPlayerId, playerId)))[0];
    if (row === undefined) {
      deps.write(`error: ${new PlayerNotFoundError({ kind: "highlightly", playerId }).message}`);
      return null;
    }
    return row;
  }
  const personIdFlag = flags.get("person-id");
  const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
  if (!Number.isInteger(personId) || personId <= 0) {
    deps.write("error: tag requires --person-id N or --highlightly-player-id N");
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
        "error: usage: seed tag <add|remove|list|rebuild> [--person-id N|--highlightly-player-id N] [--tag ns:value]",
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    const client = new MlbClientImpl({ delayMs: config.mlbApiDelayMs });
    const highlightlyClient = new HighlightlyClientImpl({ apiKey: config.highlightlyApiKey });
    return await runSeed(argv, {
      db,
      client,
      highlightlyClient,
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
    .then(exitAfterDrain)
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
