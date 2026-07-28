import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test infrastructure for the backup/restore suites (rules/testing.md: build the
 * harness the scenario needs). Migration fixtures are constructed programmatically
 * — a temp copy of the production `drizzle/` folder that a test can extend with a
 * pending or deliberately-bad migration and then remediate, exercising the
 * pre-migration Snapshot hook and the restore-then-reopen runbook against a REAL
 * drizzle migrate() cycle.
 */

export const PROD_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** A journal `when` strictly newer than every production migration. */
export const FUTURE_MILLIS = 1_900_000_000_000;

export interface TempDir {
  path: string;
  cleanup: () => void;
}

export function makeTempDir(prefix = "bryce-backup-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export interface TempMigrations {
  dir: string;
  cleanup: () => void;
}

/** A writable copy of the production migrations folder. */
export function copyProdMigrations(): TempMigrations {
  const dir = mkdtempSync(join(tmpdir(), "bryce-mig-"));
  cpSync(PROD_MIGRATIONS, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A writable copy of the production migrations folder TRUNCATED after `lastIdx`
 * — the real history up to a point, so a test can build a genuinely pre-migration
 * database by running the actual migrations rather than hand-seeding a lookalike
 * (rules/testing.md: a synthetic corpus answers a different question).
 *
 * The truncated migration files are deleted as well as unlisted, so a stray read
 * of the folder cannot resurrect them.
 */
export function copyProdMigrationsThrough(lastIdx: number): TempMigrations {
  const { dir, cleanup } = copyProdMigrations();
  const journal = readJournal(dir);
  const dropped = journal.entries.filter((e) => e.idx > lastIdx);
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeJournal(dir, journal);
  for (const entry of dropped) rmSync(join(dir, `${entry.tag}.sql`), { force: true });
  return { dir, cleanup };
}

interface Journal {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
}

function readJournal(dir: string): Journal {
  return JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
}

function writeJournal(dir: string, journal: Journal): void {
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
}

/** Append a new migration (tag.sql + a journal entry) to a migrations folder. */
export function appendMigration(
  dir: string,
  args: { tag: string; when: number; sql: string },
): void {
  writeFileSync(join(dir, `${args.tag}.sql`), args.sql);
  const journal = readJournal(dir);
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when: args.when,
    tag: args.tag,
    breakpoints: true,
  });
  writeJournal(dir, journal);
}

/** Rewrite an existing migration's SQL in place (the remediation step). */
export function setMigrationSql(dir: string, tag: string, sql: string): void {
  writeFileSync(join(dir, `${tag}.sql`), sql);
}

/**
 * Build a self-contained migrations folder from scratch (no production copy) —
 * for the ordered-prefix model tests that need duplicate-content, gapped, or
 * reordered histories.
 */
export function makeMigrationsDir(
  migrations: Array<{ tag: string; when: number; sql: string }>,
): TempMigrations {
  const dir = mkdtempSync(join(tmpdir(), "bryce-mig-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  const journal: Journal = { version: "7", dialect: "sqlite", entries: [] };
  migrations.forEach((m, idx) => {
    writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
    journal.entries.push({ idx, version: "6", when: m.when, tag: m.tag, breakpoints: true });
  });
  writeJournal(dir, journal);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A well-formed Player List Backup player entry, overridable per test. */
export interface BackupEntryOverrides {
  id?: number;
  externalId?: number | null;
  ncaaPlayerSeq?: number | null;
  highlightlyPlayerId?: number | null;
  highlightlyTeamId?: number | null;
  ncaaSourceState?: "legacy_html" | "highlightly_pending" | "highlightly_active" | null;
  fullName?: string;
  level?: "mlb" | "milb" | "ncaa";
  milbLevel?: string | null;
  teamName?: string | null;
  position?: string | null;
  schoolName?: string | null;
  active?: boolean;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function makeBackupEntry(overrides: BackupEntryOverrides = {}): Record<string, unknown> {
  return {
    id: 1,
    externalId: 691185,
    ncaaPlayerSeq: null,
    fullName: "Maximo Acosta",
    level: "milb",
    milbLevel: "Triple-A",
    teamName: "Jacksonville Jumbo Shrimp",
    position: "SS",
    schoolName: null,
    active: true,
    notes: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A complete v5 list entry (#190). Built programmatically rather than spelled
 * out per test so adding a lane field later touches one place, and so the
 * default shape is the honest one — a non-default, cadence-less list.
 */
export function makeBackupList(
  overrides: {
    name?: string;
    createdAt?: string;
    updatedAt?: string;
    isDefault?: boolean;
    refreshIntervalMinutes?: number | null;
    digestHour?: number | null;
    digestTo?: string | null;
  } = {},
): {
  name: string;
  isDefault: boolean;
  refreshIntervalMinutes: number | null;
  digestHour: number | null;
  digestTo: string | null;
} {
  return {
    name: "Prospects",
    isDefault: false,
    refreshIntervalMinutes: null,
    digestHour: null,
    digestTo: null,
    ...overrides,
  };
}

export function makeBackupEnvelope(
  players: Array<Record<string, unknown>>,
  overrides: { version?: unknown; exportedAt?: string } = {},
): Record<string, unknown> {
  return {
    version: overrides.version ?? 1,
    exportedAt: overrides.exportedAt ?? "2026-07-19T17:00:00.000Z",
    players,
  };
}
