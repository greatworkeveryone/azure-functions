import { describe, test } from "node:test";
import assert from "node:assert";
import { formatDocNumber, formatYYMMDD } from "../doc-number";

describe("formatYYMMDD", () => {
  test("pads month and day to two digits", () => {
    // 2026-01-05 UTC
    const d = new Date(Date.UTC(2026, 0, 5));
    assert.strictEqual(formatYYMMDD(d), "260105");
  });

  test("uses 2-digit year (wraps 2100 → 00)", () => {
    const d = new Date(Date.UTC(2100, 11, 31));
    assert.strictEqual(formatYYMMDD(d), "001231");
  });

  test("uses UTC (not local) to stay deterministic across servers", () => {
    // 2026-04-19 23:59 UTC → should be 260419, not 260420 even if local is
    // ahead of UTC (Sydney +10/+11).
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

  test("Quote with contractor acronym", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "Q", jobId: 42, acronym: "ACM", seq: 3, now }),
      "260419-Q-42-ACM-3",
    );
  });

  test("internal job (no contractor) uses INT", () => {
    assert.strictEqual(
      formatDocNumber({ prefix: "PO", jobId: 9, acronym: "INT", seq: 1, now }),
      "260419-PO-9-INT-1",
    );
  });
});
