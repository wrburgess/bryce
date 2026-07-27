import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { startupDb } from "../db/startup.js";
import { loadDotEnv } from "../env.js";
import { parsePlayerCardWindows } from "../api/schemas.js";
import type { PlayerCardFormat } from "../presentation/format.js";
import { PLAYER_CARD_FORMATS } from "../presentation/format.js";
import type { PlayerCardWindowSpec } from "../reports/player-card.js";
import { AmbiguousPlayerCardNameError, PlayerCardNotFoundError, assemblePlayerCard } from "../reports/player-card.js";
import { renderPlayerCardHtml, renderPlayerCardText } from "../reports/player-card-render.js";
import { exitAfterDrain, isMain } from "./main.js";
import { preflightDirect } from "./router.js";

function option(argv: readonly string[], name: string): string | undefined | null {
  const inline = argv.find((token) => token.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1] ?? null;
}

export interface ReportPlayerArgs {
  id?: number;
  name?: string;
  windows: PlayerCardWindowSpec[];
  format: PlayerCardFormat;
  out?: string;
  open: boolean;
}

/**
 * The `report player` flag contract (#141 / ADR 0055).
 *
 * | Invocation                     | Behavior                                            |
 * |--------------------------------|-----------------------------------------------------|
 * | no `--format`                  | `console` — a human at a terminal gets an artifact   |
 * | `--format console\|json\|html` | as named                                             |
 * | `--out PATH`                   | valid with EVERY format; writes there, stdout silent |
 * | `--open` alone                 | implies `--format html`, renders to a temp path      |
 * | `--open --format console\|json`| USAGE ERROR — see below                              |
 * | `--open --out PATH`            | writes PATH (not a temp path), then launches PATH    |
 *
 * `--open` with a non-HTML format is refused rather than silently upgraded: a
 * console or JSON rendering is not a browser document, and quietly changing the
 * format the operator asked for is `rules/scripting.md`'s "silently defaults on
 * a malformed invocation" anti-pattern.
 *
 * Validated in BOTH layers — declaratively in `router.ts`'s COMMANDS (so
 * `preflightDirect` rejects a bad value before this leaf, and `startupDb`, ever
 * load) and again here, since this parser is also reachable directly.
 */
export function parseReportPlayerArgs(argv: readonly string[]): ReportPlayerArgs | string {
  const idValue = option(argv, "id");
  const name = option(argv, "name");
  const windowsValue = option(argv, "windows");
  const formatValue = option(argv, "format");
  const outValue = option(argv, "out");
  // NOT via `option()`: `--open` is a boolean flag, and `option()` would consume
  // the following token as its value.
  const open = argv.includes("--open");
  if ((idValue === undefined) === (name === undefined)) return "provide exactly one of --id or --name";
  if (idValue === null || name === null || windowsValue === null || formatValue === null || outValue === null) return "a report option is missing its value";
  if (idValue !== undefined && (!/^\d+$/.test(idValue) || String(Number(idValue)) !== idValue || Number(idValue) < 1 || !Number.isSafeInteger(Number(idValue)))) return "--id must be a canonical positive integer";
  if (name !== undefined && name.trim().length === 0) return "--name must be non-blank";
  if (formatValue !== undefined && !(PLAYER_CARD_FORMATS as readonly string[]).includes(formatValue)) {
    return `--format must be one of ${PLAYER_CARD_FORMATS.join(", ")}`;
  }
  if (outValue !== undefined && outValue.trim().length === 0) return "--out must be a non-blank path";
  const format = (formatValue as PlayerCardFormat | undefined) ?? (open ? "html" : "console");
  if (open && format !== "html") return "--open requires --format html; a console or JSON rendering is not a browser document";
  try {
    return {
      ...(idValue !== undefined ? { id: Number(idValue) } : { name }),
      windows: parsePlayerCardWindows(windowsValue),
      format,
      ...(outValue !== undefined ? { out: outValue } : {}),
      open,
    };
  } catch {
    return "--windows must be a comma-separated unique subset of last10, last30, ytd";
  }
}

/**
 * Everything `runReportCli` reaches the outside world through, injected so the
 * whole command — not merely its argument parser — is exercised offline: no test
 * touches the disk and none spawns a process (the `runLists` /
 * `runPlayersBackup` precedent).
 */
export interface ReportCliDeps {
  db: Db;
  now: () => Date;
  tz: string;
  write: (line: string, error?: boolean) => void;
  /** Defaults to a synchronous UTF-8 file write. */
  writeFile?: (path: string, contents: string) => void;
  /**
   * Defaults to the platform's browser opener. May be async: the production
   * launcher only learns a missing opener asynchronously, so the caller awaits.
   */
  launch?: (path: string) => void | Promise<void>;
  /** Defaults to the OS temp dir; used only by a bare `--open`. */
  tempPath?: (filename: string) => string;
  /** Terminal width for the console rendering; `process.stdout.columns` in production. */
  terminalWidth?: number;
}

const defaultTempPath = (filename: string): string => join(tmpdir(), filename);

/**
 * The opener invocation for a platform, as a PURE function so every platform's
 * argv is unit-testable on the one platform CI actually runs.
 *
 * Windows is `cmd /c start "" <path>`, not `start <path>` under a shell: `start`
 * is a `cmd` builtin whose FIRST quoted argument is the window title, so a
 * quoted path is swallowed as a title and an unquoted one splits on spaces. The
 * empty `""` supplies that title, leaving the path as the file to open.
 */
export function launchCommand(platform: string, path: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [path] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", path] };
  return { command: "xdg-open", args: [path] };
}

/**
 * Best-effort platform browser opener. Detached and unref'd so it never holds
 * the CLI open — but it RESOLVES ONLY ONCE THE CHILD HAS ACTUALLY SPAWNED.
 *
 * `spawn` reports a missing opener asynchronously via an `error` event, long
 * after it returns. Without this promise the caller's try/catch could never
 * fire, so `--open` exited 0 on any machine lacking `open`/`xdg-open` while
 * promising a non-zero exit — and an unlistened `error` event would additionally
 * throw as an unhandled exception. Waiting for `spawn` (not for exit) keeps the
 * detached behavior while making a failure to launch observable.
 */
function defaultLaunch(path: string): Promise<void> {
  const { command, args } = launchCommand(process.platform, path);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function runReportCli(argv: string[], deps: ReportCliDeps): Promise<number> {
  const syntax = preflightDirect(["report", "player"], argv);
  if (syntax !== null) { deps.write(`error: ${syntax}`, true); return 1; }
  const parsed = parseReportPlayerArgs(argv);
  if (typeof parsed === "string") { deps.write(`error: ${parsed}`, true); return 1; }

  const { format, out, open, ...selection } = parsed;
  let card;
  try {
    card = assemblePlayerCard(deps.db, { ...selection, now: deps.now, tz: deps.tz });
  } catch (err) {
    if (err instanceof PlayerCardNotFoundError || err instanceof AmbiguousPlayerCardNameError) { deps.write(`error: ${err.message}`, true); return 1; }
    throw err;
  }

  const rendered =
    format === "json"
      ? JSON.stringify(card)
      : format === "html"
        ? renderPlayerCardHtml(card)
        : renderPlayerCardText(card, { width: deps.terminalWidth });

  // ONE payload for both destinations, ending in exactly one newline. The two
  // Presentations already do; `json` does not — and normalizing only the ones
  // that do is what left `--format json` a byte apart, since the production
  // writer appends a newline stdout gets and the file does not. Normalizing
  // here, before the paths diverge, makes "stdout and --out are the same bytes"
  // true by construction rather than per-format.
  // `\n+$`, not `\n$`: stripping only the LAST of several trailing newlines
  // would leave the payload ending in a blank line and quietly reintroduce the
  // very divergence this normalization exists to remove. Today no renderer
  // emits more than one (pinned in test/player-card-render.ts), so this is
  // defense in depth against a future edit, not a live fix.
  const payload = `${rendered.replace(/\n+$/, "")}\n`;
  if (out === undefined && !open) {
    // The writer re-adds the newline stripped here.
    deps.write(payload.slice(0, -1));
    return 0;
  }
  // A bare `--open` still needs a real file for the browser to load.
  const destination = out ?? (deps.tempPath ?? defaultTempPath)(`bryce-player-card-${card.player.id}.html`);

  // The write must SUCCEED before the launcher runs: launching a browser at a
  // path nothing was written to would report success for an empty result.
  try {
    (deps.writeFile ?? ((path, contents) => { writeFileSync(path, contents, "utf8"); }))(destination, payload);
  } catch (err) {
    deps.write(`error: could not write ${destination}: ${err instanceof Error ? err.message : String(err)}`, true);
    return 1;
  }
  if (!open) return 0;
  try {
    await (deps.launch ?? defaultLaunch)(destination);
  } catch (err) {
    // The file IS written and usable, so name it rather than only reporting the
    // launch failure — but the exit code still says the command did not do what
    // it was asked to.
    deps.write(`error: could not open ${destination}: ${err instanceof Error ? err.message : String(err)}`, true);
    return 1;
  }
  return 0;
}

/** `parseReportPlayerArgs` returns the parsed selection or an error string. */
const asError = (parsed: ReturnType<typeof parseReportPlayerArgs>): string | null =>
  typeof parsed === "string" ? parsed : null;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Preflight AND parse BEFORE dotenv/config/startupDb, so a malformed
  // invocation exits 1 without snapshotting or migrating on its way out (the
  // players-backup shape).
  //
  // BOTH are required, not just preflight: `--windows` is declared with no
  // `values` list and no validator, so `--windows bogus` clears the router and
  // is caught only by `parseReportPlayerArgs`. Validating it here and not merely
  // inside `runReportCli` is what keeps a usage error from acquiring the
  // open-lock, migrating the database, and surfacing as a config error instead.
  // `runReportCli` re-parses because it is also called directly, with its own
  // injected deps — this is a cheap pure re-parse, not a second source of truth.
  const failure = preflightDirect(["report", "player"], argv) ?? asError(parseReportPlayerArgs(argv));
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  loadDotEnv();
  const config = loadConfig();
  const { db, close } = await startupDb(config.databasePath, { backupDir: config.backupDir, keepLast: config.backupKeepLast });
  try {
    return await runReportCli(argv, {
      db,
      now: () => new Date(),
      tz: config.tz,
      write: (line, error = false) => (error ? process.stderr : process.stdout).write(`${line}\n`),
      terminalWidth: process.stdout.columns,
    });
  } finally { close(); }
}

if (isMain(import.meta.url)) {
  main().then(exitAfterDrain).catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitAfterDrain(1);
  });
}
