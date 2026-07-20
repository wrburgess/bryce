import { describe, expect, it } from "vitest";
import {
  formatIp,
  ipToOuts,
  qualityStart,
  singleGameEra,
  singleGameK9,
  singleGameWhip,
} from "../src/digest/rates.js";

describe("ipToOuts (baseball IP notation, ADR 0033)", () => {
  it("converts whole-plus-thirds notation to outs", () => {
    expect(ipToOuts("6.1")).toBe(19);
    expect(ipToOuts("6.2")).toBe(20);
    expect(ipToOuts("6.0")).toBe(18);
    expect(ipToOuts("0.1")).toBe(1);
    expect(ipToOuts("0.0")).toBe(0);
  });

  it("treats a plain integer string as whole innings", () => {
    expect(ipToOuts("7")).toBe(21);
    expect(ipToOuts("0")).toBe(0);
  });

  it("rejects invalid notation and non-strings as null (never a wrong number)", () => {
    expect(ipToOuts("6.3")).toBeNull(); // a fraction digit can only be 0-2
    expect(ipToOuts("6.10")).toBeNull();
    expect(ipToOuts("-")).toBeNull();
    expect(ipToOuts("")).toBeNull();
    expect(ipToOuts("abc")).toBeNull();
    expect(ipToOuts("-1.0")).toBeNull();
    expect(ipToOuts(null)).toBeNull();
    expect(ipToOuts(undefined)).toBeNull();
  });
});

describe("formatIp", () => {
  it("passes a parseable IP string through", () => {
    expect(formatIp("6.1")).toBe("6.1");
    expect(formatIp("7")).toBe("7");
    expect(formatIp(" 6.2 ")).toBe("6.2");
  });

  it("renders unparseable or missing IP as 0.0", () => {
    expect(formatIp("-")).toBe("0.0");
    expect(formatIp("6.3")).toBe("0.0");
    expect(formatIp(undefined)).toBe("0.0");
    expect(formatIp(6.1)).toBe("0.0"); // numbers are stringified upstream; a raw number is invalid here
  });
});

describe("single-game rates (this outing only, never cumulative)", () => {
  it("computes ERA to exactly two decimals", () => {
    expect(singleGameEra(2, ipToOuts("6.1"))).toBe("2.84"); // 2*9 / (19/3)
    expect(singleGameEra(1, ipToOuts("6.0"))).toBe("1.50");
    expect(singleGameEra(0, ipToOuts("9"))).toBe("0.00");
  });

  it("computes WHIP to exactly two decimals", () => {
    expect(singleGameWhip(1, 4, ipToOuts("6.1"))).toBe("0.79"); // (1+4) / (19/3)
    expect(singleGameWhip(2, 4, ipToOuts("6.0"))).toBe("1.00");
    expect(singleGameWhip(0, 0, ipToOuts("5"))).toBe("0.00");
  });

  it("computes K/9 to exactly one decimal", () => {
    expect(singleGameK9(8, ipToOuts("6.1"))).toBe("11.4"); // 8*9 / (19/3)
    expect(singleGameK9(6, ipToOuts("5.0"))).toBe("10.8");
    expect(singleGameK9(8, ipToOuts("6.0"))).toBe("12.0");
  });

  it("renders '-' for every rate when IP is zero or unparseable", () => {
    expect(singleGameEra(3, 0)).toBe("-");
    expect(singleGameEra(3, null)).toBe("-");
    expect(singleGameWhip(1, 2, 0)).toBe("-");
    expect(singleGameWhip(1, 2, null)).toBe("-");
    expect(singleGameK9(4, 0)).toBe("-");
    expect(singleGameK9(4, null)).toBe("-");
  });
});

describe("qualityStart (>= 6.0 IP and <= 3 ER)", () => {
  it("is 1 exactly at the boundary: 6.0 IP and 3 ER", () => {
    expect(qualityStart(ipToOuts("6.0"), 3)).toBe(1);
  });

  it("is 0 just under six innings even with zero earned runs", () => {
    expect(qualityStart(ipToOuts("5.2"), 0)).toBe(0);
  });

  it("is 0 with four earned runs no matter the innings", () => {
    expect(qualityStart(ipToOuts("7"), 4)).toBe(0);
  });

  it("is 1 comfortably inside both bounds", () => {
    expect(qualityStart(ipToOuts("6.1"), 2)).toBe(1);
  });

  it("is 0 when IP is unparseable or zero", () => {
    expect(qualityStart(null, 0)).toBe(0);
    expect(qualityStart(0, 0)).toBe(0);
  });
});
