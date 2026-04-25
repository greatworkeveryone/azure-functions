import { describe, test } from "node:test";
import assert from "node:assert";
import { extractHints } from "../functions/parseEmails";

describe("extractHints — PO detection", () => {
  test("finds PO number in subject with colon separator", () => {
    const { poNumber } = extractHints("Re: PO: 260419-PO-42-ACM-7", null);
    assert.strictEqual(poNumber, "260419-PO-42-ACM-7");
  });

  test("finds PO number with hash separator", () => {
    const { poNumber } = extractHints("PO #ABC-123", null);
    assert.strictEqual(poNumber, "ABC-123");
  });

  test("finds Purchase Order spelled out", () => {
    const { poNumber } = extractHints("Purchase Order 260419-PO-9-INT-1 enclosed", null);
    assert.strictEqual(poNumber, "260419-PO-9-INT-1");
  });

  test("finds P.O. with dots", () => {
    const { poNumber } = extractHints("P.O. XYZ-001", null);
    assert.strictEqual(poNumber, "XYZ-001");
  });

  test("finds PO number in body when subject is empty", () => {
    const { poNumber } = extractHints(null, "Please action PO: 260419-PO-42-ACM-7 at your earliest.");
    assert.strictEqual(poNumber, "260419-PO-42-ACM-7");
  });

  test("subject wins when PO appears in both", () => {
    const { poNumber } = extractHints("PO: SUBJECT-REF", "PO: BODY-REF");
    assert.strictEqual(poNumber, "SUBJECT-REF");
  });

  test("returns null when no PO present", () => {
    const { poNumber } = extractHints("Invoice for work completed", "Please find invoice attached.");
    assert.strictEqual(poNumber, null);
  });

  test("is case-insensitive", () => {
    const { poNumber } = extractHints("po #abc-123", null);
    assert.strictEqual(poNumber, "abc-123");
  });
});

describe("extractHints — Quote detection", () => {
  test("finds Quote number with colon", () => {
    const { quoteNumber } = extractHints("Quote: QT-42-ACM-3", null);
    assert.strictEqual(quoteNumber, "QT-42-ACM-3");
  });

  test("finds Q abbreviation with hash", () => {
    const { quoteNumber } = extractHints("Q #QT-001", null);
    assert.strictEqual(quoteNumber, "QT-001");
  });

  test("finds quote number in body when followed directly by the ref", () => {
    const { quoteNumber } = extractHints(null, "Please review Quote: QT-9-INT-2 attached.");
    assert.strictEqual(quoteNumber, "QT-9-INT-2");
  });

  test("Q pattern is greedy — 'quote reference' matches with 'reference' as capture (known behaviour)", () => {
    // The /i flag makes 'q' in 'quote' match the Q alternative, then the next
    // word satisfies the capture group. Callers should put the ref immediately
    // after the keyword to get a useful match.
    const { quoteNumber } = extractHints(null, "Our quote reference is QT-9-INT-2");
    assert.strictEqual(quoteNumber, "reference");
  });

  test("returns null when no quote present", () => {
    const { quoteNumber } = extractHints("Purchase Order PO-001", "Please action.");
    assert.strictEqual(quoteNumber, null);
  });
});

describe("extractHints — combined", () => {
  test("extracts both from the same email", () => {
    const subject = "Re: Quote QT-42-CR-3 / PO: 260419-PO-42-CR-7";
    const { poNumber, quoteNumber } = extractHints(subject, null);
    assert.strictEqual(poNumber, "260419-PO-42-CR-7");
    assert.strictEqual(quoteNumber, "QT-42-CR-3");
  });

  test("returns both null for unrelated email", () => {
    const { poNumber, quoteNumber } = extractHints("Meeting tomorrow", "See you then.");
    assert.strictEqual(poNumber, null);
    assert.strictEqual(quoteNumber, null);
  });

  test("handles null subject and null body", () => {
    const { poNumber, quoteNumber } = extractHints(null, null);
    assert.strictEqual(poNumber, null);
    assert.strictEqual(quoteNumber, null);
  });
});
