import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, listSnapshots, utcStamp } from "../src/backup/snapshot.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import type { TempFileDb } from "./factories.js";
import { fakeClock, insertPlayer, insertStatLine, testFileDb } from "./factories.js";

/**
 * The Snapshot service (ADR 0042): a consistent whole-DB copy, crash-safely
 * published, verified by opening the copy and counting rows. WAL-edge and
 * same-second-collision cases are the ones a naive copy gets wrong.
 */
describe("createSnapshot", () => {
  let live: TempFileDb;
  let backups: TempDir;

  beforeEach(() => {
    live = testFileDb();
    backups = makeTempDir();
  });

  afterEach(() => {
    live.cleanup();
    backups.cleanup();
  });

  it("captures a consistent, restorable copy with the same row counts", async () => {
    const player = await insertPlayer(live.opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(live.opened.db, { playerId: player.id, gameId: 1, gameDate: "2026-07-18" });
    await insertStatLine(live.opened.db, { playerId: player.id, gameId: 2, gameDate: "2026-07-18" });

    const info = await createSnapshot(live.opened.sqlite, backups.path, fakeClock("2026-07-22T12:00:00Z").now);
    expect(info.name).toMatch(/^bryce-\d{8}T\d{6}Z-\d{3}\.db$/);

    // Open the snapshot as its own database and prove it carries the data.
    const snap = new Database(info.path, { readonly: true, fileMustExist: true });
    try {
      expect(snap.pragma("integrity_check", { simple: true })).toBe("ok");
      expect((snap.prepare("SELECT count(*) AS n FROM players").get() as { n: number }).n).toBe(1);
      expect((snap.prepare("SELECT count(*) AS n FROM stat_lines").get() as { n: number }).n).toBe(2);
    } finally {
      snap.close();
    }
  });

  it("is WAL-consistent: a committed write with un-checkpointed frames is captured whole", async () => {
    // Write without checkpointing — the row lives only in the WAL when we snapshot.
    const player = await insertPlayer(live.opened.db, { fullName: "Uncheckpointed" });
    await insertStatLine(live.opened.db, { playerId: player.id, gameId: 99, gameDate: "2026-07-18" });

    const info = await createSnapshot(live.opened.sqlite, backups.path, fakeClock("2026-07-22T12:00:00Z").now);
    const snap = new Database(info.path, { readonly: true, fileMustExist: true });
    try {
      expect(snap.pragma("integrity_check", { simple: true })).toBe("ok");
      const names = (snap.prepare("SELECT full_name FROM players").all() as Array<{ full_name: string }>).map(
        (r) => r.full_name,
      );
      expect(names).toContain("Uncheckpointed");
      expect((snap.prepare("SELECT count(*) AS n FROM stat_lines").get() as { n: number }).n).toBe(1);
    } finally {
      snap.close();
    }
  });

  it("two snapshots in the SAME second get distinct names, both present", async () => {
    const clock = fakeClock("2026-07-22T12:00:00Z").now; // frozen — same second for both
    const first = await createSnapshot(live.opened.sqlite, backups.path, clock);
    const second = await createSnapshot(live.opened.sqlite, backups.path, clock);

    expect(first.name).not.toBe(second.name);
    expect(first.timestamp).toBe(second.timestamp);
    expect(second.seq).toBe(first.seq + 1);

    const listed = listSnapshots(backups.path);
    expect(listed.map((s) => s.name).sort()).toEqual([first.name, second.name].sort());
    // Newest-first: the higher same-second sequence leads.
    expect(listed[0]?.name).toBe(second.name);
  });

  it("atomically claims the sequence name — a concurrent -000 is never overwritten (finding #4)", async () => {
    const stamp = "20260722T120000Z";
    const clock = fakeClock("2026-07-22T12:00:00Z").now;
    let injected = false;
    const info = await createSnapshot(live.opened.sqlite, backups.path, clock, {
      onBeforePublish: () => {
        if (injected) return;
        injected = true;
        // A competitor publishes -000 in the same second, after we materialized
        // our copy but before we publish. The atomic link claim must NOT clobber
        // it (the old existsSync-then-rename protocol would have).
        writeFileSync(join(backups.path, `bryce-${stamp}-000.db`), "COMPETITOR");
      },
    });
    expect(info.name).toBe(`bryce-${stamp}-001.db`);
    expect(readFileSync(join(backups.path, `bryce-${stamp}-000.db`), "utf8")).toBe("COMPETITOR");
  });

  it("listSnapshots ignores unrelated files and symlinks and orders newest-first", async () => {
    const early = await createSnapshot(live.opened.sqlite, backups.path, fakeClock("2026-07-20T09:00:00Z").now);
    const late = await createSnapshot(live.opened.sqlite, backups.path, fakeClock("2026-07-22T18:30:00Z").now);

    // Noise: an unrelated file and a symlink bearing the snapshot pattern.
    writeFileSync(join(backups.path, "notes.txt"), "not a snapshot");
    writeFileSync(join(backups.path, "bryce-backup.db"), "wrong shape");
    symlinkSync(late.path, join(backups.path, "bryce-20260101T000000Z-000.db"));

    const listed = listSnapshots(backups.path);
    expect(listed.map((s) => s.name)).toEqual([late.name, early.name]);
  });
});

describe("utcStamp", () => {
  it("formats a fixed-width UTC stamp whose lexical order is chronological", () => {
    expect(utcStamp(new Date("2026-07-22T12:03:04Z"))).toBe("20260722T120304Z");
    expect(utcStamp(new Date("2026-01-02T00:00:00Z"))).toBe("20260102T000000Z");
    expect(utcStamp(new Date("2026-07-22T09:00:00Z")) < utcStamp(new Date("2026-07-22T10:00:00Z"))).toBe(
      true,
    );
  });
});
