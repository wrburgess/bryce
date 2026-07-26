import { describe, expect, it } from "vitest";
import { parseReportPlayerArgs } from "../src/cli/report.js";

describe("report player CLI", () => {
  it("parses canonical selectors and game-window grammar", () => {
    expect(parseReportPlayerArgs(["--id", "12", "--windows", " LAST10 , ytd "])).toEqual({ id: 12, windows: ["last10", "ytd"] });
    expect(parseReportPlayerArgs(["--name=José Test"])).toEqual({ name: "José Test", windows: ["last10", "last30", "ytd"] });
  });

  it("rejects ambiguous, malformed, and duplicate arguments before opening the database", () => {
    expect(parseReportPlayerArgs([])).toContain("exactly one");
    expect(parseReportPlayerArgs(["--id", "01"])).toContain("canonical");
    expect(parseReportPlayerArgs(["--id", "1", "--name", "Name"])).toContain("exactly one");
    expect(parseReportPlayerArgs(["--id", "1", "--windows", "last10,last10"])).toContain("unique");
  });
});
