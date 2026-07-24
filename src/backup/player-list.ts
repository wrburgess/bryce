import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { listMembers, playerLists, playerTags, players } from "../db/schema.js";
import { canonicalizeName } from "../domain/names.js";
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

/**
 * The version `createPlayerListBackup` EMITS. Bumped to 2 for named lists
 * (issue #70 / ADR 0046): a v2 payload adds optional `lists` (live list
 * definitions) and `members` (each referencing a player by natural id and a list
 * by name). The parser still accepts a v1 payload (no lists/members) — the bump
 * is backward compatible.
 */
export const PLAYER_BACKUP_VERSION = 2 as const;

/** Refuse absurd inputs before Zod even runs — a cheap denial-of-service guard. */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isoTimestamp = z.string().regex(ISO_8601, "must be an ISO-8601 timestamp");

/**
 * A MANUAL tag carried in a backup entry (Phase A of #29). Only `source='manual'`
 * tags are backed up — derived tags rebuild on the next Refresh, so they carry no
 * information a restore needs. Optional and additive: a v1 backup with no `tags`
 * field restores exactly as before.
 */
const backupTagSchema = z
  .object({
    namespace: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

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
    tags: z.array(backupTagSchema).optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // A name that is only whitespace passes min(1) but canonicalizes to empty,
    // which would store a nameless player — reject it up front (fullName and,
    // when present, schoolName).
    if (canonicalizeName(row.fullName).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["fullName"],
        message: "fullName is blank after normalization",
      });
    }
    if (row.schoolName != null && canonicalizeName(row.schoolName).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["schoolName"],
        message: "schoolName is blank after normalization",
      });
    }
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

/**
 * A live list definition in a v2 backup. Name is non-blank after normalization;
 * timestamps are optional (an insert falls back to `now`).
 */
const backupListSchema = z
  .object({
    name: z.string().min(1),
    createdAt: isoTimestamp.optional(),
    updatedAt: isoTimestamp.optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.name.trim().length === 0) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "list name is blank" });
    } else if (/\p{Cc}/u.test(row.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "list name must not contain a control character",
      });
    }
  });

/**
 * A membership in a v2 backup: a list (by name) plus a player (by natural id —
 * exactly one of externalId or ncaaPlayerSeq, mirroring a player row's identity
 * rule). Resolved against the just-restored players on import.
 */
const backupMemberSchema = z
  .object({
    list: z.string().min(1),
    externalId: z.number().int().positive().nullable().default(null),
    ncaaPlayerSeq: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((row, ctx) => {
    const present = (row.externalId != null ? 1 : 0) + (row.ncaaPlayerSeq != null ? 1 : 0);
    if (present !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "a member must carry exactly one natural id (externalId or ncaaPlayerSeq)",
      });
    }
    if (row.list.trim().length === 0) {
      ctx.addIssue({ code: "custom", path: ["list"], message: "list name is blank" });
    } else if (/\p{Cc}/u.test(row.list)) {
      ctx.addIssue({
        code: "custom",
        path: ["list"],
        message: "member list name must not contain a control character",
      });
    }
  });

export const playerListBackupSchema = z
  .object({
    // v1 or v2: a v1 payload (no lists/members) still restores (ADR 0046).
    version: z.union([z.literal(1), z.literal(2)]),
    exportedAt: isoTimestamp.optional(),
    players: z.array(playerEntrySchema),
    lists: z.array(backupListSchema).optional(),
    members: z.array(backupMemberSchema).optional(),
  })
  .strict()
  .superRefine((env, ctx) => {
    // Fail-closed on the version field: v1 predates named lists (ADR 0046), so a
    // v1 payload MUST NOT carry list/member data. Rejecting it here keeps the
    // version field trustworthy — list/member data requires version 2.
    if (env.version === 1 && ((env.lists?.length ?? 0) > 0 || (env.members?.length ?? 0) > 0)) {
      ctx.addIssue({
        code: "custom",
        message: "version 1 backups must not carry lists or members (use version 2)",
      });
    }

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
export type PlayerBackupList = z.infer<typeof backupListSchema>;
export type PlayerBackupMember = z.infer<typeof backupMemberSchema>;
export type PlayerListBackup = z.infer<typeof playerListBackupSchema>;

export class PlayerBackupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerBackupParseError";
  }
}

/**
 * Serialize every Player row into a versioned, re-importable backup envelope
 * (version 2). LIVE named lists and their memberships are included so the HC's
 * roster choices survive a restore (soft-deleted lists are excluded — a deleted
 * list is not a roster choice to preserve). Each membership references its player
 * by natural id and its list by name.
 */
export async function createPlayerListBackup(
  db: Db,
  now: () => Date = () => new Date(),
): Promise<PlayerListBackup> {
  const rows = await listPlayers(db, "all");

  const liveLists = await db
    .select()
    .from(playerLists)
    .where(isNull(playerLists.deletedAt))
    .orderBy(playerLists.name);

  const memberRows = await db
    .select({
      listName: playerLists.name,
      externalId: players.externalId,
      ncaaPlayerSeq: players.ncaaPlayerSeq,
    })
    .from(listMembers)
    .innerJoin(playerLists, eq(listMembers.listId, playerLists.id))
    .innerJoin(players, eq(listMembers.playerId, players.id))
    .where(isNull(playerLists.deletedAt))
    .orderBy(playerLists.name, players.id);

  // One query for every MANUAL tag, grouped by player (never a query per player):
  // derived tags are not backed up — they rebuild on the next Refresh.
  const manualTags = await db.select().from(playerTags).where(eq(playerTags.source, "manual"));
  const tagsByPlayer = new Map<number, Array<{ namespace: string; value: string }>>();
  for (const t of manualTags) {
    const list = tagsByPlayer.get(t.playerId) ?? [];
    list.push({ namespace: t.namespace, value: t.value });
    tagsByPlayer.set(t.playerId, list);
  }

  return {
    version: PLAYER_BACKUP_VERSION,
    exportedAt: now().toISOString(),
    players: rows.map((r) => {
      // ALWAYS emit `tags` (an empty array when the player has no manual tags),
      // so the format is self-describing: an authoritative empty set is distinct
      // from a legacy v1 backup that omits the field entirely. Restore reconciles
      // the player's manual tags to exactly this set (an absent field is the only
      // "leave untouched" signal, which only a pre-#30 backup carries).
      const tags = tagsByPlayer.get(r.id) ?? [];
      tags.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.value.localeCompare(b.value));
      return {
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
        tags,
      };
    }),
    lists: liveLists.map((l) => ({
      name: l.name,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    })),
    // Prefer externalId when a player carries both (a promoted NCAA -> pro row);
    // either resolves to the same player id on import.
    members: memberRows.map((m) =>
      m.externalId != null
        ? { list: m.listName, externalId: m.externalId, ncaaPlayerSeq: null }
        : { list: m.listName, externalId: null, ncaaPlayerSeq: m.ncaaPlayerSeq },
    ),
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
  // Create the destination parent so the documented `--out backups/players.json`
  // works on a fresh clone where `backups/` does not yet exist.
  mkdirSync(dirname(path), { recursive: true });
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
