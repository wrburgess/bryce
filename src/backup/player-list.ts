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
 * The version `createPlayerListBackup` EMITS.
 *
 * Version 5 (#190) carries each list's LANE configuration — `isDefault` plus the
 * three cadence/recipient columns. The bump is not cosmetic: without it a
 * restore silently loses which list is the default and every lane's schedule,
 * and a database with no default fails every unscoped command. Losing the HC's
 * configuration quietly is exactly what this backup exists to prevent.
 *
 * Earlier versions and what they added: v2 optional `lists` + `members` (issue
 * #70 / ADR 0046), v3 NCAA source state, v4 Highlightly identity as an explicit
 * membership selector. v1-v4 imports are all retained — each retained version is
 * a compatibility surface that must keep being tested, which is the cost weighed
 * when this phase chose ONE bump over two.
 */
export const PLAYER_BACKUP_VERSION = 5 as const;

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
    highlightlyPlayerId: z.number().int().positive().nullable().default(null),
    highlightlyTeamId: z.number().int().positive().nullable().default(null),
    ncaaSourceState: z
      .enum(["legacy_html", "highlightly_pending", "highlightly_active"])
      .nullable()
      .default(null),
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
    const hasHighlightlyIdentity = row.highlightlyPlayerId != null;
    if (!hasExternal && !hasSeq && !hasHighlightlyIdentity) {
      ctx.addIssue({
        code: "custom",
        message: "a player must carry at least one natural identity",
      });
    }
    if (row.level === "ncaa") {
      if (!hasSeq && !hasHighlightlyIdentity) {
        ctx.addIssue({
          code: "custom",
          path: ["ncaaPlayerSeq"],
        message: "an ncaa player requires a legacy or Highlightly identity",
        });
      }
      if (hasExternal) {
        ctx.addIssue({
          code: "custom",
          path: ["externalId"],
          message: "an ncaa player must not carry externalId (ADR 0032)",
        });
      }
      if (row.ncaaSourceState === "highlightly_active" && !hasHighlightlyIdentity) {
        ctx.addIssue({
          code: "custom",
          path: ["highlightlyPlayerId"],
          message: "an active Highlightly player requires highlightlyPlayerId",
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
 * A live list definition in a v2 backup, plus its LANE configuration from v5
 * (#190). Name is non-blank after normalization; timestamps are optional (an
 * insert falls back to `now`).
 *
 * The four lane fields are optional with explicit defaults so a v1-v4 payload
 * parses unchanged into a non-default, cadence-less list — the same shape those
 * versions could ever have described. The bounds mirror the DB CHECKs rather
 * than trusting them: a payload is untrusted input, and the schema is where it
 * is rejected with a readable message instead of a constraint failure.
 */
const backupListSchema = z
  .object({
    name: z.string().min(1),
    createdAt: isoTimestamp.optional(),
    updatedAt: isoTimestamp.optional(),
    isDefault: z.boolean().default(false),
    refreshIntervalMinutes: z.number().int().positive().nullable().default(null),
    digestHour: z.number().int().min(0).max(23).nullable().default(null),
    digestTo: z.string().min(1).nullable().default(null),
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
 * A membership in a v4 backup: a list plus exactly one current natural identity
 * (externalId, legacy ncaaPlayerSeq, or highlightlyPlayerId).
 */
const backupMemberSchema = z
  .object({
    list: z.string().min(1),
    externalId: z.number().int().positive().nullable().default(null),
    ncaaPlayerSeq: z.number().int().positive().nullable().default(null),
    highlightlyPlayerId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const present = (row.externalId != null ? 1 : 0) + (row.ncaaPlayerSeq != null ? 1 : 0) + (row.highlightlyPlayerId != null ? 1 : 0);
    if (present !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "a member must carry exactly one natural id (externalId, ncaaPlayerSeq, or highlightlyPlayerId)",
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
    // v1 through v5: a v1 payload (no lists/members) still restores (ADR 0046).
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
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
    // Lane configuration requires v5 (#190) — the same fail-closed rule the
    // version field already carries for lists (v2) and Highlightly membership
    // (v4). Without it a hand-edited v4 payload could smuggle in a default and
    // the version would stop describing the payload's contents.
    if (env.version < 5) {
      env.lists?.forEach((list, index) => {
        if (
          list.isDefault ||
          list.refreshIntervalMinutes != null ||
          list.digestHour != null ||
          list.digestTo != null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["lists", index],
            message: "lane configuration (isDefault/cadence/recipients) requires version 5",
          });
        }
      });
    }
    // At most ONE default in the payload, mirroring `player_lists_default_uq`.
    // Rejected HERE rather than left to the index: restore is all-or-nothing, so
    // a second default would roll back an otherwise good restore with a
    // constraint failure instead of naming the actual problem.
    const defaults = (env.lists ?? []).filter((list) => list.isDefault);
    if (defaults.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["lists"],
        message: `at most one list may be the default; found ${defaults.length}`,
      });
    }
    if (env.version < 4 && env.members?.some((member) => member.highlightlyPlayerId != null)) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "Highlightly membership identity requires version 4",
      });
    }
    env.players.forEach((player, index) => {
      if (player.level !== "ncaa") return;
      if (env.version >= 3 && player.ncaaSourceState == null) {
        ctx.addIssue({ code: "custom", path: ["players", index, "ncaaSourceState"], message: "an NCAA player requires ncaaSourceState in version 3+" });
      }
      if (env.version < 3 && player.highlightlyPlayerId != null) {
        ctx.addIssue({ code: "custom", path: ["players", index, "highlightlyPlayerId"], message: "Highlightly NCAA identity requires version 3+" });
      }
    });

    // v1-v3 could serialize the then-supported NCAA -> pro promotion state as
    // a professional row with both externalId and ncaaPlayerSeq. Preserve that
    // narrow historical import contract so restore can find the old local NCAA
    // row and convert it without orphaning its Stat Lines. v4 is emitted after
    // the explicit transition redesign, so it must contain one current identity
    // only. Do not generalize this compatibility exception to Highlightly state
    // or malformed mixed identities.
    env.players.forEach((player, index) => {
      if (player.level === "ncaa") return;
      const carriesNcaaState =
        player.ncaaPlayerSeq != null ||
        player.highlightlyPlayerId != null ||
        player.highlightlyTeamId != null ||
        player.ncaaSourceState != null;
      if (!carriesNcaaState) return;
      const isLegacyPromotion =
        env.version < 4 &&
        player.externalId != null &&
        player.ncaaPlayerSeq != null &&
        player.highlightlyPlayerId == null &&
        player.highlightlyTeamId == null &&
        player.ncaaSourceState == null;
      if (!isLegacyPromotion) {
        ctx.addIssue({
          code: "custom",
          path: ["players", index],
          message: "a professional player must not carry NCAA identity or state",
        });
      }
    });

    // Natural-id uniqueness WITHIN the payload — two rows sharing an identity
    // would fight over the same DB row on import.
    const seenExternal = new Set<number>();
    const seenSeq = new Set<number>();
    const seenHighlightly = new Set<number>();
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
      if (p.highlightlyPlayerId != null) {
        if (seenHighlightly.has(p.highlightlyPlayerId)) ctx.addIssue({ code: "custom", path: ["players", i, "highlightlyPlayerId"], message: `duplicate highlightlyPlayerId ${p.highlightlyPlayerId} in payload` });
        seenHighlightly.add(p.highlightlyPlayerId);
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
 * (version 5). LIVE named lists, their LANE configuration (#190), and their
 * memberships are included so the HC's roster choices AND schedule survive a
 * restore (soft-deleted lists are excluded — a deleted list is not a roster
 * choice to preserve). Each membership references its player by natural id and
 * its list by name.
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
      highlightlyPlayerId: players.highlightlyPlayerId,
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
        highlightlyPlayerId: r.highlightlyPlayerId,
        highlightlyTeamId: r.highlightlyTeamId,
        ncaaSourceState: r.ncaaSourceState,
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
      // ALWAYS emitted, never omitted-when-falsy: a v5 payload states each
      // list's lane configuration outright, so a restore never has to infer it
      // from absence (#190).
      isDefault: l.isDefault,
      refreshIntervalMinutes: l.refreshIntervalMinutes,
      digestHour: l.digestHour,
      digestTo: l.digestTo,
    })),
    // Each current player has exactly one operational natural identity.
    members: memberRows.map((m) =>
      m.externalId != null
        ? { list: m.listName, externalId: m.externalId, ncaaPlayerSeq: null, highlightlyPlayerId: null }
        : m.ncaaPlayerSeq != null
          ? { list: m.listName, externalId: null, ncaaPlayerSeq: m.ncaaPlayerSeq, highlightlyPlayerId: null }
          : { list: m.listName, externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: m.highlightlyPlayerId },
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
  // v1/v2 predate source-state serialization. Their only NCAA representation
  // was the legacy stats_player_seq, so make that historical contract explicit
  // once at the parsing seam; v3+ must carry state and never gets a silent fix.
  if (result.data.version < 3) {
    for (const player of result.data.players) {
      if (player.level === "ncaa" && player.ncaaPlayerSeq != null && player.ncaaSourceState == null) {
        player.ncaaSourceState = "legacy_html";
      }
    }
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
