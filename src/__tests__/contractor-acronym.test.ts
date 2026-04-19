import { describe, test } from "node:test";
import assert from "node:assert";
import { generateAcronym } from "../contractor-acronym";

const empty: ReadonlySet<string> = new Set();

describe("generateAcronym — base cases", () => {
  test("three words → three initials", () => {
    assert.strictEqual(generateAcronym("Sydney Commercial Plumbing", empty), "SCP");
  });

  test("two words → initials + padded from first word", () => {
    // "ACME Plumbing" → initials "AP" → pad with next unused char "C"
    assert.strictEqual(generateAcronym("ACME Plumbing", empty), "APC");
  });

  test("single word → first letter + next two chars from the word", () => {
    // "Plumbwise" → "P" (initial) + "L", "U" (next two chars) → "PLU"
    assert.strictEqual(generateAcronym("Plumbwise", empty), "PLU");
  });

  test("single short word → pads with X", () => {
    assert.strictEqual(generateAcronym("Al", empty), "ALX");
  });

  test("name with punctuation is normalised", () => {
    assert.strictEqual(generateAcronym("A.C.M.E!", empty), "ACM");
  });

  test("name with lowercase + spaces is normalised", () => {
    assert.strictEqual(generateAcronym("  ace  pty  ltd  ", empty), "APL");
  });

  test("empty name yields XXX (then digit-suffix on collision)", () => {
    assert.strictEqual(generateAcronym("", empty), "XXX");
  });

  test("non-latin name collapses to XXX", () => {
    assert.strictEqual(generateAcronym("株式会社", empty), "XXX");
  });
});

describe("generateAcronym — collision handling", () => {
  test("on collision, prefers unused letters from the compacted name", () => {
    // "ACME Plumbing" → "APC" collides → next unused char from compacted
    // "ACMEPLUMBING" is "M" → candidate "APM" (replacing 3rd position first).
    const taken = new Set(["APC"]);
    assert.strictEqual(generateAcronym("ACME Plumbing", taken), "APM");
  });

  test("exhausts position 3, then position 2, then position 1", () => {
    // Force every 3rd-position replacement to be taken.
    const taken = new Set(["APC", "APM", "APE", "APL", "APU", "API", "APN", "APG"]);
    // Then position 2 (replacing "P") cycles through unused letters.
    // Compacted "ACMEPLUMBING"; unused chars after "APC" attempt are M,E,L,U,I,N,G
    // After exhausting 3rd-pos, swaps 2nd pos: candidate with "M" at pos 1 = "AMC"
    const result = generateAcronym("ACME Plumbing", taken);
    assert.match(result, /^A[A-Z][A-Z]$|^[A-Z][A-Z][A-Z]$/);
    assert.ok(!taken.has(result), `expected unique but got ${result}`);
  });

  test("falls back to digit suffix when all letter variants collide", () => {
    // Pre-seed every plausible letter variant for "Acme" as taken.
    const taken = new Set<string>();
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const a of letters) {
      for (const b of letters) {
        for (const c of letters) taken.add(`${a}${b}${c}`);
      }
    }
    // All 3-letter alphas are taken → must fall back to digit suffix form.
    const result = generateAcronym("ACME", taken);
    assert.match(result, /^A[A-Z]\d$/);
    assert.ok(!taken.has(result));
  });

  test("two contractors that compact to the same base get distinct acronyms", () => {
    const seen = new Set<string>();
    const first = generateAcronym("Ace Pty", seen);
    seen.add(first);
    const second = generateAcronym("Ace Plumbing", seen);
    seen.add(second);
    const third = generateAcronym("Ace Painting", seen);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(second, third);
    assert.notStrictEqual(first, third);
  });
});
