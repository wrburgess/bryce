import { describe, expect, it } from "vitest";
import { canonicalizeName } from "../src/domain/names.js";

/*
 * #65 / ADR 0039. Each pair is derived from ONE base literal and then forced to
 * a normalization form with `.normalize()`, so the fixtures are guaranteed
 * genuinely-NFD vs genuinely-NFC regardless of how an editor or formatter
 * stores the source bytes (Reviewer SC4 — do not depend on the literal's form).
 */
const NFC_PENA = "Peña".normalize("NFC"); // P e ñ(U+00F1) a           — 4 code points
const NFD_PENA = "Peña".normalize("NFD"); // P e n ◌̃(U+0303) a        — 5 code points
const NFC_ACUNA = "Ronald Acuña Jr.".normalize("NFC");
const NFD_ACUNA = "Ronald Acuña Jr.".normalize("NFD");
const KANA = "鈴木"; // 鈴木 (Suzuki) — East-Asian wide glyphs, no combining marks

describe("canonicalizeName (#65 / ADR 0039)", () => {
  it("guards its own premise: the NFD and NFC fixtures really are different bytes", () => {
    expect(NFD_PENA).not.toBe(NFC_PENA);
    expect(NFD_PENA.length).toBe(5);
    expect(NFC_PENA.length).toBe(4);
  });

  it("folds an NFD name to NFC", () => {
    expect(canonicalizeName(NFD_PENA)).toBe(NFC_PENA);
    expect(canonicalizeName(NFD_ACUNA)).toBe(NFC_ACUNA);
    // One precomposed code point for ñ, not base letter + combining mark.
    expect([...canonicalizeName(NFD_PENA)]).toHaveLength(4);
  });

  it("is idempotent on an already-NFC name", () => {
    expect(canonicalizeName(NFC_PENA)).toBe(NFC_PENA);
    expect(canonicalizeName(canonicalizeName(NFD_PENA))).toBe(NFC_PENA);
  });

  it("collapses internal whitespace and trims, without altering letters", () => {
    expect(canonicalizeName("  Ronald   Acuña   Jr. ".normalize("NFC"))).toBe(NFC_ACUNA);
  });

  it("preserves an apostrophe exactly (O'Reilly)", () => {
    expect(canonicalizeName("Shane O'Reilly")).toBe("Shane O'Reilly");
  });

  it("preserves wide East-Asian characters (kana)", () => {
    expect(canonicalizeName(KANA)).toBe(KANA);
  });
});
