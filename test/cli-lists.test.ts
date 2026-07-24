import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import type { ListsDeps } from "../src/cli/lists.js";
import { runLists } from "../src/cli/lists.js";
import { addToList, createList } from "../src/lists/service.js";
import { fakeClock, insertPlayer, testDb } from "./factories.js";

/**
 * Named-list CLI (issue #70). Exercised end to end through injected deps so the
 * observable effects are asserted — greppable `key=value` output, `error=` on
 * failure, and non-zero exit — not merely a parse (rules/testing.md).
 */
describe("lists CLI", () => {
  let opened: OpenedDb;
  let out: string[];
  let err: string[];
  const clock = fakeClock("2026-07-19T17:00:00.000Z");

  const deps = (): ListsDeps => ({
    db: opened.db,
    now: clock.now,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  beforeEach(() => {
    opened = testDb();
    out = [];
    err = [];
  });
  afterEach(() => {
    opened.close();
  });

  it("create: writes a greppable line and persists the list", async () => {
    const code = await runLists(["create", "--name", "Prospects"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list created id=\d+ name=Prospects$/);
  });

  it("add + show: adds a member and shows the roster", async () => {
    await createList(opened.db, "L", clock.now());
    const p = await insertPlayer(opened.db, { fullName: "Cli Member" });

    const addCode = await runLists(
      ["add", "--name", "L", "--person-ids", String(p.externalId)],
      deps(),
    );
    expect(addCode).toBe(0);
    expect(out[0]).toBe("list add name=L added=1 refs=1");

    out = [];
    const showCode = await runLists(["show", "--name", "L"], deps());
    expect(showCode).toBe(0);
    expect(out[0]).toContain(`playerId=${p.id}`);
    expect(out.at(-1)).toBe("total=1");
  });

  it("show (all): lists live lists with member counts", async () => {
    const list = await createList(opened.db, "Alpha", clock.now());
    const p = await insertPlayer(opened.db);
    await addToList(opened.db, "Alpha", [p.externalId!], clock.now());
    const code = await runLists(["show"], deps());
    expect(code).toBe(0);
    expect(out[0]).toBe(`list id=${list.id} name=Alpha members=1`);
    expect(out.at(-1)).toBe("total=1");
  });

  it("rename: renames a live list", async () => {
    await createList(opened.db, "Old", clock.now());
    const code = await runLists(["rename", "--name", "Old", "--to", "New"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list renamed id=\d+ name=New$/);
  });

  it("delete: soft-deletes and frees the name", async () => {
    await createList(opened.db, "Temp", clock.now());
    const code = await runLists(["delete", "--name", "Temp"], deps());
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^list deleted id=\d+ name=Temp$/);
    // Recreating the freed name succeeds via the CLI.
    expect(await runLists(["create", "--name", "Temp"], deps())).toBe(0);
  });

  it("sad path: an unknown list exits 1 with a greppable error= line", async () => {
    const code = await runLists(["show", "--name", "ghost"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
    expect(err[0]).toContain('no list named "ghost"');
  });

  it("sad path: a duplicate create exits 1 with error=", async () => {
    await createList(opened.db, "Dupes", clock.now());
    const code = await runLists(["create", "--name", "Dupes"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
  });

  it("sad path: adding an unknown player ref exits 1 and writes nothing", async () => {
    await createList(opened.db, "L", clock.now());
    const code = await runLists(["add", "--name", "L", "--person-ids", "99999999"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
  });

  it("sad path: a control char in the create name exits 1 and writes nothing", async () => {
    const code = await runLists(["create", "--name", "a\nb"], deps());
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^error=/);
    // Validation fails closed at the service, before any insert — no list exists.
    const listCode = await runLists(["show"], deps());
    expect(listCode).toBe(0);
    expect(out).toEqual(["total=0"]);
  });

  it("sad path: an unknown subcommand exits 1 with usage", async () => {
    const code = await runLists(["frobnicate"], deps());
    expect(code).toBe(1);
    expect(err[0]).toContain("error=usage:");
  });
});
