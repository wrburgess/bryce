import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { players, statLines } from "../src/db/schema.js";
import { MlbClient } from "../src/mlb/client.js";
import type { BatchAddRunDeps } from "../src/cli/batch-add.js";
import { MAX_BATCH_FILE_BYTES, runBatchAdd } from "../src/cli/batch-add.js";
import {
  FakeNcaaApi,
  FakeStatsApi,
  MID_SEASON,
  TEST_TZ,
  fakeClock,
  fakeNcaaClient,
  makeNcaaGameLogHtml,
  makePerson,
  makeTeam,
  testDb,
} from "./factories.js";

describe("players:batch-add CLI (in-process)", () => {
  let opened: OpenedDb;
  let api: FakeStatsApi;
  let ncaaApi: FakeNcaaApi;
  let clock: ReturnType<typeof fakeClock>;
  let out: string[];

  const deps = (readFile?: (path: string) => string): BatchAddRunDeps => ({
    db: opened.db,
    client: new MlbClient({ fetchImpl: api.fetch, delayMs: 0 }),
    ncaaClient: fakeNcaaClient(ncaaApi),
    now: clock.now,
    tz: TEST_TZ,
    write: (line) => out.push(line),
    readFile,
  });

  beforeEach(() => {
    opened = testDb();
    clock = fakeClock(MID_SEASON);
    api = new FakeStatsApi({ person: makePerson(), teams: { 564: makeTeam() } });
    ncaaApi = new FakeNcaaApi({
      pages: {
        "2649785:batting": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
        "2649785:pitching": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
        "2649785:fielding": makeNcaaGameLogHtml({ fullName: "College Guy", schoolName: "LSU", rows: [] }),
      },
    });
    out = [];
  });

  afterEach(() => {
    opened.close();
  });

  describe("flags", () => {
    it("stages a person id, prints the outcome + summary, exits 0, and defers backfill", async () => {
      const code = await runBatchAdd(["--person-ids", "691185"], deps());
      expect(code).toBe(0);
      expect(out.some((l) => /^outcome status=added personId=691185 /.test(l))).toBe(true);
      expect(out.at(-1)).toBe("summary added=1 updated=0 unresolved=0 failed=0 total=1");
      expect(await opened.db.select().from(players)).toHaveLength(1);
      expect(await opened.db.select().from(statLines)).toHaveLength(0); // no inline refresh
    });

    it("merges comma-lists and repeated flags into one batch, exits 0", async () => {
      api.options.searchResults = [makePerson({ id: 800001, fullName: "Search Hit" })];
      const code = await runBatchAdd(
        ["--person-ids", "691185,700001", "--ncaa-seqs", "2649785", "--names", "Search Hit"],
        deps(),
      );
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("summary added=4 updated=0 unresolved=0 failed=0 total=4");
    });

    it("exits 0 even when entries are unresolved (a completed batch is not a run failure)", async () => {
      api.options.person = undefined; // every person id is not-found
      const code = await runBatchAdd(["--person-ids", "1,2"], deps());
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("summary added=0 updated=0 unresolved=2 failed=0 total=2");
    });

    it("rejects an unknown flag with exit 1", async () => {
      const code = await runBatchAdd(["--bogus", "x"], deps());
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: unknown flag --bogus/);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("rejects a non-integer id token with exit 1", async () => {
      const code = await runBatchAdd(["--person-ids", "1,abc"], deps());
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: invalid --person-ids token abc/);
    });

    it("rejects a flag missing its value with exit 1", async () => {
      const code = await runBatchAdd(["--person-ids"], deps());
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: flag --person-ids requires a value/);
    });
  });

  describe("--file grammar", () => {
    it("parses each tagged-line rule (digits, ncaa:, name:, other; skips blank + #)", async () => {
      // Resolution is defeated on every path so each outcome reveals ONLY which
      // rule fired (its identity ref), isolating the parse from resolution.
      api.options.person = undefined;
      api.options.searchResults = [];
      ncaaApi.options.status = 404;
      const file = ["# a comment", "12345", "name:12345", "ncaa:2649785", "Bob Smith", "   ", ""].join("\n");

      const code = await runBatchAdd(["--file", "batch.txt"], deps(() => file));
      expect(code).toBe(0);
      const outcomes = out.filter((l) => l.startsWith("outcome "));
      expect(outcomes).toHaveLength(4);
      // Bare digits -> personId; name: escape -> a name even when all-digits.
      expect(outcomes[0]).toMatch(/personId=12345/);
      expect(outcomes[1]).toMatch(/name=12345/);
      expect(outcomes[2]).toMatch(/ncaaSeq=2649785/);
      expect(outcomes[3]).toMatch(/name=Bob Smith/);
      expect(out.at(-1)).toBe("summary added=0 updated=0 unresolved=4 failed=0 total=4");
    });

    it("combines a --file with quick flags into one batch", async () => {
      api.options.person = undefined;
      const code = await runBatchAdd(["--person-ids", "1", "--file", "batch.txt"], deps(() => "2\n3\n"));
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("summary added=0 updated=0 unresolved=3 failed=0 total=3");
    });

    it("rejects a non-numeric ncaa: token with exit 1", async () => {
      const code = await runBatchAdd(["--file", "batch.txt"], deps(() => "ncaa:abc\n"));
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: invalid ncaa seq in file line: ncaa:abc/);
    });

    it("rejects an over-cap batch (26 file lines) with exit 1 and writes nothing", async () => {
      const file = Array.from({ length: 26 }, (_, i) => String(i + 1)).join("\n");
      const code = await runBatchAdd(["--file", "batch.txt"], deps(() => file));
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: invalid batch/);
      expect(await opened.db.select().from(players)).toHaveLength(0);
    });

    it("rejects an oversize file (over the byte ceiling) before parsing, with exit 1", async () => {
      const huge = "x".repeat(MAX_BATCH_FILE_BYTES + 100);
      const code = await runBatchAdd(["--file", "batch.txt"], deps(() => huge));
      expect(code).toBe(1);
      expect(out[0]).toMatch(/exceeds the \d+-byte size ceiling/);
    });

    it("rejects an unreadable file with exit 1", async () => {
      const code = await runBatchAdd(
        ["--file", "nope.txt"],
        deps(() => {
          throw new Error("ENOENT: no such file");
        }),
      );
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^error: cannot read nope.txt/);
    });
  });

  describe("ASCII-safe, forgery-proof output (rules/scripting.md)", () => {
    it("transliterates a resolved player's accented fullName to a pure-ASCII outcome line", async () => {
      // A resolved MLB player whose real name carries diacritics — the outcome
      // line must stay ASCII-only (no raw accented bytes on a bundled script's stdout).
      api.options.person = makePerson({ fullName: "Ronald Acuña Jr." });
      const code = await runBatchAdd(["--person-ids", "691185"], deps());
      expect(code).toBe(0);
      const line = out.find((l) => l.startsWith("outcome "));
      expect(line).toBeDefined();
      expect(/[^\x20-\x7e]/.test(line as string)).toBe(false); // no non-ASCII byte survives
      expect(line).toContain("Acuna"); // diacritic stripped, not dropped
    });

    it("collapses a newline in a --names value so it cannot forge a second output line", async () => {
      // A user-supplied name carrying an embedded newline would otherwise break the
      // single greppable outcome line into two forged lines.
      api.options.searchResults = []; // resolves to zero hits -> one unresolved outcome
      const code = await runBatchAdd(["--names", "Bad\nName"], deps());
      expect(code).toBe(0);
      // The whole captured output is exactly two physical lines (outcome + summary):
      // no embedded newline survived to forge a third.
      const physicalLines = out.join("\n").split("\n");
      expect(physicalLines).toHaveLength(2);
      const referencing = physicalLines.filter((l) => l.includes("Bad Name"));
      expect(referencing).toHaveLength(1); // exactly one line, newline collapsed to a space
      expect(referencing[0]).not.toContain("\n");
    });
  });
});
