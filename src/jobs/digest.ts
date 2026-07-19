import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PlayerRow } from "../db/schema.js";
import { digestDeliveries, players, statLines } from "../db/schema.js";
import type { RenderLine, RenderPlayer } from "../digest/render.js";
import { renderDigest, renderHeartbeat } from "../digest/render.js";
import { hostDate, isInSeason, sleepWindow } from "../domain/season.js";
import type { Mailer } from "../mailer/types.js";
import { loadActivePlayers, loadCalendars } from "./refresh.js";

export interface DigestDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  tz: string;
  to: string;
  from: string;
}

export interface DigestResult {
  kind: "digest" | "heartbeat";
  action: "sent" | "skipped" | "failed";
  reason: string | null;
  statLineCount: number;
  playerCount: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Digest (ADR 0030): report every Stat Line not yet reported by a previous
 * Digest — novelty-driven, no date windows — and send daily even when empty.
 * During Offseason Sleep (ADR 0031) a weekly heartbeat replaces it.
 */
export async function runDigest(deps: DigestDeps): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const activePlayers = await loadActivePlayers(db);
  const calendars = await loadCalendars(db);
  const sleep = sleepWindow(calendars, activePlayers, now(), tz);

  if (sleep.sleeping) {
    return runHeartbeat(deps, activePlayers.length, sleep.nextOpeningDay);
  }

  const today = hostDate(now(), tz);
  const alreadySent = await db
    .select({ id: digestDeliveries.id })
    .from(digestDeliveries)
    .where(
      and(
        eq(digestDeliveries.kind, "digest"),
        eq(digestDeliveries.dateCovered, today),
        eq(digestDeliveries.status, "sent"),
      ),
    );
  if (alreadySent.length > 0) {
    return {
      kind: "digest",
      action: "skipped",
      reason: "already-sent-today",
      statLineCount: 0,
      playerCount: 0,
    };
  }

  // One join, not one query per player (rules/backend.md).
  const unreported = await db
    .select({ line: statLines, player: players })
    .from(statLines)
    .innerJoin(players, eq(statLines.playerId, players.id))
    .where(and(isNull(statLines.digestDeliveryId), eq(players.active, true)));

  const renderLines: RenderLine[] = unreported.map(({ line, player }) => ({
    player: toRenderPlayer(player),
    gameId: line.gameId,
    statType: line.statType,
    gameDate: line.gameDate,
    gameNumber: line.gameNumber,
    isHome: line.isHome,
    opponentName: line.opponentName,
    stats: asRecord(line.stats),
  }));

  // "No new stats" tail: In Season active players with no new lines ONLY —
  // an out-of-season player is omitted entirely, not listed.
  const playersWithLines = new Set(unreported.map(({ player }) => player.id));
  const noNewStats: RenderPlayer[] = activePlayers
    .filter((p) => !playersWithLines.has(p.id))
    .filter((p) => isInSeason(p, calendars, now(), tz))
    .map(toRenderPlayer);

  const mail = renderDigest({ date: today, lines: renderLines, noNewStats });
  const reportedIds = unreported.map(({ line }) => line.id);
  const playerCount = playersWithLines.size;

  try {
    await deps.mailer.send({ to: deps.to, from: deps.from, ...mail });
  } catch (err) {
    // Send failed: record the failure, leave every line unmarked — the next
    // run retries and nothing is lost (ADR 0030).
    await recordDelivery(deps, {
      kind: "digest",
      dateCovered: today,
      status: "failed",
      errorMessage: errorMessage(err),
      playerCount,
      statLineCount: reportedIds.length,
    });
    return {
      kind: "digest",
      action: "failed",
      reason: errorMessage(err),
      statLineCount: reportedIds.length,
      playerCount,
    };
  }

  // Send succeeded: one transaction marks the delivery and every reported line.
  db.transaction((tx) => {
    const delivery = tx
      .insert(digestDeliveries)
      .values({
        kind: "digest",
        dateCovered: today,
        sentAt: now().toISOString(),
        playerCount,
        statLineCount: reportedIds.length,
        status: "sent",
        errorMessage: null,
        createdAt: now().toISOString(),
      })
      .onConflictDoUpdate({
        target: [digestDeliveries.kind, digestDeliveries.dateCovered],
        set: {
          sentAt: now().toISOString(),
          playerCount,
          statLineCount: reportedIds.length,
          status: "sent",
          errorMessage: null,
        },
      })
      .returning({ id: digestDeliveries.id })
      .all();
    const deliveryId = delivery[0]?.id;
    if (deliveryId === undefined) {
      throw new Error("Failed to record digest delivery");
    }
    if (reportedIds.length > 0) {
      tx.update(statLines)
        .set({ digestDeliveryId: deliveryId })
        .where(inArray(statLines.id, reportedIds))
        .run();
    }
  });

  return {
    kind: "digest",
    action: "sent",
    reason: null,
    statLineCount: reportedIds.length,
    playerCount,
  };
}

/** Weekly heartbeat during Offseason Sleep: send only if none sent in the last 7 days. */
async function runHeartbeat(
  deps: DigestDeps,
  watchedCount: number,
  nextOpeningDay: string | null,
): Promise<DigestResult> {
  const { db, now, tz } = deps;
  const today = hostDate(now(), tz);

  const last = await db
    .select()
    .from(digestDeliveries)
    .where(and(eq(digestDeliveries.kind, "heartbeat"), eq(digestDeliveries.status, "sent")))
    .orderBy(desc(digestDeliveries.sentAt))
    .limit(1);
  const lastSentAt = last[0]?.sentAt ?? null;
  if (lastSentAt !== null && now().getTime() - Date.parse(lastSentAt) < WEEK_MS) {
    return {
      kind: "heartbeat",
      action: "skipped",
      reason: "heartbeat-sent-within-week",
      statLineCount: 0,
      playerCount: watchedCount,
    };
  }

  const mail = renderHeartbeat({ date: today, playerCount: watchedCount, nextOpeningDay });
  try {
    await deps.mailer.send({ to: deps.to, from: deps.from, ...mail });
  } catch (err) {
    await recordDelivery(deps, {
      kind: "heartbeat",
      dateCovered: today,
      status: "failed",
      errorMessage: errorMessage(err),
      playerCount: watchedCount,
      statLineCount: 0,
    });
    return {
      kind: "heartbeat",
      action: "failed",
      reason: errorMessage(err),
      statLineCount: 0,
      playerCount: watchedCount,
    };
  }

  await recordDelivery(deps, {
    kind: "heartbeat",
    dateCovered: today,
    status: "sent",
    errorMessage: null,
    playerCount: watchedCount,
    statLineCount: 0,
  });
  return {
    kind: "heartbeat",
    action: "sent",
    reason: null,
    statLineCount: 0,
    playerCount: watchedCount,
  };
}

async function recordDelivery(
  deps: DigestDeps,
  args: {
    kind: "digest" | "heartbeat";
    dateCovered: string;
    status: "sent" | "failed";
    errorMessage: string | null;
    playerCount: number;
    statLineCount: number;
  },
): Promise<void> {
  const nowIso = deps.now().toISOString();
  const sentAt = args.status === "sent" ? nowIso : null;
  await deps.db
    .insert(digestDeliveries)
    .values({
      kind: args.kind,
      dateCovered: args.dateCovered,
      sentAt,
      playerCount: args.playerCount,
      statLineCount: args.statLineCount,
      status: args.status,
      errorMessage: args.errorMessage,
      createdAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [digestDeliveries.kind, digestDeliveries.dateCovered],
      set: {
        sentAt,
        playerCount: args.playerCount,
        statLineCount: args.statLineCount,
        status: args.status,
        errorMessage: args.errorMessage,
      },
    });
}

function toRenderPlayer(player: PlayerRow): RenderPlayer {
  return {
    fullName: player.fullName,
    level: player.level,
    milbLevel: player.milbLevel,
    teamName: player.teamName,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
