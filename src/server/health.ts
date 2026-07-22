import { count, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { DeliveryKind, DeliveryStatus } from "../db/schema.js";
import { digestDeliveries, players, statLines } from "../db/schema.js";
import type { RefreshHealth } from "../jobs/refresh-run.js";
import { refreshHealth } from "../jobs/refresh-run.js";

/**
 * Health snapshot shared by the public GET /health route and the MCP `status`
 * tool — one shape, one query path.
 *
 * `kind`/`status` come from the schema's own unions, never restated here: the
 * delivery state machine gained `sending` in ADR 0034, and a hand-copied
 * `"sent" | "failed"` would have shipped a type lie that only surfaces once a
 * claim is in flight (rules/backend.md — thread every new state through every
 * surface's seam in the same change). A stuck claim is meant to be VISIBLE
 * here, which is precisely why the status must not be narrowed.
 */

export interface HealthSnapshot {
  ok: boolean;
  players: number;
  statLines: number;
  lastDelivery: {
    kind: DeliveryKind;
    dateCovered: string;
    status: DeliveryStatus;
    sentAt: string | null;
  } | null;
  /**
   * Ingestion freshness (ADR 0043), or null when no refresh has ever run. Its
   * `state` is the DERIVED health vocabulary (fresh/stale/running/partial/
   * failed) — distinct from the stored RefreshRunStatus, because fresh/stale are
   * computed against `now`, which is why this snapshot now takes a clock. A
   * crashed run (expired lease) reports its latest terminal outcome, never a
   * phantom `running`.
   */
  refresh: RefreshHealth | null;
}

export async function healthSnapshot(db: Db, now: Date, tz: string): Promise<HealthSnapshot> {
  const playerCount = (
    await db.select({ n: count() }).from(players).where(eq(players.active, true))
  )[0];
  const statLineCount = (await db.select({ n: count() }).from(statLines))[0];
  // A retried delivery is updated in place (sentAt moves, createdAt does not),
  // so "last" means latest activity: sentAt when sent, createdAt for failed rows.
  const last = (
    await db
      .select()
      .from(digestDeliveries)
      .orderBy(
        desc(sql`coalesce(${digestDeliveries.sentAt}, ${digestDeliveries.createdAt})`),
        desc(digestDeliveries.createdAt),
      )
      .limit(1)
  )[0];
  return {
    ok: true,
    players: playerCount?.n ?? 0,
    statLines: statLineCount?.n ?? 0,
    lastDelivery:
      last === undefined
        ? null
        : {
            kind: last.kind,
            dateCovered: last.dateCovered,
            status: last.status,
            sentAt: last.sentAt,
          },
    refresh: refreshHealth(db, now, tz),
  };
}
