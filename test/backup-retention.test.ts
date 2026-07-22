import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, listSnapshots, pruneSnapshots } from "../src/backup/snapshot.js";
import type { TempDir } from "./backup-helpers.js";
import { makeTempDir } from "./backup-helpers.js";
import type { TempFileDb } from "./factories.js";
import { fakeClock, testFileDb } from "./factories.js";

/**
 * Retention (ADR 0042): keep the newest N Snapshots, delete the rest, and never
 * touch anything that is not one of our own regular-file Snapshots.
 */
describe("pruneSnapshots", () => {
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

  // Produce `count` snapshots at distinct, increasing seconds.
  async function seedSnapshots(count: number): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const iso = `2026-07-${String(10 + i).padStart(2, "0")}T12:00:00Z`;
      names.push((await createSnapshot(live.opened.sqlite, backups.path, fakeClock(iso).now)).name);
    }
    return names;
  }

  it("keeps exactly the keepLast newest and deletes the rest", async () => {
    const names = await seedSnapshots(5); // oldest -> newest
    const result = pruneSnapshots(backups.path, 3);

    expect(result.kept).toHaveLength(3);
    expect(result.deleted.sort()).toEqual(names.slice(0, 2).sort()); // two oldest deleted
    const remaining = listSnapshots(backups.path).map((s) => s.name);
    expect(remaining).toEqual(names.slice(2).reverse()); // newest-first
  });

  it("is a no-op at the boundary (count === keepLast) and idempotent", async () => {
    await seedSnapshots(3);
    const first = pruneSnapshots(backups.path, 3);
    expect(first.deleted).toEqual([]);
    expect(listSnapshots(backups.path)).toHaveLength(3);
    // A second sweep changes nothing.
    const second = pruneSnapshots(backups.path, 3);
    expect(second.deleted).toEqual([]);
    expect(listSnapshots(backups.path)).toHaveLength(3);
  });

  it("never deletes unrelated files or a symlink, even past the keep boundary", async () => {
    const names = await seedSnapshots(4);
    const unrelated = join(backups.path, "keep-me.txt");
    writeFileSync(unrelated, "not a snapshot");
    // A symlink bearing a (very old) snapshot name — must survive prune to 1.
    const symlinkName = "bryce-20200101T000000Z-000.db";
    symlinkSync(names[3] ? join(backups.path, names[3]) : unrelated, join(backups.path, symlinkName));

    pruneSnapshots(backups.path, 1);

    // Exactly the newest real snapshot remains among regular-file snapshots.
    expect(listSnapshots(backups.path).map((s) => s.name)).toEqual([names[3]]);
    // The unrelated file and the symlink were untouched.
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(join(backups.path, symlinkName))).toBe(true);
  });

  it("keeps the newest across MULTIPLE same-second snapshots straddling the boundary", async () => {
    const clock = fakeClock("2026-07-22T12:00:00Z").now; // frozen — all same second
    const a = await createSnapshot(live.opened.sqlite, backups.path, clock); // seq 0
    const b = await createSnapshot(live.opened.sqlite, backups.path, clock); // seq 1
    const c = await createSnapshot(live.opened.sqlite, backups.path, clock); // seq 2

    const result = pruneSnapshots(backups.path, 2);
    // Ordering is by embedded seq, not lexical accident: seq 0 is the oldest.
    expect(result.deleted).toEqual([a.name]);
    expect(listSnapshots(backups.path).map((s) => s.name)).toEqual([c.name, b.name]);
  });

  it("rejects a non-positive keepLast (config guards this upstream, the sweep double-checks)", () => {
    expect(() => pruneSnapshots(backups.path, 0)).toThrow(RangeError);
    expect(() => pruneSnapshots(backups.path, -1)).toThrow(RangeError);
  });
});
