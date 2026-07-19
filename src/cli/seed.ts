import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { openDb } from "../db/client.js";
import { players } from "../db/schema.js";
import { runRefreshForPlayer } from "../jobs/refresh.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbClient as MlbClientImpl } from "../mlb/client.js";
import { levelForSportId } from "../mlb/levels.js";
import type { Person } from "../mlb/schemas.js";
import { isMain } from "./main.js";

/**
 * Watch-list seeding CLI. Output is deterministic, greppable, ASCII-only
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

  const person = await deps.client.getPerson(personId);
  const existing = (
    await deps.db.select().from(players).where(eq(players.externalId, personId))
  )[0];
  const nowIso = deps.now().toISOString();

  let playerId: number;
  if (existing !== undefined) {
    // Duplicate add: no-op update — same Player, refreshed identity fields.
    await deps.db
      .update(players)
      .set({ fullName: person.fullName, active: true, updatedAt: nowIso })
      .where(eq(players.id, existing.id));
    playerId = existing.id;
    deps.write(`updated player id=${playerId} personId=${personId} name=${person.fullName}`);
    return 0;
  }

  const location = await resolveLocation(person, deps);
  const insertedRows = await deps.db
    .insert(players)
    .values({
      externalId: personId,
      fullName: person.fullName,
      level: location.level,
      milbLevel: location.milbLevel,
      teamName: location.teamName,
      position: person.primaryPosition?.abbreviation ?? null,
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning({ id: players.id });
  const insertedId = insertedRows[0]?.id;
  if (insertedId === undefined) {
    deps.write("error: insert failed");
    return 1;
  }
  playerId = insertedId;
  deps.write(`added player id=${playerId} personId=${personId} name=${person.fullName}`);

  // Adding a Player IS his first Refresh (ADR 0030) — unless the pipeline sleeps.
  const refresh = await runRefreshForPlayer(
    { db: deps.db, client: deps.client, now: deps.now, tz: deps.tz },
    playerId,
  );
  if (refresh.skipped) {
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

async function resolveLocation(
  person: Person,
  deps: SeedDeps,
): Promise<{ level: "mlb" | "milb"; milbLevel: string | null; teamName: string | null }> {
  if (person.currentTeam !== undefined) {
    const team = await deps.client.getTeam(person.currentTeam.id);
    const info = levelForSportId(team.sport.id);
    if (info !== null && info.level !== "ncaa") {
      return { level: info.level, milbLevel: info.milbLevel, teamName: team.name };
    }
  }
  // No resolvable team (e.g. free agent): default to mlb; the next Refresh corrects it.
  return { level: "mlb", milbLevel: null, teamName: null };
}

async function runDeactivate(flags: Map<string, string>, deps: SeedDeps): Promise<number> {
  const personIdFlag = flags.get("person-id");
  const personId = personIdFlag !== undefined ? Number.parseInt(personIdFlag, 10) : Number.NaN;
  if (!Number.isInteger(personId) || personId <= 0) {
    deps.write("error: deactivate requires --person-id N");
    return 1;
  }
  const existing = (
    await deps.db.select().from(players).where(eq(players.externalId, personId))
  )[0];
  if (existing === undefined) {
    deps.write(`error: no player with personId=${personId}`);
    return 1;
  }
  await deps.db
    .update(players)
    .set({ active: false, updatedAt: deps.now().toISOString() })
    .where(eq(players.id, existing.id));
  deps.write(`deactivated player id=${existing.id} personId=${personId} name=${existing.fullName}`);
  return 0;
}

async function runList(deps: SeedDeps): Promise<number> {
  const rows = await deps.db.select().from(players).orderBy(players.id);
  for (const p of rows) {
    deps.write(
      `player id=${p.id} personId=${p.externalId ?? "-"} name=${p.fullName} level=${p.level} milbLevel=${p.milbLevel ?? "-"} team=${p.teamName ?? "-"} active=${p.active}`,
    );
  }
  deps.write(`total=${rows.length}`);
  return 0;
}

export async function main(): Promise<number> {
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
