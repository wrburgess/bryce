import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import {
  NcaaAccessDeniedError,
  NcaaApiError,
  NcaaClient,
  UnsupportedNcaaSeasonError,
} from "../ncaa/client.js";
import { parseGameLogPage } from "../ncaa/parse.js";
import type { NcaaStatCategory } from "../ncaa/seasons.js";
import { isMain } from "./main.js";

/**
 * Live probe for the stats.ncaa.org scrape adapter (ADR 0032) — the on-host
 * validation step. Fetches ONE game-log page for a seq/season/type and reports
 * the HTTP status plus what the parser extracted. Deterministic, ASCII-only
 * key=value output; non-zero exit on any failure (rules/scripting.md).
 *
 *   npm run ncaa:probe -- --seq 2649785 --season 2025 --type batting
 */

export interface ProbeDeps {
  client: NcaaClient;
  write: (line: string) => void;
}

export async function runProbe(argv: string[], deps: ProbeDeps): Promise<number> {
  const flags = parseFlags(argv);
  const seqFlag = flags.get("seq");
  const seq = seqFlag !== undefined ? Number.parseInt(seqFlag, 10) : Number.NaN;
  if (!Number.isInteger(seq) || seq <= 0) {
    deps.write("error: probe requires --seq N (stats_player_seq)");
    return 1;
  }
  const season = flags.get("season") ?? String(new Date().getFullYear());
  const type = (flags.get("type") ?? "batting") as NcaaStatCategory;
  if (type !== "batting" && type !== "pitching" && type !== "fielding") {
    deps.write(`error: invalid --type ${type} (use batting, pitching, or fielding)`);
    return 1;
  }

  let html: string;
  try {
    html = await deps.client.getGameLogPage(seq, season, type);
  } catch (err) {
    if (err instanceof NcaaAccessDeniedError) {
      deps.write(`probe seq=${seq} season=${season} type=${type} result=access_denied`);
      return 1;
    }
    if (err instanceof NcaaApiError) {
      deps.write(`probe seq=${seq} season=${season} type=${type} http=${err.status} result=error`);
      return 1;
    }
    if (err instanceof UnsupportedNcaaSeasonError) {
      deps.write(`error: no bundled NCAA season lookup for season=${season}`);
      return 1;
    }
    deps.write(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  deps.write(`probe seq=${seq} season=${season} type=${type} http=200 bytes=${html.length}`);
  try {
    const page = parseGameLogPage(html);
    deps.write(
      `parse ok name=${ascii(page.fullName)} school=${ascii(page.schoolName)} rows=${page.rows.length}`,
    );
    return 0;
  } catch (err) {
    deps.write(`parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Collapse to printable ASCII so the probe's stdout is locale-safe. */
function ascii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
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

export async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const client = new NcaaClient({ delayMs: config.ncaaScrapeDelayMs });
  return runProbe(process.argv.slice(2), {
    client,
    write: (line) => process.stdout.write(`${line}\n`),
  });
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
