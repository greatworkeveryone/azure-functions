import { describe, test } from "node:test";
import assert from "node:assert";
import { formatDocNumber, formatYYMMDD, nameToAcronym } from "../doc-number";

describe("formatYYMMDD", () => {
  test("pads month and day to two digits", () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    assert.strictEqual(formatYYMMDD(d), "260105");
  });

  test("uses 2-digit year (wraps 2100 → 00)", () => {
    const d = new Date(Date.UTC(2100, 11, 31));
    assert.strictEqual(formatYYMMDD(d), "001231");
  });

  test("uses UTC (not local) to stay deterministic across servers", () => {
    const d = new Date(Date.UTC(2026, 3, 19, 23, 59, 59));
    assert.strictEqual(formatYYMMDD(d), "260419");
  });
});

describe("formatDocNumber", () => {
  const now = new Date(Date.UTC(2026, 3, 19));

  test("PO with contractor acronym", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "PO", jobId: 42, acronym: "ACM", seq: 7, now }),
      "260419-PO-42-ACM-7",
    );
  });

  test("Quote (QT) with contractor acronym", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "QT", jobId: 42, acronym: "CR", seq: 3, now }),
      "260419-QT-42-CR-3",
    );
  });

  test("Invoice (IV) with contractor acronym", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "IV", jobId: 42, acronym: "CR", seq: 1, now }),
      "260419-IV-42-CR-1",
    );
  });

  test("internal job (no contractor) uses INT", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "PO", jobId: 9, acronym: "INT", seq: 1, now }),
      "260419-PO-9-INT-1",
    );
  });
});

describe("nameToAcronym", () => {
  test("two-word name → initials", () => {
    assert.strictEqual(nameToAcronym("Connor Randazzo"), "CR");
  });

  test("three-word name → first 3 initials", () => {
    assert.strictEqual(nameToAcronym("Acme Corp Materials"), "ACM");
  });

  test("single word → first letter only", () => {
    assert.strictEqual(nameToAcronym("Microsoft"), "M");
  });

  test("more than three words → capped at 3", () => {
    assert.strictEqual(nameToAcronym("Alpha Beta Gamma Delta"), "ABG");
  });

  test("empty string → UNK", () => {
    assert.strictEqual(nameToAcronym(""), "UNK");
  });
});
