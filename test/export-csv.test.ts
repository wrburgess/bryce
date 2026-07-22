import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../src/export/csv.js";

/**
 * The RFC-4180 writer + OWASP formula guard in isolation (rules/security.md:
 * normalize hostile input at the boundary). The guard/quote rules are asserted
 * on `csvCell` directly; `toCsv` is checked for CRLF termination and the
 * header-only shape.
 */

describe("csvCell — RFC-4180 quoting", () => {
  it("passes a plain string through unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
  });

  it("renders null as the empty field", () => {
    expect(csvCell(null)).toBe("");
  });

  it("quotes a field containing a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("quotes a field containing a double quote, doubling it", () => {
    expect(csvCell('a"b')).toBe('"a""b"');
  });

  it("quotes a field containing an embedded newline (LF and CRLF)", () => {
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("csvCell — OWASP formula-injection guard", () => {
  it("prefixes a single quote on a leading = + @ - TAB or CR", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1+2")).toBe("'+1+2");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
  });

  it("guards then quotes when the guarded value still needs quoting (leading CR)", () => {
    // Leading CR triggers the guard AND forces quoting.
    expect(csvCell("\rcmd")).toBe('"\'\rcmd"');
  });

  it("never guards a NUMBER cell, even a negative one", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(3.14)).toBe("3.14");
  });

  it("exempts a plain numeric-literal STRING from the guard", () => {
    expect(csvCell("-5")).toBe("-5"); // negative number as text
    expect(csvCell("+5")).toBe("+5");
    expect(csvCell(".333")).toBe(".333"); // a rate
    expect(csvCell("5")).toBe("5");
    expect(csvCell("12.5")).toBe("12.5");
  });

  it("guards a lone '-' rate placeholder (not a numeric literal)", () => {
    expect(csvCell("-")).toBe("'-");
  });
});

describe("toCsv", () => {
  it("joins cells with commas and terminates EVERY row with CRLF, last included", () => {
    expect(toCsv(["a", "b"], [["x", "y"], ["z", "w"]])).toBe("a,b\r\nx,y\r\nz,w\r\n");
  });

  it("emits a single terminated header line for an empty body", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  it("mixes numbers, nulls, and guarded/quoted strings in one table", () => {
    expect(toCsv(["n", "s"], [[1, "=x"], [null, "a,b"]])).toBe('n,s\r\n1,\'=x\r\n,"a,b"\r\n');
  });

  it("formula-guards a dangerous HEADER (a SQL column alias) too", () => {
    expect(toCsv(["=evil"], [["ok"]])).toBe("'=evil\r\nok\r\n");
  });
});
