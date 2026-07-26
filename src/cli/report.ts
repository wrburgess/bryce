import { loadConfig } from "../config.js";
import { startupDb } from "../db/startup.js";
import { loadDotEnv } from "../env.js";
import { parsePlayerCardWindows } from "../api/schemas.js";
import type { PlayerCardWindowSpec } from "../reports/player-card.js";
import { AmbiguousPlayerCardNameError, PlayerCardNotFoundError, assemblePlayerCard } from "../reports/player-card.js";
import { exitAfterDrain, isMain } from "./main.js";
import { preflightDirect } from "./router.js";

function option(argv: readonly string[], name: string): string | undefined | null {
  const inline = argv.find((token) => token.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1] ?? null;
}

export function parseReportPlayerArgs(argv: readonly string[]): { id?: number; name?: string; windows: PlayerCardWindowSpec[] } | string {
  const idValue = option(argv, "id");
  const name = option(argv, "name");
  const windowsValue = option(argv, "windows");
  if ((idValue === undefined) === (name === undefined)) return "provide exactly one of --id or --name";
  if (idValue === null || name === null || windowsValue === null) return "a report option is missing its value";
  if (idValue !== undefined && (!/^\d+$/.test(idValue) || String(Number(idValue)) !== idValue || Number(idValue) < 1 || !Number.isSafeInteger(Number(idValue)))) return "--id must be a canonical positive integer";
  if (name !== undefined && name.trim().length === 0) return "--name must be non-blank";
  try {
    return { ...(idValue !== undefined ? { id: Number(idValue) } : { name }), windows: parsePlayerCardWindows(windowsValue) };
  } catch {
    return "--windows must be a comma-separated unique subset of last10, last30, ytd";
  }
}

export async function runReportCli(argv: string[], write: (line: string, error?: boolean) => void = (line, error = false) => (error ? process.stderr : process.stdout).write(`${line}\n`)): Promise<number> {
  const syntax = preflightDirect(["report", "player"], argv);
  if (syntax !== null) { write(`error: ${syntax}`, true); return 1; }
  const parsed = parseReportPlayerArgs(argv);
  if (typeof parsed === "string") { write(`error: ${parsed}`, true); return 1; }
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, { backupDir: config.backupDir, keepLast: config.backupKeepLast });
  try {
    const card = assemblePlayerCard(db, { ...parsed, now: () => new Date(), tz: config.tz });
    write(JSON.stringify(card));
    return 0;
  } catch (err) {
    if (err instanceof PlayerCardNotFoundError || err instanceof AmbiguousPlayerCardNameError) { write(`error: ${err.message}`, true); return 1; }
    throw err;
  } finally { close(); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> { return runReportCli(argv); }

if (isMain(import.meta.url)) {
  main().then(exitAfterDrain).catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitAfterDrain(1);
  });
}
