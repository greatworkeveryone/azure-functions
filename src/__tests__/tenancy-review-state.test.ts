import assert from "node:assert";
import { computeReviewState } from "../functions/tenancy";

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("computeReviewState", () => {
  test("returns grey for vacated tenants even when a NextReviewDate is set", () => {
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(30), "vacated"),
      "grey",
    );
  });

  test("returns grey when NextReviewDate is undefined", () => {
    assert.strictEqual(computeReviewState(undefined, "current"), "grey");
  });

  test("returns grey for an unparseable date string", () => {
    assert.strictEqual(computeReviewState("not-a-date", "current"), "grey");
  });

  test("returns green when the next review is more than 90 days away", () => {
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(120), "current"),
      "green",
    );
  });

  test("returns amber when the next review is within 90 days", () => {
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(30), "current"),
      "amber",
    );
  });

  test("returns amber when the next review is overdue (collapses with due-soon)", () => {
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(-45), "current"),
      "amber",
    );
  });

  test("treats holdover status the same as current for review state", () => {
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(30), "holdover"),
      "amber",
    );
    assert.strictEqual(
      computeReviewState(isoDaysFromNow(180), "holdover"),
      "green",
    );
  });
});
