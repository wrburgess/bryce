import { describe, expect, it } from "vitest";
import { MAX_BATCH_FILE_BYTES, runBatchAdd } from "../src/cli/batch-add.js";
import { MID_SEASON, TEST_TZ, fakeClock, fakeHighlightlyClient, testDb } from "./factories.js";

describe("players:batch-add CLI", () => {
  it("stages an explicit Highlightly identity", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runBatchAdd([
        "--highlightly-player-id", "501", "--canonical-name", "C Guy", "--team-id", "10",
      ], {
        db: opened.db,
        client: {} as never,
        highlightlyClient: fakeHighlightlyClient(),
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
        write: (line) => out.push(line),
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("highlightlyPlayerId=501");
    } finally { opened.close(); }
  });

  it("rejects the removed sequence flag", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runBatchAdd(["--ncaa-seqs", "1"], {
        db: opened.db, client: {} as never, now: fakeClock(MID_SEASON).now, tz: TEST_TZ, write: (line) => out.push(line),
      });
      expect(code).toBe(1);
      expect(out[0]).toContain("unknown flag");
    } finally { opened.close(); }
  });
});

/**
 * The `--file` batch grammar. It is the paste-friendly path an operator actually
 * uses for a bulk add, and every one of its shapes and refusals ran untested
 * through the CLI until now — the parse is where a silent misread costs the most,
 * because a mis-tagged line becomes a *different player* rather than an error.
 * `readFile` is injected, so no case touches the filesystem.
 */
describe("players:batch-add --file grammar", () => {
  const run = async (contents: string, out: string[]): Promise<number> => {
    const opened = testDb();
    try {
      return await runBatchAdd(["--file", "batch.txt"], {
        db: opened.db,
        client: {} as never,
        highlightlyClient: fakeHighlightlyClient(),
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
        write: (line) => out.push(line),
        readFile: () => contents,
      });
    } finally { opened.close(); }
  };

  it("reads every tagged line shape, ignoring blanks and comments", async () => {
    const out: string[] = [];
    const code = await run(
      [
        "# a comment line",
        "",
        "highlightly:501|C Guy|10",
        "name:12345",           // the escape hatch: a name that is all digits
        "  Maximo Acosta  ",    // a bare name, trimmed
        "691185",               // a bare MLB personId
      ].join("\n"),
      out,
    );
    expect(code).toBe(0);
    // Four entries, in file order — the comment and the blank produced none.
    const outcomes = out.filter((line) => line.startsWith("outcome "));
    expect(outcomes).toHaveLength(4);
    expect(outcomes[0]).toContain("highlightlyPlayerId=501");
    // `name:12345` is a NAME, not the personId 12345 — the whole point of the tag.
    expect(outcomes[1]).toContain("name=12345");
    expect(outcomes[2]).toContain("name=Maximo Acosta");
    expect(outcomes[3]).toContain("personId=691185");
    expect(out.at(-1)).toContain("total=4");
  });

  it("refuses a malformed Highlightly identity line, naming the offending line", async () => {
    const out: string[] = [];
    expect(await run("highlightly:notanid|C Guy|10", out)).toBe(1);
    expect(out[0]).toBe("error: invalid Highlightly identity in file line: highlightly:notanid|C Guy|10");

    out.length = 0;
    expect(await run("highlightly:501||10", out)).toBe(1);
    expect(out[0]).toContain("invalid Highlightly identity in file line");
  });

  it("refuses the retired `ncaa:` tag with the replacement spelling", async () => {
    const out: string[] = [];
    expect(await run("ncaa:2649785", out)).toBe(1);
    expect(out[0]).toBe(
      "error: ncaa: entries are no longer supported; use highlightly:<id>|<name>|<team-id>",
    );
  });

  it("refuses a file over the size ceiling before parsing a single line", async () => {
    const out: string[] = [];
    // One byte over, built from VALID lines: the ceiling must be what rejects it,
    // not the grammar (rules/testing.md — never pass for the wrong reason).
    expect(await run("691185\n".repeat(MAX_BATCH_FILE_BYTES), out)).toBe(1);
    expect(out).toEqual([
      `error: batch file exceeds the ${MAX_BATCH_FILE_BYTES}-byte size ceiling`,
    ]);
  });

  it("reports an unreadable file as a usage error rather than throwing", async () => {
    const opened = testDb();
    const out: string[] = [];
    try {
      const code = await runBatchAdd(["--file", "missing.txt"], {
        db: opened.db,
        client: {} as never,
        now: fakeClock(MID_SEASON).now,
        tz: TEST_TZ,
        write: (line) => out.push(line),
        readFile: () => { throw new Error("ENOENT: no such file"); },
      });
      expect(code).toBe(1);
      expect(out[0]).toBe("error: cannot read missing.txt: ENOENT: no such file");
    } finally { opened.close(); }
  });
});
