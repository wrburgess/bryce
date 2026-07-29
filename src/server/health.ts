import type { SQL } from "drizzle-orm";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { DeliveryKind, DeliveryStatus } from "../db/schema.js";
import { digestDeliveries, playerLists, players, statLines } from "../db/schema.js";
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
  /**
   * PER-LANE delivery state (#193, ADR 0062 decision 5) — the owed view ADR 0059
   * amendment 2 named, alongside the host-wide `lastDelivery` above rather than
   * replacing it.
   *
   * ADDITIVE, keyed on LANES rather than on delivery rows, and that is the whole
   * design. `lastDelivery` answers "is the host delivering at all?", which a
   * single healthy lane keeps green while another has been silent for a month.
   * This answers "is EVERY lane delivering?", and it can only do so by starting
   * from the lanes: a view built from delivery rows cannot report a lane that has
   * never produced one, which is exactly the dead-lane case worth seeing.
   *
   * Three states are distinguishable BY CONSTRUCTION:
   *   - `digestHour: null` — not scheduled. Healthy by configuration, not silent.
   *   - scheduled, `lastDelivery: null` — configured and NEVER delivered.
   *   - scheduled, stale `lastDelivery` — the dead lane ADR 0059 named.
   * Ordered by lane id, the same stable order the tick attempts lanes in.
   */
  lanes: LaneHealth[];
}

export interface LaneHealth {
  listId: number;
  name: string;
  isDefault: boolean;
  /** The lane's configured digest hour, or null when it never auto-digests. */
  digestHour: number | null;
  /**
   * This lane's CURRENT delivery state — its latest `kind = 'digest'` row by the
   * same ordering the host-wide field uses, or null when it has none.
   *
   * ALL STATUSES ARE INCLUDED DELIBERATELY (Reviewer must-fix 3). A newest
   * `failed` or in-flight `sending` row IS the lane's current state and
   * supersedes an older `sent` one — suppressing it in favour of the last
   * success would hide precisely the signal this view exists to show. And
   * `kind = 'digest'` ONLY: a heartbeat rides the DEFAULT lane's slot as a
   * storage detail (ADR 0059 → *Amendment (#191)*), so counting one here would
   * forge weekly liveness for that one lane and for no other.
   */
  lastDelivery: {
    dateCovered: string;
    status: DeliveryStatus;
    sentAt: string | null;
  } | null;
}

/**
 * THE delivery-recency ordering — "latest activity first" — authored ONCE and
 * spread into every `orderBy` that needs it (#193 self-review).
 *
 * A retried delivery is updated in place (`sent_at` moves, `created_at` does
 * not), so "last" cannot mean `created_at`: it means `coalesce(sent_at,
 * created_at)`, then `created_at` to separate two rows whose coalesced value is
 * a tie, then `id` so rows identical in BOTH still order deterministically
 * rather than by insertion luck.
 *
 * It is a shared helper for the reason `latestCoveringRun` is one for the
 * coverage predicate (src/jobs/refresh-run.ts): the host-wide `lastDelivery` and
 * the per-lane view answer the same question about the same table, and two
 * authorings of one rule is how they quietly stop agreeing. They had already
 * drifted — the lane view carried the `id` tiebreak and the host-wide field did
 * not — so two rows stamped in the same whole second made /health report a
 * DIFFERENT "last" delivery on each surface for one set of rows, while the
 * comment claimed they agreed and a test with distinct timestamps never engaged
 * the tiebreak.
 */
export function deliveryRecencyOrder(): SQL[] {
  return [
    desc(sql`coalesce(${digestDeliveries.sentAt}, ${digestDeliveries.createdAt})`),
    desc(digestDeliveries.createdAt),
    desc(digestDeliveries.id),
  ];
}

export async function healthSnapshot(db: Db, now: Date, tz: string): Promise<HealthSnapshot> {
  const playerCount = (
    await db.select({ n: count() }).from(players).where(eq(players.active, true))
  )[0];
  const statLineCount = (await db.select({ n: count() }).from(statLines))[0];
  // Ordered by the ONE recency rule (`deliveryRecencyOrder`), which is also what
  // the per-lane view below reads — the two surfaces cannot disagree about which
  // row is "last" because there is only one authoring of the rule.
  //
  // DELIBERATELY HOST-WIDE, not lane-scoped (ADR 0059 → *Amendment (#191)*).
  // This field answers "is the host delivering at all?", and narrowing it would
  // silently change a published contract for every /health and MCP `status`
  // consumer. It does NOT answer "is every lane delivering?": once lanes send,
  // a healthy lane A digesting daily keeps this fresh while lane B has been
  // silent for a month. #193 owes a per-lane view ALONGSIDE this one.
  const last = (
    await db
      .select()
      .from(digestDeliveries)
      .orderBy(...deliveryRecencyOrder())
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
    lanes: await laneHealth(db),
  };
}

/**
 * One row per LIVE lane, each carrying its latest `digest` delivery (#193).
 *
 * ONE query for the deliveries, not one per lane (`rules/backend.md`: no N+1),
 * and no materialized `IN (<every lane id>)` either — the whole digest-delivery
 * set is read once and reduced in memory, the same shape the digest side uses.
 * At this host's scale (one person's lanes, one row per lane per day) that is a
 * small, bounded read; a correlated per-lane subquery would be a query per lane
 * dressed up as one statement.
 *
 * The reduction keeps the FIRST row it sees per lane, which is authoritative
 * because the read is ordered by `deliveryRecencyOrder()` — the SAME helper the
 * host-wide field spreads, not a restatement of it. The agreement is structural
 * now rather than asserted: there is one authoring of the rule, so the tests
 * that build the ambiguous cases (a retried row, a fresh failure, a live claim,
 * two rows stamped in the same whole second) pin behavior instead of policing a
 * duplicate.
 */
async function laneHealth(db: Db): Promise<LaneHealth[]> {
  const lanes = await db
    .select()
    .from(playerLists)
    .where(isNull(playerLists.deletedAt))
    .orderBy(playerLists.id);
  if (lanes.length === 0) return [];

  const rows = await db
    .select()
    .from(digestDeliveries)
    .where(eq(digestDeliveries.kind, "digest"))
    .orderBy(...deliveryRecencyOrder());
  const latestByLane = new Map<number, (typeof rows)[number]>();
  for (const row of rows) if (!latestByLane.has(row.listId)) latestByLane.set(row.listId, row);

  return lanes.map((lane) => {
    const last = latestByLane.get(lane.id);
    return {
      listId: lane.id,
      name: lane.name,
      isDefault: lane.isDefault,
      digestHour: lane.digestHour,
      lastDelivery:
        last === undefined
          ? null
          : { dateCovered: last.dateCovered, status: last.status, sentAt: last.sentAt },
    };
  });
}
