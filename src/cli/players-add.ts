import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import type { PlayerListRow, PlayerRow } from "../db/schema.js";
import { startupDb } from "../db/startup.js";
import type { HighlightlyClient } from "../highlightly/client.js";
import { HighlightlyClient as HighlightlyClientImpl } from "../highlightly/client.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbClient as MlbClientImpl } from "../mlb/client.js";
import {
  NoDefaultListError,
  UnknownListError,
  addPlayerIdsToLiveList,
  resolveListOrDefault,
} from "../lists/service.js";
import {
  UnknownPersonError,
  addHighlightlyNcaaPlayer,
  addPlayer,
} from "../watchlist/service.js";
import { parseFlags } from "./flags.js";
import { exitAfterDrain, isMain } from "./main.js";
import { pickFromSearch, pickNcaaFromSearch, writeHighlightlyError } from "./pick.js";
import { normalizeDirect, preflightDirect } from "./router.js";

/**
 * `sk players add` (#191, phase 2 of the #189 epic): resolve one player by name
 * and land him on a LANE in a single command — the two-step
 * `seed add` + `players lists add` dance, collapsed.
 *
 * This is a command SURFACE over existing services. It reads the phase-1 schema
 * and changes no refresh or digest behavior; the identity rules it applies are
 * the ones `seed add` already shipped, imported from `src/cli/pick.ts` rather
 * than restated (rules/scripting.md).
 *
 * Output is deterministic, greppable `key=value`; as a human-facing app CLI it
 * echoes the canonical (NFC) player identity and the operator's list name
 * VERBATIM in UTF-8, never ASCII-folded (ADR 0047). Failures use the `error: `
 * prefix `seed add` uses, not `lists`'s `error=`, because this is an `add` and
 * an operator greps the two together.
 *
 * ORDER IS THE CONTRACT (rules/scripting.md — validate before the first side
 * effect):
 *
 *   1. resolve the lane — BEFORE any network call and before any write, the
 *      `batchAddPlayers` precedent. A typo'd `--list` must not cost an upstream
 *      call, and must never leave a player created but homeless.
 *   2. resolve the identity (MLB people-search, or Highlightly under `--ncaa`).
 *   3. create/upsert the player.
 *   4. attach him to the lane, re-checking under the write lock that the lane
 *      is still live.
 *
 * Steps 3 and 4 are TWO WRITES and cannot be one transaction: `addPlayer` does
 * network I/O and runs the new player's first refresh, and holding a SQLite
 * write lock across the network is forbidden. So this command does not claim
 * atomicity it does not have — if the attach fails, it reports the residual
 * state (the player EXISTS, unattached), names the exact repair command, and
 * exits non-zero.
 */

export interface PlayersAddDeps {
  db: Db;
  client: MlbClient;
  highlightlyClient?: HighlightlyClient;
  now: () => Date;
  tz: string;
  write: (line: string) => void;
  writeError?: (line: string) => void;
}

/** What identity resolution produced, plus how the summary line names it. */
type Resolved =
  | { kind: "mlb"; personId: number }
  | { kind: "ncaa"; playerId: number; canonicalName: string; teamId: number };

export async function runPlayersAdd(rawArgv: string[], deps: PlayersAddDeps): Promise<number> {
  const writeError = deps.writeError ?? deps.write;
  const syntaxFailure = preflightDirect(["players", "add"], rawArgv);
  if (syntaxFailure !== null) {
    writeError(`error: ${syntaxFailure}`);
    return 1;
  }
  const flags = parseFlags(normalizeDirect(["players", "add"], rawArgv));
  const name = (flags.get("name") ?? "").trim();
  if (name.length === 0) {
    writeError("error: --name is required and must be non-blank");
    return 1;
  }
  const listFlag = flags.get("list");
  if (listFlag !== undefined && listFlag.trim().length === 0) {
    writeError("error: --list requires a non-blank list name");
    return 1;
  }
  const ncaa = flags.has("ncaa");
  const highlightlyClient = deps.highlightlyClient;
  if (ncaa && highlightlyClient === undefined) {
    // Checked BEFORE the lane lookup, and with the same message and exit 78
    // `seed add` gives, so one runbook entry covers both commands.
    writeError("error: highlightly_not_configured: HIGHLIGHTLY_API_KEY is required for NCAA refresh");
    return 78;
  }
  if (ncaa && flags.has("pick")) {
    // Also refused at preflight; kept here because this presenter is reachable
    // directly, and because honoring it would mint a SECOND ambiguity rule.
    writeError("error: option '--pick' cannot be combined with '--ncaa'");
    return 1;
  }

  // STEP 1 — the lane, before any network call and before any write.
  let list: PlayerListRow;
  try {
    list = await resolveListOrDefault(deps.db, listFlag?.trim());
  } catch (err) {
    if (err instanceof UnknownListError || err instanceof NoDefaultListError) {
      writeError(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // STEP 2 — the identity.
  let resolved: Resolved | null;
  try {
    resolved = ncaa
      ? await resolveNcaa(name, highlightlyClient as HighlightlyClient, deps)
      : await resolveMlb(name, flags.get("pick"), deps);
  } catch (err) {
    return writeHighlightlyError(err, { write: writeError });
  }
  if (resolved === null) return 1;

  // STEP 3 — create or upsert. Nothing before this point has written anything.
  let action: "added" | "updated";
  let player: PlayerRow;
  let refreshLine: string | null;
  try {
    const created = resolved.kind === "mlb"
      ? await addPlayer(
          { db: deps.db, client: deps.client, highlightlyClient: deps.highlightlyClient, now: deps.now, tz: deps.tz },
          resolved.personId,
        )
      : await addHighlightlyNcaaPlayer(
          { db: deps.db, client: deps.client, highlightlyClient: deps.highlightlyClient, now: deps.now, tz: deps.tz },
          { playerId: resolved.playerId, canonicalName: resolved.canonicalName, teamId: resolved.teamId },
        );
    action = created.action;
    player = created.player;
    // Mirrors `seed add`: the first-refresh line is printed ONLY for a
    // brand-new player. A re-add runs no refresh, so a line claiming one would
    // be a lie the operator has no way to check.
    refreshLine = created.action !== "added"
      ? null
      : created.refresh === null || created.refresh.skipped
        ? `refresh skipped reason=${created.refresh?.reason ?? "offseason-sleep"}`
        : `refresh done inserted=${created.refresh.inserted} updated=${created.refresh.updated}`;
  } catch (err) {
    if (err instanceof UnknownPersonError) {
      writeError(`error: ${err.message}`);
      return 1;
    }
    return writeHighlightlyError(err, { write: writeError });
  }

  // STEP 4 — attach. A separate write, so its failure is REPORTED, not hidden.
  let changed: number;
  try {
    changed = await addPlayerIdsToLiveList(deps.db, list, [player.id], deps.now());
  } catch (err) {
    // Two different failures needing two different repairs. If the lane died
    // mid-add, `players lists add --name <that name>` would fail the SAME way,
    // so printing it would send the operator down a path that cannot work —
    // a repair instruction is only worth printing if running it finishes the job.
    if (err instanceof UnknownListError) {
      writeError(
        `error: player id=${player.id} created but not attached - ` +
          `list=${list.name} was deleted mid-add; re-create it or re-run with a live --list`,
      );
      return 1;
    }
    writeError(
      `error: player id=${player.id} created but not attached to list=${list.name} - ` +
        `re-run: sk players lists add --name ${shellQuote(list.name)} ${repairSelector(resolved)}`,
    );
    return 1;
  }

  const identity = resolved.kind === "mlb"
    ? `personId=${resolved.personId}`
    : `highlightlyPlayerId=${resolved.playerId}`;
  deps.write(
    `${action} player id=${player.id} ${identity} name=${player.fullName} ` +
      `list=${list.name} member=${changed > 0 ? "added" : "existing"}`,
  );
  if (refreshLine !== null) deps.write(refreshLine);
  return 0;
}

/** The `players lists add` selector that repairs a failed attach for this identity. */
function repairSelector(resolved: Resolved): string {
  return resolved.kind === "mlb"
    ? `--person-ids ${resolved.personId}`
    : `--highlightly-player-ids ${resolved.playerId}`;
}

/**
 * POSIX-quote a list name for the repair command above (Reviewer P2, #191).
 *
 * List names legitimately carry spaces — this repo's own help text uses
 * `'Top 30'` — and `requireName` rejects only control characters, not quotes,
 * `$`, or backticks. Unquoted, the advertised recovery `--name Top 30` splits
 * into a value and an unexpected argument, so the one command the operator was
 * told to run to finish the job fails. Printing a repair that cannot be pasted
 * is the failure this message exists to prevent, one layer down.
 *
 * Always quoted, never conditionally: a rule with a "safe enough to leave bare"
 * branch is a rule whose boundary has to be right, and this one has no reason to
 * have a boundary.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** MLB/MiLB name search, through the shared `--pick` rule. */
async function resolveMlb(
  name: string,
  pickFlag: string | undefined,
  deps: PlayersAddDeps,
): Promise<Resolved | null> {
  const personId = await pickFromSearch(name, pickFlag, { client: deps.client, write: deps.writeError ?? deps.write });
  return personId === null ? null : { kind: "mlb", personId };
}

/** NCAA name search, through the shared no-pick-escape rule. */
async function resolveNcaa(
  name: string,
  highlightlyClient: HighlightlyClient,
  deps: PlayersAddDeps,
): Promise<Resolved | null> {
  const picked = await pickNcaaFromSearch(name, {
    highlightlyClient,
    write: deps.writeError ?? deps.write,
  });
  return picked === null
    ? null
    : { kind: "ncaa", playerId: picked.playerId, canonicalName: picked.canonicalName, teamId: picked.teamId };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Validated HERE as well as in `runPlayersAdd`, and that duplication is
  // INTENTIONAL (the digest/refresh pattern): main() must reject a bad
  // invocation BEFORE `startupDb` snapshots and migrates on its way to exit 1,
  // while `runPlayersAdd` is the injectable seam every test drives. Only
  // `runPlayersAdd` normalizes, because only it goes on to parse the argv.
  const failure = preflightDirect(["players", "add"], argv);
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, {
    backupDir: config.backupDir,
    keepLast: config.backupKeepLast,
  });
  try {
    return await runPlayersAdd(argv, {
      db,
      client: new MlbClientImpl({ delayMs: config.mlbApiDelayMs }),
      highlightlyClient: new HighlightlyClientImpl({ apiKey: config.highlightlyApiKey }),
      now: () => new Date(),
      tz: config.tz,
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
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterDrain(1);
    });
}
