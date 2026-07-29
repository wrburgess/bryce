import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, OpenedDb } from "../src/db/client.js";
import type { PlayerListRow } from "../src/db/schema.js";
import { digestDeliveries } from "../src/db/schema.js";
import { assembleDigest } from "../src/digest/assemble.js";
import type { DigestDeps } from "../src/jobs/digest.js";
import { runDigest } from "../src/jobs/digest.js";
import {
  UnknownListError,
  addToList,
  configureList,
  createList,
  deleteList,
  renameList,
} from "../src/lists/service.js";
import { resolveTagScope } from "../src/tags/service.js";
import {
  CapturingMailer,
  MID_SEASON,
  OFFSEASON,
  TEST_TZ,
  enrollInDefaultLane,
  fakeClock,
  insertCalendars2026,
  insertDelivery,
  insertPlayer,
  insertPlayerTag,
  insertStatLine,
  testDb,
} from "./factories.js";

/**
 * The scoped digest (issue #70 / ADR 0046). The headline hazard is the
 * two-selection-site leak: `assembleDigest` selects players in the main
 * stat-line join AND via the active-player set (which feeds the idle/zero-row
 * tail and `seasonStartFor`). Both must be scoped or an off-list player leaks —
 * as a real row OR as a zero row. Every assertion is over the assembled content.
 */
describe("scoped digest (#70)", () => {
  let opened: OpenedDb;
  const clock = fakeClock(MID_SEASON);

  beforeEach(async () => {
    opened = testDb();
    // The clock is describe-scoped, and the Offseason-Sleep case below MOVES it.
    // Resetting per test keeps that case from silently turning every later one
    // into a heartbeat — shared mutable fixture state failing open.
    clock.set(MID_SEASON);
    await insertCalendars2026(opened.db);
  });
  afterEach(() => {
    opened.close();
  });

  /**
   * A `runDigest` invocation scoped to one lane, as every surface builds it:
   * the lane's id plus the name the CALLER resolved. The job re-reads the row by
   * id regardless, which is what the renamed-lane case below proves.
   */
  const laneDeps = (mailer: CapturingMailer, lane: PlayerListRow): DigestDeps => ({
    db: opened.db,
    mailer,
    now: clock.now,
    tz: TEST_TZ,
    to: "hc@example.com",
    from: "bryce@example.com",
    spec: "1d",
    listId: lane.id,
    listName: lane.name,
  });

  /** Names of every batter+pitcher row (real and zero) the assembly produced. */
  function rowNames(assembly: Awaited<ReturnType<typeof assembleDigest>>): string[] {
    return [...assembly.batters, ...assembly.pitchers].map((r) => r.player.fullName).sort();
  }

  it("scopes BOTH selection sites: a non-member with stats and a non-member idle both vanish", async () => {
    const list = await createList(opened.db, "L", clock.now());

    // A member with a stat line in the 1d window -> a real row.
    const member = await insertPlayer(opened.db, { fullName: "Member Withstats" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });

    // A member with NO stats but in season -> a zero row (should appear).
    const memberIdle = await insertPlayer(opened.db, { fullName: "Member Idle" });

    // A NON-member with a stat line -> must NOT leak through the main join.
    const nonMember = await insertPlayer(opened.db, { fullName: "Nonmember Withstats" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });

    // A NON-member idle -> must NOT leak as a zero row (the second selection site).
    await insertPlayer(opened.db, { fullName: "Nonmember Idle" });

    await addToList(opened.db, "L", [member.externalId!, memberIdle.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
      listName: list.name,
    });
    expect(rowNames(scoped)).toEqual(["Member Idle", "Member Withstats"]);
    expect(scoped.playerCount).toBe(1); // only the member with a line is counted
    expect(scoped.statLineCount).toBe(1);
  });

  it("with no listId, every active player appears (regression guard)", async () => {
    const list = await createList(opened.db, "L", clock.now());
    const member = await insertPlayer(opened.db, { fullName: "Member Withstats" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
    const nonMember = await insertPlayer(opened.db, { fullName: "Nonmember Withstats" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "1d" });
    expect(rowNames(unscoped)).toContain("Nonmember Withstats");
    expect(unscoped.playerCount).toBe(2);
    expect(list.id).toBeGreaterThan(0);
  });

  it("a named EMPTY list yields empty batters/pitchers and playerCount 0", async () => {
    const list = await createList(opened.db, "Empty", clock.now());
    // An active player with stats exists but is not a member.
    const p = await insertPlayer(opened.db);
    await insertStatLine(opened.db, { playerId: p.id, gameDate: "2026-07-18" });

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
      listName: list.name,
    });
    expect(scoped.batters).toEqual([]);
    expect(scoped.pitchers).toEqual([]);
    expect(scoped.playerCount).toBe(0);
    expect(scoped.statLineCount).toBe(0);
  });

  it("excludes a deactivated member from a scoped digest", async () => {
    const list = await createList(opened.db, "L", clock.now());
    const active = await insertPlayer(opened.db, { fullName: "Active Member" });
    await insertStatLine(opened.db, { playerId: active.id, gameDate: "2026-07-18" });
    const gone = await insertPlayer(opened.db, { fullName: "Deactivated Member", active: false });
    await insertStatLine(opened.db, { playerId: gone.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [active.externalId!], clock.now());
    // gone is a member row too, but deactivated.
    await addToList(opened.db, "L", [gone.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "1d",
      listId: list.id,
    });
    expect(rowNames(scoped)).toEqual(["Active Member"]);
  });

  it("seasonStartFor uses only the scoped members' sports (ytd window.from)", async () => {
    const list = await createList(opened.db, "L", clock.now());
    // Member plays Triple-A (sportId 11, regular season starts 2026-03-27).
    const member = await insertPlayer(opened.db, { level: "milb", milbLevel: "Triple-A" });
    // Non-member plays MLB (sportId 1, starts earlier: 2026-03-25).
    await insertPlayer(opened.db, { level: "mlb", milbLevel: null });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const scoped = await assembleDigest(opened.db, {
      now: clock.now,
      tz: TEST_TZ,
      spec: "ytd",
      listId: list.id,
    });
    const unscoped = await assembleDigest(opened.db, { now: clock.now, tz: TEST_TZ, spec: "ytd" });
    // Scoped to Triple-A only -> ytd anchors on 2026-03-27; unscoped includes
    // MLB's earlier 2026-03-25. The two windows differ, proving the second
    // selection site (seasonStartFor) is scoped too.
    expect(scoped.window.from).toBe("2026-03-27");
    expect(unscoped.window.from).toBe("2026-03-25");
  });

  it("runDigest scoped by list mails only member content, and CLAIMS the lane's slot (#193)", async () => {
    // The assertion this case used to make — "no delivery row" — INVERTS at
    // #193 (ADR 0062 decision 1, superseding ADR 0046 decision 4). A tag-free 1d
    // named-lane send is that lane's scheduled artifact now, so it claims. The
    // CONTENT half of the case is unchanged and still the point of the file.
    const list = await createList(opened.db, "L", clock.now());
    const member = await insertPlayer(opened.db, { fullName: "Mailed Memberrow" });
    await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
    const nonMember = await insertPlayer(opened.db, { fullName: "Hidden Nonmemberrow" });
    await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });
    await addToList(opened.db, "L", [member.externalId!], clock.now());

    const mailer = new CapturingMailer();
    const result = await runDigest(laneDeps(mailer, list));
    expect(result.action).toBe("sent");
    expect(result.playerCount).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    // The renderer abbreviates the first name, so assert on the unique surname.
    const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
    expect(body).toContain("Memberrow");
    expect(body).not.toContain("Nonmemberrow");
    expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (L) - Sat, July 18, 2026");

    const rows = await opened.db.select().from(digestDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "digest",
      dateCovered: "2026-07-19",
      listId: list.id,
      status: "sent",
      playerCount: 1,
      statLineCount: 1,
    });
    // The provider key is lane-suffixed, so lane L's recovery can never find
    // another lane's accepted message and suppress its own send.
    expect(mailer.contexts[0]).toEqual({
      deliveryKey: `bryce:digest:2026-07-19:list-${list.id}`,
    });
  });

  /**
   * The claimed lane digest (#193 / ADR 0062 decision 1). Everything below runs
   * through the SAME `runDigest` entry point every surface uses, and asserts the
   * persisted row and the mailed content — never the routing decision directly,
   * because what has to hold is that a real send claims, not that a branch was
   * taken.
   */
  describe("claimed lane digest (#193)", () => {
    it("two lanes claim the SAME date; the same lane twice is refused", async () => {
      const a = await createList(opened.db, "A", clock.now());
      const b = await createList(opened.db, "B", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Shared Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "A", [player.externalId!], clock.now());
      await addToList(opened.db, "B", [player.externalId!], clock.now());

      const mailer = new CapturingMailer();
      expect((await runDigest(laneDeps(mailer, a))).action).toBe("sent");
      expect((await runDigest(laneDeps(mailer, b))).action).toBe("sent");
      // Two lanes, one date, two slots — the lane dimension #190 added to the
      // unique index is what makes that legal.
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(2);
      expect(mailer.sent).toHaveLength(2);

      // ...and the SAME triple is still exactly-once (acceptance criterion).
      const again = await runDigest(laneDeps(mailer, a));
      expect(again).toMatchObject({ action: "skipped", reason: "already-sent-today" });
      expect(mailer.sent).toHaveLength(2); // nothing mailed a third time
    });

    it("a FAILED lane send lands on its own slot, and a later run re-claims and sends", async () => {
      const lane = await createList(opened.db, "L", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Retry Guy" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "L", [player.externalId!], clock.now());

      const mailer = new CapturingMailer();
      mailer.failWith = new Error("postmark down");
      expect(await runDigest(laneDeps(mailer, lane))).toMatchObject({
        action: "failed",
        reason: "postmark down",
      });
      const failed = await opened.db.select().from(digestDeliveries);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        listId: lane.id,
        status: "failed",
        sentAt: null,
        attemptCount: 1,
      });

      // A `failed` row is re-claimable, so the next run retries the SAME slot —
      // which is what makes the tick's four-times-an-hour retry work.
      mailer.failWith = null;
      expect((await runDigest(laneDeps(mailer, lane))).action).toBe("sent");
      const settled = await opened.db.select().from(digestDeliveries);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ listId: lane.id, status: "sent", attemptCount: 2 });
    });

    it("LEAK GUARD: a non-member with a stat line AND a non-member idle are both excluded", async () => {
      // The claimed-path twin of this file's headline case. `assembleDigest` has
      // two selection sites — the stat-line join and the active-player set that
      // feeds the idle/zero-row tail — and the claimed path threads the lane
      // into the same call, so a leak here would MAIL a non-member's data rather
      // than merely return it. Both sites are exercised in one send.
      // EVERY SURNAME IS UNIQUE, and that is load-bearing rather than tidy: the
      // renderer abbreviates the FIRST name to an initial, so a fixture whose
      // member and non-member shared a surname (`Member Withstats` /
      // `Nonmember Withstats`) renders both as `Withstats, ?` and the word
      // "Nonmember" never appears in the email at all. Such a case passes with
      // the lane filter DELETED — verified by deleting it — which is precisely
      // the vacuous-fixture failure rules/testing.md names.
      const lane = await createList(opened.db, "L", clock.now());
      const member = await insertPlayer(opened.db, { fullName: "Aaa Memberstats" });
      await insertStatLine(opened.db, { playerId: member.id, gameDate: "2026-07-18" });
      const memberIdle = await insertPlayer(opened.db, { fullName: "Bbb Memberidle" });
      const nonMember = await insertPlayer(opened.db, { fullName: "Ccc Leakystats" });
      await insertStatLine(opened.db, { playerId: nonMember.id, gameDate: "2026-07-18" });
      await insertPlayer(opened.db, { fullName: "Ddd Leakyidle" });
      await addToList(opened.db, "L", [member.externalId!, memberIdle.externalId!], clock.now());

      const mailer = new CapturingMailer();
      expect((await runDigest(laneDeps(mailer, lane))).action).toBe("sent");
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      expect(body).toContain("Memberstats"); // the member's real row (join site)
      expect(body).toContain("Memberidle"); // the member's zero row (idle site)
      // One assertion per SELECTION SITE, so a half-scoped build fails on the
      // site it left whole rather than passing on the other's behalf.
      expect(body).not.toContain("Leakystats"); // the stat-line join
      expect(body).not.toContain("Leakyidle"); // the idle/zero-row tail
    });

    it("RECIPIENTS: a lane's digest_to wins; a NULL one falls back to the host value", async () => {
      const configured = await createList(opened.db, "Configured", clock.now());
      const bare = await createList(opened.db, "Bare", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "Configured", [player.externalId!], clock.now());
      await addToList(opened.db, "Bare", [player.externalId!], clock.now());
      await configureList(opened.db, "Configured", { digestTo: "lane@example.com" }, clock.now());

      const mailer = new CapturingMailer();
      expect((await runDigest(laneDeps(mailer, configured))).action).toBe("sent");
      expect(mailer.sent[0]?.to).toBe("lane@example.com");

      expect((await runDigest(laneDeps(mailer, bare))).action).toBe("sent");
      expect(mailer.sent[1]?.to).toBe("hc@example.com"); // deps.to, the DIGEST_TO value
    });

    it("an ON-DEMAND lane report keeps the HOST recipients and takes no slot", async () => {
      // The other half of the recipients split: a 7d request is a question the
      // operator asked from a terminal, and answering it into the lane's
      // subscriber list would mail his ad-hoc query to other people.
      const lane = await createList(opened.db, "Configured", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "Configured", [player.externalId!], clock.now());
      await configureList(opened.db, "Configured", { digestTo: "lane@example.com" }, clock.now());

      const mailer = new CapturingMailer();
      const result = await runDigest({ ...laneDeps(mailer, lane), spec: "7d" });
      expect(result.action).toBe("sent");
      expect(mailer.sent[0]?.to).toBe("hc@example.com");
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    });

    it("ROUTING RESIDUE: 7d, list+tags, and a game-count send all stay on-demand", async () => {
      // Only the tag-free 1d case moved. Each of these still records NO delivery
      // row, which is the observable that distinguishes the two paths — and the
      // reason ADR 0046 decision 4 gave for them still applies: the slot key has
      // neither a window nor a tag dimension.
      const lane = await createList(opened.db, "L", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "L", [player.externalId!], clock.now());
      await insertPlayerTag(opened.db, { playerId: player.id, namespace: "status", value: "rostered" });

      const mailer = new CapturingMailer();
      for (const overrides of [
        { spec: "7d" as const },
        { tagScope: resolveTagScope("status:rostered") },
        { spec: "last10games" as const },
      ]) {
        const result = await runDigest({ ...laneDeps(mailer, lane), ...overrides });
        expect(result.action, JSON.stringify(overrides)).toBe("sent");
      }
      expect(mailer.sent).toHaveLength(3);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    });

    it("a SOFT-DELETED lane id is refused loudly, before anything is claimed or mailed", async () => {
      const lane = await createList(opened.db, "Doomed", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "Doomed", [player.externalId!], clock.now());
      await deleteList(opened.db, "Doomed", clock.now());

      const mailer = new CapturingMailer();
      // The EXISTING typed error, not a new one — so the CLI, REST, and MCP
      // mappings it already has apply unchanged (ADR 0062, Reviewer must-fix 4).
      await expect(runDigest(laneDeps(mailer, lane))).rejects.toBeInstanceOf(UnknownListError);
      expect(mailer.sent).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
    });

    /**
     * Reviewer must-fix 1: the deleted-lane guarantee had a TOCTOU hole.
     *
     * `runDigest` resolves the lane with an ordinary read and then does real
     * work — orphan recovery, the sleep decision — before it claims. A
     * `lists delete` landing in that gap would let the claim proceed and the
     * mail go out from a stale row. The fix moved liveness INSIDE the claim
     * transaction (a `requirement`, which force cannot replay past), and these
     * cases drive the interleaving deterministically rather than hoping for it.
     *
     * A `GatedMailer` barrier cannot express this one: by the time the mailer is
     * reached the claim is already taken, so the window has closed. The seam
     * that IS the window is `db.transaction` — the claim is the first one this
     * path opens — so the delete is injected immediately before it, through the
     * raw sqlite handle (a genuinely separate statement, like the other process
     * would issue).
     */
    describe("lane deleted between resolution and the claim", () => {
      /**
       * A Db whose Nth `transaction` call is preceded by a soft-delete of
       * `laneName`. Modelled on `faultingDb` in test/factories.ts, and for the
       * same reason: the honest way to prove a race is closed is to actually run
       * the two operations in the order that used to break it.
       */
      function deletingDb(db: Db, sqlite: OpenedDb["sqlite"], laneName: string): Db {
        let transactions = 0;
        return new Proxy(db, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop);
            if (prop !== "transaction") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            const real = (value as (...args: unknown[]) => unknown).bind(target);
            return (...args: unknown[]): unknown => {
              transactions += 1;
              // The claim is the FIRST transaction the claimed digest path opens
              // (every read before it is a plain select), so this lands exactly
              // in the resolve→claim gap.
              if (transactions === 1) {
                sqlite
                  .prepare("update player_lists set deleted_at = ? where name = ?")
                  .run("2026-07-19T00:00:00.000Z", laneName);
              }
              return real(...args);
            };
          },
        }) as Db;
      }

      async function laneWithAPlayer(name: string) {
        const lane = await createList(opened.db, name, clock.now());
        const player = await insertPlayer(opened.db, { fullName: `${name} Player` });
        await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
        await addToList(opened.db, name, [player.externalId!], clock.now());
        return lane;
      }

      it("is refused, mails nothing, and leaves no row stuck `sending`", async () => {
        const lane = await laneWithAPlayer("Racy");
        const mailer = new CapturingMailer();

        const result = await runDigest({
          ...laneDeps(mailer, lane),
          db: deletingDb(opened.db, opened.sqlite, "Racy"),
        });

        expect(result).toMatchObject({ action: "skipped", reason: "lane-deleted" });
        expect(mailer.sent).toHaveLength(0);
        // No row at all: the requirement refuses BEFORE the insert, so there is
        // nothing left `sending` for a later run to recover and re-send from a
        // lane that no longer exists.
        expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
      });

      it("is refused UNDER --force too: force overrides bookkeeping, never lane liveness", async () => {
        // The force-proofing is the non-obvious half. `force` turns a refusing
        // `precondition` into a write-free REPLAY by design — which for this
        // check would mean "mail the deleted lane's digest and record nothing",
        // exactly the send the refusal exists to prevent. So liveness is a
        // `requirement`, which force cannot reach.
        const lane = await laneWithAPlayer("Forced");
        const mailer = new CapturingMailer();

        const result = await runDigest({
          ...laneDeps(mailer, lane),
          db: deletingDb(opened.db, opened.sqlite, "Forced"),
          force: true,
        });

        expect(result).toMatchObject({ action: "skipped", reason: "lane-deleted" });
        expect(mailer.sent).toHaveLength(0);
        expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);
      });
    });

    it("RENAMED LANE: the rendered name comes from the live row, not the caller's stale one", async () => {
      // Reviewer should-consider 3. A surface resolves a name to an id at request
      // time; the job may run much later. If the rendering used `deps.listName`,
      // a rename in that gap would mail a digest titled with a name the lane no
      // longer carries — wrong, and invisible to anyone but the recipient.
      const lane = await createList(opened.db, "Old Name", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Any Player" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
      await addToList(opened.db, "Old Name", [player.externalId!], clock.now());

      // The caller's resolution happened; now the lane is renamed underneath it.
      await renameList(opened.db, "Old Name", "New Name", clock.now());

      const mailer = new CapturingMailer();
      // `listName` is deliberately the STALE name the caller held.
      const result = await runDigest({
        ...laneDeps(mailer, lane),
        listName: "Old Name",
      });
      expect(result.action).toBe("sent");
      expect(mailer.sent[0]?.subject).toBe("ScoreKeeps Baseball (New Name) - Sat, July 18, 2026");
      expect(mailer.sent[0]?.text).toContain("New Name List");
      expect(mailer.sent[0]?.subject).not.toContain("Old Name");
    });

    it("SLEEP: a scoped lane with NOTHING OWED claims nothing; the unscoped run still heartbeats", async () => {
      // ADR 0062 decision 4, affirming ADR 0059's amendment. One liveness signal
      // per host: letting every scheduled lane substitute a heartbeat would
      // multiply offseason mail by the lane count for no added signal.
      //
      // "NOTHING OWED" IS LOAD-BEARING, and this case's `toHaveLength(0)` used
      // to be vacuous about it (#193 self-review, LOW 1): the fixture has no
      // orphan, so the empty delivery table said nothing about whether a scoped
      // Sleep invocation "takes no claim" — the contract prose's old wording.
      // It does not: recovery runs above the sleep branch, and the very next
      // case drives it. What Sleep suppresses is TODAY's digest, and only that.
      clock.set(OFFSEASON);
      const lane = await createList(opened.db, "L", clock.now());
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy",
        level: "mlb",
        milbLevel: null,
      });
      await addToList(opened.db, "L", [player.externalId!], clock.now());

      const mailer = new CapturingMailer();
      const scoped = await runDigest(laneDeps(mailer, lane));
      expect(scoped).toMatchObject({ kind: "digest", action: "skipped", reason: "offseason-sleep" });
      expect(mailer.sent).toHaveLength(0);
      expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

      // The UNSCOPED invocation is unchanged: it still carries the heartbeat.
      const unscoped = await runDigest({ ...laneDeps(mailer, lane), listId: undefined, listName: undefined });
      expect(unscoped).toMatchObject({ kind: "heartbeat", action: "sent" });
      expect(mailer.sent).toHaveLength(1);
    });

    it("SLEEP: a scoped lane that OWES A PRIOR DAY does claim and mail it, then skips today", async () => {
      // The with-orphan half the case above cannot show (#193 self-review, LOW
      // 1). `runDigest` catches up ONE orphaned prior day BEFORE it reads the
      // sleep state, deliberately: ADR 0034's recovery guarantee must not lapse
      // for the length of an offseason, and a digest that failed on the season's
      // LAST day is only ever recoverable while asleep. So "a scoped Sleep
      // invocation takes no claim" was simply false, and the prose said it in
      // four places.
      clock.set(OFFSEASON);
      const lane = await createList(opened.db, "L", clock.now());
      const player = await insertPlayer(opened.db, {
        fullName: "Offseason Guy",
        level: "mlb",
        milbLevel: null,
      });
      // The orphaned slot covers 2026-10-01; its 1d window is the day before.
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-09-30" });
      await addToList(opened.db, "L", [player.externalId!], clock.now());
      await insertDelivery(opened.db, {
        dateCovered: "2026-10-01",
        listId: lane.id,
        status: "failed",
        sentAt: null,
        createdAt: "2026-10-01T10:00:00.000Z",
      });

      const mailer = new CapturingMailer();
      const scoped = await runDigest(laneDeps(mailer, lane));

      // TODAY is still skipped — Sleep suppresses the regular daily artifact...
      expect(scoped).toMatchObject({ kind: "digest", action: "skipped", reason: "offseason-sleep" });
      // ...and the ORPHAN was claimed, mailed, and settled on its own date.
      expect(mailer.sent).toHaveLength(1);
      const rows = await opened.db.select().from(digestDeliveries);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dateCovered: "2026-10-01",
        listId: lane.id,
        status: "sent",
      });
    });

    it("ORPHAN RECOVERY runs on the INVOKED lane, and uses that lane's recipients", async () => {
      const lane = await createList(opened.db, "L", clock.now());
      const other = await createList(opened.db, "Other", clock.now());
      const player = await insertPlayer(opened.db, { fullName: "Recovered Guy" });
      await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-17" });
      await addToList(opened.db, "L", [player.externalId!], clock.now());
      await configureList(opened.db, "L", { digestTo: "lane@example.com" }, clock.now());

      // BOTH lanes owe a prior day. Only the invoked one may be caught up:
      // recovery re-claims the date it finds, so a cross-lane answer would have
      // lane L re-send Other's missing digest under its own slot.
      await insertDelivery(opened.db, { dateCovered: "2026-07-18", listId: lane.id, status: "failed" });
      await insertDelivery(opened.db, { dateCovered: "2026-07-18", listId: other.id, status: "failed" });

      const mailer = new CapturingMailer();
      expect((await runDigest(laneDeps(mailer, lane))).action).toBe("sent");

      // Two emails: the recovered Jul 18 day and today's Jul 19 — both lane L's,
      // both to lane L's own recipients.
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent.map((m) => m.to)).toEqual(["lane@example.com", "lane@example.com"]);
      const rows = await opened.db.select().from(digestDeliveries);
      // Other's failed row is untouched — it is not this lane's to recover.
      expect(rows.find((r) => r.listId === other.id)).toMatchObject({ status: "failed" });
      expect(rows.filter((r) => r.listId === lane.id).map((r) => r.status).sort()).toEqual([
        "sent",
        "sent",
      ]);
    });

    it("BARE `sk digest` now excludes an active player on NO lane (cross-ref #202)", async () => {
      // The default-lane narrowing, made explicit. On a MIGRATED host this
      // changes nothing — drizzle/0012 enrolled every active Player in the
      // seeded default lane — but a Player added to no lane afterwards is now
      // neither refreshed (#192) nor digested. Out of scope here; recorded so
      // the behavior is a decision rather than a discovery.
      const enrolled = await insertPlayer(opened.db, { fullName: "Anyname Enrolledrow" });
      await insertStatLine(opened.db, { playerId: enrolled.id, gameDate: "2026-07-18" });
      await enrollInDefaultLane(opened.db, [enrolled]);

      const orphan = await insertPlayer(opened.db, { fullName: "Anyname Orphanedrow" });
      await insertStatLine(opened.db, { playerId: orphan.id, gameDate: "2026-07-18" });

      const mailer = new CapturingMailer();
      const result = await runDigest({
        db: opened.db,
        mailer,
        now: clock.now,
        tz: TEST_TZ,
        to: "hc@example.com",
        from: "bryce@example.com",
        spec: "1d",
      });
      expect(result).toMatchObject({ action: "sent", playerCount: 1 });
      const body = `${mailer.sent[0]?.html}\n${mailer.sent[0]?.text}`;
      // The renderer abbreviates the FIRST name, so assert on the surnames —
      // which are distinct here precisely so a pass cannot be borrowed from the
      // other player's row.
      expect(body).toContain("Enrolledrow");
      expect(body).not.toContain("Orphanedrow");
    });
  });
});
