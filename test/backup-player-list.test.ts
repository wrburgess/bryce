import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { playerTags, players, statLines } from "../src/db/schema.js";
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
  restorePlayerListBackup,
} from "../src/watchlist/service.js";
import { makeBackupEntry, makeBackupEnvelope, makeTempDir } from "./backup-helpers.js";
import { fakeClock, insertPlayer, insertPlayerTag, insertStatLine, testDb } from "./factories.js";

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
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "College Guy",
      schoolName: "LSU",
      active: false,
    });

    const backup = await createPlayerListBackup(opened.db, fakeClock("2026-07-22T12:00:00Z").now);
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBe("2026-07-22T12:00:00.000Z");
    expect(backup.players).toHaveLength(2);
    expect(backup.players[1]).toMatchObject({
      externalId: null,
      ncaaPlayerSeq: 2649785,
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

  it("promotion: a backup with BOTH ids matches the NCAA row and gains external_id without losing the seq", async () => {
    const existing = await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 2649785,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "Prospect",
      schoolName: "LSU",
    });
    const rows = parse([
      makeBackupEntry({
        externalId: 800001,
        ncaaPlayerSeq: 2649785,
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
    expect(stored[0]?.ncaaPlayerSeq).toBe(2649785); // kept
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

  it("is transactional: a later split-identity conflict rolls the WHOLE import back", async () => {
    // Two existing rows whose identities a later backup row straddles.
    await insertPlayer(opened.db, { externalId: 500001, fullName: "MLB Row" });
    await insertPlayer(opened.db, {
      externalId: null,
      ncaaPlayerSeq: 600001,
      level: "ncaa",
      milbLevel: null,
      teamName: null,
      fullName: "NCAA Row",
      schoolName: "State",
    });

    const rows = parse([
      makeBackupEntry({ externalId: 700003, fullName: "Would Insert First" }),
      // externalId -> MLB Row, ncaaPlayerSeq -> NCAA Row: two different rows.
      makeBackupEntry({ externalId: 500001, ncaaPlayerSeq: 600001, level: "mlb", milbLevel: null }),
    ]);

    expect(() => restorePlayerListBackup(opened.db, rows, NOW)).toThrow(SplitIdentityConflictError);
    // The earlier row was NOT persisted — the whole transaction rolled back.
    expect(await opened.db.select().from(players).where(eq(players.externalId, 700003))).toHaveLength(0);
  });

  it("rejects two payload rows that resolve to ONE existing player, writing nothing (finding #3)", async () => {
    // An existing row combines external_id A and ncaa X (a promoted player).
    const combined = await insertPlayer(opened.db, {
      externalId: 500002,
      ncaaPlayerSeq: 600002,
      level: "mlb",
      milbLevel: null,
      fullName: "Combined Row",
    });
    const before = await opened.db.select().from(players);

    // A-only resolves to `combined` (by external_id); B+X ALSO resolves to it (by
    // ncaa). The second update would silently overwrite the first and drop a
    // backed-up player — reject the whole import.
    const rows = parse([
      makeBackupEntry({ externalId: 500002, fullName: "First Target", level: "mlb", milbLevel: null }),
      makeBackupEntry({
        externalId: 999001,
        ncaaPlayerSeq: 600002,
        fullName: "Second Target",
        level: "mlb",
        milbLevel: null,
      }),
    ]);

    expect(() => restorePlayerListBackup(opened.db, rows, NOW)).toThrow(AmbiguousImportTargetError);
    // Nothing was written — the combined row is byte-for-byte unchanged.
    const after = await opened.db.select().from(players);
    expect(after).toEqual(before);
    expect(after.find((p) => p.id === combined.id)?.fullName).toBe("Combined Row");
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
  it("rejects an absent or wrong version", () => {
    expect(() =>
      parsePlayerListBackup(JSON.stringify({ players: [makeBackupEntry()] })),
    ).toThrow(PlayerBackupParseError);
    expect(() =>
      parsePlayerListBackup(JSON.stringify(makeBackupEnvelope([makeBackupEntry()], { version: 2 }))),
    ).toThrow(PlayerBackupParseError);
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

  it("a tagless roster omits the tags key entirely (v1 back-compat)", async () => {
    await insertPlayer(opened.db, { externalId: 691185 });
    const backup = await createPlayerListBackup(opened.db, () => NOW);
    expect("tags" in (backup.players[0] ?? {})).toBe(false);
    // The pre-#30 strict parser still round-trips the serialized envelope.
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
});
