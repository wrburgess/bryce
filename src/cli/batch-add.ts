import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import type { MlbClient } from "../mlb/client.js";
import { MlbClient as MlbClientImpl } from "../mlb/client.js";
import type { NcaaClient } from "../ncaa/client.js";
import { NcaaClient as NcaaClientImpl } from "../ncaa/client.js";
import type { BatchAddEntryResult } from "../watchlist/service.js";
import { batchAddPlayers } from "../watchlist/service.js";
import { isMain } from "./main.js";

/**
 * `players:batch-add` — stage up to 25 players onto the Watch List in one call
 * (issue #68 / ADR 0045). A thin presenter over the watch-list service: identity
 * is resolved and staged now, and the season backfills at the next Refresh (this
 * CLI runs NONE). Output is deterministic, greppable, ASCII-only key=value lines
 * (rules/scripting.md); the exit code is SET (never process.exit after an async
 * write, #64/#76).
 *
 * Three quick flags plus a paste-friendly file, all merged into one entries[]:
 *   --person-ids 1,2,3     comma-separated MLB personIds (repeatable)
 *   --ncaa-seqs 10,20      comma-separated NCAA stats_player_seq (repeatable)
 *   --names NAME           one MLB/MiLB name to people-search (repeatable)
 *   --file PATH            tagged lines (see below), combinable with the flags
 *
 * File grammar (each line trimmed; blank lines and `#` comments ignored):
 *   ncaa:<n>   -> an NCAA stats_player_seq (a non-numeric `ncaa:` is a usage error)
 *   name:<x>   -> an explicit name (the escape hatch for a name that is all digits)
 *   <digits>   -> an MLB personId
 *   <other>    -> a name
 *
 * A completed batch (valid shape) exits 0 even when some entries are unresolved
 * or failed — those are per-entry outcomes, not a run failure. A usage error —
 * an unknown flag, a non-integer id token, an unreadable/oversize file, or a
 * shape rejection (empty, over-cap, in-batch duplicate) — exits 1.
 */

const USAGE =
  "usage: players:batch-add [--person-ids 1,2,3] [--ncaa-seqs 10,20] [--names NAME]... [--file PATH]";

/** A batch file may not exceed this size — a cheap guard, mirroring MAX_BACKUP_BYTES. */
export const MAX_BATCH_FILE_BYTES = 64 * 1024;

/** One typed entry as the CLI assembles it, before the service parses/validates. */
type BatchEntryInput = { personId: number } | { ncaaPlayerSeq: number } | { name: string };

export interface BatchAddRunDeps {
  db: Db;
  client: MlbClient;
  ncaaClient: NcaaClient;
  now: () => Date;
  tz: string;
  write: (line: string) => void;
  /** Injected for tests; defaults to reading the file at the given path. */
  readFile?: (path: string) => string;
}

interface ParsedFlags {
  personIds: number[];
  ncaaSeqs: number[];
  names: string[];
  file: string | null;
  error: string | null;
}

/** Parse a comma-separated list of positive-integer tokens; a non-digit token fails loud. */
function parseIntList(value: string): { ints: number[]; bad: string | null } {
  const ints: number[] = [];
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue; // tolerate a trailing/extra comma
    if (!/^\d+$/.test(trimmed)) return { ints, bad: trimmed };
    ints.push(Number.parseInt(trimmed, 10));
  }
  return { ints, bad: null };
}

/**
 * Parse the CLI flags. Every flag takes the following token as its value;
 * `--person-ids`/`--ncaa-seqs`/`--names` accumulate across repeats. An unknown
 * flag, a missing value, or a non-integer id token is a usage error.
 */
function parseBatchFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { personIds: [], ncaaSeqs: [], names: [], file: null, error: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      return { ...out, error: `unexpected argument ${arg}` };
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ...out, error: `flag --${key} requires a value` };
    }
    i += 1;
    switch (key) {
      case "person-ids": {
        const { ints, bad } = parseIntList(value);
        if (bad !== null) return { ...out, error: `invalid --person-ids token ${bad}` };
        out.personIds.push(...ints);
        break;
      }
      case "ncaa-seqs": {
        const { ints, bad } = parseIntList(value);
        if (bad !== null) return { ...out, error: `invalid --ncaa-seqs token ${bad}` };
        out.ncaaSeqs.push(...ints);
        break;
      }
      case "names":
        out.names.push(value);
        break;
      case "file":
        out.file = value;
        break;
      default:
        return { ...out, error: `unknown flag --${key}` };
    }
  }
  return out;
}

/** Parse the tagged-line file grammar into typed entries; a bad `ncaa:` token fails loud. */
function parseBatchFile(raw: string): { entries: BatchEntryInput[]; error: string | null } {
  const entries: BatchEntryInput[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("ncaa:")) {
      const seq = line.slice("ncaa:".length).trim();
      if (!/^\d+$/.test(seq)) return { entries, error: `invalid ncaa seq in file line: ${line}` };
      entries.push({ ncaaPlayerSeq: Number.parseInt(seq, 10) });
    } else if (line.startsWith("name:")) {
      entries.push({ name: line.slice("name:".length).trim() });
    } else if (/^\d+$/.test(line)) {
      entries.push({ personId: Number.parseInt(line, 10) });
    } else {
      entries.push({ name: line });
    }
  }
  return { entries, error: null };
}

/** Describe the identity an entry addressed, for a per-entry outcome line. */
function describeEntry(result: BatchAddEntryResult): string {
  const entry = result.entry;
  if (entry.personId !== undefined) return `personId=${entry.personId}`;
  if (entry.ncaaPlayerSeq !== undefined) return `ncaaSeq=${entry.ncaaPlayerSeq}`;
  return `name=${entry.name ?? ""}`;
}

/** One greppable key=value outcome line per entry. */
function formatOutcome(result: BatchAddEntryResult): string {
  const ref = describeEntry(result);
  if (result.status === "added" || result.status === "updated") {
    return `outcome status=${result.status} ${ref} id=${result.player.id} name=${result.player.fullName}`;
  }
  if (result.status === "unresolved") {
    const candidates = result.candidates !== undefined ? ` candidates=${result.candidates.length}` : "";
    return `outcome status=unresolved reason=${result.reason} ${ref}${candidates}`;
  }
  const message = result.message !== undefined ? ` message=${result.message.replace(/\s+/g, " ")}` : "";
  return `outcome status=failed reason=${result.reason} ${ref}${message}`;
}

export async function runBatchAdd(argv: string[], deps: BatchAddRunDeps): Promise<number> {
  const flags = parseBatchFlags(argv);
  if (flags.error !== null) {
    deps.write(`error: ${flags.error}; ${USAGE}`);
    return 1;
  }

  const entries: BatchEntryInput[] = [];
  for (const personId of flags.personIds) entries.push({ personId });
  for (const ncaaPlayerSeq of flags.ncaaSeqs) entries.push({ ncaaPlayerSeq });
  for (const name of flags.names) entries.push({ name });

  if (flags.file !== null) {
    const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    let raw: string;
    try {
      raw = readFile(flags.file);
    } catch (err) {
      deps.write(`error: cannot read ${flags.file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (raw.length > MAX_BATCH_FILE_BYTES) {
      deps.write(`error: batch file exceeds the ${MAX_BATCH_FILE_BYTES}-byte size ceiling`);
      return 1;
    }
    const parsed = parseBatchFile(raw);
    if (parsed.error !== null) {
      deps.write(`error: ${parsed.error}`);
      return 1;
    }
    entries.push(...parsed.entries);
  }

  let result;
  try {
    result = await batchAddPlayers(
      { db: deps.db, client: deps.client, ncaaClient: deps.ncaaClient, now: deps.now, tz: deps.tz },
      { entries },
    );
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((issue) => {
          const path = issue.path.join(".");
          return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; ");
      deps.write(`error: invalid batch: ${detail}`);
      return 1;
    }
    throw err;
  }

  for (const outcome of result.entries) {
    deps.write(formatOutcome(outcome));
  }
  const s = result.summary;
  deps.write(
    `summary added=${s.added} updated=${s.updated} unresolved=${s.unresolved} failed=${s.failed} total=${s.total}`,
  );
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
    return await runBatchAdd(process.argv.slice(2), {
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
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
