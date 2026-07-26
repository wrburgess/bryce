import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { listMembers, playerTags, players, statLines } from "../src/db/schema.js";
import {
  MAX_BACKUP_BYTES,
  PlayerBackupParseError,
  createPlayerListBackup,
  parsePlayerListBackup,
  writePlayerListBackupFile,
} from "../src/backup/player-list.js";
import {
  AmbiguousImportTargetError,
  SplitIdentityConflictError,
  UnresolvedBackupMemberError,
  restorePlayerListBackup,
} from "../src/watchlist/service.js";
import {
  addToList,
  createList,
  deleteList,
  listLists,
  listMembersOf,
} from "../src/lists/service.js";
import { makeBackupEntry, makeBackupEnvelope, makeTempDir, type BackupEntryOverrides } from "./backup-helpers.js";
import {
  InjectedFault,
  fakeClock,
  faultingDb,
  insertPlayer,
  insertPlayerTag,
  insertStatLine,
  testDb,
} from "./factories.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

/** Parse an envelope of raw player rows into typed, restorable entries. */
function parse(rows: Array<Record<string, unknown>>): ReturnType<typeof parsePlayerListBackup>["players"] {
  return parsePlayerListBackup(JSON.stringify(makeBackupEnvelope(rows))).players;
}

describe("createPlayerListBackup", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("serializes every Player row (active and inactive) with all fields and a version", async () => {
    await insertPlayer(opened.db, { externalId: 691185, fullName: "Maximo Acosta", active: true });
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      ncaaSourceState: "legacy_html",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "College Guy",
      schoolName: "LSU",
      active: false,
    });

    const backup = await createPlayerListBackup(opened.db, fakeClock("2026-07-22T12:00:00Z").now);
    expect(backup.version).toBe(4);
    expect(backup.exportedAt).toBe("2026-07-22T12:00:00.000Z");
    expect(backup.players).toHaveLength(2);
    expect(backup.players[1]).toMatchObject({
      externalId: null,
      ncaaPlayerSeq: 2649785,
      ncaaSourceState: "legacy_html",
      level: "ncaa",
      schoolName: "LSU",
      active: false,
    });
    // The envelope round-trips through the strict parser.
    expect(() => parsePlayerListBackup(JSON.stringify(backup))).not.toThrow();
  });
});

describe("restorePlayerListBackup: import semantics", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("fresh import: assigns new local ids but preserves natural id, notes, and active", async () => {
    const rows = parse([
      makeBackupEntry({ id: 5, externalId: 691185, notes: "watch closely", active: false }),
    ]);
    const summary = restorePlayerListBackup(opened.db, rows, NOW);
    expect(summary).toEqual({ inserted: 1, updated: 0, total: 1 });

    const stored = (await opened.db.select().from(players))[0];
    expect(stored?.id).toBe(1); // fresh autoincrement, NOT the source-local 5
    expect(stored?.externalId).toBe(691185);
    expect(stored?.notes).toBe("watch closely");
    expect(stored?.active).toBe(false);
  });

  it("existing import: upsert keeps players.id so Stat Line FKs stay intact", async () => {
    const existing = await insertPlayer(opened.db, { externalId: 691185, fullName: "Old Name" });
    await insertStatLine(opened.db, { playerId: existing.id, gameId: 1 });

    // Back up, mutate the backup's attributes, and restore into the SAME db.
    const backup = await createPlayerListBackup(opened.db, () => NOW);
    backup.players[0]!.fullName = "New Name";
    backup.players[0]!.teamName = "Traded Team";
    const summary = restorePlayerListBackup(opened.db, backup.players, NOW);
    expect(summary).toEqual({ inserted: 0, updated: 1, total: 1 });

    const rows = await opened.db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existing.id); // id unchanged
    expect(rows[0]?.fullName).toBe("New Name");
    expect(rows[0]?.teamName).toBe("Traded Team");
    // The Stat Line still points at the same, unchanged player id.
    const lines = await opened.db.select().from(statLines).where(eq(statLines.playerId, existing.id));
    expect(lines).toHaveLength(1);
  });

  it("authority matrix: a new row takes every field from the backup; timestamps per the rules", async () => {
    const rows = parse([
      makeBackupEntry({
        id: 99,
        externalId: 700001,
        ncaaPlayerSeq: null,
        fullName: "Full Authority",
        level: "milb",
        milbLevel: "Double-A",
        teamName: "Somewhere Sod Poodles",
        position: "3B",
        schoolName: null,
        active: false,
        notes: "authoritative note",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-06-06T00:00:00.000Z",
      }),
    ]);
    restorePlayerListBackup(opened.db, rows, NOW);
    const stored = (await opened.db.select().from(players))[0];
    expect(stored).toMatchObject({
      externalId: 700001,
      ncaaPlayerSeq: null,
      fullName: "Full Authority",
      level: "milb",
      milbLevel: "Double-A",
      teamName: "Somewhere Sod Poodles",
      position: "3B",
      schoolName: null,
      active: false,
      notes: "authoritative note",
      createdAt: "2025-01-01T00:00:00.000Z", // backup's value on insert
      updatedAt: "2026-07-22T12:00:00.000Z", // always now
    });
  });

  it("authority matrix: an update preserves createdAt, stamps updatedAt=now, and overwrites fields", async () => {
    await insertPlayer(opened.db, {
      externalId: 700002,
      fullName: "Before",
      level: "milb",
      milbLevel: "High-A",
      notes: "old note",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const rows = parse([
      makeBackupEntry({
        externalId: 700002,
        fullName: "After",
        level: "mlb",
        milbLevel: null,
        notes: "new note",
        active: false,
        createdAt: "2099-01-01T00:00:00.000Z", // must be IGNORED on update
      }),
    ]);
    restorePlayerListBackup(opened.db, rows, NOW);
    const stored = (await opened.db.select().from(players))[0];
    expect(stored).toMatchObject({
      fullName: "After",
      level: "mlb",
      milbLevel: null,
      notes: "new note",
      active: false,
      createdAt: "2024-01-01T00:00:00.000Z", // existing row's value preserved
      updatedAt: "2026-07-22T12:00:00.000Z",
    });
  });

  it("professional backup updates a matching professional row without NCAA state", async () => {
    const existing = await insertPlayer(opened.db, {
      externalId: 800001,
      ncaaPlayerSeq: null,
      level: "mlb",
      milbLevel: null,
      teamName: null,
      fullName: "Prospect",
      schoolName: null,
    });
    const rows = parse([
      makeBackupEntry({
        externalId: 800001,
        ncaaPlayerSeq: null,
        level: "mlb",
        milbLevel: null,
        teamName: "The Show",
        schoolName: null,
        fullName: "Prospect",
      }),
    ]);
    const summary = restorePlayerListBackup(opened.db, rows, NOW);
    expect(summary).toEqual({ inserted: 0, updated: 1, total: 1 });

    const stored = await opened.db.select().from(players);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(existing.id); // one row, kept
    expect(stored[0]?.externalId).toBe(800001); // gained
    expect(stored[0]?.ncaaPlayerSeq).toBeNull(); // retired
    expect(stored[0]?.level).toBe("mlb");
  });

  it("canonicalizes fullName and schoolName (ADR 0041): NFD -> NFC, whitespace collapsed", async () => {
    const nfd = "José   Ramírez "; // decomposed accents + messy whitespace
    const nfdSchool = " Universidad  dé  Prueba ";
    const rows = parse([
      makeBackupEntry({
        externalId: null,
        ncaaPlayerSeq: 3000001,
        level: "ncaa",
        milbLevel: null,
        teamName: null,
        fullName: nfd,
        schoolName: nfdSchool,
      }),
    ]);
    restorePlayerListBackup(opened.db, rows, NOW);
    const stored = (await opened.db.select().from(players))[0];
    expect(stored?.fullName).toBe("José Ramírez");
    expect(stored?.fullName).toBe(stored!.fullName.normalize("NFC"));
    expect(stored?.schoolName).toBe("Universidad dé Prueba");
  });

  it("round-trips a v4 Highlightly member by its current NCAA identity", async () => {
    const ncaa = await insertPlayer(opened.db, {
      externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600002,
      highlightlyTeamId: 10, ncaaSourceState: "highlightly_active", level: "ncaa",
      milbLevel: null, fullName: "Highlightly Guy", schoolName: "State",
    });
    const list = await createList(opened.db, "NCAA", NOW);
    await opened.db.insert(listMembers).values({ listId: list.id, playerId: ncaa.id, createdAt: NOW.toISOString() });
    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect(backup.members).toContainEqual({ list: "NCAA", externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600002 });
    const target = testDb();
    try {
      const parsed = parsePlayerListBackup(JSON.stringify(backup));
      restorePlayerListBackup(target.db, parsed.players, NOW, { lists: parsed.lists, members: parsed.members });
      const restored = (await target.db.select().from(players).where(eq(players.highlightlyPlayerId, 600002)))[0];
      expect(restored).toBeDefined();
      expect((await target.db.select().from(listMembers).where(eq(listMembers.playerId, restored!.id)))).toHaveLength(1);
    } finally { target.close(); }
  });

  it("restores members through each current-identity selector", async () => {
    const pro = await insertPlayer(opened.db, { externalId: 600100, fullName: "Pro" });
    const legacy = await insertPlayer(opened.db, {
      externalId: null, ncaaPlayerSeq: 600101, ncaaSourceState: "legacy_html", level: "ncaa",
      milbLevel: null, fullName: "Legacy", schoolName: "State",
    });
    const highlightly = await insertPlayer(opened.db, {
      externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600102, highlightlyTeamId: 10,
      ncaaSourceState: "highlightly_active", level: "ncaa", milbLevel: null, fullName: "Highlightly", schoolName: "State",
    });
    for (const [name, player] of [["Pro list", pro], ["Legacy list", legacy], ["Highlightly list", highlightly]] as const) {
      const list = await createList(opened.db, name, NOW);
      await opened.db.insert(listMembers).values({ listId: list.id, playerId: player.id, createdAt: NOW.toISOString() });
    }
    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect(backup.members).toEqual(expect.arrayContaining([
      { list: "Pro list", externalId: 600100, ncaaPlayerSeq: null, highlightlyPlayerId: null },
      { list: "Legacy list", externalId: null, ncaaPlayerSeq: 600101, highlightlyPlayerId: null },
      { list: "Highlightly list", externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600102 },
    ]));
    const target = testDb();
    try {
      const parsed = parsePlayerListBackup(JSON.stringify(backup));
      restorePlayerListBackup(target.db, parsed.players, NOW, { lists: parsed.lists, members: parsed.members });
      expect(await target.db.select().from(listMembers)).toHaveLength(3);
    } finally { target.close(); }
  });

  it("rolls back when a pending backup identity splits across two live NCAA rows", async () => {
    await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 600010, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy", schoolName: "State" });
    await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600011, highlightlyTeamId: 10, ncaaSourceState: "highlightly_active", level: "ncaa", milbLevel: null, fullName: "Active", schoolName: "State" });
    const rows = parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry({ externalId: null, ncaaPlayerSeq: 600010, highlightlyPlayerId: 600011, highlightlyTeamId: 10, ncaaSourceState: "highlightly_pending", level: "ncaa", milbLevel: null, fullName: "Would Split", schoolName: "State" })], { version: 4 }))).players;
    expect(() => restorePlayerListBackup(opened.db, rows, NOW)).toThrow(SplitIdentityConflictError);
    expect((await opened.db.select().from(players).where(eq(players.ncaaPlayerSeq, 600010)))[0]?.fullName).toBe("Legacy");
  });

  it("rolls back when two payload rows resolve to one pending cutover row", async () => {
    const pending = await insertPlayer(opened.db, { externalId: null, ncaaPlayerSeq: 600020, highlightlyPlayerId: 600021, highlightlyTeamId: 10, ncaaSourceState: "highlightly_pending", level: "ncaa", milbLevel: null, fullName: "Pending", schoolName: "State" });
    const rows = parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([
      makeBackupEntry({ externalId: null, ncaaPlayerSeq: 600020, ncaaSourceState: "legacy_html", level: "ncaa", milbLevel: null, fullName: "Legacy Version", schoolName: "State" }),
      makeBackupEntry({ externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 600021, highlightlyTeamId: 10, ncaaSourceState: "highlightly_active", level: "ncaa", milbLevel: null, fullName: "Highlightly Version", schoolName: "State" }),
    ], { version: 4 }))).players;
    expect(() => restorePlayerListBackup(opened.db, rows, NOW)).toThrow(AmbiguousImportTargetError);
    expect((await opened.db.select().from(players).where(eq(players.id, pending.id)))[0]?.fullName).toBe("Pending");
  });
});

describe("writePlayerListBackupFile", () => {
  it("creates the destination parent directory (finding #7)", () => {
    const dir = makeTempDir();
    try {
      const target = join(dir.path, "nested", "deeper", "players.json");
      writePlayerListBackupFile(target, '{"version":1,"players":[]}');
      expect(readFileSync(target, "utf8")).toBe('{"version":1,"players":[]}');
    } finally {
      dir.cleanup();
    }
  });
});

describe("parsePlayerListBackup: strict validation", () => {
  it("rejects an absent or wrong version (v1-v4 are accepted)", () => {
    expect(() =>
      parsePlayerListBackup(JSON.stringify({ players: [makeBackupEntry()] })),
    ).toThrow(PlayerBackupParseError);
    // v5 is not a known version.
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 5 }))),
    ).toThrow(PlayerBackupParseError);
    // v1-v3 remain compatible and v4 is the current envelope.
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 1 }))),
    ).not.toThrow();
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 2 }))),
    ).not.toThrow();
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 4 }))),
    ).not.toThrow();
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 3 }))),
    ).not.toThrow();
  });

  it("rejects unknown keys (strict envelope and rows)", () => {
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify(makeBackupEnvelope([{ ...makeBackupEntry(), surprise: true }])),
      ),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects a row with neither identity, and an NCAA row carrying externalId", () => {
    expect(() =>
      parse([makeBackupEntry({ externalId: null, ncaaPlayerSeq: null })]),
    ).toThrow(PlayerBackupParseError);
    expect(() =>
      parse([makeBackupEntry({ level: "ncaa", externalId: 1, ncaaPlayerSeq: 2, milbLevel: null })]),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects an active Highlightly NCAA row without its Highlightly identity before restore", () => {
    expect(() =>
      parse([
        makeBackupEntry({
          externalId: null,
          ncaaPlayerSeq: 2649785,
          highlightlyPlayerId: null,
          ncaaSourceState: "highlightly_active",
          level: "ncaa",
          milbLevel: null,
        }),
      ]),
    ).toThrow(PlayerBackupParseError);
  });

  it("keeps v1-v3 current-identity imports compatible but rejects every combined pro/NCAA shape", () => {
    for (const version of [1, 2, 3]) {
      const legacy = makeBackupEntry({ externalId: null, ncaaPlayerSeq: 2649785, level: "ncaa", milbLevel: null, teamName: null, schoolName: "LSU" });
      if (version === 3) legacy.ncaaSourceState = "legacy_html";
      expect(() => parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([
        makeBackupEntry({ externalId: 691185, ncaaPlayerSeq: null, level: "milb" }),
        legacy,
      ], { version })))).not.toThrow();
      expect(() => parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([
        makeBackupEntry({ externalId: 691185, ncaaPlayerSeq: 2649785, level: "milb" }),
      ], { version })))).toThrow(PlayerBackupParseError);
    }
    const combinedIdentityExtras: BackupEntryOverrides[] = [
      { highlightlyPlayerId: 501 },
      { highlightlyTeamId: 10 },
      { ncaaSourceState: "highlightly_active" },
      { highlightlyPlayerId: 501, highlightlyTeamId: 10, ncaaSourceState: "highlightly_active" },
    ];
    for (const extra of combinedIdentityExtras) {
      expect(() => parse([makeBackupEntry({ externalId: 691185, level: "mlb", ...extra })])).toThrow(PlayerBackupParseError);
    }
  });

  it("accepts legacy v1-v3 membership shapes but reserves Highlightly members for v4", () => {
    const legacyMember = { list: "Prospects", externalId: 691185, ncaaPlayerSeq: null };
    for (const version of [2, 3]) {
      expect(() => parsePlayerListBackup(JSON.stringify({ ...makeBackupEnvelope([makeBackupEntry()], { version }), lists: [{ name: "Prospects" }], members: [legacyMember] }))).not.toThrow();
    }
    const highlightlyMember = { list: "NCAA", externalId: null, ncaaPlayerSeq: null, highlightlyPlayerId: 501 };
    expect(() => parsePlayerListBackup(JSON.stringify({ ...makeBackupEnvelope([makeBackupEntry()], { version: 3 }), lists: [{ name: "NCAA" }], members: [highlightlyMember] }))).toThrow(PlayerBackupParseError);
    expect(() => parsePlayerListBackup(JSON.stringify({ ...makeBackupEnvelope([makeBackupEntry()], { version: 4 }), lists: [{ name: "NCAA" }], members: [highlightlyMember] }))).not.toThrow();
  });

  it("rejects a non-positive natural id", () => {
    expect(() => parse([makeBackupEntry({ externalId: 0 })])).toThrow(PlayerBackupParseError);
    expect(() => parse([makeBackupEntry({ externalId: -5 })])).toThrow(PlayerBackupParseError);
  });

  it("rejects a name that is only whitespace — canonicalizes to empty (finding #8)", () => {
    // fullName "   " passes min(1) but canonicalizeName trims it to "".
    expect(() => parse([makeBackupEntry({ fullName: "   " })])).toThrow(PlayerBackupParseError);
    // schoolName too, on an NCAA row.
    expect(() =>
      parse([
        makeBackupEntry({
          externalId: null,
          ncaaPlayerSeq: 700100,
          level: "ncaa",
          milbLevel: null,
          teamName: null,
          fullName: "Real Name",
          schoolName: "   ",
        }),
      ]),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects a v2 list name containing a control character (mirrors the live surfaces)", () => {
    // A crafted backup could otherwise restore a list name with a newline/tab,
    // reintroducing the forge-extra-lines issue the live path forbids.
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry()], { version: 2 }),
          lists: [{ name: "a\nb" }],
        }),
      ),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects a v2 member list field containing a control character", () => {
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry()], { version: 2 }),
          members: [{ list: "a\tb", externalId: 691185, ncaaPlayerSeq: null }],
        }),
      ),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects a version 1 payload that carries lists or members (fail-closed on version)", () => {
    // A v1 payload claiming named-list data is a version-field lie — list/member
    // data requires version 2. Both a non-empty `lists` and a non-empty `members`
    // must be rejected.
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry()], { version: 1 }),
          lists: [{ name: "Prospects" }],
        }),
      ),
    ).toThrow(PlayerBackupParseError);
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry()], { version: 1 }),
          members: [{ list: "Prospects", externalId: 691185, ncaaPlayerSeq: null }],
        }),
      ),
    ).toThrow(PlayerBackupParseError);
    // A v1 payload with an EMPTY lists/members array is still fine (players-only).
    expect(() =>
      parsePlayerListBackup(
        JSON.stringify({
          ...makeBackupEnvelope([makeBackupEntry()], { version: 1 }),
          lists: [],
          members: [],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate natural ids within the payload", () => {
    expect(() =>
      parse([makeBackupEntry({ externalId: 42 }), makeBackupEntry({ externalId: 42 })]),
    ).toThrow(PlayerBackupParseError);
  });

  it("rejects a non-ISO timestamp and invalid JSON", () => {
    expect(() => parse([makeBackupEntry({ createdAt: "yesterday" })])).toThrow(PlayerBackupParseError);
    expect(() => parsePlayerListBackup("{not json")).toThrow(PlayerBackupParseError);
  });

  it("rejects a payload over the size ceiling before parsing", () => {
    const huge = "a".repeat(MAX_BACKUP_BYTES + 1);
    expect(() => parsePlayerListBackup(huge)).toThrow(/size ceiling/);
  });
});

describe("named lists in the backup (v2, #70 / ADR 0046)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("emits version 2 with live lists and memberships, and round-trips into an empty db", async () => {
    const mlb = await insertPlayer(opened.db, { externalId: 691185, fullName: "Mlb Guy" });
    const ncaa = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 555,
      ncaaSourceState: "legacy_html",
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "Ncaa Guy",
      schoolName: "LSU",
    });
    const list = await createList(opened.db, "Prospects", NOW);
    await addToList(opened.db, "Prospects", [mlb.externalId!], NOW);
    await opened.db.insert(listMembers).values({ listId: list.id, playerId: ncaa.id, createdAt: NOW.toISOString() });

    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect(backup.version).toBe(4);
    expect(backup.lists).toEqual([{ name: "Prospects", createdAt: expect.any(String), updatedAt: expect.any(String) }]);
    expect(backup.members).toHaveLength(2);
    // The envelope round-trips through the strict parser.
    expect(() => parsePlayerListBackup(JSON.stringify(backup))).not.toThrow();

    // Restore into a FRESH db recreates players, the list, and both memberships.
    const dest = testDb();
    try {
      const parsed = parsePlayerListBackup(JSON.stringify(backup));
      restorePlayerListBackup(dest.db, parsed.players, NOW, {
        lists: parsed.lists,
        members: parsed.members,
      });
      const lists = await listLists(dest.db);
      expect(lists.map((l) => l.name)).toEqual(["Prospects"]);
      const members = await listMembersOf(dest.db, "Prospects");
      expect(members.map((m) => m.fullName).sort()).toEqual(["Mlb Guy", "Ncaa Guy"]);
      expect(ncaa.ncaaPlayerSeq).toBe(555);
    } finally {
      dest.close();
    }
  });

  it("excludes a soft-deleted list from the backup", async () => {
    const p = await insertPlayer(opened.db, { externalId: 700 });
    await createList(opened.db, "Live", NOW);
    await createList(opened.db, "Gone", NOW);
    await addToList(opened.db, "Gone", [p.externalId!], NOW);
    await deleteList(opened.db, "Gone", NOW);

    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect(backup.lists?.map((l) => l.name)).toEqual(["Live"]);
    // The deleted list's membership is not carried either.
    expect(backup.members).toEqual([]);
  });

  it("still restores a v1 payload (no lists/members) with no lists created", async () => {
    const parsed = parsePlayerListBackup(
      JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 1 })),
    );
    const summary = restorePlayerListBackup(opened.db, parsed.players, NOW, {
      lists: parsed.lists,
      members: parsed.members,
    });
    expect(summary.inserted).toBe(1);
    expect(await listLists(opened.db)).toEqual([]);
  });

  it("aborts the whole import when a membership's player natural id does not resolve", async () => {
    const rows = parse([makeBackupEntry({ externalId: 691185 })]);
    expect(() =>
      restorePlayerListBackup(opened.db, rows, NOW, {
        lists: [{ name: "Prospects" }],
        // References a player NOT in the payload.
        members: [{ list: "Prospects", externalId: 999999, ncaaPlayerSeq: null }],
      }),
    ).toThrow(UnresolvedBackupMemberError);

    // The transaction rolled back entirely: no players, no lists persisted.
    expect(await opened.db.select().from(players)).toHaveLength(0);
    expect(await listLists(opened.db)).toEqual([]);
  });

  it("restore reuses a pre-existing live list of the same name and merges memberships (idempotent, no rollback)", async () => {
    // A live list "L" already holds its own member (a DIFFERENT player).
    const existing = await insertPlayer(opened.db, { externalId: 100, fullName: "Existing Member" });
    await createList(opened.db, "L", NOW);
    await addToList(opened.db, "L", [existing.externalId!], NOW);

    // The v2 backup carries a list ALSO named "L" and a backed-up member (player 200).
    const rows = parse([makeBackupEntry({ externalId: 200, fullName: "Backup Member" })]);
    const summary = restorePlayerListBackup(opened.db, rows, NOW, {
      lists: [{ name: "L" }],
      members: [{ list: "L", externalId: 200, ncaaPlayerSeq: null }],
    });

    // If list recreation still INSERTed, the name would collide on the partial
    // unique index and roll the WHOLE restore back — the player would be lost.
    // Instead the player restore commits and the list is reused.
    expect(summary).toEqual({ inserted: 1, updated: 0, total: 1 });
    const lists = await listLists(opened.db);
    expect(lists.map((l) => l.name)).toEqual(["L"]); // reused, not duplicated
    // Both the original and the backed-up member are present (memberships merged).
    const members = await listMembersOf(opened.db, "L");
    expect(members.map((m) => m.externalId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([100, 200]);
  });
});

describe("manual-tag backup round-trip (Phase A of #29)", () => {
  let opened: OpenedDb;

  beforeEach(() => {
    opened = testDb();
  });

  afterEach(() => {
    opened.close();
  });

  it("export carries ONLY manual tags, never derived ones", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayerTag(opened.db, { playerId: player.id, namespace: "status", value: "rostered", source: "manual" });
    await insertPlayerTag(opened.db, { playerId: player.id, namespace: "level", value: "aaa", source: "derived" });

    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect(backup.players[0]?.tags).toEqual([{ namespace: "status", value: "rostered" }]);
  });

  it("ALWAYS emits tags (an empty array for a tagless player), self-describing", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const backup = await createPlayerListBackup(opened.db, () => NOW);
    // An authoritative empty set — distinct from a legacy v1 backup that omits it.
    expect(backup.players[0]?.tags).toEqual([]);
    expect(() => parsePlayerListBackup(JSON.stringify(backup))).not.toThrow();
  });

  it("restore rebuilds derived tags AND re-applies the entry's manual tags", () => {
    const row = {
      ...makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" }),
      tags: [{ namespace: "status", value: "rostered" }],
    };
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    const restored = opened.db.select().from(players).where(eq(players.externalId, 691185)).all()[0];
    const tags = opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, restored?.id ?? -1))
      .all();
    const keys = new Set(tags.map((t) => `${t.namespace}:${t.value}:${t.source}`));
    // Manual tag round-tripped...
    expect(keys.has("status:rostered:manual")).toBe(true);
    // ...and derived tags rebuilt from the restored identity columns.
    expect(keys.has("level:aaa:derived")).toBe(true);
    expect(keys.has("pos:ss:derived")).toBe(true);
    expect(keys.has("prospect:prospect:derived")).toBe(true);
  });

  it("a v1 entry with no tags field restores derived tags and no manual tags", () => {
    const row = makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" });
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    const restored = opened.db.select().from(players).where(eq(players.externalId, 691185)).all()[0];
    const tags = opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, restored?.id ?? -1))
      .all();
    expect(tags.every((t) => t.source === "derived")).toBe(true);
    expect(tags.some((t) => t.namespace === "level" && t.value === "aaa")).toBe(true);
  });

  /** Manual tags on the pre-existing row before a restore matches it. */
  const manualOf = (playerId: number): string[] =>
    opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, playerId))
      .all()
      .filter((t) => t.source === "manual")
      .map((t) => `${t.namespace}:${t.value}`);

  it("reconciles manual tags to the backup's authoritative set (rostered replaces scouted)", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayerTag(opened.db, { playerId: player.id, namespace: "status", value: "scouted", source: "manual" });

    const row = {
      ...makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" }),
      tags: [{ namespace: "status", value: "rostered" }],
    };
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    // The current scouted tag is gone; ONLY the authoritative rostered remains.
    expect(manualOf(player.id)).toEqual(["status:rostered"]);
  });

  it("an authoritative empty tags array clears the player's manual tags (derived untouched)", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayerTag(opened.db, { playerId: player.id, namespace: "status", value: "rostered", source: "manual" });

    const row = {
      ...makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" }),
      tags: [] as Array<{ namespace: string; value: string }>,
    };
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    expect(manualOf(player.id)).toEqual([]);
    // Reconcile is manual-only: derived tags are still (re)built.
    const derived = opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, player.id))
      .all()
      .filter((t) => t.source === "derived");
    expect(derived.some((t) => t.namespace === "level" && t.value === "aaa")).toBe(true);
  });

  it("a legacy v1 entry (no tags field) leaves existing manual tags untouched", async () => {
    const player = await insertPlayer(opened.db, { externalId: 691185 });
    await insertPlayerTag(opened.db, { playerId: player.id, namespace: "status", value: "scouted", source: "manual" });

    // makeBackupEntry omits `tags` entirely — a pre-#30 payload.
    const row = makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" });
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    // Absent tags means "leave manual tags untouched" — scouted survives.
    expect(manualOf(player.id)).toEqual(["status:scouted"]);
  });

  it("skips a hand-edited derived-namespace (or unknown) tag rather than writing a bogus manual row", () => {
    const row = {
      ...makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" }),
      tags: [
        { namespace: "level", value: "aa" }, // derived namespace — must be skipped
        { namespace: "bogus", value: "x" }, // unknown namespace — must be skipped
        { namespace: "status", value: "scouted" }, // the one valid manual tag
      ],
    };
    restorePlayerListBackup(opened.db, parse([row]), NOW);

    const restored = opened.db.select().from(players).where(eq(players.externalId, 691185)).all()[0];
    const manual = opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, restored?.id ?? -1))
      .all()
      .filter((t) => t.source === "manual");
    // Only the valid status tag was written as a manual row; the bogus ones were dropped.
    expect(manual.map((t) => `${t.namespace}:${t.value}`)).toEqual(["status:scouted"]);
    // The derived level tag is the RECONCILED one (aaa), not the injected 'aa'.
    const level = opened.db
      .select()
      .from(playerTags)
      .where(eq(playerTags.playerId, restored?.id ?? -1))
      .all()
      .filter((t) => t.namespace === "level");
    expect(level.map((t) => `${t.value}:${t.source}`)).toEqual(["aaa:derived"]);
  });

  it("rolls the tag writes back too when the restore transaction fails before COMMIT", () => {
    const row = {
      ...makeBackupEntry({ externalId: 691185, level: "milb", milbLevel: "Triple-A", position: "SS" }),
      tags: [{ namespace: "status", value: "rostered" }],
    };
    // A fault injected AFTER the whole restore body runs (player imported, tags
    // derived + manual tag applied) but BEFORE COMMIT — proving the tag writes
    // share the import transaction and roll back with it (atomicity).
    const faulting = faultingDb(opened.db, { failAt: "in-settle", passThrough: 0 });
    expect(() => restorePlayerListBackup(faulting, parse([row]), NOW)).toThrow(InjectedFault);
    expect(opened.db.select().from(players).all()).toHaveLength(0);
    expect(opened.db.select().from(playerTags).all()).toHaveLength(0);
  });
});
