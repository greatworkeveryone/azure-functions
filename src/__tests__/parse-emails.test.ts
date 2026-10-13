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

describe("extractHints — PO numbers in Johanne's format", () => {
  test.each([
    ["PO 66Sm261013", "66Sm261013"],
    ["PO#: 9Ce261013b", "9Ce261013b"],
    ["Order No. 66Sm261013", "66Sm261013"],
    ["Order Number: McMgm261013", "McMgm261013"],
    ["P.O. ALLins261013", "ALLins261013"],
    ["PO number 66Sm261013", "66Sm261013"],
    ["po 66Sm261013", "66Sm261013"],
    ["Re: Purchase Order 66Sm261013 — Leaking tap L2 kitchen", "66Sm261013"],
    ["PO66Sm261013", "66Sm261013"],
    ["PO&nbsp;66Sm261013", "66Sm261013"],
    ["PO: 66Sm261013.", "66Sm261013"],
  ])("finds %j", (subject, expected) => {
    assert.strictEqual(extractHints(subject, null).poNumber, expected);
  });

  test("finds the number in the body", () => {
    const { poNumber } = extractHints("Invoice attached", "<p>Re PO 9Ce261013b, thanks</p>");
    assert.strictEqual(poNumber, "9Ce261013b");
  });

  test("keeps the case of the code", () => {
    assert.strictEqual(extractHints("PO McMgm261013", null).poNumber, "McMgm261013");
  });

  test("a real number beats an earlier loose token", () => {
    const { poNumber } = extractHints("PO 2024 follow-up", "see PO 66Sm261013");
    assert.strictEqual(poNumber, "66Sm261013");
  });

  test("a real number in either format beats a loose supplier reference", () => {
    assert.strictEqual(extractHints("PO: ABC-123", "Ours: PO 260419-PO-42-ACM-7").poNumber, "260419-PO-42-ACM-7");
    assert.strictEqual(extractHints("PO: ABC-123", "Ours: PO 9Ce261013").poNumber, "9Ce261013");
  });

  test("the earliest real number wins, so the subject beats the body", () => {
    assert.strictEqual(extractHints("PO 66Sm261013", "also PO 9Ce261013b").poNumber, "66Sm261013");
  });

  test("still finds the legacy format next to the new one", () => {
    assert.strictEqual(extractHints("PO 260419-PO-42-ACM-7", "PO 66Sm261013").poNumber, "260419-PO-42-ACM-7");
  });

  test("a loose token with a wrong-case code is still only a loose hint", () => {
    assert.strictEqual(extractHints("PO 66sm261013", null).poNumber, "66sm261013");
    assert.strictEqual(extractHints("PO 66Sm261013", "PO 66sm261013").poNumber, "66Sm261013");
  });

  test.each([
    ["PO box for deliveries"],
    ["PO Box"],
    ["PO numbers are listed below"],
    ["Please police the position"],
    ["Position: manager"],
    ["Purchase orders attached"],
    ["Order status update"],
    ["Order confirmation"],
    ["Order No. please"],
    ["P.O. is pending"],
    ["PO 5"],
    ["Total order 66Sm261013"],
  ])("does not read %j as a PO", (text) => {
    assert.strictEqual(extractHints(text, null).poNumber, null);
  });

  test("skips an ordinary word and carries on to a real number", () => {
    assert.strictEqual(extractHints("PO box 12 Darwin", "Please action PO 66Sm261013").poNumber, "66Sm261013");
  });
});
