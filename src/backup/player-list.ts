import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { listPlayers } from "../watchlist/service.js";
import { fsyncDir } from "./snapshot.js";

/**
 * The Player List Backup (ADR 0042): a portable, versioned serialization of
 * *every* Player row — active and inactive — the recovery counterpart to the one
 * irreplaceable thing, the human's roster choices and notes. It is NOT an Export
 * (a spreadsheet artifact); it is a restore point, re-imported network-free by
 * upserting on each Player's natural identity.
 *
 * The envelope is JSON (inert — no formula-injection surface, unlike CSV) and
 * strictly validated on import: unknown keys rejected, positive natural ids,
 * enum/nullability enforced, ISO-8601 timestamps, a payload-size ceiling, and
 * per-row identity rules consistent with ADR 0032.
 */

export const PLAYER_BACKUP_VERSION = 1 as const;

/** Refuse absurd inputs before Zod even runs — a cheap denial-of-service guard. */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isoTimestamp = z.string().regex(ISO_8601, "must be an ISO-8601 timestamp");

const playerEntrySchema = z
  .object({
    // The source-local primary key: carried for provenance, NEVER authoritative
    // on import (a natural-id match decides the row; id is the FK target).
    id: z.number().int().positive().optional(),
    externalId: z.number().int().positive().nullable().default(null),
    ncaaPlayerSeq: z.number().int().positive().nullable().default(null),
    fullName: z.string().min(1),
    level: z.enum(["mlb", "milb", "ncaa"]),
    milbLevel: z.string().nullable().default(null),
    teamName: z.string().nullable().default(null),
    position: z.string().nullable().default(null),
    schoolName: z.string().nullable().default(null),
    active: z.boolean(),
    notes: z.string().nullable().default(null),
    createdAt: isoTimestamp.optional(),
    updatedAt: isoTimestamp.optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const hasExternal = row.externalId != null;
    const hasSeq = row.ncaaPlayerSeq != null;
    if (!hasExternal && !hasSeq) {
      ctx.addIssue({
        code: "custom",
        message: "a player must carry at least one natural identity (externalId or ncaaPlayerSeq)",
      });
    }
    if (row.level === "ncaa") {
      if (!hasSeq) {
        ctx.addIssue({
          code: "custom",
          path: ["ncaaPlayerSeq"],
          message: "an ncaa player requires ncaaPlayerSeq",
        });
      }
      if (hasExternal) {
        ctx.addIssue({
          code: "custom",
          path: ["externalId"],
          message: "an ncaa player must not carry externalId (ADR 0032)",
        });
      }
    } else if (!hasExternal) {
      ctx.addIssue({
        code: "custom",
        path: ["externalId"],
        message: `a ${row.level} player requires externalId`,
      });
    }
  });

export const playerListBackupSchema = z
  .object({
    version: z.literal(PLAYER_BACKUP_VERSION),
    exportedAt: isoTimestamp.optional(),
    players: z.array(playerEntrySchema),
  })
  .strict()
  .superRefine((env, ctx) => {
    // Natural-id uniqueness WITHIN the payload — two rows sharing an identity
    // would fight over the same DB row on import.
    const seenExternal = new Set<number>();
    const seenSeq = new Set<number>();
    env.players.forEach((p, i) => {
      if (p.externalId != null) {
        if (seenExternal.has(p.externalId)) {
          ctx.addIssue({
            code: "custom",
            path: ["players", i, "externalId"],
            message: `duplicate externalId ${p.externalId} in payload`,
          });
        }
        seenExternal.add(p.externalId);
      }
      if (p.ncaaPlayerSeq != null) {
        if (seenSeq.has(p.ncaaPlayerSeq)) {
          ctx.addIssue({
            code: "custom",
            path: ["players", i, "ncaaPlayerSeq"],
            message: `duplicate ncaaPlayerSeq ${p.ncaaPlayerSeq} in payload`,
          });
        }
        seenSeq.add(p.ncaaPlayerSeq);
      }
    });
  });

export type PlayerBackupEntry = z.infer<typeof playerEntrySchema>;
export type PlayerListBackup = z.infer<typeof playerListBackupSchema>;

export class PlayerBackupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerBackupParseError";
  }
}

/** Serialize every Player row into a versioned, re-importable backup envelope. */
export async function createPlayerListBackup(
  db: Db,
  now: () => Date = () => new Date(),
): Promise<PlayerListBackup> {
  const rows = await listPlayers(db, "all");
  return {
    version: PLAYER_BACKUP_VERSION,
    exportedAt: now().toISOString(),
    players: rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      ncaaPlayerSeq: r.ncaaPlayerSeq,
      fullName: r.fullName,
      level: r.level,
      milbLevel: r.milbLevel,
      teamName: r.teamName,
      position: r.position,
      schoolName: r.schoolName,
      active: r.active,
      notes: r.notes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}

/** Parse and strictly validate a Player List Backup from its JSON text. */
export function parsePlayerListBackup(json: string): PlayerListBackup {
  if (json.length > MAX_BACKUP_BYTES) {
    throw new PlayerBackupParseError(
      `backup exceeds the ${MAX_BACKUP_BYTES}-byte size ceiling`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new PlayerBackupParseError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = playerListBackupSchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new PlayerBackupParseError(detail);
  }
  return result.data;
}

/**
 * Crash-safe write of the serialized backup: temp sibling + fsync + atomic
 * rename, owner-only permissions. A crash never leaves a torn file under the
 * final name.
 */
export function writePlayerListBackupFile(path: string, json: string): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
  closeSync(fd);
  renameSync(tempPath, path);
  fsyncDir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
}
